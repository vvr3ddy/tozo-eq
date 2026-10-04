#!/usr/bin/env python3
"""
Push custom EQ profiles directly to TOZO Open EarRing (mark B3) earbuds,
bypassing the TOZO app.

Protocol derived through independent research and verified on hardware:
  - BLE GATT, write char UUID contains "b611" (write without response),
    notify char UUID contains "b612".
  - Frame: [cmd_hi][cmd_lo][len][payload...][sum(payload) & 0xFF]
  - GET firmware:  cmd 0x0001   GET EQ: cmd 0x000B
  - SET EQ (plain 10-band): cmd 0x100B
      payload = 10x gain bytes (int8, dB*10)
              + 10x Q bytes (uint8, Q*10)
              + 1x save byte (1 = persist to earbuds)
  - Bands (fixed): 20 50 100 200 400 800 1600 3200 6400 12800 Hz
  - Factory default Qs: 0.5 0.6 0.7 0.8 1.0 1.2 1.4 1.6 1.8 2.0

Usage:
  1. Close the TOZO app completely (it hogs the BLE connection).
  2. Put earbuds in the case / near the phone-adjacent Bluetooth adapter,
     powered on. Audio keeps playing over A2DP; this is only a side channel.
  3. pip install bleak numpy
  4. python3 tozo_eq.py            # scan + show current EQ + apply profile
     python3 tozo_eq.py --scan     # just scan, don't write anything
     python3 tozo_eq.py --profile bass_boost
     python3 tozo_eq.py --autoeq ~/Downloads/TOZO_Open_Earring_parametric_eq.txt
"""

import argparse
import asyncio
import re
import sys

import numpy as np
from bleak import BleakClient, BleakScanner

FREQS = [20, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800]
DEFAULT_QS = [0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0]

# --- EQ profiles: gain in dB per band (20 Hz .. 12.8 kHz) -------------------
PROFILES = {
    "flat":       [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "bass_boost": [6, 5, 4, 2, 0, 0, 0, 0, 1, 2],
    "vocal":      [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    "treble":     [-1, -1, 0, 0, 0, 1, 2, 4, 5, 6],
    "v_shape":    [5, 4, 2, 0, -2, -2, 0, 2, 4, 5],
}

CMD_GET_FW = bytes([0x00, 0x01])
CMD_GET_EQ = bytes([0x00, 0x0B])
CMD_SET_EQ = bytes([0x10, 0x0B])


def build_frame(cmd: bytes, payload: bytes = b"") -> bytes:
    checksum = sum(payload) & 0xFF
    return cmd + bytes([len(payload)]) + payload + bytes([checksum])


def encode_gains(gains_db):
    out = []
    for g in gains_db:
        v = int(round(g * 10))
        if not -128 <= v <= 127:
            raise ValueError(f"gain {g} dB out of range (+/-12.7 dB)")
        out.append(v & 0xFF)
    return bytes(out)


def encode_qs(qs):
    return bytes(int(round(q * 10)) & 0xFF for q in qs)


# --- AutoEQ import & 10-band fit --------------------------------------------

FIT_FREQS = np.geomspace(20, 20000, 160)   # target curve sample points
FIT_FS = 48000.0
# The wire format is int8 (dB*10, ±12.7 encodable), but the buds' DSP rejects
# swings that large — a fit that pushed a band to +12.6 dB came back "rejected".
# Built-in tunings stay within ~±5 dB, so cap the fitter to a safe ceiling.
GAIN_LIMIT = 6.0
GAIN_CANDS = np.arange(-int(round(GAIN_LIMIT * 10)),
                       int(round(GAIN_LIMIT * 10)) + 1) / 10.0
Q_CANDS = np.arange(5, 21) / 10.0           # keep to app's 0.5..2.0 range

_FILTER_RE = re.compile(
    r"Filter\s+\d+\s*:\s*ON\s+(PK|PEAK|LSC|LSF|HSC|HSF)\s+"
    r"Fc\s+([\d.,]+)\s*(Hz|kHz)?\s+Gain\s+([+-]?[\d.]+)\s*dB"
    r"(?:\s+Q\s*([\d.]+))?",
    re.IGNORECASE)

_GRAPHIC_RE = re.compile(r"^\s*([\d.,]+)\s*(Hz|kHz)\s+([+-]?[\d.]+)\s*dB",
                         re.IGNORECASE | re.MULTILINE)


def _hz(num, unit):
    f = float(num.replace(",", ""))
    return f * 1000.0 if unit and unit.lower() == "khz" else f


def parse_autoeq(text):
    """Parse AutoEQ parametric_eq.txt (or graphic_eq.txt). Returns target
    curve in dB over FIT_FREQS."""
    filters = _FILTER_RE.findall(text)
    if filters:
        target = np.zeros_like(FIT_FREQS)
        for kind, fc, unit, gain, q in filters:
            kind = kind.upper()
            if kind in ("PK", "PEAK"):
                kind = "PK"
            elif kind in ("LSC", "LSF"):
                kind = "LS"
            else:
                kind = "HS"
            q = float(q) if q else (0.707 if kind == "PK" else None)
            target += _filter_db(kind, _hz(fc, unit), float(gain), q,
                                 FIT_FREQS)
        return target
    pts = [(_hz(f, u), float(g)) for f, u, g in _GRAPHIC_RE.findall(text)]
    if len(pts) >= 3:
        pts.sort()
        lf = np.log10([p[0] for p in pts])
        lg = [p[1] for p in pts]
        return np.interp(np.log10(FIT_FREQS), lf, lg)
    raise ValueError("no AutoEQ filters found in file "
                     "(expected 'Filter N: ON PK ...' or graphic EQ lines)")


def _filter_db(kind, fc, gain_db, q, freqs):
    """RBJ cookbook biquad magnitude response in dB."""
    w0 = 2 * np.pi * fc / FIT_FS
    w = 2 * np.pi * freqs / FIT_FS
    A = 10 ** (gain_db / 40.0)
    cw0, sw0 = np.cos(w0), np.sin(w0)
    if kind == "PK":
        alpha = sw0 / (2 * q)
        b = [1 + alpha * A, -2 * cw0, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw0, 1 - alpha / A]
    else:
        sa = (sw0 / 2) * np.sqrt(2.0)  # shelf slope S=1 (AutoEQ default)
        if kind == "LS":
            b = [A * ((A + 1) - (A - 1) * cw0 + sa),
                 2 * A * ((A - 1) - (A + 1) * cw0),
                 A * ((A + 1) - (A - 1) * cw0 - sa)]
            a = [(A + 1) + (A - 1) * cw0 + sa,
                 -2 * ((A - 1) + (A + 1) * cw0),
                 (A + 1) + (A - 1) * cw0 - sa]
        else:
            b = [A * ((A + 1) + (A - 1) * cw0 + sa),
                 -2 * A * ((A - 1) + (A + 1) * cw0),
                 A * ((A + 1) + (A - 1) * cw0 - sa)]
            a = [(A + 1) - (A - 1) * cw0 + sa,
                 2 * ((A - 1) - (A + 1) * cw0),
                 (A + 1) - (A - 1) * cw0 - sa]
    z1 = np.exp(-1j * w)
    z2 = z1 * z1
    num = b[0] + b[1] * z1 + b[2] * z2
    den = a[0] + a[1] * z1 + a[2] * z2
    return 20 * np.log10(np.abs(num / den))


def fit_eq(target, passes=8):
    """Least-squares fit of 10 fixed-frequency peaking filters (gain & Q
    within hardware limits) to a target dB curve."""
    # center target in gain range (preamp isn't available on-device)
    target = target - (target.max() + target.min()) / 2.0
    tables = []
    for f0 in FREQS:
        resp = np.empty((len(GAIN_CANDS), len(Q_CANDS), len(FIT_FREQS)),
                        dtype=np.float32)
        for gi, g in enumerate(GAIN_CANDS):
            for qi, q in enumerate(Q_CANDS):
                resp[gi, qi] = _filter_db("PK", f0, g, q, FIT_FREQS)
        tables.append(resp.reshape(-1, len(FIT_FREQS)))
    choice = [int(np.argmin(np.abs(GAIN_CANDS))) * len(Q_CANDS)] * 10
    contrib = [tables[i][choice[i]] for i in range(10)]
    for _ in range(passes):
        for i in range(10):
            resid = target - (np.sum(contrib, axis=0) - contrib[i])
            err = np.linalg.norm(tables[i] - resid, axis=1)
            choice[i] = int(np.argmin(err))
            contrib[i] = tables[i][choice[i]]
    model = np.sum(contrib, axis=0)
    err = model - target
    gains = [float(GAIN_CANDS[c // len(Q_CANDS)]) for c in choice]
    qs = [float(Q_CANDS[c % len(Q_CANDS)]) for c in choice]
    return gains, qs, float(np.sqrt(np.mean(err ** 2))), float(np.abs(err).max())


def is_tozo_adv(device, adv) -> str | None:
    """Return the id hex string if this advert is a TOZO device."""
    for _company_id, data in (adv.manufacturer_data or {}).items():
        # layout after company id: [6-byte mac][1-byte id]["WR"(+batch) | "WOER"]
        if len(data) >= 9 and data[7:9] == b"WR":
            return f"{data[6]:02X}"
        if len(data) >= 11 and data[7:11] == b"WOER":
            return f"{data[6]:02X}"
    name = (adv.local_name or device.name or "")
    if "TOZO" in name.upper():
        return "?"
    return None


def find_char(client: BleakClient, needle: str):
    for service in client.services:
        for ch in service.characteristics:
            if needle in ch.uuid.lower():
                return ch
    return None


def parse_response(data: bytes):
    """Validate frame, return (cmd, payload) or None."""
    if len(data) < 4:
        return None
    length = data[2]
    if len(data) != length + 4:
        return None
    payload = data[3:3 + length]
    if (sum(payload) & 0xFF) != data[3 + length]:
        return None
    return data[0:2], payload


def decode_eq_payload(payload: bytes):
    gains = [((b ^ 0x80) - 0x80) / 10.0 for b in payload[:10]]  # signed
    qs = [b / 10.0 for b in payload[10:20]] if len(payload) >= 20 else None
    return gains, qs


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true", help="scan only")
    ap.add_argument("--address", help="skip scan, connect to this MAC/UUID")
    ap.add_argument("--profile", default=None,
                    help=f"one of: {', '.join(PROFILES)}")
    ap.add_argument("--autoeq", metavar="FILE",
                    help="AutoEQ parametric_eq.txt or graphic_eq.txt to fit")
    ap.add_argument("--gains", help="10 comma-separated dB values, e.g. 3,2,0,...")
    ap.add_argument("--no-save", action="store_true",
                    help="don't persist to earbud flash (volatile)")
    ap.add_argument("--read-only", action="store_true",
                    help="connect and read current EQ, write nothing")
    args = ap.parse_args()

    address = args.address
    if not address:
        print("Scanning for TOZO devices (10 s)...")
        found = {}
        devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
        for device, adv in devices.values():
            id_hex = is_tozo_adv(device, adv)
            if id_hex:
                found[device.address] = (device, id_hex, adv.rssi)
        if not found:
            print("No TOZO devices found. Are the earbuds on and the app closed?")
            sys.exit(1)
        for addr, (dev, id_hex, rssi) in found.items():
            name = adv_name = dev.name or "?"
            tag = " <-- Open EarRing (B3)" if id_hex == "B3" else ""
            print(f"  {addr}  id={id_hex}  rssi={rssi}  name={name}{tag}")
        if args.scan:
            return
        b3 = [a for a, (_, i, _) in found.items() if i == "B3"]
        if len(b3) == 1:
            address = b3[0]
        elif args.profile or args.gains or args.read_only or args.autoeq:
            if len(found) == 1:
                address = next(iter(found))
            else:
                print("Multiple devices; pass --address explicitly.")
                sys.exit(1)
        else:
            address = next(iter(found))

    print(f"\nConnecting to {address} ...")
    async with BleakClient(address, timeout=30.0) as client:
        write_ch = find_char(client, "b611")
        notify_ch = find_char(client, "b612")
        if not write_ch or not notify_ch:
            print("b611/b612 characteristics not found - is this really a "
                  "TOZO-protocol device?")
            sys.exit(1)
        print(f"  write : {write_ch.uuid}")
        print(f"  notify: {notify_ch.uuid}")

        responses: asyncio.Queue = asyncio.Queue()

        def on_notify(_ch, data: bytes):
            responses.put_nowait(bytes(data))

        await client.start_notify(notify_ch, on_notify)

        async def send(cmd: bytes, payload: bytes = b"", expect_cmd=None,
                       timeout=5.0):
            frame = build_frame(cmd, payload)
            responses._queue.clear()
            await client.write_gatt_char(write_ch, frame, response=False)
            print(f"  >> {frame.hex(' ')}")
            deadline = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < deadline:
                try:
                    data = await asyncio.wait_for(
                        responses.get(),
                        timeout=max(0.1, deadline - asyncio.get_event_loop().time()))
                except asyncio.TimeoutError:
                    break
                parsed = parse_response(data)
                print(f"  << {data.hex(' ')}")
                if parsed and (expect_cmd is None or parsed[0] == expect_cmd):
                    return parsed
            return None

        print("\nGetting firmware version (0x0001)...")
        r = await send(CMD_GET_FW, expect_cmd=CMD_GET_FW)
        if r:
            try:
                print(f"  firmware: {r[1].decode('utf-8', 'replace')}")
            except Exception:
                print(f"  firmware raw: {r[1].hex(' ')}")
        else:
            print("  no valid response - device may use a different protocol.")

        print("\nGetting current EQ (0x000B)...")
        r = await send(CMD_GET_EQ, expect_cmd=CMD_GET_EQ)
        if r:
            gains, qs = decode_eq_payload(r[1])
            print("  band(Hz): " + " ".join(f"{f:>6}" for f in FREQS))
            print("  gain(dB): " + " ".join(f"{g:>6.1f}" for g in gains))
            if qs:
                print("  Q       : " + " ".join(f"{q:>6.1f}" for q in qs))

        if args.read_only:
            return

        if args.gains:
            gains_db = [float(x) for x in args.gains.split(",")]
            if len(gains_db) != 10:
                print("--gains needs exactly 10 values")
                sys.exit(1)
            qs = DEFAULT_QS
            label = "custom"
        elif args.profile:
            if args.profile not in PROFILES:
                print(f"unknown profile; choose from: {', '.join(PROFILES)}")
                sys.exit(1)
            gains_db = PROFILES[args.profile]
            qs = DEFAULT_QS
            label = args.profile
        elif args.autoeq:
            with open(args.autoeq, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            target = parse_autoeq(text)
            print("\nFitting AutoEQ curve to the 10 fixed bands "
                  "(this takes a few seconds)...")
            gains_db, qs, rms, peak = fit_eq(target)
            label = f"autoeq:{args.autoeq}"
            print(f"  fit error: {rms:.2f} dB rms, {peak:.2f} dB max "
                  "(broad tonal EQ fits well; narrow high-Q peaks will be "
                  "approximated)")
        else:
            print("\nNothing to write. Use --profile NAME, --autoeq FILE, "
                  "or --gains g1,...,g10")
            return

        save = 0 if args.no_save else 1
        payload = encode_gains(gains_db) + encode_qs(qs) + bytes([save])
        print(f"\nSetting EQ ({label}), save={save}...")
        print("  band(Hz): " + " ".join(f"{f:>6}" for f in FREQS))
        print("  gain(dB): " + " ".join(f"{g:>6.1f}" for g in gains_db))
        print("  Q       : " + " ".join(f"{q:>6.1f}" for q in qs))
        r = await send(CMD_SET_EQ, payload, expect_cmd=CMD_SET_EQ)
        if r:
            print("  earbuds acknowledged the new EQ.")
        else:
            print("  no ack received (some firmwares don't ack SET; "
                  "re-read with --read-only to verify).")

        print("\nVerifying by re-reading EQ...")
        r = await send(CMD_GET_EQ, expect_cmd=CMD_GET_EQ)
        if r:
            gains, _ = decode_eq_payload(r[1])
            print("  now: " + " ".join(f"{g:>6.1f}" for g in gains))


if __name__ == "__main__":
    asyncio.run(main())
