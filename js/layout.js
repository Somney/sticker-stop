// Sheet presets and packing stickers onto sheets.

export const SHEETS = {
  'stickerpix-pc': {
    label: 'Cricut StickerPix Print + Cut — 4 × 7 in sticker sheet',
    w: 3.94, h: 6.93, margin: 0.12,
    note: 'Usable sheet area 3.94 × 6.93 in (100 × 176 mm). Kiss-cuts around each sticker shape.',
  },
  'ptc-letter': {
    label: 'Cricut Explore / Maker / Joy Xtra Print Then Cut — Letter / A4',
    w: 6.75, h: 9.25, margin: 0,
    note: 'Classic Print Then Cut max image area 6.75 × 9.25 in; works on every Design Space version. Newer firmware may allow more (check the size indicator in Design Space).',
  },
  custom: { label: 'Custom size…', w: 4, h: 6, margin: 0.1, note: 'Enter your own printable area.' },
};

/**
 * Shelf-packs items (in order, so frames stay sequential) onto sheets.
 * items: [{ w, h }] in px; sheet: { w, h } usable area in px; gap px.
 * Returns [{ placements: [{ index, x, y, w, h }] }]
 */
export function packSheets(items, sheetW, sheetH, gap) {
  const sheets = [];
  let cur = null, x = 0, y = 0, rowH = 0;
  const newSheet = () => { cur = { placements: [] }; sheets.push(cur); x = 0; y = 0; rowH = 0; };
  items.forEach((it, index) => {
    if (it.w > sheetW || it.h > sheetH) {
      // Oversized sticker: give it its own sheet so it's visible; flagged by caller.
      newSheet();
      cur.placements.push({ index, x: 0, y: 0, w: it.w, h: it.h, oversize: true });
      cur = null;
      return;
    }
    if (!cur) newSheet();
    if (x > 0 && x + it.w > sheetW) { x = 0; y += rowH + gap; rowH = 0; }
    if (y + it.h > sheetH) newSheet();
    cur.placements.push({ index, x, y, w: it.w, h: it.h });
    x += it.w + gap;
    rowH = Math.max(rowH, it.h);
  });
  return sheets;
}

/** Usable sheet area in inches after margins and orientation. */
export function usableArea(preset, orientation, margin) {
  let w = preset.w, h = preset.h;
  if (orientation === 'landscape') [w, h] = [Math.max(w, h), Math.min(w, h)];
  else [w, h] = [Math.min(w, h), Math.max(w, h)];
  return { w: w - 2 * margin, h: h - 2 * margin, sheetW: w, sheetH: h };
}
