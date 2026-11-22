// Binary-mask helpers: Euclidean distance transform, connected components, hole filling.
// All masks are Uint8Array (1 = foreground, 0 = background), row-major, width w, height h.

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Distance (in px) from every pixel to the nearest foreground pixel. 0 on foreground. */
export function distanceToForeground(mask, w, h) {
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Removes foreground blobs smaller than minRatio * (largest blob area). Mutates mask; returns kept-label map. */
export function removeSpecks(mask, w, h, minRatio = 0.03) {
  const labels = new Int32Array(w * h);
  const areas = [0];
  const stack = new Int32Array(w * h);
  let label = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    label++;
    let sp = 0;
    let area = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !labels[p - w]) { labels[p - w] = label; stack[sp++] = p - w; }
      if (p < w * (h - 1) && mask[p + w] && !labels[p + w]) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    areas.push(area);
  }
  if (label === 0) return { labels, kept: 0 };
  const largest = Math.max(...areas);
  const minArea = Math.max(4, largest * minRatio);
  let kept = 0;
  const keep = areas.map((a) => a >= minArea);
  for (let l = 1; l <= label; l++) if (keep[l]) kept++;
  for (let i = 0; i < mask.length; i++) if (mask[i] && !keep[labels[i]]) mask[i] = 0;
  return { labels, kept };
}

/** Fills enclosed background regions (holes) so the mask is solid. Mutates mask. */
export function fillHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p) => {
    if (!mask[p] && !outside[p]) { outside[p] = 1; stack[sp++] = p; }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  for (let i = 0; i < mask.length; i++) if (!mask[i] && !outside[i]) mask[i] = 1;
}

/** Bounding box of pixels where alpha > threshold. Returns null if empty. */
export function alphaBBox(data, w, h, threshold = 0) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Fills enclosed background holes up to maxArea pixels (mask noise), but keeps big real gaps,
 * like the space between an arm on a hip and the body. Mutates mask; returns filled pixel indices.
 */
export function fillSmallHoles(mask, w, h, maxArea) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const filled = [];
  // Mark background connected to the image border.
  let sp = 0;
  const pushOut = (p) => { if (!mask[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { pushOut(x); pushOut((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { pushOut(y * w); pushOut(y * w + w - 1); }
  const flood = (collect) => {
    while (sp) {
      const p = stack[--sp];
      if (collect) collect.push(p);
      const x = p % w;
      if (x > 0) pushOut(p - 1);
      if (x < w - 1) pushOut(p + 1);
      if (p >= w) pushOut(p - w);
      if (p < w * (h - 1)) pushOut(p + w);
    }
  };
  flood(null);
  // Every remaining unseen background region is an enclosed hole.
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || seen[i]) continue;
    const region = [];
    seen[i] = 1; stack[sp++] = i;
    flood(region);
    if (region.length <= maxArea) {
      for (const p of region) { mask[p] = 1; filled.push(p); }
    }
  }
  return filled;
}
