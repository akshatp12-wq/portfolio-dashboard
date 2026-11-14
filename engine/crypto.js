// AES-256-GCM with PBKDF2-SHA256 key derivation, Web Crypto only.
// Envelope: { v:1, kdf:'PBKDF2-SHA256', iter, salt, iv, ct } (base64 fields).

const subtle = globalThis.crypto.subtle;
export const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function passphraseStrength(p) {
  const words = p.trim().split(/\s+/).filter(Boolean);
  const ok = words.length >= 5 || p.length >= 20;
  return { ok, words: words.length, chars: p.length, reason: ok ? '' : 'Use at least 5 random words or 20+ characters. There is no recovery.' };
}

export async function deriveKey(passphrase, salt, iter) {
  const base = await subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptDocument(obj, passphrase, iter = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iter);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-GCM', iter, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function decryptDocument(envelope, passphrase) {
  if (envelope?.v !== 1) throw new Error('Unsupported envelope version');
  const key = await deriveKey(passphrase, unb64(envelope.salt), envelope.iter);
  let pt;
  try { pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.ct)); }
  catch { throw new Error('Wrong passphrase or corrupted file'); }
  return JSON.parse(dec.decode(pt));
}

function b64(bytes) {
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s);
}
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }

// ---- key-based API (remember-me) ----
// A non-extractable CryptoKey can be kept in IndexedDB so a trusted device skips the passphrase.
// The salt stays stable across saves, so a remembered key keeps working until the passphrase
// changes. Every save still uses a fresh random 96-bit IV.

export async function unlockWithPassphrase(envelope, passphrase) {
  if (envelope?.v !== 1) throw new Error('Unsupported envelope version');
  const key = await deriveKey(passphrase, unb64(envelope.salt), envelope.iter);
  return { key, doc: await decryptWithKey(envelope, key), salt: envelope.salt, iter: envelope.iter };
}

export async function decryptWithKey(envelope, key) {
  let pt;
  try { pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, key, unb64(envelope.ct)); }
  catch { throw new Error('Wrong passphrase or corrupted file'); }
  return JSON.parse(dec.decode(pt));
}

export async function newSession(passphrase, iter = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { key: await deriveKey(passphrase, salt, iter), salt: b64(salt), iter };
}

export async function encryptWithKey(obj, session) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, session.key, enc.encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', cipher: 'AES-256-GCM', iter: session.iter, salt: session.salt, iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}
