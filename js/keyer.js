// Chroma key (green / blue screen) in YCbCr space with spill suppression.

export function rgbToCbCr(r, g, b) {
  return [
    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ];
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/**
 * Computes a key alpha (0..255) per pixel and suppresses colour spill in-place.
 * opts: { key:[r,g,b], tolerance:0..100, softness:0..100, spill:0..1 }
 * Returns Uint8ClampedArray of alpha values.
 */
export function chromaKey(data, w, h, opts) {
  const [kr, kg, kb] = opts.key;
  const [kcb, kcr] = rgbToCbCr(kr, kg, kb);
  // Map 0..100 slider to chroma distance (max useful ~ 120).
  const inner = (opts.tolerance / 100) * 90;
  const outer = inner + 4 + (opts.softness / 100) * 50;
  const span = outer - inner;
  const alpha = new Uint8ClampedArray(w * h);
  // Which channel dominates the key colour (for spill suppression)?
  const dom = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0;
  const spill = opts.spill;
  for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const dcb = cb - kcb, dcr = cr - kcr;
    const dist = Math.sqrt(dcb * dcb + dcr * dcr);
    let a;
    if (dist <= inner) a = 0;
    else if (dist >= outer) a = 1;
    else {
      const t = (dist - inner) / span;
      a = t * t * (3 - 2 * t);
    }
    alpha[i] = a * 255;
    if (spill > 0 && a > 0) {
      // Clamp the dominant channel to the max of the other two (classic despill).
      if (dom === 1) {
        const lim = Math.max(r, b);
        if (g > lim) data[p + 1] = g - (g - lim) * spill;
      } else if (dom === 2) {
        const lim = Math.max(r, g);
        if (b > lim) data[p + 2] = b - (b - lim) * spill;
      } else {
        const lim = Math.max(g, b);
        if (r > lim) data[p] = r - (r - lim) * spill;
      }
    }
  }
  return alpha;
}

/** Estimates the backdrop colour from the median of the frame's outer border pixels. */
export function detectKeyColor(data, w, h) {
  const rs = [], gs = [], bs = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const step = Math.max(1, Math.round((w + h) / 400));
  const sample = (x, y) => {
    const p = (y * w + x) * 4;
    rs.push(data[p]); gs.push(data[p + 1]); bs.push(data[p + 2]);
  };
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < band; x += step) { sample(x, y); sample(w - 1 - x, y); }
  }
  for (let x = 0; x < w; x += step) {
    for (let y = 0; y < band; y += step) { sample(x, y); sample(x, h - 1 - y); }
  }
  const med = (a) => { a.sort((m, n) => m - n); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}
