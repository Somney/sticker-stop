// Turns one raw video frame into a transparent cutout of the dancer.
import { chromaKey, hexToRgb } from './keyer.js';
import { segmentPerson } from './segmenter.js';
import { distanceToForeground, removeSpecks, alphaBBox } from './mask.js';

/**
 * settings: {
 *   method: 'key' | 'ai' | 'both',
 *   keyColor: '#00b140', tolerance, softness, spill (0..100),
 *   choke (px), cleanSpecks (bool)
 * }
 * Returns { canvas, bbox, srcW, srcH } where canvas is the cropped cutout, or null if nothing found.
 */
export async function cutoutFrame(src, settings) {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const n = w * h;
  let alpha = null;

  if (settings.method === 'key' || settings.method === 'both') {
    alpha = chromaKey(data, w, h, {
      key: hexToRgb(settings.keyColor),
      tolerance: settings.tolerance,
      softness: settings.softness,
      spill: settings.spill / 100,
    });
  }
  if (settings.method === 'ai' || settings.method === 'both') {
    const ai = await segmentPerson(src);
    if (alpha) for (let i = 0; i < n; i++) alpha[i] = Math.min(alpha[i], ai[i]);
    else alpha = ai;
  }

  // Shrink the edge to remove leftover backdrop fringe.
  if (settings.choke > 0) {
    const bg = new Uint8Array(n);
    for (let i = 0; i < n; i++) bg[i] = alpha[i] < 128 ? 1 : 0;
    const d = distanceToForeground(bg, w, h);
    const c = settings.choke;
    for (let i = 0; i < n; i++) {
      if (d[i] < c + 1) alpha[i] = alpha[i] * Math.max(0, d[i] - c);
    }
  }

  // Drop stray specks of noise so each frame is one clean sticker.
  if (settings.cleanSpecks) {
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) fg[i] = alpha[i] >= 128 ? 1 : 0;
    removeSpecks(fg, w, h, 0.03);
    // Kill anything not near a kept blob (including faint fringe pixels).
    const d = distanceToForeground(fg, w, h);
    for (let i = 0; i < n; i++) if (d[i] > 2) alpha[i] = 0;
  }

  for (let i = 0; i < n; i++) data[i * 4 + 3] = alpha[i];
  const bbox = alphaBBox(data, w, h, 24);
  if (!bbox) return null;

  const out = document.createElement('canvas');
  out.width = bbox.w;
  out.height = bbox.h;
  const octx = out.getContext('2d');
  const crop = new ImageData(bbox.w, bbox.h);
  for (let y = 0; y < bbox.h; y++) {
    const s = ((bbox.y + y) * w + bbox.x) * 4;
    crop.data.set(data.subarray(s, s + bbox.w * 4), y * bbox.w * 4);
  }
  octx.putImageData(crop, 0, 0);
  return { canvas: out, bbox, srcW: w, srcH: h };
}

/** Draws a source (video/image/bitmap) into a working canvas, scaled so height <= maxH. */
export function grabFrame(source, maxH, mirror = false, target = null) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxH / sh);
  const c = target || document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.save();
  if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, 0, 0, c.width, c.height);
  ctx.restore();
  return c;
}
