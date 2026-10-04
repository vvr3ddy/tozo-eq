import {
  BAND_FREQS, DEFAULT_QS, GAIN_LIMIT, Q_MIN, Q_MAX,
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID,
  CMD_GET_FW, CMD_GET_EQ, CMD_SET_EQ, PROFILES,
  buildFrame, parseResponse, eqPayload, decodeEqPayload, hex,
} from './protocol.js';
import { parseAutoeq, fitEq, FIT_FREQS, bandResponse } from './eqfit.js';

/* ------------------------------- state --------------------------------- */

const state = {
  device: null,
  writeChar: null,
  connected: false,
  pending: [],            // resolvers for awaited notifications
  gains: PROFILES['Flat'].gains.slice(),
  qs: DEFAULT_QS.slice(),
  target: null,           // Float64Array | null — imported AutoEQ curve
  dirty: true,
};

const $ = id => document.getElementById(id);
const els = {
  connDot: $('conn-dot'), connLabel: $('conn-label'),
  btnConnect: $('btn-connect'), chkAll: $('chk-all-devices'),
  btnRead: $('btn-read'), btnPreview: $('btn-preview'),
  btnSave: $('btn-save'), btnFlat: $('btn-flat'),
  bands: $('bands'), curve: $('curve'), log: $('log'),
  btnClearLog: $('btn-clear-log'),
  presets: $('presets'),
  autoeqText: $('autoeq-text'), autoeqFile: $('autoeq-file'),
  btnFit: $('btn-fit'), fitNote: $('fit-note'),
  fitStats: $('fit-stats'), fitRms: $('fit-rms'), fitMax: $('fit-max'),
  legendTarget: $('legend-target'),
};

if (!navigator.bluetooth) $('unsupported').hidden = false;

const guide = $('connect-guide');
const guideContinue = $('guide-continue');
const guideCancel = $('guide-cancel');
const guideDontShow = $('guide-dont-show');

/* -------------------------------- log ----------------------------------- */

function log(text, cls = 't-dim') {
  const line = document.createElement('div');
  line.className = cls;
  const time = new Date().toTimeString().slice(0, 8);
  line.textContent = `${time}  ${text}`;
  els.log.appendChild(line);
  while (els.log.childElementCount > 200) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
}
els.btnClearLog.addEventListener('click', () => { els.log.textContent = ''; });

/* ------------------------------ band UI ---------------------------------- */

const bandEls = [];

function fmtFreq(f) { return f >= 1000 ? `${(f / 1000).toFixed(1).replace('.0', '')}k` : `${f}`; }
function fmtDb(v) { return `${v > 0 ? '+' : ''}${v.toFixed(1)}`; }

function buildBands() {
  for (let i = 0; i < 10; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'band';
    wrap.innerHTML = `
      <span class="band-db">0.0</span>
      <input type="range" class="band-slider" min="${-GAIN_LIMIT}" max="${GAIN_LIMIT}"
             step="0.1" value="0" aria-label="Gain at ${BAND_FREQS[i]} Hz">
      <span class="band-freq">${fmtFreq(BAND_FREQS[i])}</span>
      <input type="number" class="band-q" min="${Q_MIN}" max="${Q_MAX}" step="0.1"
             value="${DEFAULT_QS[i].toFixed(1)}" aria-label="Q at ${BAND_FREQS[i]} Hz">
      <span class="band-q-label">Q</span>`;
    const db = wrap.querySelector('.band-db');
    const slider = wrap.querySelector('.band-slider');
    const qIn = wrap.querySelector('.band-q');
    slider.addEventListener('input', () => {
      state.gains[i] = parseFloat(slider.value);
      db.textContent = fmtDb(state.gains[i]);
      db.classList.toggle('pos', state.gains[i] > 0.05);
      scheduleDraw();
    });
    qIn.addEventListener('change', () => {
      let q = parseFloat(qIn.value);
      if (!Number.isFinite(q)) q = DEFAULT_QS[i];
      q = Math.min(Q_MAX, Math.max(Q_MIN, Math.round(q * 10) / 10));
      qIn.value = q.toFixed(1);
      state.qs[i] = q;
      scheduleDraw();
    });
    els.bands.appendChild(wrap);
    bandEls.push({ db, slider, qIn });
  }
}

function syncBandUI() {
  for (let i = 0; i < 10; i++) {
    bandEls[i].slider.value = state.gains[i].toFixed(1);
    bandEls[i].db.textContent = fmtDb(state.gains[i]);
    bandEls[i].db.classList.toggle('pos', state.gains[i] > 0.05);
    bandEls[i].qIn.value = state.qs[i].toFixed(1);
  }
  scheduleDraw();
}

function setEq(gains, qs) {
  state.gains = gains.map(g => Math.round(g * 10) / 10);
  state.qs = qs.map(q => Math.round(q * 10) / 10);
  syncBandUI();
}

/* ------------------------------ curve ------------------------------------ */

let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

const CURVE_FREQS = Float64Array.from({ length: 240 },
  (_, i) => 20 * Math.pow(1000, i / 239));

function draw() {
  const cv = els.curve;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr; cv.height = h * dpr;
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const DB_MAX = 15;
  const x = f => pad.l + pw * (Math.log10(f) - Math.log10(20)) / 3;
  const y = db => pad.t + ph * (1 - (db + DB_MAX) / (2 * DB_MAX));

  const css = getComputedStyle(document.documentElement);
  const cBorder = css.getPropertyValue('--border').trim();
  const cFaint = css.getPropertyValue('--text-faint').trim();
  const cAccent = css.getPropertyValue('--accent').trim();

  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';

  // dB gridlines
  ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
  for (const db of [-12, -6, 0, 6, 12]) {
    ctx.beginPath();
    ctx.moveTo(pad.l, Math.round(y(db)) + 0.5);
    ctx.lineTo(w - pad.r, Math.round(y(db)) + 0.5);
    ctx.globalAlpha = db === 0 ? 0.9 : 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = cFaint; ctx.textAlign = 'right';
    ctx.fillText(`${db > 0 ? '+' : ''}${db}`, pad.l - 6, y(db) + 3);
  }
  // frequency ticks
  ctx.textAlign = 'center';
  for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    ctx.fillStyle = cFaint;
    ctx.fillText(fmtFreq(f), x(f), h - 6);
    ctx.strokeStyle = cBorder; ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(f)) + 0.5, pad.t);
    ctx.lineTo(Math.round(x(f)) + 0.5, pad.t + ph);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // target curve (imported AutoEQ)
  if (state.target) {
    ctx.strokeStyle = cFaint; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let i = 0; i < FIT_FREQS.length; i++) {
      const px = x(FIT_FREQS[i]), py = y(state.target[i]);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // current response
  const resp = bandResponse(state.gains, state.qs, CURVE_FREQS);
  ctx.beginPath();
  for (let i = 0; i < CURVE_FREQS.length; i++) {
    const px = x(CURVE_FREQS[i]), py = y(resp[i]);
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.strokeStyle = cAccent; ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // fill under curve
  ctx.lineTo(x(20000), y(0)); ctx.lineTo(x(20), y(0)); ctx.closePath();
  ctx.fillStyle = 'rgba(232,163,61,0.07)';
  ctx.fill();

  // band markers
  for (let i = 0; i < 10; i++) {
    const dbNow = bandResponse(state.gains, state.qs, Float64Array.of(BAND_FREQS[i]))[0];
    ctx.beginPath();
    ctx.arc(x(BAND_FREQS[i]), y(dbNow), 3, 0, Math.PI * 2);
    ctx.fillStyle = cAccent; ctx.fill();
    ctx.strokeStyle = '#0c0d10'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

addEventListener('resize', scheduleDraw);

/* ---------------------------- bluetooth ---------------------------------- */

function setConnUi(connected, label) {
  state.connected = connected;
  els.connDot.className = 'dot' + (connected ? ' on' : '');
  els.connLabel.textContent = label;
  for (const b of [els.btnRead, els.btnPreview, els.btnSave]) b.disabled = !connected;
  els.btnConnect.textContent = connected ? 'Disconnect' : 'Connect';
}

els.btnConnect.addEventListener('click', () => {
  if (state.connected) { state.device?.gatt?.disconnect(); return; }
  if (localStorage.getItem('tozo-eq.skipGuide') === '1') { beginConnect(); return; }
  guideDontShow.checked = false;
  guide.showModal();
});

guideCancel.addEventListener('click', () => guide.close());
guideContinue.addEventListener('click', () => {
  if (guideDontShow.checked) localStorage.setItem('tozo-eq.skipGuide', '1');
  guide.close();
  beginConnect();
});

async function beginConnect() {
  try {
    const opts = els.chkAll.checked
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : { filters: [{ namePrefix: 'TOZO' }], optionalServices: [SERVICE_UUID] };
    log('opening device chooser…');
    const device = await navigator.bluetooth.requestDevice(opts);
    state.device = device;
    device.addEventListener('gattserverdisconnected', () => {
      setConnUi(false, 'not connected');
      log('disconnected', 't-err');
    });
    setConnUi(false, `connecting ${device.name || device.id.slice(0, 8)}…`);
    const gatt = await device.gatt.connect();
    const svc = await gatt.getPrimaryService(SERVICE_UUID);
    state.writeChar = await svc.getCharacteristic(WRITE_UUID);
    const notifyChar = await svc.getCharacteristic(NOTIFY_UUID);
    notifyChar.addEventListener('characteristicvaluechanged', ev => {
      onNotify(new Uint8Array(ev.target.value.buffer));
    });
    await notifyChar.startNotifications();
    setConnUi(true, device.name || device.id.slice(0, 8));
    log(`connected to ${device.name || device.id}`, 't-ok');
    const fw = await request(CMD_GET_FW, CMD_GET_FW, 4000);
    if (fw) log(`firmware: ${hex(fw.payload)}`);
    await readEq(false);
  } catch (e) {
    if (e.name !== 'NotFoundError') {   // user cancelled chooser
      setConnUi(false, 'connection failed');
      log(`connect failed: ${e.message}`, 't-err');
    } else log('device chooser cancelled');
  }
}

function onNotify(data) {
  log(`<< ${hex(data)}`, 't-rx');
  const parsed = parseResponse(data);
  if (!parsed) { log('frame failed checksum/length check', 't-err'); return; }
  const wakers = state.pending.splice(0);
  for (const w of wakers) w(parsed);
}

function request(cmd, expectCmd, timeout = 5000, payload = new Uint8Array()) {
  return new Promise(resolve => {
    const frame = buildFrame(cmd, payload);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.pending = state.pending.filter(f => f !== deliver);
      resolve(null);
    }, timeout);
    function deliver(parsed) {
      if (settled) return;
      if (expectCmd && (parsed.cmd[0] !== expectCmd[0] || parsed.cmd[1] !== expectCmd[1])) return;
      settled = true;
      clearTimeout(timer);
      resolve(parsed);
    }
    state.pending.push(deliver);
    log(`>> ${hex(frame)}`, 't-tx');
    state.writeChar.writeValueWithoutResponse(frame).catch(e => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
      log(`write failed: ${e.message}`, 't-err');
    });
  });
}

/* ------------------------------ EQ actions -------------------------------- */

async function readEq(announce = true) {
  const r = await request(CMD_GET_EQ, CMD_GET_EQ);
  if (!r) { log('no EQ response', 't-err'); return; }
  if (r.payload.length < 20) { log('short EQ payload', 't-err'); return; }
  const { gains, qs } = decodeEqPayload(r.payload);
  setEq(gains, qs);
  log(`read EQ: ${gains.map(fmtDb).join(' ')}`, 't-ok');
  if (announce) log('note: readback lags the most recent write by one step');
}

async function writeEq(save) {
  const payload = eqPayload(state.gains, state.qs, save);
  const r = await request(CMD_SET_EQ, CMD_SET_EQ, 5000, payload);
  if (!r) { log('no ack — write may have failed', 't-err'); return false; }
  const status = r.payload[0];
  if (status === 0) {
    log(save ? 'saved to buds' : 'applied (volatile)', 't-ok');
    return true;
  }
  log(`device rejected write (status ${status})`, 't-err');
  return false;
}

els.btnRead.addEventListener('click', () => readEq(true));
els.btnPreview.addEventListener('click', () => writeEq(false));

let saveArmed = false, saveTimer = null;
els.btnSave.addEventListener('click', () => {
  if (!saveArmed) {
    saveArmed = true;
    els.btnSave.classList.add('confirm');
    els.btnSave.textContent = 'Confirm save?';
    saveTimer = setTimeout(() => {
      saveArmed = false;
      els.btnSave.classList.remove('confirm');
      els.btnSave.textContent = 'Save to buds';
    }, 3500);
    return;
  }
  clearTimeout(saveTimer);
  saveArmed = false;
  els.btnSave.classList.remove('confirm');
  els.btnSave.textContent = 'Save to buds';
  writeEq(true);
});

els.btnFlat.addEventListener('click', () => {
  state.target = null;
  els.legendTarget.hidden = true;
  els.fitStats.hidden = true;
  setEq(PROFILES['Flat'].gains, PROFILES['Flat'].qs);
});

/* ------------------------------- presets ---------------------------------- */

for (const [name, p] of Object.entries(PROFILES)) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.textContent = name;
  chip.addEventListener('click', () => {
    setEq(p.gains, p.qs);
    els.presets.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
  });
  els.presets.appendChild(chip);
}

/* ----------------------------- AutoEQ import ------------------------------- */

function showFitNote(text, isErr = false) {
  els.fitNote.hidden = false;
  els.fitNote.textContent = text;
  els.fitNote.classList.toggle('err', isErr);
}

els.autoeqFile.addEventListener('change', async () => {
  const f = els.autoeqFile.files?.[0];
  if (!f) return;
  els.autoeqText.value = await f.text();
  els.autoeqFile.value = '';
  log(`loaded file ${f.name}`);
});

els.btnFit.addEventListener('click', async () => {
  const text = els.autoeqText.value.trim();
  if (!text) { showFitNote('paste an EQ block or choose a file first', true); return; }
  els.btnFit.disabled = true;
  els.btnFit.textContent = 'Fitting…';
  await new Promise(r => setTimeout(r, 30));   // let the UI repaint
  try {
    const target = parseAutoeq(text);
    const fit = fitEq(target);
    state.target = target;
    els.legendTarget.hidden = false;
    setEq(fit.gains, fit.qs);
    els.fitStats.hidden = false;
    els.fitRms.textContent = `fit ${fit.rms.toFixed(2)} dB rms`;
    els.fitMax.textContent = `${fit.max.toFixed(2)} dB max`;
    showFitNote(`fitted — ${fit.rms.toFixed(2)} dB rms / ${fit.max.toFixed(2)} dB max error. ` +
      'Preview first, then save if you like it.');
    log(`autoeq fit: ${fit.gains.map(fmtDb).join(' ')}`, 't-ok');
  } catch (e) {
    showFitNote(e.message, true);
    log(`fit failed: ${e.message}`, 't-err');
  } finally {
    els.btnFit.disabled = false;
    els.btnFit.textContent = 'Fit curve';
  }
});

/* -------------------------------- init ------------------------------------ */

buildBands();
syncBandUI();
draw();
log('ready — connect your buds (close the TOZO app first)');
