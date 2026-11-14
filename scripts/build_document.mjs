// Builds (or extends) the encrypted document from Portfolio Performance CSVs, entirely offline.
//
//   PD_PASSPHRASE='...' node scripts/build_document.mjs --out data/portfolio.enc.json file1.csv file2.csv ...
//   PD_PASSPHRASE='...' node scripts/build_document.mjs --merge data/portfolio.enc.json \
//       --map "Original label=taxable_b" --out data/portfolio.enc.json new.csv
//
// Account labels in the CSVs are used only to group rows; they are replaced by generic ids and never
// written out. The passphrase comes from the environment so it never appears in a command line or file.
// Everything is checked before writing: closed schema, closed value shapes, a denylist of institution
// names, and an account-number scan over the plaintext AND over the final ciphertext envelope.
import fs from 'node:fs';
import { parsePortfolioPerformanceCsv } from '../engine/parse.js';
import { buildAccountMap, scrubRows, accountsFromMap, findDenylisted, findAccountNumberLike } from '../engine/scrub.js';
import { emptyDocument, validateDocument, mergeImport } from '../engine/document.js';
import { checkLedger } from '../engine/ledger.js';
import { passphraseStrength, newSession, encryptWithKey, unlockWithPassphrase } from '../engine/crypto.js';

const args = process.argv.slice(2);
const opt = { out: 'data/portfolio.enc.json', merge: null, map: {}, deny: [], files: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opt.out = args[++i];
  else if (a === '--merge') opt.merge = args[++i];
  else if (a === '--deny') opt.deny.push(...args[++i].split(','));
  else if (a === '--map') { const [k, v] = args[++i].split('='); opt.map[k.trim()] = v.trim(); }
  else opt.files.push(a);
}
const pass = process.env.PD_PASSPHRASE || '';
const st = passphraseStrength(pass);
if (!st.ok) { console.error('PD_PASSPHRASE: ' + st.reason); process.exit(2); }
if (!opt.files.length) { console.error('No CSV files given.'); process.exit(2); }

const rows = opt.files.flatMap((f) => parsePortfolioPerformanceCsv(fs.readFileSync(f, 'utf8'), f.split('/').pop()));
console.log(`parsed ${rows.length} rows from ${opt.files.length} file(s)`);

let doc, session;
if (opt.merge) {
  const env = JSON.parse(fs.readFileSync(opt.merge, 'utf8'));
  const u = await unlockWithPassphrase(env, pass);
  doc = u.doc; session = { key: u.key, salt: u.salt, iter: u.iter };
} else { doc = emptyDocument(); session = await newSession(pass); }

// Map raw account labels to generic ids. In merge mode every label must be mapped explicitly,
// otherwise a new account could silently collide with an existing generic id.
const keys = [...new Set(rows.map((r) => r.accountKey))];
let map;
if (opt.merge) {
  const missing = keys.filter((k) => !opt.map[k]);
  if (missing.length) { console.error(`Merge needs --map "Original=existing_or_new_id" for ${missing.length} account(s). Existing ids: ${doc.accounts.map((a) => a.id).join(', ')}`); process.exit(2); }
  const built = buildAccountMap(rows);
  map = {};
  for (const k of keys) {
    const id = opt.map[k]; const known = doc.accounts.find((a) => a.id === id);
    const type = known ? known.type : built[k].type; const label = known ? known.label : null;
    if (!known) { console.error(`Unknown account id ${id}; ids look like taxable_c. Add it by importing in a fresh build.`); process.exit(2); }
    map[k] = { id, type, label };
  }
} else map = buildAccountMap(rows);

console.log('account mapping (original -> stored):');
for (const [k, a] of Object.entries(map)) console.log(`  ${k}  ->  ${a.label || a.id}  [${a.type}]`);

const candidate = { accounts: accountsFromMap(map), transactions: scrubRows(rows, map) };
const defaultDeny = ['fidelity', 'schwab', 'workplace', 'brokerage', 'vanguard', 'chase', 'bank', 'example', 'individual', 'roth ira'];
const hits = findDenylisted(candidate, [...defaultDeny, ...opt.deny]);
const nums = findAccountNumberLike(candidate);
if (hits.length || nums.length) { console.error('BLOCKED', JSON.stringify({ hits: hits.slice(0, 5), nums: nums.slice(0, 5) })); process.exit(3); }

const { doc: merged, added, skipped } = mergeImport(doc, candidate);
validateDocument(merged);
const { issues } = checkLedger(merged.transactions, merged.accounts);
console.log(`transactions: +${added} added, ${skipped} already present, ${merged.transactions.length} total`);
console.log(`review flags: ${merged.transactions.filter((t) => t.flags.includes('REVIEW')).length}; ledger issues: ${issues.length}`);
issues.slice(0, 8).forEach((i) => console.log('  - ' + (i.message || JSON.stringify(i))));

const env = await encryptWithKey(merged, session);
const text = JSON.stringify(env);
// Final guard on exactly what will be committed: it must be a bare envelope.
const keysOut = Object.keys(JSON.parse(text)).sort().join(',');
if (keysOut !== 'cipher,ct,iter,iv,kdf,salt,v') throw new Error('Unexpected envelope shape');
fs.writeFileSync(opt.out, text);
console.log(`wrote ${opt.out} (${text.length} bytes)`);
