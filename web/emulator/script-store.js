import { validateScript } from './scripts.js';

const DATABASE = 'sq64-ui-scripts';
const STORE = 'scripts';

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(Error('IndexedDB is unavailable. You can still import and export scripts.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(Error('Script storage is blocked by another tab. Close that tab and retry.')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      // Resolve on commit, not request success: quota errors can abort later.
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error || Error('Script storage transaction was aborted'));
      tx.onerror = () => {}; // onabort reports the final transaction error.
    });
  } finally { database.close(); }
}

export async function listScripts() {
  return (await transaction('readonly', store => store.getAll())).sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function saveScript(script, id = crypto.randomUUID()) {
  const record = { id, script: validateScript(script), updatedAt: Date.now() };
  await transaction('readwrite', store => store.put(record));
  return record;
}
export function deleteScript(id) {
  return transaction('readwrite', store => store.delete(id));
}
