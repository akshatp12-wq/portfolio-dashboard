import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortfolioPerformanceCsv } from '../engine/parse.js';
import { buildAccountMap, scrubRows, findDenylisted, findAccountNumberLike, accountsFromMap } from '../engine/scrub.js';
import { encryptDocument, decryptDocument, passphraseStrength } from '../engine/crypto.js';
import { emptyDocument, validateDocument, mergeImport } from '../engine/document.js';
import { checkLedger, endingState } from '../engine/ledger.js';

const SAMPLE = `Date,Type,Value,Transaction Currency,Fees,Taxes,Shares,Ticker Symbol,Security Name,Cash Account,Securities Account,Note
2024-03-11,Deposit,6500.00,USD,,,,,,Alpha Roth IRA Cash,,IRA cash contribution (prior year) acct 123-456789-0
2024-03-28,Interest,18.59,USD,,,,,,Alpha Roth IRA Cash,,SPAXX money-market dividend (treated as cash interest)
2025-02-27,Buy,798.60,USD,,,2,MSFT,MICROSOFT CORP,Alpha Roth IRA Cash,Alpha Roth IRA Securities,Alpha: bought
2025-09-05,Removal,2500.00,USD,,,,,,Beta Individual Cash,,"Tfr Example Bank, JANE DOE"
2022-11-29,Delivery (Inbound),0.00,USD,,,5,AMZN,AMAZON.COM INC,,Beta Individual Securities,OPENING POSITION: cost basis unknown
2025-05-20,Dividend,103.44,USD,,,,FWRD,FORWARD AIR CORP,Beta Individual Cash,Beta Individual Securities,"REVIEW: covered-call premium (FWRD 06/20/2025 20.00 C), net of $0.56 fees"
`;

test('scrub drops notes and brokerage names, keeps closed-vocabulary kinds and flags', () => {
  const raw = parsePortfolioPerformanceCsv(SAMPLE, 'sample.csv');
  const map = buildAccountMap(raw);
  assert.equal(map['Alpha Roth IRA'].type, 'tax_free');
  assert.equal(map['Beta Individual'].type, 'taxable');
  const txs = scrubRows(raw, map);
  const json = JSON.stringify({ accounts: accountsFromMap(map), transactions: txs });
  for (const bad of ['Alpha', 'Beta', 'Example Bank', 'JANE', 'DOE', '123-456789', 'Tfr']) assert.ok(!json.includes(bad), `leaked ${bad}`);
  assert.equal(txs[0].kind, 'contribution');
  assert.equal(txs[1].kind, 'mm_interest');
  assert.equal(txs[4].kind, 'opening');
  assert.deepEqual(txs[5].flags, ['REVIEW']);
  assert.equal(txs[5].kind, 'option_premium');
  assert.ok(!('rawNote' in txs[0]) && !('note' in txs[0]));
});

test('denylist and account-number scans catch leaks', () => {
  const doc = { transactions: [{ ticker: 'MSFT', memo: 'Tfr Example Bank' }], x: 'acct 123-456789-0' };
  const hits = findDenylisted(doc, ['example bank', 'Doe']);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'transactions[0].memo');
  assert.equal(findAccountNumberLike(doc).length, 1);
  assert.equal(findAccountNumberLike({ a: 'MSFT 2 shares 798.60' }).length, 0);
});

test('document schema rejects unexpected fields', () => {
  const doc = emptyDocument();
  doc.accounts.push({ id: 'taxable_a', type: 'taxable', label: 'Taxable A' });
  doc.transactions.push({ id: 't00001', date: '2024-01-01', type: 'Deposit', value: 1, fees: 0, taxes: 0, shares: null, ticker: '', account: 'taxable_a', kind: '', flags: [] });
  assert.ok(validateDocument(doc));
  doc.transactions[0].note = 'oops';
  assert.throws(() => validateDocument(doc), /Unexpected transaction field note/);
});

test('mergeImport de-duplicates identical rows', () => {
  const raw = parsePortfolioPerformanceCsv(SAMPLE, 'sample.csv');
  const map = buildAccountMap(raw);
  const imp = { accounts: accountsFromMap(map), transactions: scrubRows(raw, map) };
  const a = mergeImport(emptyDocument(), imp);
  assert.equal(a.added, 6);
  const b = mergeImport(a.doc, imp);
  assert.equal(b.added, 0); assert.equal(b.skipped, 6);
});

test('ledger checks flag negative cash', () => {
  const raw = parsePortfolioPerformanceCsv(SAMPLE, 'sample.csv');
  const map = buildAccountMap(raw);
  const txs = scrubRows(raw, map);
  const { issues, ending } = checkLedger(txs);
  assert.ok(issues.some((i) => i.level === 'error' && /Cash goes negative/.test(i.msg)));
  assert.equal(ending.pos['taxable_a'].AMZN, 5);
  assert.equal(endingState(txs).cash['tax_free_a'], 6500 + 18.59 - 798.6);
});

test('encryption round-trips, rejects a wrong passphrase, and randomizes salt/iv', async () => {
  const doc = emptyDocument();
  const pass = 'correct horse battery staple ocean';
  const e1 = await encryptDocument(doc, pass, 1000);
  const e2 = await encryptDocument(doc, pass, 1000);
  assert.notEqual(e1.salt, e2.salt); assert.notEqual(e1.iv, e2.iv); assert.notEqual(e1.ct, e2.ct);
  assert.deepEqual(await decryptDocument(e1, pass), doc);
  await assert.rejects(decryptDocument(e1, 'wrong passphrase here ok'), /Wrong passphrase/);
  assert.ok(!JSON.stringify(e1).includes('transactions'));
});

test('passphrase policy', () => {
  assert.equal(passphraseStrength('short').ok, false);
  assert.equal(passphraseStrength('five random words are fine').ok, true);
  assert.equal(passphraseStrength('x'.repeat(20)).ok, true);
});

test('mergeImport keeps legitimate duplicate rows but ignores a re-import', () => {
  const doc = emptyDocument();
  doc.accounts.push({ id: 'taxable_a', type: 'taxable', label: 'Taxable A' });
  const row = { id: 'x', date: '2023-11-21', type: 'Removal', value: 5000, fees: 0, taxes: 0, shares: null, ticker: '', account: 'taxable_a', kind: '', flags: [] };
  const imp = { accounts: doc.accounts, transactions: [structuredClone(row), structuredClone(row)] };
  const a = mergeImport(doc, imp);
  assert.equal(a.added, 2);
  const b = mergeImport(a.doc, imp);
  assert.equal(b.added, 0); assert.equal(b.skipped, 2);
  assert.ok(!('name' in a.doc.transactions[0]));
});
