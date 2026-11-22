import { cutoutFrame, grabFrame } from './processor.js';
import { detectKeyColor, rgbToHex } from './keyer.js';
import { loadSegmenter } from './segmenter.js';
import { buildSticker, DPI } from './sticker.js';
import { SHEETS, packSheets, usableArea } from './layout.js';
import { pngWithDpi, download, zipFiles, recordWebm } from './export.js';

const $ = (id) => document.getElementById(id);
const state = {
  mode: 'upload',
  frames: [], // { id, raw: Blob, cut: {canvas,bbox,srcW,srcH}|null, include, thumb }
  nextId: 1,
  srcW: 0, srcH: 0,
  stream: null,
  cancel: false,
  busy: false,
  stickers: null, // cached built stickers [{canvas, frame}]
  layout: null,
};

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
const fmt = (n, d = 2) => Number(n).toFixed(d);

// ---------- settings ----------
function cutSettings() {
  return {
    method: document.querySelector('input[name="method"]:checked').value,
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

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', t === tab);
    });
    state.mode = tab.dataset.tab;
    document.querySelectorAll('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== state.mode));
    $('extractBtn').classList.toggle('hidden', state.mode !== 'upload');
    updateEstimate();
    if (state.mode === 'upload') previewUploadFrame();
  });
});

// ---------- cutout preview ----------
let playing = false;
let previewSource = null; // canvas holding the latest original frame
let previewBusy = false;
async function renderPreview(srcCanvas) {
  previewSource = srcCanvas;
  const orig = $('origCanvas');
  orig.width = srcCanvas.width; orig.height = srcCanvas.height;
  orig.getContext('2d').drawImage(srcCanvas, 0, 0);
  const work = document.createElement('canvas');
  work.width = srcCanvas.width; work.height = srcCanvas.height;
  work.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0);
  const cut = $('cutCanvas');
  cut.width = srcCanvas.width; cut.height = srcCanvas.height;
  const ctx = cut.getContext('2d');
  try {
    const res = await cutoutFrame(work, cutSettings());
    ctx.clearRect(0, 0, cut.width, cut.height);
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
  $('aiStatus').textContent = 'Could not load the AI model (needs an internet connection the first time). Green screen key still works offline.';
  $('aiStatus').classList.add('warn');
}

// Eyedropper on the original preview.
$('origCanvas').addEventListener('click', (e) => {
  const c = $('origCanvas');
  const r = c.getBoundingClientRect();
  const x = Math.round(((e.clientX - r.left) / r.width) * c.width);
  const y = Math.round(((e.clientY - r.top) / r.height) * c.height);
  const d = c.getContext('2d').getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++; }
  $('keyColor').value = rgbToHex([rs / n, gs / n, bs / n]);
  if (cutSettings().method === 'ai') document.querySelector('input[name="method"][value="key"]').checked = true;
  syncMethodUI();
  refreshPreview();
  toast(`Key colour set to ${$('keyColor').value}`);
});
$('autoKey').addEventListener('click', () => {
  const c = $('origCanvas');
  if (!previewSource) return toast('Load a video or start the camera first.');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  $('keyColor').value = rgbToHex(detectKeyColor(d, c.width, c.height));
  refreshPreview();
  toast(`Detected backdrop colour ${$('keyColor').value}`);
});

function syncMethodUI() {
  const m = cutSettings().method;
  $('keyControls').classList.toggle('hidden', m === 'ai');
  const st = $('aiStatus');
  st.classList.remove('warn');
  if (m !== 'key') {
    st.textContent = 'Loading AI person segmentation…';
    loadSegmenter()
      .then(() => { st.textContent = 'AI segmentation ready (runs on your device).'; refreshPreview(); })
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
let images = null; // batch of photos instead of a video
$('videoFile').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  if (files[0].type.startsWith('image/')) {
    images = files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    video.classList.add('hidden');
    $('trimRow').classList.add('hidden');
    $('extractBtn').disabled = false;
    $('extractBtn').textContent = `Cut out ${images.length} photo${images.length > 1 ? 's' : ''}`;
    const c = grabFrame(await createImageBitmap(images[0]), procRes());
    renderPreview(c);
    updateEstimate();
    return;
  }
  images = null;
  $('extractBtn').textContent = 'Extract & cut out frames';
  video.src = URL.createObjectURL(files[0]);
  video.classList.remove('hidden');
  $('trimRow').classList.remove('hidden');
});
video.addEventListener('loadedmetadata', () => {
  $('trimStart').value = 0;
  $('trimEnd').value = fmt(video.duration, 1);
  $('trimStart').max = $('trimEnd').max = video.duration;
  $('extractBtn').disabled = false;
  video.currentTime = Math.min(0.5, video.duration / 2);
  updateEstimate();
});
video.addEventListener('seeked', () => { if (!state.busy) previewUploadFrame(); });
video.addEventListener('pause', () => previewUploadFrame());
function previewUploadFrame() {
  if (state.mode !== 'upload' || !video.videoWidth || images) return;
  previewSource = grabFrame(video, procRes());
  refreshPreview();
}
$('setStart').addEventListener('click', () => { $('trimStart').value = fmt(video.currentTime, 1); updateEstimate(); });
$('setEnd').addEventListener('click', () => { $('trimEnd').value = fmt(video.currentTime, 1); updateEstimate(); });
['trimStart', 'trimEnd', 'fps'].forEach((id) => $(id).addEventListener('input', updateEstimate));

function seekTo(t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

$('extractBtn').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true; state.cancel = false;
  $('extractBtn').disabled = true;
  $('cancelBtn').classList.remove('hidden');
  const prog = $('progress');
  prog.classList.remove('hidden');
  const settings = cutSettings();
  try {
    if (images) {
      for (let i = 0; i < images.length && !state.cancel; i++) {
        const c = grabFrame(await createImageBitmap(images[i]), procRes());
        await addFrame(c, settings);
        prog.value = (i + 1) / images.length;
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
        prog.value = (i + 1) / times.length;
      }
    }
    toast(state.cancel ? 'Stopped.' : `Done — ${state.frames.length} frames.`);
  } catch (e) {
    console.error(e);
    toast('Something went wrong while extracting: ' + e.message, 5000);
  } finally {
    state.busy = false;
    $('extractBtn').disabled = false;
    $('cancelBtn').classList.add('hidden');
    prog.classList.add('hidden');
    rebuildSheets();
  }
});
$('cancelBtn').addEventListener('click', () => { state.cancel = true; });

async function addFrame(srcCanvas, settings) {
  const raw = await canvasToBlob(srcCanvas);
  const work = document.createElement('canvas');
  work.width = srcCanvas.width; work.height = srcCanvas.height;
  work.getContext('2d', { willReadFrequently: true }).drawImage(srcCanvas, 0, 0);
  let cut = null;
  try { cut = await cutoutFrame(work, settings); } catch (e) { reportAiError(e); }
  const f = { id: state.nextId++, raw, cut, include: !!cut, thumb: null };
  state.srcW = srcCanvas.width; state.srcH = srcCanvas.height;
  state.frames.push(f);
  await makeThumb(f);
  renderFrames();
  return f;
}
async function makeThumb(f) {
  if (f.thumb) URL.revokeObjectURL(f.thumb);
  f.thumb = f.cut ? URL.createObjectURL(await canvasToBlob(f.cut.canvas, 'image/png')) : null;
}

// ---------- live camera ----------
const cam = $('cam');
let liveLoopOn = false;
async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const sel = $('camSelect');
  const cur = sel.value;
  sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`).join('');
  if (cur) sel.value = cur;
}
async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('liveStatus').textContent = 'This browser can\'t access the camera here. Open the app over https:// or localhost.';
    return;
  }
  state.stream?.getTracks().forEach((t) => t.stop());
  const deviceId = $('camSelect').value;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (e) {
    $('liveStatus').textContent = 'Camera blocked or unavailable: ' + e.message;
    return;
  }
  cam.srcObject = state.stream;
  await cam.play();
  await listCameras();
  $('recordBtn').disabled = false;
  $('snapBtn').disabled = false;
  $('camStart').textContent = 'Restart camera';
  $('liveStatus').textContent = 'Camera on. Step back so your whole body is in frame.';
  if (!liveLoopOn) liveLoop();
}
$('camStart').addEventListener('click', startCamera);
$('camSelect').addEventListener('change', () => state.stream && startCamera());

async function liveLoop() {
  liveLoopOn = true;
  while (state.stream && state.mode === 'live') {
    if ($('livePreview').checked && !state.recording) {
      const c = grabFrame(cam, Math.min(480, procRes()), $('mirror').checked);
      await renderPreview(c);
    } else if (!state.recording) {
      const c = grabFrame(cam, 480, $('mirror').checked);
      const o = $('origCanvas');
      o.width = c.width; o.height = c.height;
      o.getContext('2d').drawImage(c, 0, 0);
      previewSource = c;
    }
    await sleep(30);
  }
  liveLoopOn = false;
}
document.querySelector('.tab[data-tab="live"]').addEventListener('click', () => { if (state.stream && !liveLoopOn) liveLoop(); });

$('snapBtn').addEventListener('click', async () => {
  const c = grabFrame(cam, procRes(), $('mirror').checked);
  await addFrame(c, cutSettings());
  rebuildSheets();
  toast(`Frame ${state.frames.length} captured`);
});

$('recordBtn').addEventListener('click', async () => {
  if (state.recording) { state.cancel = true; return; }
  const secs = +$('recordSecs').value || 5;
  const count = +$('countdown').value || 0;
  const status = $('liveStatus');
  const btn = $('recordBtn');
  state.cancel = false;
  for (let i = count; i > 0 && !state.cancel; i--) {
    status.textContent = `Get ready… ${i}`;
    await sleep(1000);
  }
  state.recording = true;
  btn.textContent = '■ Stop';
  const settings = cutSettings();
  const interval = 1000 / fps();
  const total = Math.round(secs * fps());
  const queue = [];
  // Capture on a fixed clock; cut out in the background so capture timing stays steady.
  let processing = Promise.resolve();
  const t0 = performance.now();
  for (let i = 0; i < total && !state.cancel; i++) {
    const target = t0 + i * interval;
    const wait = target - performance.now();
    if (wait > 0) await sleep(wait);
    const c = grabFrame(cam, procRes(), $('mirror').checked);
    queue.push(c);
    processing = processing.then(() => addFrame(c, settings));
    status.textContent = `Recording ${i + 1}/${total} · cutting out in background…`;
    const o = $('origCanvas');
    o.width = c.width; o.height = c.height;
    o.getContext('2d').drawImage(c, 0, 0);
  }
  state.recording = false;
  btn.textContent = '● Record & auto-cut';
  status.textContent = 'Finishing cutouts…';
  await processing;
  status.textContent = `Captured ${queue.length} frames.`;
  state.cancel = false;
  rebuildSheets();
});

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
  if (!n) { el.textContent = 'Load a video to see how many stickers it makes.'; return; }
  const per = estimatePerSheet();
  const sheets = Math.ceil(n / Math.max(1, per));
  el.innerHTML = `${secs ? `${fmt(secs, 1)} s × ${fps()} fps = ` : ''}<b>${n} stickers</b> → about <b>${sheets} sheet${sheets > 1 ? 's' : ''}</b> (${per} per sheet at ${fmt(sheetSettings().figureH)}" tall).`;
}
$('recordSecs').addEventListener('input', updateEstimate);

/** Stickers per sheet using real sticker sizes if we have them, else a typical dancer shape. */
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
function renderFrames() {
  const wrap = $('frames');
  wrap.innerHTML = '';
  let num = 0;
  for (const f of state.frames) {
    const b = document.createElement('button');
    b.className = 'frame' + (f.include && f.cut ? '' : ' off') + (f.cut ? '' : ' empty');
    b.type = 'button';
    if (f.include && f.cut) num++;
    b.setAttribute('aria-label', f.include && f.cut ? `Frame ${num}, click to skip` : 'Skipped frame, click to include');
    if (f.thumb) {
      const img = document.createElement('img');
      img.src = f.thumb; img.alt = '';
      b.appendChild(img);
    }
    const tag = document.createElement('span');
    tag.className = 'num';
    tag.textContent = f.include && f.cut ? num : '–';
    b.appendChild(tag);
    b.addEventListener('click', () => {
      if (!f.cut) return toast('No person found in this frame — adjust the cutout and re-cut.');
      f.include = !f.include;
      renderFrames();
      rebuildSheets();
    });
    wrap.appendChild(b);
  }
  const inc = included().length;
  $('frameCount').textContent = state.frames.length ? `${inc} of ${state.frames.length} in use` : '';
  const has = state.frames.length > 0;
  ['reprocessBtn', 'includeAllBtn', 'clearBtn'].forEach((id) => ($(id).disabled = !has || state.busy));
  $('playBtn').disabled = $('webmBtn').disabled = inc === 0;
  if (inc && !playing) {
    const c = sizePlayCanvas();
    drawAnimFrame(c.getContext('2d'), included()[0], $('playBg').value);
  }
}

$('includeAllBtn').addEventListener('click', () => {
  state.frames.forEach((f) => (f.include = !!f.cut));
  renderFrames();
  rebuildSheets();
});
$('clearBtn').addEventListener('click', () => {
  if (!confirm('Remove all captured frames?')) return;
  state.frames.forEach((f) => f.thumb && URL.revokeObjectURL(f.thumb));
  state.frames = [];
  renderFrames();
  rebuildSheets();
});
$('reprocessBtn').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  const prog = $('progress');
  prog.classList.remove('hidden');
  const settings = cutSettings();
  for (let i = 0; i < state.frames.length; i++) {
    const f = state.frames[i];
    const c = await blobToCanvas(f.raw);
    try { f.cut = await cutoutFrame(c, settings); } catch (e) { reportAiError(e); }
    if (!f.cut) f.include = false;
    await makeThumb(f);
    prog.value = (i + 1) / state.frames.length;
  }
  prog.classList.add('hidden');
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
  ctx.drawImage(f.cut.canvas, f.cut.bbox.x, f.cut.bbox.y);
}
function sizePlayCanvas() {
  const fr = included();
  const c = $('playCanvas');
  c.width = fr[0]?.cut.srcW || state.srcW || 320;
  c.height = fr[0]?.cut.srcH || state.srcH || 180;
  return c;
}
$('playBtn').addEventListener('click', async () => {
  if (playing) { playing = false; return; }
  const fr = included();
  if (!fr.length) return;
  playing = true;
  $('playBtn').textContent = '■ Stop';
  const c = sizePlayCanvas();
  const ctx = c.getContext('2d');
  let i = 0;
  while (playing && included().length) {
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
  $('webmBtn').disabled = true;
  toast('Recording preview…');
  const c = sizePlayCanvas();
  const bg = $('playBg').value === 'checker' ? '#ffffff' : $('playBg').value;
  const blob = await recordWebm(c, fr.length, fps(), (ctx, i) => drawAnimFrame(ctx, fr[i], bg), fr.length < 24 ? 3 : 1);
  download(blob, `dance-preview-${fps()}fps.webm`);
  $('webmBtn').disabled = false;
});

// ---------- sticker sheets ----------
function initPresets() {
  const sel = $('preset');
  sel.innerHTML = Object.entries(SHEETS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.value = 'stickerpix-pc';
  applyPreset();
}
function applyPreset() {
  const key = $('preset').value;
  const p = SHEETS[key];
  $('customSize').classList.toggle('hidden', key !== 'custom');
  $('presetNote').textContent = p.note;
  $('margin').value = p.margin;
}
$('preset').addEventListener('change', () => { applyPreset(); rebuildSheets(); });

/** Builds all stickers at print resolution and lays them out. */
async function buildAll() {
  const s = sheetSettings();
  const frames = included();
  if (!frames.length) return null;
  // One shared scale so the dancer is the same size on every sticker (essential for stop motion).
  const maxH = Math.max(...frames.map((f) => f.cut.bbox.h));
  const scale = (s.figureH * DPI) / maxH;
  const stickers = [];
  for (let i = 0; i < frames.length; i++) {
    const canvas = buildSticker(frames[i].cut, {
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
    stickers.push({ canvas, number: i + 1 });
    if (i % 4 === 3) await sleep(0); // keep UI responsive
  }
  const layout = bestOrientation(stickers.map((st) => ({ w: st.canvas.width, h: st.canvas.height })), s);
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
  if (!included().length) {
    state.stickers = null; state.layout = null;
    stats.textContent = 'No frames yet.';
    $('sheets').innerHTML = '';
    $('dlSheets').disabled = $('dlStickers').disabled = true;
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

function renderSheetCanvas(built, sheet, { preview }) {
  const { area } = built.layout;
  const s = built.settings;
  const W = Math.round(area.w * DPI), H = Math.round(area.h * DPI);
  const c = document.createElement('canvas');
  if (preview) {
    // Show the whole physical sheet with its margin.
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
      const st = built.stickers[p.index].canvas;
      const x = m + p.x * k, y = m + p.y * k;
      // Faint shadow hints where the cut line (sticker edge) will be.
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 2;
      ctx.drawImage(st, x, y, p.w * k, p.h * k);
      ctx.restore();
    }
    return c;
  }
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  for (const p of sheet.placements) ctx.drawImage(built.stickers[p.index].canvas, p.x, p.y);
  return c;
}

function renderSheets(built) {
  const { layout } = built;
  const s = built.settings;
  const wrap = $('sheets');
  wrap.innerHTML = '';
  layout.sheets.forEach((sh, i) => {
    const fig = document.createElement('figure');
    fig.className = 'sheet';
    fig.appendChild(renderSheetCanvas(built, sh, { preview: true }));
    const nums = sh.placements.map((p) => p.index + 1);
    const cap = document.createElement('figcaption');
    cap.textContent = `Sheet ${i + 1} · #${nums[0]}–${nums[nums.length - 1]}`;
    fig.appendChild(cap);
    wrap.appendChild(fig);
  });
  const oversize = layout.sheets.some((sh) => sh.placements.some((p) => p.oversize));
  const total = built.stickers.length;
  stats.innerHTML =
    `<b>${total}</b> stickers · up to <b>${layout.perSheet}</b> per sheet · <b>${layout.sheets.length}</b> sheet${layout.sheets.length > 1 ? 's' : ''} ` +
    `<span class="hint">(${layout.orientation}, printable ${fmt(layout.area.w)} × ${fmt(layout.area.h)} in)</span>` +
    (oversize ? `<br><span class="warn">Some stickers are bigger than the sheet. Lower the dancer height.</span>` : '');
  $('dlSheets').disabled = $('dlStickers').disabled = false;
}
const stats = $('stats');

['orientation', 'figureH', 'borderW', 'gap', 'margin', 'borderColor', 'fillHoles', 'badgeShow', 'badgeCorner', 'badgeSize', 'badgeColor', 'customW', 'customH']
  .forEach((id) => $(id).addEventListener('input', () => { state.layout = null; updateEstimate(); rebuildSheets(); }));

// ---------- downloads ----------
function contentBox(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (data[(y * canvas.width + x) * 4 + 3]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? { w: 0, h: 0 } : { w: maxX - minX + 1, h: maxY - minY + 1 };
}

$('dlSheets').addEventListener('click', async () => {
  if (!state.stickers) return;
  $('dlSheets').disabled = true;
  toast('Preparing print files…');
  const built = { stickers: state.stickers, layout: state.layout, settings: sheetSettings() };
  const files = [];
  const lines = [
    'STICKER STOP — print files',
    `Machine/paper: ${built.settings.preset.label}`,
    `Orientation: ${built.layout.orientation}`,
    `Resolution: ${DPI} dpi PNG, transparent background (Cricut cuts around each sticker)`,
    `Frame rate these were cut at: ${fps()} fps`,
    '',
    'In Design Space: Upload → Print Then Cut image → lock proportions → set the size below.',
    'If Design Space trims the empty edges on upload, use the "sticker area" size.',
    '',
  ];
  for (let i = 0; i < built.layout.sheets.length; i++) {
    const sh = built.layout.sheets[i];
    const c = renderSheetCanvas(built, sh, { preview: false });
    const nums = sh.placements.map((p) => p.index + 1);
    const wIn = c.width / DPI, hIn = c.height / DPI;
    const box = contentBox(c);
    const name = `sheet-${String(i + 1).padStart(2, '0')}_frames-${nums[0]}-${nums[nums.length - 1]}_${fmt(wIn)}x${fmt(hIn)}in.png`;
    files.push({ name, blob: await pngWithDpi(c, DPI) });
    lines.push(`${name}\n   full image: ${fmt(wIn)} × ${fmt(hIn)} in   sticker area: ${fmt(box.w / DPI)} × ${fmt(box.h / DPI)} in   (${sh.placements.length} stickers)`);
  }
  files.push({ name: 'SIZES.txt', text: lines.join('\n') + '\n' });
  download(await zipFiles(files), `sticker-sheets-${files.length - 1}.zip`);
  $('dlSheets').disabled = false;
});

$('dlStickers').addEventListener('click', async () => {
  if (!state.stickers) return;
  $('dlStickers').disabled = true;
  toast('Preparing stickers…');
  const files = [];
  const lines = ['Individual stickers (300 dpi, transparent PNG). Size in Design Space:'];
  for (const st of state.stickers) {
    const name = `sticker-${String(st.number).padStart(3, '0')}.png`;
    files.push({ name, blob: await pngWithDpi(st.canvas, DPI) });
    lines.push(`${name}: ${fmt(st.canvas.width / DPI)} × ${fmt(st.canvas.height / DPI)} in`);
  }
  files.push({ name: 'SIZES.txt', text: lines.join('\n') + '\n' });
  download(await zipFiles(files), `stickers-${state.stickers.length}.zip`);
  $('dlStickers').disabled = false;
});

// ---------- init ----------
initPresets();
syncMethodUI();
updateEstimate();
renderFrames();
// Expose for automated testing / debugging.
window.__stickerStop = { state, rebuildSheets, addFrame, cutSettings };
