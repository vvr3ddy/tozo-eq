/* TOZO earbud BLE control protocol — derived through independent research
 * and verified on hardware. Frame: [cmd_hi][cmd_lo][len][payload...][sum&0xff] */

export const BAND_FREQS = [20, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800];
export const DEFAULT_QS  = [0.5, 0.6, 0.7, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0];

export const GAIN_LIMIT = 12.7;   // int8 dB*10
export const Q_MIN = 0.5;
export const Q_MAX = 2.0;

export const SERVICE_UUID = '0000b610-0000-1000-8000-00805f9b34fb';
export const WRITE_UUID   = '0000b611-0000-1000-8000-00805f9b34fb';
export const NOTIFY_UUID  = '0000b612-0000-1000-8000-00805f9b34fb';

export const CMD_GET_FW = Uint8Array.of(0x00, 0x01);
export const CMD_GET_EQ = Uint8Array.of(0x00, 0x0b);
export const CMD_SET_EQ = Uint8Array.of(0x10, 0x0b);

export const PROFILES = {
  'Flat':            { gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], qs: DEFAULT_QS },
  'Bass Boost':      { gains: [6, 5, 4, 2, 0, 0, 0, 0, 1, 2], qs: DEFAULT_QS },
  'Vocal':           { gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1], qs: DEFAULT_QS },
  'Treble':          { gains: [-1, -1, 0, 0, 0, 1, 2, 4, 5, 6], qs: DEFAULT_QS },
  'V-Shape':         { gains: [5, 4, 2, 0, -2, -2, 0, 2, 4, 5], qs: DEFAULT_QS },
  'Crusher Style':   { gains: [3, 5, 6, 4, 1, 0, -1, -1, -2, -3], qs: DEFAULT_QS },
  'AirPods Max-ish': { gains: [3.2, 2.4, 1.3, -0.8, 0.6, 2.6, 0.6, -2.6, -8.6, 7.7],
                       qs: [0.5, 0.6, 0.8, 0.5, 0.5, 0.5, 0.7, 0.5, 1.0, 0.5] },
};

export function buildFrame(cmd, payload = new Uint8Array()) {
  let sum = 0;
  for (const b of payload) sum = (sum + b) & 0xff;
  const frame = new Uint8Array(payload.length + 4);
  frame.set(cmd, 0);
  frame[2] = payload.length;
  frame.set(payload, 3);
  frame[3 + payload.length] = sum;
  return frame;
}

export function parseResponse(data) {
  if (data.length < 4) return null;
  const len = data[2];
  if (data.length !== len + 4) return null;
  const payload = data.slice(3, 3 + len);
  let sum = 0;
  for (const b of payload) sum = (sum + b) & 0xff;
  if (sum !== data[3 + len]) return null;
  return { cmd: [data[0], data[1]], payload };
}

export function encodeGains(gains) {
  const out = new Uint8Array(gains.length);
  for (let i = 0; i < gains.length; i++) {
    const v = Math.round(gains[i] * 10);
    if (v < -128 || v > 127) throw new Error(`gain ${gains[i]} dB out of range`);
    out[i] = v & 0xff;
  }
  return out;
}

export function encodeQs(qs) {
  const out = new Uint8Array(qs.length);
  for (let i = 0; i < qs.length; i++) out[i] = Math.round(qs[i] * 10) & 0xff;
  return out;
}

export function eqPayload(gains, qs, save) {
  const g = encodeGains(gains), q = encodeQs(qs);
  const p = new Uint8Array(g.length + q.length + 1);
  p.set(g, 0);
  p.set(q, g.length);
  p[p.length - 1] = save ? 1 : 0;
  return p;
}

export function decodeEqPayload(payload) {
  const gains = [], qs = [];
  for (let i = 0; i < 10; i++) gains.push(((payload[i] ^ 0x80) - 0x80) / 10);
  for (let i = 10; i < 20 && i < payload.length; i++) qs.push(payload[i] / 10);
  return { gains, qs };
}

export function hex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
