// Remember-me: keeps the non-extractable derived key in this browser's IndexedDB.
// The passphrase itself is never stored. "Forget this device" deletes the record.
const DB = 'pd-device', STORE = 'k', ID = 'session';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode); const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function rememberDevice(session) { try { await tx('readwrite', (s) => s.put({ key: session.key, salt: session.salt, iter: session.iter }, ID)); return true; } catch { return false; } }
export async function recallDevice() { try { return (await tx('readonly', (s) => s.get(ID))) || null; } catch { return null; } }
export async function forgetDevice() { try { await tx('readwrite', (s) => s.delete(ID)); return true; } catch { return false; } }
