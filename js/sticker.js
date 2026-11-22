// Builds a print-ready sticker: the cutout + a solid offset border (the Cricut cut line follows
// its outer edge) + a numbered badge fused onto the border so it gets cut with the sticker.
import { distanceToForeground, fillHoles } from './mask.js';

export const DPI = 300;

const CORNERS = {
  'top-left': [0, 0],
  'top-right': [1, 0],
  'bottom-left': [0, 1],
  'bottom-right': [1, 1],
};

/**
 * frame: { canvas, bbox } from cutoutFrame
 * opts: {
 *   scale: output px per source px,
 *   offsetPx, borderColor, fillHoles,
 *   badge: { show, number, corner, radiusPx, color, textColor }
 * }
 * Returns a canvas (transparent outside the sticker).
 */
export function buildSticker(frame, opts) {
  const artW = Math.max(1, Math.round(frame.bbox.w * opts.scale));
  const artH = Math.max(1, Math.round(frame.bbox.h * opts.scale));
  const badge = opts.badge;
  const R = badge.show ? badge.radiusPx : 0;
  const ring = Math.max(3, Math.round(opts.offsetPx * 0.6));
  const pad = Math.ceil(opts.offsetPx + (badge.show ? R + ring : 0)) + 4;
  const W = artW + pad * 2, H = artH + pad * 2;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(frame.canvas, pad, pad, artW, artH);
  const art = ctx.getImageData(0, 0, W, H);
  const n = W * H;

  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = art.data[i * 4 + 3] > 100 ? 1 : 0;
  if (opts.fillHoles) fillHoles(fg, W, H);
  const dist = distanceToForeground(fg, W, H);

  // Outline coverage 0..1 (anti-aliased).
  const off = opts.offsetPx;
  const cover = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = off + 0.5 - dist[i];
    cover[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  if (opts.fillHoles && off > 0) {
    const solid = new Uint8Array(n);
    for (let i = 0; i < n; i++) solid[i] = cover[i] > 0.5 ? 1 : 0;
    fillHoles(solid, W, H);
    for (let i = 0; i < n; i++) if (solid[i]) cover[i] = 1;
  }

  // Badge placement: nearest outline point to the chosen corner, nudged outward.
  let bx = 0, by = 0;
  if (badge.show) {
    const [fx, fy] = CORNERS[badge.corner] || CORNERS['bottom-left'];
    const cx = pad + fx * artW, cy = pad + fy * artH;
    let best = Infinity;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (cover[y * W + x] < 0.5) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < best) { best = d; bx = x; by = y; }
      }
    }
    const dx = cx - bx, dy = cy - by;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      const push = Math.min(len, R * 0.55);
      bx += (dx / len) * push;
      by += (dy / len) * push;
    }
    const outer = R + ring;
    for (let y = Math.max(0, Math.floor(by - outer - 1)); y < Math.min(H, by + outer + 1); y++) {
      for (let x = Math.max(0, Math.floor(bx - outer - 1)); x < Math.min(W, bx + outer + 1); x++) {
        const v = outer + 0.5 - Math.hypot(x - bx, y - by);
        if (v > 0) {
          const i = y * W + x;
          cover[i] = Math.max(cover[i], Math.min(1, v));
        }
      }
    }
  }

  // Paint border, then art on top, then the badge.
  const out = ctx.createImageData(W, H);
  const [br, bg, bb] = hex(opts.borderColor);
  for (let i = 0; i < n; i++) {
    const a = cover[i];
    if (a <= 0) continue;
    const p = i * 4;
    out.data[p] = br; out.data[p + 1] = bg; out.data[p + 2] = bb;
    out.data[p + 3] = a * 255;
  }
  ctx.clearRect(0, 0, W, H);
  ctx.putImageData(out, 0, 0);
  // Clip art to the cut shape (removes faint fringe that would print outside the cut line).
  const artLayer = document.createElement('canvas');
  artLayer.width = W; artLayer.height = H;
  const actx = artLayer.getContext('2d', { willReadFrequently: true });
  actx.putImageData(art, 0, 0);
  actx.globalCompositeOperation = 'destination-in';
  actx.drawImage(c, 0, 0);
  ctx.drawImage(artLayer, 0, 0);

  if (badge.show) {
    ctx.beginPath();
    ctx.arc(bx, by, R, 0, Math.PI * 2);
    ctx.fillStyle = badge.color;
    ctx.fill();
    const label = String(badge.number);
    const size = R * (label.length >= 3 ? 0.95 : label.length === 2 ? 1.15 : 1.3);
    ctx.fillStyle = badge.textColor;
    ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx, by + size * 0.05);
  }

  return trim(c);
}

function hex(h) {
  const v = parseInt(h.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Crops transparent edges. */
export function trim(c) {
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return c;
  const t = document.createElement('canvas');
  t.width = maxX - minX + 1;
  t.height = maxY - minY + 1;
  t.getContext('2d', { willReadFrequently: true }).drawImage(c, -minX, -minY);
  return t;
}
