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
export async function forgetDevice() { try { await tx('readwrite', (s) => { s.delete(ID); s.delete(TOKEN); }); return true; } catch { return false; } }

// GitHub token for the refresh button and saving, encrypted with the session key (AES-GCM),
// so the stored bytes are useless without the passphrase-derived key.
const TOKEN = 'gh-token';
export async function rememberToken(session, token) {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, new TextEncoder().encode(token));
    await tx('readwrite', (s) => s.put({ iv, ct: new Uint8Array(ct), salt: session.salt }, TOKEN)); return true;
  } catch { return false; }
}
export async function recallToken(session) {
  try {
    const r = await tx('readonly', (s) => s.get(TOKEN)); if (!r || r.salt !== session.salt) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.iv }, session.key, r.ct));
  } catch { return null; }
}
export async function forgetToken() { try { await tx('readwrite', (s) => s.delete(TOKEN)); return true; } catch { return false; } }
