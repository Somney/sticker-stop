// Local project storage (IndexedDB): frames + settings survive reloads and app restarts.
// Everything stays on the device. If IndexedDB is unavailable (e.g. private mode) the app still works,
// it just won't remember the project.

const DB_NAME = 'sticker-stop';
const DB_VERSION = 1;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('frames')) d.createObjectStore('frames', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  try {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch (e) {
    console.warn('storage unavailable', e);
    return undefined;
  }
}

export const putFrame = (rec) => tx('frames', 'readwrite', (s) => s.put(rec));
export const deleteFrame = (id) => tx('frames', 'readwrite', (s) => s.delete(id));
export const clearFrames = () => tx('frames', 'readwrite', (s) => s.clear());
export const getFrames = async () => ((await tx('frames', 'readonly', (s) => s.getAll())) || []).sort((a, b) => a.id - b.id);
export const setKV = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
export const getKV = (k) => tx('kv', 'readonly', (s) => s.get(k));

/** Ask the browser not to evict our data under storage pressure. */
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
