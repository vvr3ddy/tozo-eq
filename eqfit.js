/* AutoEQ import + least-squares fit of arbitrary parametric/graphic EQ onto
 * the 10 fixed-frequency peaking bands the TOZO DSP accepts.
 * Port of cli/tozo_eq.py — keep the two in sync. */

import { BAND_FREQS, GAIN_LIMIT, Q_MIN, Q_MAX } from './protocol.js';

const N_GRID = 160;
const FS = 48000;

export const FIT_FREQS = Float64Array.from(
  { length: N_GRID },
  (_, i) => 20 * Math.pow(20000 / 20, i / (N_GRID - 1)));

const GAIN_CANDS = [];
for (let v = -Math.round(GAIN_LIMIT * 10); v <= Math.round(GAIN_LIMIT * 10); v++)
  GAIN_CANDS.push(v / 10);
const Q_CANDS = [];
for (let v = Math.round(Q_MIN * 10); v <= Math.round(Q_MAX * 10); v++)
  Q_CANDS.push(v / 10);

// grid trig, precomputed once
const COSW = new Float64Array(N_GRID), SINW = new Float64Array(N_GRID);
{
  const cosW2 = new Float64Array(N_GRID), sinW2 = new Float64Array(N_GRID);
  for (let i = 0; i < N_GRID; i++) {
    const w = 2 * Math.PI * FIT_FREQS[i] / FS;
    COSW[i] = Math.cos(w); SINW[i] = Math.sin(w);
    cosW2[i] = Math.cos(2 * w); sinW2[i] = Math.sin(2 * w);
  }
  var COSW2 = cosW2, SINW2 = sinW2;
}

/* RBJ Audio EQ Cookbook biquad magnitude response in dB over the grid. */
export function filterDb(kind, fc, gainDb, q, out = new Float64Array(N_GRID)) {
  const w0 = 2 * Math.PI * fc / FS;
  const cw0 = Math.cos(w0), sw0 = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'PK') {
    const alpha = sw0 / (2 * q);
    b0 = 1 + alpha * A; b1 = -2 * cw0; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cw0; a2 = 1 - alpha / A;
  } else {
    const sa = (sw0 / 2) * Math.SQRT2; // shelf slope S=1 (AutoEQ default)
    if (kind === 'LS') {
      b0 = A * ((A + 1) - (A - 1) * cw0 + sa);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw0);
      b2 = A * ((A + 1) - (A - 1) * cw0 - sa);
      a0 = (A + 1) + (A - 1) * cw0 + sa;
      a1 = -2 * ((A - 1) + (A + 1) * cw0);
      a2 = (A + 1) + (A - 1) * cw0 - sa;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cw0 + sa);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw0);
      b2 = A * ((A + 1) + (A - 1) * cw0 - sa);
      a0 = (A + 1) - (A - 1) * cw0 + sa;
      a1 = 2 * ((A - 1) - (A + 1) * cw0);
      a2 = (A + 1) - (A - 1) * cw0 - sa;
    }
  }
  for (let i = 0; i < N_GRID; i++) {
    // H(e^jw) = (b0 + b1 z^-1 + b2 z^-2) / (a0 + a1 z^-1 + a2 z^-2)
    const nr = b0 + b1 * COSW[i] + b2 * COSW2[i];
    const ni = -(b1 * SINW[i] + b2 * SINW2[i]);
    const dr = a0 + a1 * COSW[i] + a2 * COSW2[i];
    const di = -(a1 * SINW[i] + a2 * SINW2[i]);
    const d2 = dr * dr + di * di;
    const hr = (nr * dr + ni * di) / d2;
    const hi = (ni * dr - nr * di) / d2;
    out[i] = 10 * Math.log10(hr * hr + hi * hi);
  }
  return out;
}

const FILTER_RE =
  /Filter\s+\d+\s*:\s*ON\s+(PK|PEAK|LSC|LSF|HSC|HSF)\s+Fc\s+([\d.,]+)\s*(Hz|kHz)?\s+Gain\s+([+-]?[\d.]+)\s*dB(?:\s+Q\s*([\d.]+))?/gi;
const GRAPHIC_RE =
  /^[ \t]*([\d.,]+)\s*(Hz|kHz)\s+([+-]?[\d.]+)\s*dB[ \t]*$/gim;

function toHz(num, unit) {
  const f = parseFloat(num.replace(/,/g, ''));
  return unit && unit.toLowerCase() === 'khz' ? f * 1000 : f;
}

/* Parse AutoEQ parametric_eq.txt or graphic_eq.txt -> target dB curve. */
export function parseAutoeq(text) {
  const target = new Float64Array(N_GRID);
  let found = false;
  FILTER_RE.lastIndex = 0;
  let m;
  while ((m = FILTER_RE.exec(text)) !== null) {
    found = true;
    const kindUp = m[1].toUpperCase();
    const kind = (kindUp === 'PK' || kindUp === 'PEAK') ? 'PK'
      : (kindUp === 'LSC' || kindUp === 'LSF') ? 'LS' : 'HS';
    const fc = toHz(m[2], m[3]);
    const gain = parseFloat(m[4]);
    const q = m[5] ? parseFloat(m[5]) : 0.707;
    const resp = filterDb(kind, fc, gain, kind === 'PK' ? q : 0.707);
    for (let i = 0; i < N_GRID; i++) target[i] += resp[i];
  }
  if (found) return target;

  const pts = [];
  GRAPHIC_RE.lastIndex = 0;
  while ((m = GRAPHIC_RE.exec(text)) !== null)
    pts.push([toHz(m[1], m[2]), parseFloat(m[3])]);
  if (pts.length >= 3) {
    pts.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < N_GRID; i++) {
      const lf = Math.log10(FIT_FREQS[i]);
      let v;
      if (lf <= Math.log10(pts[0][0])) v = pts[0][1];
      else if (lf >= Math.log10(pts[pts.length - 1][0])) v = pts[pts.length - 1][1];
      else {
        let j = 1;
        while (Math.log10(pts[j][0]) < lf) j++;
        const l0 = Math.log10(pts[j - 1][0]), l1 = Math.log10(pts[j][0]);
        v = pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * (lf - l0) / (l1 - l0);
      }
      target[i] = v;
    }
    return target;
  }
  throw new Error('No AutoEQ filters found (expected "Filter N: ON PK ..." ' +
                  'or graphic EQ lines like "1000 Hz -3.5 dB")');
}

/* Least-squares coordinate-descent fit: 10 fixed-frequency peaking filters,
 * gain and Q on the hardware's 0.1-step grid. */
export function fitEq(target, passes = 8) {
  // center in gain range (device has no preamp)
  let tmin = Infinity, tmax = -Infinity;
  for (const v of target) { if (v < tmin) tmin = v; if (v > tmax) tmax = v; }
  const off = (tmax + tmin) / 2;
  const t = Float64Array.from(target, v => v - off);

  const nCand = GAIN_CANDS.length * Q_CANDS.length;
  const tables = BAND_FREQS.map(f0 => {
    const tbl = new Float32Array(nCand * N_GRID);
    const resp = new Float64Array(N_GRID);
    for (let gi = 0; gi < GAIN_CANDS.length; gi++)
      for (let qi = 0; qi < Q_CANDS.length; qi++) {
        filterDb('PK', f0, GAIN_CANDS[gi], Q_CANDS[qi], resp);
        tbl.set(resp, (gi * Q_CANDS.length + qi) * N_GRID);
      }
    return tbl;
  });

  const zeroIdx = GAIN_CANDS.indexOf(0) * Q_CANDS.length;
  const choice = new Array(10).fill(zeroIdx);
  const contrib = choice.map((c, i) =>
    Float64Array.from(tables[i].subarray(c * N_GRID, (c + 1) * N_GRID)));

  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < 10; i++) {
      // residual target with band i's contribution removed
      const resid = new Float64Array(N_GRID);
      for (let k = 0; k < N_GRID; k++) {
        let s = 0;
        for (let j = 0; j < 10; j++) if (j !== i) s += contrib[j][k];
        resid[k] = t[k] - s;
      }
      const tbl = tables[i];
      let best = -1, bestErr = Infinity;
      for (let c = 0; c < nCand; c++) {
        const base = c * N_GRID;
        let err = 0;
        for (let k = 0; k < N_GRID; k++) {
          const d = tbl[base + k] - resid[k];
          err += d * d;
        }
        if (err < bestErr) { bestErr = err; best = c; }
      }
      choice[i] = best;
      contrib[i] = Float64Array.from(
        tbl.subarray(best * N_GRID, (best + 1) * N_GRID));
    }
  }

  const model = new Float64Array(N_GRID);
  for (const c of contrib) for (let i = 0; i < N_GRID; i++) model[i] += c[i];
  let sq = 0, peak = 0;
  for (let i = 0; i < N_GRID; i++) {
    const d = model[i] - t[i];
    sq += d * d;
    if (Math.abs(d) > peak) peak = Math.abs(d);
  }
  return {
    gains: choice.map(c => GAIN_CANDS[Math.floor(c / Q_CANDS.length)]),
    qs: choice.map(c => Q_CANDS[c % Q_CANDS.length]),
    rms: Math.sqrt(sq / N_GRID),
    max: peak,
    model,
  };
}

/* Magnitude response of the current 10-band settings, over arbitrary freqs. */
export function bandResponse(gains, qs, freqs) {
  const out = new Float64Array(freqs.length);
  const tmp = new Float64Array(freqs.length);
  for (let b = 0; b < gains.length; b++) {
    if (Math.abs(gains[b]) < 0.05) continue;
    // reuse filterDb on a custom grid
    const w0 = 2 * Math.PI * BAND_FREQS[b] / FS;
    const cw0 = Math.cos(w0), sw0 = Math.sin(w0);
    const A = Math.pow(10, gains[b] / 40);
    const alpha = sw0 / (2 * qs[b]);
    const b0 = 1 + alpha * A, b1 = -2 * cw0, b2 = 1 - alpha * A;
    const a0 = 1 + alpha / A, a1 = -2 * cw0, a2 = 1 - alpha / A;
    for (let i = 0; i < freqs.length; i++) {
      const w = 2 * Math.PI * freqs[i] / FS;
      const cw = Math.cos(w), sw = Math.sin(w);
      const cw2 = Math.cos(2 * w), sw2 = Math.sin(2 * w);
      const nr = b0 + b1 * cw + b2 * cw2, ni = -(b1 * sw + b2 * sw2);
      const dr = a0 + a1 * cw + a2 * cw2, di = -(a1 * sw + a2 * sw2);
      const d2 = dr * dr + di * di;
      const hr = (nr * dr + ni * di) / d2, hi = (ni * dr - nr * di) / d2;
      tmp[i] = 10 * Math.log10(hr * hr + hi * hi);
      out[i] += tmp[i];
    }
  }
  return out;
}
