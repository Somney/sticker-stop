// AI person segmentation (no green screen needed) using MediaPipe's multiclass selfie segmenter.
// Loaded lazily from CDN the first time it's needed; runs fully in the browser.

const TASKS_VERSION = '0.10.14';
const BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/vision_bundle.mjs`;
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

let segmenterPromise = null;

export function loadSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import(BUNDLE);
      const fileset = await FilesetResolver.forVisionTasks(WASM);
      const make = (delegate) =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL, delegate },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
      try {
        return await make('GPU');
      } catch {
        return await make('CPU');
      }
    })();
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

/**
 * Returns Uint8ClampedArray person alpha (0..255) for the canvas.
 * Class 0 of the multiclass model is background; person = 1 - background.
 */
export async function segmentPerson(canvas, { lo = 0.25, hi = 0.75 } = {}) {
  const seg = await loadSegmenter();
  const result = seg.segment(canvas);
  const masks = result.confidenceMasks;
  const bg = masks[0].getAsFloat32Array();
  const alpha = new Uint8ClampedArray(bg.length);
  const span = hi - lo;
  for (let i = 0; i < bg.length; i++) {
    let t = (1 - bg[i] - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    alpha[i] = t * t * (3 - 2 * t) * 255;
  }
  masks.forEach((m) => m.close());
  return alpha;
}
