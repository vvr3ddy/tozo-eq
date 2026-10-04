# tozo-eq

Edit the EQ of TOZO earbuds **directly over Bluetooth LE** — no companion app,
no account, no cloud. Import an [AutoEQ](https://autoeq.app) profile, fit it to
the buds' 10-band DSP, preview it live, and save it to the earbuds' flash.

Two front-ends, one protocol:

| | Web app | CLI |
|---|---|---|
| Where | this repo's root (`index.html`) — hostable on GitHub Pages | `cli/tozo_eq.py` |
| Needs | Chrome/Edge/Vivaldi (Web Bluetooth), HTTPS or localhost | Python 3.9+, `bleak`, `numpy` |
| Best for | daily tweaking, sharing with others | scripting, automation, any OS |

## Quick start — web app

1. Open the page (locally: `python3 -m http.server` in the repo root, then
   visit `http://localhost:8000`).
2. Force-close the TOZO app on your phone — it holds the buds' BLE control
   channel.
3. Click **Connect**, pick your buds in the browser's device chooser.
4. Adjust sliders or import an AutoEQ file, then **Preview** (volatile) and
   **Save to buds** (persisted to flash).

## Quick start — CLI

```bash
pip install -r cli/requirements.txt

python cli/tozo_eq.py --scan                          # find your buds
python cli/tozo_eq.py --read-only                     # dump current EQ
python cli/tozo_eq.py --profile bass_boost --no-save  # built-in profiles
python cli/tozo_eq.py --autoeq my_eq.txt --no-save    # fit an AutoEQ file
python cli/tozo_eq.py --autoeq my_eq.txt              # …and persist it
python cli/tozo_eq.py --gains 3,5,6,4,1,0,-1,-1,-2,-3 # manual, 10 bands
```

## How the AutoEQ fitting works

The buds' DSP has **10 fixed-frequency peaking bands**
(20/50/100/200/400/800/1600/3200/6400/12800 Hz), ±12.7 dB gain (0.1 dB steps),
Q 0.5–2.0, and no preamp. AutoEQ files specify arbitrary frequencies and Q
values, so both front-ends:

1. Parse the parametric (`Filter N: ON PK/LSC/HSC …`) or graphic EQ format.
2. Evaluate the target magnitude curve (RBJ biquads, 48 kHz) on a log grid.
3. Re-center it into the gain range (no preamp on-device).
4. Least-squares fit 10 peaking filters — frequencies locked, gain and Q on the
   hardware grid — via coordinate descent (~90 ms in JS, ~0.5 s in Python).

Broad tonal curves fit within ~0.5–1 dB rms; narrow high-Q notches get
approximated (fit error is always displayed).

**Emulating another headphone?** AutoEQ files are *corrections* toward neutral.
Invert every `Gain` sign of the file for headphone X and you get X's coloration
on top of your (roughly neutral) buds — that's how the built-in
"AirPods Max-ish" and "Crusher Style" presets were made.

## Supported hardware

Verified on **TOZO Open EarRing** (device mark `B3`). Expected to work with any
TOZO-protocol buds exposing GATT service `0000b610` with characteristics
`b611` (write) / `b612` (notify). Not compatible with TOZO models that use
Airoha (classic BT/SPP) or Juxin (different GATT) protocols. Audio is
unaffected by all of this — it streams over standard A2DP.

Protocol details: [docs/PROTOCOL.md](docs/PROTOCOL.md)

## Development

```bash
npm test        # JS fitter parity tests vs. Python reference outputs
```

No build step — the web app is plain ES modules.

## Disclaimer

Unofficial community tool. Not affiliated with TOZO. The control protocol was
derived through independent research and verified on hardware for
interoperability. Writing EQ to your earbuds is done at your own risk; nothing
here should brick a device (writes touch DSP parameters only, not firmware),
but no guarantees.

## Credits

Protocol research, CLI and web app co-built by **vvr3ddy** and
[**Qoder**](https://qoder.com) (AI pair). EQ curve math follows the RBJ Audio
EQ Cookbook; AutoEQ parsing targets the [AutoEQ](https://github.com/jaakkopasanen/AutoEq)
formats.

MIT licensed.
