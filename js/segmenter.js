// AI person segmentation (no green screen needed) using MediaPipe's multiclass selfie segmenter.
// Loaded lazily from CDN the first time it's needed; runs fully in the browser.
//
// Runs on the CPU (WASM) on purpose: the GPU (WebGL) path returns blocky, corrupted masks on some
// phones, which showed up as white squares punched out of stickers. Calls are also serialised so the
// live preview and frame processing never share the model at the same time.

const TASKS_VERSION = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

let segmenterPromise = null;
let queue = Promise.resolve();

export function loadSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

/**
 * Returns Uint8ClampedArray person alpha (0..255) for the canvas, same size as the canvas.
 * Class 0 of the multiclass model is background; person = 1 - background.
 */
export function segmentPerson(canvas, { lo = 0.25, hi = 0.75 } = {}) {
  const run = queue.then(async () => {
    const seg = await loadSegmenter();
    const result = seg.segment(canvas);
    const masks = result.confidenceMasks;
    try {
      const m = masks[0];
      const bg = m.getAsFloat32Array();
      if (m.width !== canvas.width || m.height !== canvas.height) {
        return resizeMask(bg, m.width, m.height, canvas.width, canvas.height, lo, hi);
      }
      const alpha = new Uint8ClampedArray(bg.length);
      const span = hi - lo;
      for (let i = 0; i < bg.length; i++) {
        let t = (1 - bg[i] - lo) / span;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        alpha[i] = t * t * (3 - 2 * t) * 255;
      }
      return alpha;
    } finally {
      masks.forEach((mk) => mk.close());
    }
  });
  queue = run.catch(() => {});
  return run;
}

function resizeMask(bg, mw, mh, w, h, lo, hi) {
  const alpha = new Uint8ClampedArray(w * h);
  const span = hi - lo;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(mh - 1, ((y + 0.5) * mh) / h - 0.5);
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(mh - 1, y0 + 1), ty = Math.max(0, fy - y0);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(mw - 1, ((x + 0.5) * mw) / w - 0.5);
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(mw - 1, x0 + 1), tx = Math.max(0, fx - x0);
      const v = (bg[y0 * mw + x0] * (1 - tx) + bg[y0 * mw + x1] * tx) * (1 - ty) +
        (bg[y1 * mw + x0] * (1 - tx) + bg[y1 * mw + x1] * tx) * ty;
      let t = (1 - v - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      alpha[y * w + x] = t * t * (3 - 2 * t) * 255;
    }
  }
  return alpha;
}
