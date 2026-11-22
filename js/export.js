// PNG export with embedded 300 DPI metadata, ZIP bundling, and WebM preview recording.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Inserts a pHYs chunk so apps read the PNG at the right physical size. */
export async function pngWithDpi(canvas, dpi = 300) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const src = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // after signature (8) + IHDR (25)
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(src.subarray(at), at + chunk.length);
  return new Blob([out], { type: 'image/png' });
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function zipFiles(files) {
  // JSZip is loaded globally from cdnjs in index.html.
  const zip = new window.JSZip();
  for (const f of files) zip.file(f.name, f.blob ?? f.text);
  return zip.generateAsync({ type: 'blob' });
}

/** Records frames to a WebM clip. drawFrame(ctx, i) paints frame i. */
export async function recordWebm(canvas, count, fps, drawFrame, loops = 1) {
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) =>
    MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();
  const ctx = canvas.getContext('2d');
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i < count; i++) {
      drawFrame(ctx, i);
      track.requestFrame?.();
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
  }
  rec.stop();
  await done;
  return new Blob(chunks, { type: 'video/webm' });
}
