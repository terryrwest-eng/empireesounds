// Photos attached to pins.
//
// They live in IndexedDB, not localStorage: a single site photo is bigger than
// the whole 5 MB localStorage budget the rest of the project shares. Images are
// downscaled on the way in, because a 12 MP phone photo of a valve box is 4 MB
// of detail nobody needs and a full card of them will fill a phone.

const DB_NAME = 'station-photos';
const STORE = 'photos';
const MAX_EDGE = 1600;
const QUALITY = 0.82;

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('pinId', 'pinId', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** Shrink to something a phone can hold hundreds of. */
export async function downscale(file) {
  if (typeof createImageBitmap !== 'function') return { blob: file, width: null, height: null };
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return { blob: file, width: null, height: null }; }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', QUALITY));
  return { blob: blob || file, width: w, height: h };
}

export async function savePhoto(pinId, file, extra = {}) {
  const { blob, width, height } = await downscale(file);
  const record = {
    id: `ph${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    pinId,
    blob,
    width, height,
    size: blob.size,
    name: file.name || 'photo.jpg',
    t: Date.now(),
    ...extra
  };
  await tx('readwrite', store => store.put(record));
  return { ...record, blob: undefined };
}

export async function photosFor(pinId) {
  return tx('readonly', store => store.index('pinId').getAll(pinId));
}

export async function allPhotos() {
  return tx('readonly', store => store.getAll());
}

export async function deletePhoto(id) {
  return tx('readwrite', store => store.delete(id));
}

export async function deletePhotosFor(pinId) {
  const list = await photosFor(pinId);
  for (const p of list) await deletePhoto(p.id);
  return list.length;
}

export async function countPhotos() {
  return tx('readonly', store => store.count());
}

export async function totalBytes() {
  const list = await allPhotos();
  return list.reduce((s, p) => s + (p.size || 0), 0);
}

/** Object URLs are handed out here and revoked together, to avoid leaking them. */
const urls = new Map();

export function urlFor(record) {
  if (urls.has(record.id)) return urls.get(record.id);
  const url = URL.createObjectURL(record.blob);
  urls.set(record.id, url);
  return url;
}

export function releaseUrls() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}
