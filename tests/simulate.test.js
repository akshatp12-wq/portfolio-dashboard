import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDocument, validateDocument } from '../engine/document.js';
import { validateTrade, tradeRows, withSimulations, recordTrade, impact, newSimulationId } from '../engine/simulate.js';
import { endingState } from '../engine/ledger.js';
import { PriceBook } from '../engine/prices.js';

function doc() {
  const d = emptyDocument();
  d.accounts = [{ id: 'taxable_a', type: 'taxable', label: 'Taxable A' }];
  d.transactions = [
    { id: 't00001', date: '2024-01-02', type: 'Deposit', value: 10000, fees: 0, taxes: 0, shares: null, ticker: '', account: 'taxable_a', kind: '', flags: [] },
    { id: 't00002', date: '2024-01-03', type: 'Buy', value: 4000, fees: 0, taxes: 0, shares: 10, ticker: 'VOO', account: 'taxable_a', kind: '', flags: [] }
  ];
  return d;
}
const trade = { side: 'Buy', ticker: 'QQQ', date: '2024-02-01', shares: 5, price: 400, fees: 1, account: 'taxable_a', funding: 'cash' };

test('validateTrade rejects free text in ticker and bad numbers', () => {
  const d = doc();
  assert.equal(validateTrade(trade, d.accounts), null);
  assert.match(validateTrade({ ...trade, ticker: 'My Broker Acct 1234' }, d.accounts), /Ticker/);
  assert.match(validateTrade({ ...trade, shares: 0 }, d.accounts), /Shares/);
  assert.match(validateTrade({ ...trade, account: 'nope' }, d.accounts), /account/);
  assert.match(validateTrade({ ...trade, side: 'Sell', funding: 'deposit' }, d.accounts), /sell/i);
});

test('tradeRows: buy includes fees in value; deposit funding adds a same-day deposit', () => {
  const rows = tradeRows(trade, { idPrefix: 'x_', flag: 'SIM', kind: 'simulation' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 2001);
  const funded = tradeRows({ ...trade, funding: 'deposit' }, { idPrefix: 'x_', flag: 'SIM', kind: 'simulation' });
  assert.equal(funded.length, 2);
  assert.equal(funded[0].type, 'Deposit'); assert.equal(funded[0].value, 2001);
  const sell = tradeRows({ ...trade, side: 'Sell' }, { idPrefix: 'x_', flag: 'SIM', kind: 'simulation' });
  assert.equal(sell[0].value, 1999);
});

test('withSimulations merges only enabled sims and never mutates the real ledger', () => {
  const d = doc();
  d.simulations.push({ id: 's0001', name: 'A', ...trade, createdAt: '2024-02-01', enabled: true });
  d.simulations.push({ id: 's0002', name: 'B', ...trade, shares: 1, createdAt: '2024-02-01', enabled: false });
  const m = withSimulations(d);
  assert.deepEqual(m.applied, ['s0001']);
  assert.equal(m.transactions.length, 3);
  assert.equal(d.transactions.length, 2);
  assert.ok(m.transactions[2].flags.includes('SIM'));
  const st = endingState(m.transactions);
  assert.equal(st.pos.taxable_a.QQQ, 5);
  assert.equal(st.cash.taxable_a, 10000 - 4000 - 2001);
  assert.equal(newSimulationId(d), 's0003');
  validateDocument(d);
});

test('validateDocument rejects simulation names with disallowed characters and unknown fields', () => {
  const d = doc();
  d.simulations.push({ id: 's0001', name: 'ok name 70/30', ...trade, createdAt: '2024-02-01', enabled: true });
  validateDocument(d);
  d.simulations[0].name = 'call <John> at bank';
  assert.throws(() => validateDocument(d), /name/);
  d.simulations[0].name = 'fine'; d.simulations[0].note = 'free text';
  assert.throws(() => validateDocument(d), /Unexpected simulation field/);
});

test('recordTrade appends real MANUAL rows with sequential ids', () => {
  const d = doc();
  const rows = recordTrade(d, { ...trade, funding: 'deposit' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.id), ['t00003', 't00004']);
  assert.ok(d.transactions.every((t) => t.id.startsWith('t')));
  assert.ok(rows.every((r) => r.flags.includes('MANUAL')));
  validateDocument(d);
});

test('impact reports weight and cash before/after', () => {
  const d = doc();
  const pb = new PriceBook({ tickers: { VOO: { close: { '2024-03-01': 500 }, adjClose: { '2024-03-01': 500 } }, QQQ: { close: { '2024-03-01': 400 }, adjClose: { '2024-03-01': 400 } } } }, {});
  const rows = tradeRows(trade, { idPrefix: 'p_', flag: 'SIM', kind: 'simulation' });
  const im = impact({ transactions: d.transactions, simRows: rows, accounts: ['taxable_a'], priceBook: pb, asOf: '2024-03-01', endingState });
  assert.equal(im.before.cash, 6000); assert.equal(im.after.cash, 3999);
  assert.equal(im.before.total, 11000);
  assert.ok(Math.abs(im.after.total - (3999 + 5000 + 2000)) < 1e-6);
  assert.equal(im.weights[0].ticker, 'QQQ'); assert.equal(im.weights[0].before, 0);
  assert.ok(Math.abs(im.weights[0].after - 2000 / 10999) < 1e-9);
  assert.equal(im.cashNegative, false);
});
