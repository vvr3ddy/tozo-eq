/* Parity tests: JS fitter vs. reference outputs from cli/tozo_eq.py */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parseAutoeq, fitEq, invertCurve, FIT_FREQS } from '../eqfit.js';
import { buildFrame, eqPayload, hex, GAIN_LIMIT, Q_MIN, Q_MAX, PROFILES } from '../protocol.js';

// --- golden frame (matches CLI byte-for-byte) ------------------------------
const gains = [6, 5, 4, 2, 0, 0, 0, 0, 1, 2];
const qs = [0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
const frame = buildFrame(Uint8Array.of(0x10, 0x0b), eqPayload(gains, qs, 1));
assert.strictEqual(
  hex(frame),
  '10 0b 15 3c 32 28 14 00 00 00 00 0a 14 05 06 07 08 0a 0c 0e 10 12 14 01 3d');
assert.strictEqual(hex(buildFrame(Uint8Array.of(0x00, 0x01))), '00 01 00 00');
console.log('ok  frame encoding matches CLI goldens');

// --- built-in presets must stay inside the buds' accepted range -------------
// Guards the class of bug where a preset/fit exceeds the DSP gain ceiling and
// the write is refused (status 1).
for (const [name, p] of Object.entries(PROFILES)) {
  for (const g of p.gains)
    assert.ok(Math.abs(g) <= GAIN_LIMIT + 1e-9,
      `preset "${name}" gain ${g} dB exceeds ±${GAIN_LIMIT}`);
  for (const q of p.qs)
    assert.ok(q >= Q_MIN - 1e-9 && q <= Q_MAX + 1e-9,
      `preset "${name}" Q ${q} outside ${Q_MIN}–${Q_MAX}`);
}
console.log(`ok  ${Object.keys(PROFILES).length} presets within ±${GAIN_LIMIT} dB / Q ${Q_MIN}–${Q_MAX}`);

// --- parametric fit: Apple AirPods Max ParametricEq.txt ---------------------
// reference (python), capped to the buds' ±GAIN_LIMIT dB ceiling: rms 1.19, max 4.41
const maxEq = readFileSync(new URL('./AirPodsMax.txt', import.meta.url), 'utf8');
const target = parseAutoeq(maxEq);
const t0 = Date.now();
const fit = fitEq(target);
console.log(`ok  fit ran in ${Date.now() - t0} ms`);
assert.deepStrictEqual(
  fit.gains.map(g => g.toFixed(1)),
  ['-3.2', '-1.9', '-1.0', '-1.1', '1.0', '-3.3', '-0.1', '2.8', '6.0', '-6.0']);
assert.deepStrictEqual(
  fit.qs.map(q => q.toFixed(1)),
  ['0.5', '0.8', '2.0', '2.0', '1.4', '0.5', '0.8', '0.5', '0.8', '0.5']);
assert.ok(Math.abs(fit.rms - 1.19) < 0.03, `rms ${fit.rms}`);
assert.ok(Math.abs(fit.max - 4.41) < 0.05, `max ${fit.max}`);
assert.ok(fit.gains.every(g => Math.abs(g) <= GAIN_LIMIT + 1e-9),
  `fit exceeded ±${GAIN_LIMIT} dB: ${fit.gains}`);
console.log(`ok  parametric fit matches python (rms ${fit.rms.toFixed(2)}, max ${fit.max.toFixed(2)})`);

// --- emulate mode: inverting the target negates the fit exactly --------------
// A peaking filter's dB response is odd in gain, and the fitter's midpoint
// re-centring is odd under negation, so fitEq(invertCurve(t)) must be the exact
// gain-negation of fitEq(t) with identical Qs and mirrored error.
assert.deepStrictEqual(
  Array.from(invertCurve(Float64Array.of(1.5, -2, 0, 3)), v => v + 0),
  [-1.5, 2, 0, -3]);
const emu = fitEq(invertCurve(target));
assert.deepStrictEqual(emu.gains.map(g => g.toFixed(1)),
  fit.gains.map(g => (-g).toFixed(1)));
assert.deepStrictEqual(emu.qs.map(q => q.toFixed(1)),
  fit.qs.map(q => q.toFixed(1)));
assert.ok(Math.abs(emu.rms - fit.rms) < 1e-9 && Math.abs(emu.max - fit.max) < 1e-9,
  'emulate fit error should mirror the correct fit');
console.log(`ok  emulate fit is the exact negation (rms ${emu.rms.toFixed(2)})`);

// --- gain-ceiling regression: a bass-heavy correction that used to overflow --
// This is the profile that made the buds reply "rejected (status 1)": a +9.5 dB
// low shelf with a -10.5 dB preamp we can't honour (the DSP has no preamp). The
// old ±12.7 dB fitter emitted +12.6 / -10.1 dB bands; the fit must now stay in
// range so the write is accepted.
const bassHeavy = [
  'Preamp: -10.5 dB',
  'Filter 1: ON LSC Fc 105.0 Hz Gain +9.50 dB Q 0.70',
  'Filter 2: ON PK Fc 40.0 Hz Gain +4.00 dB Q 1.50',
  'Filter 3: ON PK Fc 168.5 Hz Gain -3.00 dB Q 1.00',
  'Filter 4: ON PK Fc 511.4 Hz Gain +2.00 dB Q 1.70',
  'Filter 5: ON PK Fc 2121.9 Hz Gain +3.50 dB Q 1.10',
  'Filter 6: ON PK Fc 3133.2 Hz Gain -1.50 dB Q 5.86',
  'Filter 7: ON PK Fc 4985.6 Hz Gain +1.00 dB Q 2.33',
  'Filter 8: ON PK Fc 6142.5 Hz Gain -3.50 dB Q 5.98',
  'Filter 9: ON PK Fc 8420.5 Hz Gain +0.00 dB Q 2.30',
  'Filter 10: ON HSC Fc 10000.0 Hz Gain +1.00 dB Q 0.70',
].join('\n');
const bassFit = fitEq(parseAutoeq(bassHeavy));
const bassPeak = Math.max(...bassFit.gains.map(Math.abs));
assert.ok(bassPeak <= GAIN_LIMIT + 1e-9,
  `bass-heavy fit exceeded ±${GAIN_LIMIT} dB (peak ${bassPeak.toFixed(1)}): ${bassFit.gains}`);
console.log(`ok  bass-heavy fit stays within ±${GAIN_LIMIT} dB (peak ${bassPeak.toFixed(1)})`);

// --- graphic EQ parse --------------------------------------------------------
const graphic = [
  '20 Hz +3.0 dB', '100 Hz +2.0 dB', '1000 Hz 0.0 dB',
  '5000 Hz -1.0 dB', '10000 Hz +2.0 dB',
].join('\n');
const gTarget = parseAutoeq(graphic);
assert.ok(Math.abs(gTarget[0] - 3.0) < 1e-9);
assert.ok(Math.abs(gTarget[gTarget.length - 1] - 2.0) < 1e-9);
console.log('ok  graphic EQ parse');

// --- shelf filters change the curve ------------------------------------------
const flat = new Float64Array(FIT_FREQS.length);
const ls = parseAutoeq('Filter 1: ON LSC Fc 105 Hz Gain +6.0 dB');
assert.ok(ls[0] > 3 && ls[ls.length - 1] < 0.5, 'low shelf shape wrong');
assert.deepStrictEqual(Array.from(flat).every(v => v === 0) ? 'flat' : 'x', 'flat');
console.log('ok  shelf filter evaluation');

console.log('\nall tests passed');
