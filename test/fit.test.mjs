/* Parity tests: JS fitter vs. reference outputs from cli/tozo_eq.py */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { parseAutoeq, fitEq, FIT_FREQS } from '../eqfit.js';
import { buildFrame, eqPayload, hex } from '../protocol.js';

// --- golden frame (matches CLI byte-for-byte) ------------------------------
const gains = [6, 5, 4, 2, 0, 0, 0, 0, 1, 2];
const qs = [0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];
const frame = buildFrame(Uint8Array.of(0x10, 0x0b), eqPayload(gains, qs, 1));
assert.strictEqual(
  hex(frame),
  '10 0b 15 3c 32 28 14 00 00 00 00 0a 14 05 06 07 08 0a 0c 0e 10 12 14 01 3d');
assert.strictEqual(hex(buildFrame(Uint8Array.of(0x00, 0x01))), '00 01 00 00');
console.log('ok  frame encoding matches CLI goldens');

// --- parametric fit: Apple AirPods Max ParametricEq.txt ---------------------
// reference (python): rms 1.14, max 4.15
const maxEq = readFileSync(new URL('./AirPodsMax.txt', import.meta.url), 'utf8');
const target = parseAutoeq(maxEq);
const t0 = Date.now();
const fit = fitEq(target);
console.log(`ok  fit ran in ${Date.now() - t0} ms`);
assert.deepStrictEqual(
  fit.gains.map(g => g.toFixed(1)),
  ['-3.2', '-1.9', '-1.0', '-1.1', '1.0', '-3.2', '-0.1', '2.6', '7.5', '-6.8']);
assert.deepStrictEqual(
  fit.qs.map(q => q.toFixed(1)),
  ['0.5', '0.8', '2.0', '2.0', '1.4', '0.5', '0.6', '0.5', '0.9', '0.5']);
assert.ok(Math.abs(fit.rms - 1.14) < 0.03, `rms ${fit.rms}`);
assert.ok(Math.abs(fit.max - 4.15) < 0.05, `max ${fit.max}`);
console.log(`ok  parametric fit matches python (rms ${fit.rms.toFixed(2)}, max ${fit.max.toFixed(2)})`);

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
