import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSession, encryptWithKey, unlockWithPassphrase, decryptWithKey } from '../engine/crypto.js';
import { emptyDocument, validateDocument } from '../engine/document.js';

const PASS = 'abcde-fghjk-mnpqr-stuvw';

test('session key round-trips, keeps its salt across saves, and uses a fresh IV each time', async () => {
  const s = await newSession(PASS);
  const a = await encryptWithKey({ n: 1 }, s), b = await encryptWithKey({ n: 2 }, s);
  assert.equal(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  // a remembered key (no passphrase) can open a later save made with the same salt
  assert.deepEqual(await decryptWithKey(b, s.key), { n: 2 });
  // typing the passphrase on another device derives the same key from the stored salt
  const u = await unlockWithPassphrase(b, PASS);
  assert.deepEqual(u.doc, { n: 2 });
  assert.equal(u.salt, b.salt);
});

test('a wrong passphrase or a key from a different salt cannot decrypt', async () => {
  const s = await newSession(PASS), other = await newSession(PASS);
  const env = await encryptWithKey({ n: 1 }, s);
  await assert.rejects(unlockWithPassphrase(env, 'wrong-wrong-wrong-wrong'), /Wrong passphrase/);
  await assert.rejects(decryptWithKey(env, other.key), /Wrong passphrase/);
});

test('the stored key is not extractable, so remember-me never exposes key material', async () => {
  const s = await newSession(PASS);
  assert.equal(s.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', s.key));
});

test('validateDocument rejects free text in ticker, kind, flags and account labels', () => {
  const base = () => { const d = emptyDocument(); d.accounts = [{ id: 'taxable_a', type: 'taxable', label: 'Taxable A' }]; d.transactions = [{ id: 't00001', date: '2024-01-02', type: 'Buy', value: 1, fees: 0, taxes: 0, shares: 1, ticker: 'VOO', account: 'taxable_a', kind: '', flags: [] }]; return d; };
  validateDocument(base());
  let d = base(); d.transactions[0].ticker = 'Jane Doe IRA'; assert.throws(() => validateDocument(d), /ticker/);
  d = base(); d.transactions[0].kind = 'wire to my bank'; assert.throws(() => validateDocument(d), /kind/);
  d = base(); d.transactions[0].flags = ['call mom']; assert.throws(() => validateDocument(d), /flag/);
  d = base(); d.accounts[0].label = 'Fidelity Roth 1234'; assert.throws(() => validateDocument(d), /generic label/);
});
