import { cutoutFrame, grabFrame } from './processor.js';
import { detectKeyColor, rgbToHex } from './keyer.js';
import { loadSegmenter } from './segmenter.js';
import { buildSticker, DPI } from './sticker.js';
import { SHEETS, packSheets, usableArea } from './layout.js';
import { pngWithDpi, download, zipFiles, recordWebm } from './export.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);
const state = {
  screen: 'source',
  mode: 'upload', // 'upload' | 'live'
  frames: [], // { id, raw: Blob, cut: {canvas,bbox,srcW,srcH}|null, cutPng: Blob|null, include, thumb }
  nextId: 1,
  srcW: 0, srcH: 0,
  stream: null,
  cancel: false,
  busy: false,
  phase: 'idle', // live capture: 'idle' | 'countdown' | 'recording' | 'processing'
  stickers: null,
  layout: null,
  storageOk: true,
};
const STAGE_SCREENS = new Set(['source', 'cutout', 'capture']);

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 2) => Number(n).toFixed(d);
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const canvasToBlob = (c, type = 'image/jpeg', q = 0.92) => new Promise((r) => c.toBlob(r, type, q));
async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}
function confirmDialog(title, text, okLabel = 'Delete') {
  const dlg = $('confirmDlg');
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
}

// ---------- settings (persisted) ----------
const SETTING_IDS = [
  'keyColor', 'tolerance', 'softness', 'spill', 'choke', 'procRes', 'cleanSpecks', 'mirror', 'livePreview',
  'fps', 'countdown', 'recordSecs', 'preset', 'customW', 'customH', 'orientation', 'figureH', 'borderW', 'gap',
  'margin', 'borderColor', 'fillHoles', 'badgeShow', 'badgeCorner', 'badgeSize', 'badgeColor', 'playBg', 'soundCues',
];
function readSettings() {
  const s = { method: radio('method'), srcMode: radio('srcMode'), screen: state.screen };
  for (const id of SETTING_IDS) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  return s;
}
function applySettings(s) {
  if (!s) return;
  for (const id of SETTING_IDS) {
    const el = $(id);
    if (!(id in s) || !el) continue;
    if (el.type === 'checkbox') el.checked = !!s[id];
    else {
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === String(s[id]))) addOption(el, s[id]);
      el.value = s[id];
    }
    const out = document.querySelector(`output[for="${id}"]`);
    if (out) out.textContent = el.value;
  }
  setRadio('method', s.method);
  setRadio('srcMode', s.srcMode);
}
const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
function setRadio(name, v) {
  const el = v && document.querySelector(`input[name="${name}"][value="${v}"]`);
  if (el) el.checked = true;
}
function addOption(sel, v) {
  const o = document.createElement('option');
  o.value = v; o.textContent = `${v} fps`;
  sel.appendChild(o);
}
const saveSettings = debounce(() => store.setKV('settings', readSettings()), 300);
document.addEventListener('input', (e) => { if (e.target.closest('.app')) saveSettings(); });
document.addEventListener('change', (e) => { if (e.target.closest('.app')) saveSettings(); });

function cutSettings() {
  return {
    method: radio('method'),
    keyColor: $('keyColor').value,
    tolerance: +$('tolerance').value,
    softness: +$('softness').value,
    spill: +$('spill').value,
    choke: +$('choke').value,
    cleanSpecks: $('cleanSpecks').checked,
  };
}
function sheetSettings() {
  const key = $('preset').value;
  const preset = key === 'custom'
    ? { ...SHEETS.custom, w: +$('customW').value || 4, h: +$('customH').value || 6 }
    : SHEETS[key];
  return {
    preset,
    orientation: $('orientation').value,
    figureH: Math.max(0.2, +$('figureH').value || 1.5),
    borderW: Math.max(0, +$('borderW').value || 0),
    gap: Math.max(0, +$('gap').value || 0),
    margin: Math.max(0, +$('margin').value || 0),
    borderColor: $('borderColor').value,
    fillHoles: $('fillHoles').checked,
    badge: {
      show: $('badgeShow').checked,
      corner: $('badgeCorner').value,
      sizeIn: +$('badgeSize').value || 0.14,
      color: $('badgeColor').value,
    },
  };
}
const procRes = () => +$('procRes').value;
const fps = () => +$('fps').value;

// ---------- save indicator ----------
let pending = 0;
async function persistOp(p) {
  pending++;
  $('saveState').textContent = 'Saving…';
  $('saveState').classList.add('saving');
  const r = await p;
  pending--;
  if (!pending) {
    $('saveState').textContent = state.storageOk ? 'Saved' : 'Not saved';
    $('saveState').classList.remove('saving');
  }
  return r;
}
async function saveFrame(f) {
  return persistOp(store.putFrame({
    id: f.id, raw: f.raw, cutPng: f.cutPng, include: f.include,
    bbox: f.cut?.bbox || null, srcW: f.cut?.srcW || state.srcW, srcH: f.cut?.srcH || state.srcH, area: f.cut?.area || 0,
  }));
}

// ---------- navigation ----------
function go(screen) {
  state.screen = screen;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('hidden', s.dataset.screen !== screen));
  document.querySelectorAll('.tabbar [data-go]').forEach((b) => b.setAttribute('aria-selected', b.dataset.go === screen));
  const withStage = STAGE_SCREENS.has(screen);
  document.body.classList.toggle('with-stage', withStage);
  $('stage').classList.toggle('hidden', !withStage);
  if (withStage && state.mode === 'live' && state.stream && !liveLoopOn) liveLoop();
  if (screen === 'sheets' && !state.stickers && included().length) rebuildSheets();
  if (screen === 'frames') drawFirstFrame();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  saveSettings();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((el) => el.classList.toggle('hidden', el.dataset.mode !== mode));
  $('scrubber').classList.toggle('hidden', mode !== 'upload' || !video.duration || !!images);
  if (mode === 'upload') {
    stopCamera();
    if (video.duration) previewUploadFrame();
    else if (!images) clearStage();
  } else if (!state.stream) {
    clearStage('Tap “Start camera”');
  } else if (!liveLoopOn) liveLoop();
  updateEstimate();
}
document.querySelectorAll('input[name="srcMode"]').forEach((r) => r.addEventListener('change', () => setMode(radio('srcMode'))));

function clearStage(msg = 'Add a video or start the camera') {
  previewSource = null;
  for (const id of ['origCanvas', 'cutCanvas']) {
    const c = $(id);
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }
  $('stageEmpty').textContent = msg;
  $('stageEmpty').classList.remove('hidden');
}

// ---------- cutout preview ----------
let previewSource = null;
let previewBusy = false;
let playing = false;
async function renderPreview(srcCanvas) {
  previewSource = srcCanvas;
  $('stageEmpty').classList.add('hidden');
  const orig = $('origCanvas');
  orig.width = srcCanvas.width; orig.height = srcCanvas.height;
  orig.getContext('2d').drawImage(srcCanvas, 0, 0);
  const work = document.createElement('canvas');
  work.width = srcCanvas.width; work.height = srcCanvas.height;
  work.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0);
  const cut = $('cutCanvas');
  try {
    const res = await cutoutFrame(work, cutSettings());
    cut.width = srcCanvas.width; cut.height = srcCanvas.height;
    const ctx = cut.getContext('2d');
    if (res) ctx.drawImage(res.canvas, res.bbox.x, res.bbox.y);
  } catch (e) {
    reportAiError(e);
  }
}
const refreshPreview = debounce(async () => {
  if (state.mode === 'live' && state.stream) return; // live loop handles it
  if (!previewSource || previewBusy) return;
  previewBusy = true;
  await renderPreview(previewSource);
  previewBusy = false;
}, 120);

function reportAiError(e) {
  console.error(e);
  $('aiStatus').textContent = 'Couldn’t load the AI model. It needs internet the first time. The green screen key still works offline.';
  $('aiStatus').classList.add('warn');
}

$('origCanvas').addEventListener('click', (e) => {
  if (!previewSource) return;
  const c = $('origCanvas');
  const r = c.getBoundingClientRect();
  // Canvas uses object-fit: contain; map the click into the drawn image area.
  const k = Math.min(r.width / c.width, r.height / c.height);
  const ox = (r.width - c.width * k) / 2, oy = (r.height - c.height * k) / 2;
  const x = Math.round((e.clientX - r.left - ox) / k);
  const y = Math.round((e.clientY - r.top - oy) / k);
  if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
  const d = c.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++; }
  $('keyColor').value = rgbToHex([rs / n, gs / n, bs / n]);
  if (radio('method') === 'ai') setRadio('method', 'key');
  syncMethodUI();
  refreshPreview();
  saveSettings();
  toast(`Key colour set to ${$('keyColor').value}`);
});
$('autoKey').addEventListener('click', () => {
  if (!previewSource) return toast('Add a video or start the camera first.');
  const c = $('origCanvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  $('keyColor').value = rgbToHex(detectKeyColor(d, c.width, c.height));
  refreshPreview();
  saveSettings();
  toast(`Detected backdrop colour ${$('keyColor').value}`);
});

function syncMethodUI() {
  const m = radio('method');
  $('keyControls').classList.toggle('hidden', m === 'ai');
  const st = $('aiStatus');
  st.classList.remove('warn');
  if (m !== 'key') {
    st.textContent = 'Loading AI person segmentation…';
    loadSegmenter()
      .then(() => { st.textContent = 'AI segmentation ready. It runs on your device.'; refreshPreview(); })
      .catch(reportAiError);
  } else st.textContent = '';
}
document.querySelectorAll('input[name="method"]').forEach((r) => r.addEventListener('change', () => { syncMethodUI(); refreshPreview(); }));
['keyColor', 'tolerance', 'softness', 'spill', 'choke', 'cleanSpecks', 'procRes'].forEach((id) => {
  const el = $(id);
  el.addEventListener('input', () => {
    const out = document.querySelector(`output[for="${id}"]`);
    if (out) out.textContent = el.value;
    if (id === 'procRes' && state.mode === 'upload') previewUploadFrame();
    else refreshPreview();
  });
});

// ---------- upload ----------
const video = $('video');
let images = null;
async function loadFiles(files) {
  if (!files.length) return;
  if (state.mode !== 'upload') { setRadio('srcMode', 'upload'); setMode('upload'); }
  if (files[0].type.startsWith('image/')) {
    images = files.filter((f) => f.type.startsWith('image/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    video.removeAttribute('src');
    $('scrubber').classList.add('hidden');
    $('fileName').textContent = `${images.length} photo${images.length > 1 ? 's' : ''}`;
    $('extractBtn').disabled = false;
    $('extractBtn').textContent = `Cut out ${images.length} photo${images.length > 1 ? 's' : ''}`;
    renderPreview(grabFrame(await createImageBitmap(images[0]), procRes()));
    updateEstimate();
    return;
  }
  images = null;
  $('fileName').textContent = files[0].name;
  $('extractBtn').textContent = 'Extract & cut out frames';
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(files[0]);
}
$('videoFile').addEventListener('change', (e) => loadFiles([...e.target.files]));
const dz = $('dropzone');
['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', (e) => loadFiles([...e.dataTransfer.files]));

video.addEventListener('loadedmetadata', () => {
  $('trimStart').value = 0;
  $('trimEnd').value = fmt(video.duration, 1);
  $('trimStart').max = $('trimEnd').max = video.duration;
  $('extractBtn').disabled = false;
  $('scrubber').classList.remove('hidden');
  video.currentTime = Math.min(0.5, video.duration / 2);
  updateEstimate();
  toast('Video loaded. Tune the cutout next.');
});
video.addEventListener('error', () => toast('This video format isn’t supported by your browser. Try MP4 or WebM.', 5000));
video.addEventListener('seeked', () => {
  $('timeLabel').textContent = `${fmt(video.currentTime, 1)} s`;
  if (!state.busy) {
    $('scrub').value = Math.round((video.currentTime / video.duration) * 1000);
    previewUploadFrame();
  }
});
$('scrub').addEventListener('input', () => {
  if (!video.duration || state.busy) return;
  video.currentTime = ($('scrub').value / 1000) * video.duration;
});
function previewUploadFrame() {
  if (state.mode !== 'upload' || !video.videoWidth || images) return;
  previewSource = grabFrame(video, procRes());
  refreshPreview();
}
$('setStart').addEventListener('click', () => { $('trimStart').value = fmt(video.currentTime, 1); updateEstimate(); });
$('setEnd').addEventListener('click', () => { $('trimEnd').value = fmt(video.currentTime, 1); updateEstimate(); });
['trimStart', 'trimEnd', 'fps', 'recordSecs'].forEach((id) => $(id).addEventListener('input', updateEstimate));

function seekTo(t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

function setProgress(v, label) {
  $('progressRow').classList.remove('hidden');
  $('progress').value = v;
  $('progressLabel').textContent = label || '';
}
const hideProgress = () => $('progressRow').classList.add('hidden');

$('extractBtn').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true; state.cancel = false;
  $('extractBtn').disabled = true;
  const settings = cutSettings();
  const before = state.frames.length;
  try {
    if (images) {
      for (let i = 0; i < images.length && !state.cancel; i++) {
        const c = grabFrame(await createImageBitmap(images[i]), procRes());
        renderPreview(c);
        await addFrame(c, settings);
        setProgress((i + 1) / images.length, `${i + 1} / ${images.length}`);
      }
    } else {
      video.pause();
      const start = +$('trimStart').value || 0;
      const end = Math.min(video.duration, +$('trimEnd').value || video.duration);
      const step = 1 / fps();
      const times = [];
      for (let t = start; t < end - 1e-3; t += step) times.push(t);
      for (let i = 0; i < times.length && !state.cancel; i++) {
        await seekTo(times[i]);
        const c = grabFrame(video, procRes());
        if (i % 3 === 0) renderPreview(c);
        await addFrame(c, settings);
        setProgress((i + 1) / times.length, `${i + 1} / ${times.length}`);
      }
    }
    const made = state.frames.length - before;
    toast(state.cancel ? `Stopped after ${made} frames.` : `Done: ${made} frames cut out.`);
    if (!state.cancel && made) go('frames');
  } catch (e) {
    console.error(e);
    toast('Something went wrong while extracting: ' + e.message, 5000);
  } finally {
    state.busy = false;
    $('extractBtn').disabled = false;
    hideProgress();
    rebuildSheets();
  }
});
$('cancelBtn').addEventListener('click', () => { state.cancel = true; });

async function addFrame(srcCanvas, settings, raw = null) {
  raw = raw || (await canvasToBlob(srcCanvas));
  const work = document.createElement('canvas');
  work.width = srcCanvas.width; work.height = srcCanvas.height;
  work.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0);
  let res = null;
  try { res = await cutoutFrame(work, settings); } catch (e) { reportAiError(e); }
  const f = { id: state.nextId++, raw, cut: null, cutPng: null, include: !!res, thumb: null };
  state.srcW = srcCanvas.width; state.srcH = srcCanvas.height;
  state.frames.push(f);
  await setCut(f, res);
  saveFrame(f);
  renderFrames();
  return f;
}
/**
 * Stores a cutout as a compact PNG blob + metadata. We deliberately don't keep hundreds of canvases
 * alive: on phones the browser can silently drop canvas memory, which corrupts the stickers.
 */
async function setCut(f, res) {
  if (f.thumb) URL.revokeObjectURL(f.thumb);
  imgCache.delete(f.id);
  f.cut = res ? { bbox: res.bbox, srcW: res.srcW, srcH: res.srcH, area: res.area } : null;
  f.cutPng = res ? await canvasToBlob(res.canvas, 'image/png') : null;
  f.thumb = f.cutPng ? URL.createObjectURL(f.cutPng) : null;
}
const imgCache = new Map();
function frameImg(f) {
  let img = imgCache.get(f.id);
  if (!img) {
    img = new Image();
    img.src = f.thumb;
    imgCache.set(f.id, img);
  }
  return img;
}
async function preloadImgs(frames) {
  await Promise.all(frames.map((f) => frameImg(f).decode().catch(() => {})));
}

// ---------- live camera ----------
const cam = $('cam');
let liveLoopOn = false;
let wakeLock = null;
async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('camSelect');
  const cur = sel.value;
  sel.innerHTML = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('liveStatus').textContent = 'The camera isn’t available here. Open the app over https:// (or install it).';
    return;
  }
  stopCamera();
  const deviceId = $('camSelect').value;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (e) {
    $('liveStatus').textContent = 'Camera blocked or unavailable: ' + e.message;
    return;
  }
  cam.srcObject = state.stream;
  await cam.play();
  await listCameras();
  setPhase('idle', '● Start recording');
  $('camStart').textContent = 'Restart camera';
  $('liveStatus').textContent = 'Camera on. Step back so your whole body is in the frame.';
  if (!liveLoopOn) liveLoop();
}
function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  if (state.phase === 'countdown' || state.phase === 'recording') state.cancel = true;
  $('recordBtn').disabled = true;
  $('snapBtn').disabled = true;
  $('camStart').textContent = 'Start camera';
}
$('camStart').addEventListener('click', startCamera);
$('camSelect').addEventListener('change', () => state.stream && startCamera());

async function liveLoop() {
  liveLoopOn = true;
  while (state.stream && state.mode === 'live' && STAGE_SCREENS.has(state.screen) && !document.hidden) {
    if (state.phase === 'idle' || state.phase === 'countdown') {
      const c = grabFrame(cam, Math.min(480, procRes()), $('mirror').checked);
      // During the countdown show the plain camera (fast + smooth) so you can see yourself get in place.
      if ($('livePreview').checked && state.phase === 'idle') await renderPreview(c);
      else showRaw(c);
    }
    await sleep(state.phase === 'countdown' ? 16 : 30);
  }
  liveLoopOn = false;
}
function showRaw(c) {
  const o = $('origCanvas');
  o.width = c.width; o.height = c.height;
  o.getContext('2d').drawImage(c, 0, 0);
  previewSource = c;
  $('stageEmpty').classList.add('hidden');
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.stream && state.mode === 'live' && !liveLoopOn) liveLoop();
});

$('snapBtn').addEventListener('click', async () => {
  flash();
  beep(1320, 0.06);
  const c = grabFrame(cam, procRes(), $('mirror').checked);
  await addFrame(c, cutSettings());
  rebuildSheets();
  toast(`Frame ${state.frames.length} captured`);
});

// --- recording feedback: big on-screen overlay, button states, sound + vibration cues ---
let audioCtx = null;
function beep(freq = 880, dur = 0.12) {
  if (!$('soundCues').checked) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* audio is optional */ }
}
const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* optional */ } };
function flash() {
  const f = $('shutterFlash');
  f.classList.remove('go');
  void f.offsetWidth; // restart animation
  f.classList.add('go');
}
function overlay(phase, big = '', sub = '', progress = null) {
  const ov = $('recOverlay');
  ov.className = 'rec-overlay' + (phase ? ` show ${phase}` : '');
  $('ovBig').textContent = big;
  $('ovSub').textContent = sub;
  $('ovBar').style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
  $('ovBarWrap').classList.toggle('hidden', progress == null);
}
function setPhase(phase, label) {
  state.phase = phase;
  const btn = $('recordBtn');
  btn.dataset.phase = phase;
  btn.disabled = phase === 'processing' || !state.stream;
  btn.textContent = label;
  $('snapBtn').disabled = phase !== 'idle' || !state.stream;
  $('recDot').classList.toggle('hidden', phase !== 'recording');
}

$('recordBtn').addEventListener('click', async () => {
  if (state.phase === 'countdown' || state.phase === 'recording') { state.cancel = true; return; }
  if (state.phase !== 'idle') return;
  const secs = +$('recordSecs').value || 5;
  const count = Math.max(0, Math.round(+$('countdown').value || 0));
  const rate = fps();
  const total = Math.round(secs * rate);
  state.cancel = false;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  $('stage').scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 1) Countdown — nothing is captured yet, and the screen says so.
  for (let i = count; i > 0 && !state.cancel; i--) {
    setPhase('countdown', `Starting in ${i}… (tap to cancel)`);
    overlay('countdown', String(i), 'Get in position. Not recording yet.');
    beep(660, 0.12);
    buzz(40);
    await sleep(1000);
  }
  if (state.cancel) return finishRecording(0, []);

  // 2) Recording — fixed clock, grab only (no heavy processing), so snaps are evenly spaced.
  setPhase('recording', '■ Stop recording');
  overlay('recording', 'GO!', `Recording · 0 / ${total} photos`, 0);
  beep(1320, 0.25);
  buzz(120);
  const shots = [];
  const t0 = performance.now();
  for (let i = 0; i < total && !state.cancel; i++) {
    const wait = t0 + i * (1000 / rate) - performance.now();
    if (wait > 0) await sleep(wait);
    const c = grabFrame(cam, procRes(), $('mirror').checked);
    showRaw(c);
    // Keep just the compressed JPEG; free the full-size pixels right away (phones run out of memory).
    shots.push(canvasToBlob(c).then((b) => { c.width = c.height = 0; return b; }));
    flash();
    const left = Math.max(0, secs - (performance.now() - t0) / 1000);
    overlay('recording', `${fmt(left, 1)}s`, `Recording · ${i + 1} / ${total} photos`, (i + 1) / total);
    $('recordBtn').textContent = `■ Stop recording (${fmt(left, 1)} s left)`;
  }
  beep(520, 0.3);
  buzz([60, 60, 60]);
  await finishRecording(total, shots);
});

async function finishRecording(total, shots) {
  const settings = cutSettings();
  if (shots.length) {
    // 3) Processing — clearly separate from recording, with its own progress.
    setPhase('processing', `Cutting out 0 / ${shots.length}…`);
    overlay('processing', 'Done!', `Recording finished. Cutting out ${shots.length} photos…`, 0);
    for (let i = 0; i < shots.length; i++) {
      const blob = await shots[i];
      const c = await blobToCanvas(blob);
      await addFrame(c, settings, blob);
      c.width = c.height = 0;
      $('recordBtn').textContent = `Cutting out ${i + 1} / ${shots.length}…`;
      overlay('processing', `${i + 1}/${shots.length}`, 'Recording finished. Cutting out your photos…', (i + 1) / shots.length);
    }
  }
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  const stopped = state.cancel;
  state.cancel = false;
  overlay(null);
  setPhase('idle', '● Start recording');
  updateEstimate();
  rebuildSheets();
  if (!shots.length) { toast('Cancelled. Nothing was recorded.'); return; }
  toast(stopped ? `Stopped early: ${shots.length} of ${total} photos kept.` : `All done: ${shots.length} photos cut out.`);
  go('frames');
}

// ---------- estimate ----------
function updateEstimate() {
  const el = $('estimate');
  let n = 0, secs = 0;
  if (state.mode === 'upload') {
    if (images) n = images.length;
    else if (video.duration) {
      secs = Math.max(0, (+$('trimEnd').value || 0) - (+$('trimStart').value || 0));
      n = Math.ceil(secs * fps());
    }
  } else {
    secs = +$('recordSecs').value || 0;
    n = Math.round(secs * fps());
  }
  if (!n) { el.textContent = state.mode === 'upload' ? 'Add a video to see how many stickers it makes.' : 'Set a recording length to see the sticker count.'; return; }
  const per = estimatePerSheet();
  const sheets = Math.ceil(n / Math.max(1, per));
  el.innerHTML = `${secs ? `${fmt(secs, 1)} s × ${fps()} fps = ` : ''}<b>${n} stickers</b> → about <b>${sheets} sheet${sheets > 1 ? 's' : ''}</b> <span class="hint">(${per} per sheet at ${fmt(sheetSettings().figureH)} in tall)</span>`;
}
function estimatePerSheet() {
  const s = sheetSettings();
  if (state.layout?.perSheet) return state.layout.perSheet;
  const hIn = s.figureH + 2 * s.borderW;
  const wIn = s.figureH * 0.55 + 2 * s.borderW;
  return bestOrientation(Array(60).fill({ w: wIn * DPI, h: hIn * DPI }), s).perSheet;
}
function bestOrientation(items, s) {
  const opts = s.orientation === 'auto' ? ['portrait', 'landscape'] : [s.orientation];
  let best = null;
  for (const o of opts) {
    const area = usableArea(s.preset, o, s.margin);
    const sheets = packSheets(items, area.w * DPI, area.h * DPI, s.gap * DPI);
    const perSheet = sheets.length ? Math.max(...sheets.map((sh) => sh.placements.length)) : 0;
    const cand = { orientation: o, area, sheets, perSheet };
    if (!best || sheets.length < best.sheets.length || (sheets.length === best.sheets.length && perSheet > best.perSheet)) best = cand;
  }
  return best;
}

// ---------- frames gallery ----------
const included = () => state.frames.filter((f) => f.include && f.cut);

/**
 * Flags frames whose cutout size jumps compared with their neighbours. That's usually a glitchy mask
 * (missing chunks, or a patch of background left in) that would flicker in the animation.
 */
function oddFrames() {
  const list = included().filter((f) => f.cut.area > 0);
  const odd = new Set();
  if (list.length < 5) return odd;
  list.forEach((f, i) => {
    const near = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(list.length - 1, i + 3); j++) if (j !== i) near.push(list[j].cut.area);
    near.sort((a, b) => a - b);
    const med = near[near.length >> 1];
    const r = f.cut.area / med;
    if (r < 0.8 || r > 1.25) odd.add(f.id);
  });
  return odd;
}

function renderFrames() {
  const wrap = $('frames');
  wrap.innerHTML = '';
  if (!state.frames.length) {
    wrap.innerHTML = '<p class="empty">No frames yet. Go to <b>Capture</b> to make some.</p>';
  }
  let num = 0;
  const odd = oddFrames();
  const skipOdd = $('skipOddBtn');
  skipOdd.classList.toggle('hidden', !odd.size);
  skipOdd.textContent = `Skip ${odd.size} ⚠ frame${odd.size > 1 ? 's' : ''}`;
  const frag = document.createDocumentFragment();
  for (const f of state.frames) {
    const on = f.include && f.cut;
    if (on) num++;
    const b = document.createElement('button');
    b.className = 'frame' + (on ? '' : ' off') + (f.cut ? '' : ' empty-frame') + (odd.has(f.id) ? ' odd' : '');
    if (odd.has(f.id)) b.title = 'This cutout looks different from its neighbours (possible glitch)';
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!on));
    b.setAttribute('aria-label', on ? `Frame ${num}. Tap to skip.` : 'Skipped frame. Tap to include.');
    if (f.thumb) {
      const img = document.createElement('img');
      img.src = f.thumb; img.alt = ''; img.loading = 'lazy';
      b.appendChild(img);
    }
    const tag = document.createElement('span');
    tag.className = 'num';
    tag.textContent = on ? num : '–';
    b.appendChild(tag);
    b.addEventListener('click', () => {
      if (!f.cut) return toast('No person found in this frame. Adjust the cutout and tap Re-cut all.');
      f.include = !f.include;
      saveFrame(f);
      renderFrames();
      rebuildSheets();
    });
    frag.appendChild(b);
  }
  wrap.appendChild(frag);
  const inc = included().length;
  $('frameCount').textContent = state.frames.length ? `${inc} of ${state.frames.length} in use` : '';
  const badge = $('framesBadge');
  badge.textContent = inc;
  badge.classList.toggle('hidden', !inc);
  const has = state.frames.length > 0;
  ['reprocessBtn', 'includeAllBtn', 'clearBtn', 'everyOtherBtn'].forEach((id) => ($(id).disabled = !has || state.busy));
  $('playBtn').disabled = $('webmBtn').disabled = inc === 0;
  $('playCanvas').closest('.player').classList.toggle('hidden', inc === 0);
  if (state.screen === 'frames' && !playing) drawFirstFrame();
}

$('includeAllBtn').addEventListener('click', () => {
  state.frames.forEach((f) => { if (f.include !== !!f.cut) { f.include = !!f.cut; saveFrame(f); } });
  renderFrames();
  rebuildSheets();
});
$('skipOddBtn').addEventListener('click', () => {
  const odd = oddFrames();
  state.frames.forEach((f) => { if (odd.has(f.id)) { f.include = false; saveFrame(f); } });
  renderFrames();
  rebuildSheets();
  toast(`Skipped ${odd.size} glitchy frame${odd.size > 1 ? 's' : ''}. Tap one to bring it back.`);
});
$('everyOtherBtn').addEventListener('click', () => {
  // Drop every second sticker (e.g. 24 → 12 fps) and slow playback to match.
  included().forEach((f, i) => { if (i % 2 === 1) { f.include = false; saveFrame(f); } });
  const half = fps() / 2;
  const sel = $('fps');
  if (![...sel.options].some((o) => +o.value === half)) addOption(sel, half);
  sel.value = half;
  saveSettings();
  renderFrames();
  rebuildSheets();
  toast(`Halved: now ${included().length} stickers at ${half} fps.`);
});
$('clearBtn').addEventListener('click', async () => {
  if (!(await confirmDialog('Clear all frames?', 'This removes every captured frame from this device.', 'Clear'))) return;
  await clearAllFrames();
  toast('Frames cleared.');
});
async function clearAllFrames() {
  state.frames.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb));
  state.frames = [];
  state.nextId = 1;
  await persistOp(store.clearFrames());
  renderFrames();
  rebuildSheets();
}
$('reprocessBtn').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  renderFrames();
  const settings = cutSettings();
  for (let i = 0; i < state.frames.length; i++) {
    const f = state.frames[i];
    const c = await blobToCanvas(f.raw);
    let res = null;
    try { res = await cutoutFrame(c, settings); } catch (e) { reportAiError(e); }
    f.include = !!res;
    await setCut(f, res);
    saveFrame(f);
    setProgress((i + 1) / state.frames.length, `Re-cutting ${i + 1} / ${state.frames.length}`);
  }
  hideProgress();
  state.busy = false;
  renderFrames();
  rebuildSheets();
  toast('All frames re-cut.');
});

// ---------- animation preview ----------
function drawAnimFrame(ctx, f, bg) {
  const c = ctx.canvas;
  ctx.clearRect(0, 0, c.width, c.height);
  if (bg !== 'checker') { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  const img = frameImg(f);
  if (img.complete && img.naturalWidth) ctx.drawImage(img, f.cut.bbox.x, f.cut.bbox.y);
  else img.decode().then(() => !playing && drawFirstFrame()).catch(() => {});
}
function sizePlayCanvas() {
  const fr = included();
  const c = $('playCanvas');
  c.width = fr[0]?.cut.srcW || state.srcW || 320;
  c.height = fr[0]?.cut.srcH || state.srcH || 180;
  return c;
}
function drawFirstFrame() {
  const fr = included();
  if (!fr.length || playing) return;
  drawAnimFrame(sizePlayCanvas().getContext('2d'), fr[0], $('playBg').value);
}
$('playBg').addEventListener('change', drawFirstFrame);
$('playBtn').addEventListener('click', async () => {
  if (playing) { playing = false; return; }
  if (!included().length) return;
  playing = true;
  $('playBtn').textContent = '■ Stop';
  await preloadImgs(included());
  const ctx = sizePlayCanvas().getContext('2d');
  let i = 0;
  while (playing && included().length && state.screen === 'frames') {
    const list = included();
    drawAnimFrame(ctx, list[i % list.length], $('playBg').value);
    i++;
    await sleep(1000 / fps());
  }
  playing = false;
  $('playBtn').textContent = '▶ Play';
});
$('webmBtn').addEventListener('click', async () => {
  const fr = included();
  if (!fr.length) return;
  if (typeof MediaRecorder === 'undefined') return toast('Saving video isn’t supported in this browser.');
  $('webmBtn').disabled = true;
  toast('Recording preview…');
  const c = sizePlayCanvas();
  const bg = $('playBg').value === 'checker' ? '#ffffff' : $('playBg').value;
  try {
    await preloadImgs(fr);
    const blob = await recordWebm(c, fr.length, fps(), (ctx, i) => drawAnimFrame(ctx, fr[i], bg), fr.length < 24 ? 3 : 1);
    download(blob, `dance-preview-${fps()}fps.webm`);
  } catch (e) {
    toast('Couldn’t record video: ' + e.message, 4000);
  }
  $('webmBtn').disabled = false;
});

// ---------- sticker sheets ----------
function initPresets() {
  const sel = $('preset');
  sel.innerHTML = '';
  for (const [k, v] of Object.entries(SHEETS)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = v.label;
    sel.appendChild(o);
  }
  sel.value = 'stickerpix-pc';
}
function applyPreset(resetMargin) {
  const key = $('preset').value;
  const p = SHEETS[key];
  $('customSize').classList.toggle('hidden', key !== 'custom');
  $('presetNote').textContent = p.note;
  if (resetMargin) $('margin').value = p.margin;
}
$('preset').addEventListener('change', () => { applyPreset(true); state.layout = null; updateEstimate(); rebuildSheets(); });

async function buildAll() {
  const s = sheetSettings();
  const frames = included();
  if (!frames.length) return null;
  // One shared scale so the dancer is the same size on every sticker (essential for stop motion).
  const maxH = Math.max(...frames.map((f) => f.cut.bbox.h));
  const scale = (s.figureH * DPI) / maxH;
  const stickers = [];
  for (let i = 0; i < frames.length; i++) {
    const art = await blobToCanvas(frames[i].cutPng);
    const canvas = buildSticker({ canvas: art, bbox: frames[i].cut.bbox }, {
      scale,
      offsetPx: s.borderW * DPI,
      borderColor: s.borderColor,
      fillHoles: s.fillHoles,
      badge: {
        show: s.badge.show,
        number: i + 1,
        corner: s.badge.corner,
        radiusPx: (s.badge.sizeIn * DPI) / 2,
        color: s.badge.color,
        textColor: pickTextColor(s.badge.color),
      },
    });
    const blob = await canvasToBlob(canvas, 'image/png');
    const k = Math.min(1, 160 / canvas.height);
    const preview = document.createElement('canvas');
    preview.width = Math.max(1, Math.round(canvas.width * k));
    preview.height = Math.max(1, Math.round(canvas.height * k));
    preview.getContext('2d', { willReadFrequently: true }).drawImage(canvas, 0, 0, preview.width, preview.height);
    stickers.push({ blob, w: canvas.width, h: canvas.height, preview, number: i + 1 });
    art.width = art.height = canvas.width = canvas.height = 0; // free memory now
    if (i % 4 === 3) await sleep(0);
  }
  const layout = bestOrientation(stickers.map((st) => ({ w: st.w, h: st.h })), s);
  return { stickers, layout, settings: s };
}
function pickTextColor(hex) {
  const v = parseInt(hex.slice(1), 16);
  const l = 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255);
  return l > 150 ? '#111111' : '#ffffff';
}

let buildToken = 0;
const rebuildSheets = debounce(async () => {
  const token = ++buildToken;
  const stats = $('stats');
  const exportBtns = ['dlSheets', 'dlStickers', 'shareSheets'];
  if (!included().length) {
    state.stickers = null; state.layout = null;
    stats.textContent = 'No frames yet.';
    $('sheets').innerHTML = '';
    exportBtns.forEach((id) => ($(id).disabled = true));
    $('sheetsBadge').classList.add('hidden');
    updateEstimate();
    return;
  }
  stats.textContent = 'Building stickers…';
  const built = await buildAll();
  if (token !== buildToken || !built) return;
  state.stickers = built.stickers;
  state.layout = built.layout;
  renderSheets(built);
  updateEstimate();
}, 250);

async function renderSheetCanvas(built, sheet, { preview }) {
  const { area } = built.layout;
  const s = built.settings;
  const W = Math.round(area.w * DPI), H = Math.round(area.h * DPI);
  const c = document.createElement('canvas');
  if (preview) {
    const k = Math.min(280 / (area.sheetW * DPI), 380 / (area.sheetH * DPI));
    c.width = Math.round(area.sheetW * DPI * k);
    c.height = Math.round(area.sheetH * DPI * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#c9c9c9';
    const m = s.margin * DPI * k;
    ctx.strokeRect(m, m, W * k, H * k);
    ctx.setLineDash([]);
    for (const p of sheet.placements) {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 2;
      ctx.drawImage(built.stickers[p.index].preview, m + p.x * k, m + p.y * k, p.w * k, p.h * k);
      ctx.restore();
    }
    return c;
  }
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const p of sheet.placements) {
    const bmp = await createImageBitmap(built.stickers[p.index].blob);
    ctx.drawImage(bmp, p.x, p.y);
    bmp.close();
  }
  return c;
}

async function renderSheets(built) {
  const { layout } = built;
  const wrap = $('sheets');
  wrap.innerHTML = '';
  for (let i = 0; i < layout.sheets.length; i++) {
    const sh = layout.sheets[i];
    const fig = document.createElement('figure');
    fig.className = 'sheet';
    fig.appendChild(await renderSheetCanvas(built, sh, { preview: true }));
    const nums = sh.placements.map((p) => p.index + 1);
    const cap = document.createElement('figcaption');
    cap.textContent = `Sheet ${i + 1} · #${nums[0]}–${nums[nums.length - 1]}`;
    fig.appendChild(cap);
    wrap.appendChild(fig);
  }
  const oversize = layout.sheets.some((sh) => sh.placements.some((p) => p.oversize));
  const n = layout.sheets.length;
  $('stats').innerHTML =
    `<b>${built.stickers.length}</b> stickers · up to <b>${layout.perSheet}</b> per sheet · <b>${n}</b> sheet${n > 1 ? 's' : ''} ` +
    `<span class="hint">(${layout.orientation}, printable ${fmt(layout.area.w)} × ${fmt(layout.area.h)} in)</span>` +
    (oversize ? '<br><span class="warn">Some stickers are bigger than the sheet. Lower the dancer height.</span>' : '');
  ['dlSheets', 'dlStickers', 'shareSheets'].forEach((id) => ($(id).disabled = false));
  $('sheetsBadge').textContent = n;
  $('sheetsBadge').classList.remove('hidden');
}

['orientation', 'figureH', 'borderW', 'gap', 'margin', 'borderColor', 'fillHoles', 'badgeShow', 'badgeCorner', 'badgeSize', 'badgeColor', 'customW', 'customH']
  .forEach((id) => $(id).addEventListener('input', () => { state.layout = null; updateEstimate(); rebuildSheets(); }));

// ---------- downloads & share ----------
function contentBox(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? { w: 0, h: 0 } : { w: maxX - minX + 1, h: maxY - minY + 1 };
}

async function sheetFiles() {
  const built = { stickers: state.stickers, layout: state.layout, settings: sheetSettings() };
  const files = [];
  const lines = [
    'STICKER STOP — print files',
    `Machine/paper: ${built.settings.preset.label}`,
    `Orientation: ${built.layout.orientation}`,
    `Resolution: ${DPI} dpi PNG, transparent background (Cricut cuts around each sticker)`,
    `Frame rate: ${fps()} fps`,
    '',
    'In Design Space: Upload → Print Then Cut image → lock proportions → set the size below.',
    'If Design Space trims the empty edges on upload, use the "sticker area" size.',
    '',
  ];
  for (let i = 0; i < built.layout.sheets.length; i++) {
    const sh = built.layout.sheets[i];
    const c = await renderSheetCanvas(built, sh, { preview: false });
    const nums = sh.placements.map((p) => p.index + 1);
    const wIn = c.width / DPI, hIn = c.height / DPI;
    const box = contentBox(c);
    const name = `sheet-${String(i + 1).padStart(2, '0')}_frames-${nums[0]}-${nums[nums.length - 1]}_${fmt(wIn)}x${fmt(hIn)}in.png`;
    files.push({ name, blob: await pngWithDpi(c, DPI) });
    lines.push(`${name}\n   full image: ${fmt(wIn)} × ${fmt(hIn)} in   sticker area: ${fmt(box.w / DPI)} × ${fmt(box.h / DPI)} in   (${sh.placements.length} stickers)`);
    await sleep(0);
  }
  return { files, sizes: lines.join('\n') + '\n' };
}

$('dlSheets').addEventListener('click', async () => {
  if (!state.stickers) return;
  $('dlSheets').disabled = true;
  toast('Preparing print files…');
  try {
    const { files, sizes } = await sheetFiles();
    download(await zipFiles([...files, { name: 'SIZES.txt', text: sizes }]), `sticker-sheets-${files.length}.zip`);
  } finally {
    $('dlSheets').disabled = false;
  }
});

$('shareSheets').addEventListener('click', async () => {
  if (!state.stickers) return;
  $('shareSheets').disabled = true;
  try {
    const { files, sizes } = await sheetFiles();
    const shareFiles = files.map((f) => new File([f.blob], f.name, { type: 'image/png' }));
    await navigator.share({ files: shareFiles, title: 'Sticker sheets', text: sizes });
  } catch (e) {
    if (e.name !== 'AbortError') toast('Sharing failed: ' + e.message, 4000);
  } finally {
    $('shareSheets').disabled = false;
  }
});
{
  const probe = new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [probe] })) $('shareSheets').classList.remove('hidden');
}

$('dlStickers').addEventListener('click', async () => {
  if (!state.stickers) return;
  $('dlStickers').disabled = true;
  toast('Preparing stickers…');
  try {
    const files = [];
    const lines = ['Individual stickers (300 dpi, transparent PNG). Size in Design Space:'];
    for (const st of state.stickers) {
      const name = `sticker-${String(st.number).padStart(3, '0')}.png`;
      files.push({ name, blob: await pngWithDpi(st.blob, DPI) });
      lines.push(`${name}: ${fmt(st.w / DPI)} × ${fmt(st.h / DPI)} in`);
    }
    files.push({ name: 'SIZES.txt', text: lines.join('\n') + '\n' });
    download(await zipFiles(files), `stickers-${state.stickers.length}.zip`);
  } finally {
    $('dlStickers').disabled = false;
  }
});

// ---------- new project ----------
$('newProjectBtn').addEventListener('click', async () => {
  if (state.frames.length && !(await confirmDialog('Start a new project?', 'This removes all frames from this device. Your settings are kept.', 'Start new'))) return;
  await clearAllFrames();
  images = null;
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
  $('fileName').textContent = '';
  $('videoFile').value = '';
  $('extractBtn').disabled = true;
  $('scrubber').classList.add('hidden');
  stopCamera();
  setRadio('srcMode', 'upload');
  setMode('upload');
  go('source');
  toast('New project started.');
});

// ---------- install (PWA) ----------
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('installBtn').classList.remove('hidden');
});
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (isIOS && !standalone) $('installBtn').classList.remove('hidden');
$('installBtn').addEventListener('click', async () => {
  if (installEvt) {
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null;
    $('installBtn').classList.add('hidden');
  } else if (isIOS) {
    toast('In Safari, tap Share, then “Add to Home Screen”.', 5000);
  }
});
window.addEventListener('appinstalled', () => { $('installBtn').classList.add('hidden'); toast('Installed! Open Sticker Stop from your home screen.'); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
}

// ---------- restore & init ----------
async function restore() {
  const saved = await store.getKV('settings');
  if (saved === undefined) {
    // Either a first run or storage is unavailable; check which.
    state.storageOk = 'indexedDB' in window && (await store.setKV('ping', 1)) !== undefined;
  }
  applySettings(saved);
  applyPreset(false);
  const recs = await store.getFrames();
  for (const r of recs) {
    const f = { id: r.id, raw: r.raw, cut: null, cutPng: r.cutPng, include: r.include, thumb: null };
    if (r.cutPng && r.bbox) {
      f.cut = { bbox: r.bbox, srcW: r.srcW, srcH: r.srcH, area: r.area || 0 };
      f.thumb = URL.createObjectURL(r.cutPng);
      state.srcW = r.srcW; state.srcH = r.srcH;
    }
    state.frames.push(f);
    state.nextId = Math.max(state.nextId, r.id + 1);
  }
  if (recs.length) {
    store.persist();
    toast(`Welcome back. ${recs.length} frames restored.`);
  }
  return saved;
}

initPresets();
const saved = await restore();
syncMethodUI();
setMode(radio('srcMode') || 'upload');
renderFrames();
rebuildSheets();
go(saved?.screen && (saved.screen !== 'capture' || state.frames.length) ? saved.screen : 'source');
$('saveState').textContent = state.storageOk ? 'Saved' : 'Not saved';
// Exposed for automated tests / debugging.
window.__stickerStop = { state, rebuildSheets, addFrame, cutSettings, go };
