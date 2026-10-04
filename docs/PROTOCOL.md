# TOZO earbud BLE control protocol

Derived through independent research and verified on hardware
(TOZO Open EarRing, device mark `B3`).

## 1. Device discovery

Devices are identifiable from raw advertisement bytes:

```
… FF <mac:6> <id:1> "WR" [<batch:1>]     or     … FF <mac:6> <id:1> "WOER"
```

- `FF` — manufacturer-specific data marker
- `<mac:6>` — device MAC
- `<id:1>` — product mark, e.g. `B3` = Open EarRing
  (other observed marks: `CF0D` / `DF0D` = HR variants)
- ASCII tag `WR` (with batch byte) or `WOER`

Manufacturer IDs observed: 1628 (TOZO), 2019 (Airoha).

## 2. GATT layout (TOZO-protocol devices)

Verified on Open EarRing; devices expose the command characteristics under
a vendor service, discoverable by the characteristic UUID substrings
`b611`/`b612`:

| Service | Characteristic | Properties | Purpose |
|---|---|---|---|
| `0000b610-0000-1000-8000-00805f9b34fb` | `0000b611-…` | write-without-response | command channel → buds |
| | `0000b612-…` | notify (CCCD `00002902-…`) | response channel → host |
| `0000b510-…` | `0000b511-…` | write / read | OTA channel |
| | `0000b512-…` | notify | OTA responses |

Older firmware exposes the same characteristics as 128-bit
`4157b611-d129-aeb5-859b-d547e30ffcb1` etc. — match on the `b611`/`b612`
substring, not the full UUID.

Observed connection parameters: MTU request 512, connect timeout 20 s,
3 reconnect attempts, **no pairing, authentication, or encryption** on the
control channel.

## 3. Frame format

Every command and response, in both directions:

```
[cmd_hi][cmd_lo][len:1][payload:len][checksum:1]
checksum = sum(payload) & 0xFF        (payload only — not cmd/len)
```

- `len` = payload length (0 for parameter-less GETs)
- Receivers validate `len` against the actual frame size and the checksum;
  mismatches are dropped.
- GET commands are `0x00xx`, SET commands `0x10xx`.
- SET responses: payload `[status]`, `0x00` = accepted.

## 4. Command table (subset)

| Cmd | Meaning | Payload (host → buds) |
|---|---|---|
| `0x0001` | GET firmware version | — (binary version fields in response) |
| `0x0002` | GET battery level | — |
| `0x0003` / `0x1003` | GET / SET button config | SET: 10 bytes (5 left actions + 5 right) |
| `0x0004` / `0x1004` | GET / SET ANC on-off | SET: `[0|1]` |
| `0x0006` / `0x1006` | GET / SET gaming mode | SET: `[0|1]` |
| `0x000B` / `0x100B` | GET / SET 10-band EQ | see below |
| `0x100C` | EQ reset | — |
| `0x100D` | SET EQ (Airoha coefficient mode) | biquad coefficient container — not used by TOZO-protocol buds |
| `0x0011` / `0x1011` | GET / SET adaptive ANC | |
| `0x0012` / `0x1012` | GET / SET boot ANC mode | |

## 5. EQ encoding (`0x100B`)

Payload = 21 bytes:

```
[0..9]   gains, int8, dB × 10        (±12.7 dB range)
[10..19] Q values, uint8, Q × 10     (app only sends 0.5–2.0)
[20]     save flag: 1 = persist to flash, 0 = live DSP only
```

Bands are fixed at 20, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800 Hz.
Factory Q defaults: 0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0.

`GET 0x000B` returns the same 20-byte gains+Qs layout (no save byte).

Example — set gains `[+6,+5,+4,+2,0,0,0,0,+1,+2]`, default Qs, save:

```
10 0b 15 3c 32 28 14 00 00 00 00 0a 14 05 06 07 08 0a 0c 0e 10 12 14 01 3d
```

## 6. Observed firmware quirks

- **GET lags one write.** After a successful SET (ack received), an immediate
  GET may still return the previous state; the following GET shows the new one.
- `save=0` applies immediately to the DSP (audible) but is not reflected in
  some responses and does not survive a power cycle; `save=1` persists and
  replaces the stored preset.
- There is no handshake or authentication step before issuing commands —
  connect, subscribe to `b612`, and start sending frames.

## 7. Device families

TOZO hardware spans several controller chips, and only some use the
protocol documented here:

- **TOZO-protocol buds** (this document) expose the `b611`/`b612` GATT
  characteristics and accept the plain `0x100B` 10-band EQ. The Open
  EarRing (mark `B3`) is in this family.
- **Airoha-chip models** use command `0x100D` with biquad coefficients
  instead of the `0x100B` gain/Q layout, over a classic-BT transport.
- **Juxin-chip models** use a different GATT service
  (`0000faa0`/`faa1`/`faa2`).
- **OTA** runs on a separate channel (`b511`/`b512`) with per-chip vendor
  protocols — intentionally not implemented here.
