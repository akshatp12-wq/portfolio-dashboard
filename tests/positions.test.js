import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPositions, CASH } from '../engine/positions.js';

const types = { taxable_a: 'taxable', taxable_b: 'taxable', tax_deferred_a: 'tax_deferred', tax_deferred_b: 'tax_deferred', tax_free_a: 'tax_free', hsa_a: 'hsa' };
const it = (account, ticker, shares, value, cost, extra = {}) => ({ account, ticker, shares, value, cost, basisMissing: false, priceMissing: false, ...extra });
const items = [
  it('taxable_a', 'VOO', 10, 5000, 4000), it('tax_free_a', 'VOO', 2, 1000, 900), it('tax_deferred_b', 'VINIX', 5, 2000, 1500),
  it('hsa_a', 'FXAIX', 20, 3000, 2500), it('taxable_b', 'SCHG', 4, 400, 300), it('tax_free_a', 'VONG', 1, 100, 60),
  it('taxable_b', 'META', 2, 1200, 456), it('taxable_a', CASH, null, 500, 500), it('hsa_a', CASH, null, 50, 50)
];

test('by account type: four buckets, merged tickers, subtotals add to the total', () => {
  const g = groupPositions(items, 'type', (a) => types[a]);
  assert.deepEqual(g.sections.map((s) => s.label), ['Taxable', '401k / Traditional IRA', 'Roth IRA', 'HSA']);
  const sum = g.sections.reduce((s, x) => s + x.total.value, 0);
  assert.equal(sum, g.total.value);
  assert.equal(g.total.value, 13250);
  const roth = g.sections[2];
  assert.deepEqual(roth.rows.map((r) => r.label), ['VOO', 'VONG']);
  assert.ok(g.sections[0].rows.some((r) => r.label === 'Cash' && r.value === 500));
});

test('by security: comparable funds collapse across accounts; others stay by ticker', () => {
  const g = groupPositions(items, 'security', (a) => types[a]);
  const rows = Object.fromEntries(g.sections[0].rows.map((r) => [r.label, r]));
  assert.equal(rows['S&P 500 index'].value, 11000);
  assert.equal(rows['S&P 500 index'].cost, 8900);
  assert.equal(rows['S&P 500 index'].shares, null); // mixed funds: no share count
  assert.equal(rows['S&P 500 index'].accounts, 4);
  assert.equal(rows['US large-cap growth'].value, 500);
  assert.equal(rows.META.shares, 2);
  assert.equal(rows.Cash.value, 550);
});

test('missing basis blanks the gain for that row only', () => {
  const g = groupPositions([it('taxable_a', 'COIN', 15, 3000, 0, { basisMissing: true }), it('taxable_a', 'F', 100, 1200, 1343.57)], 'security', (a) => types[a]);
  const rows = Object.fromEntries(g.sections[0].rows.map((r) => [r.label, r]));
  assert.equal(rows.COIN.gain, null);
  assert.ok(Math.abs(rows.F.gain - (1200 - 1343.57)) < 1e-9);
});

test('gain %, annualized over cost-weighted years, and net income % with taxes, fees and expenses', () => {
  // two lots: $1000 held 2 years and $1000 held 0 years -> weighted 1 year
  const a = { account: 'taxable_a', ticker: 'VOO', shares: 4, value: 2420, cost: 2000, costDays: 1000 * 730.5, basisMissing: false, priceMissing: false, income: 40, taxes: 6, fees: 2, expense: 0.726 };
  const g = groupPositions([a], 'detail', () => 'taxable');
  const r = g.sections[0].rows[0];
  assert.ok(Math.abs(r.gainPct - 0.21) < 1e-12);
  assert.ok(Math.abs(r.years - 1) < 1e-9);
  assert.ok(Math.abs(r.cagr - 0.21) < 1e-9);
  assert.ok(Math.abs(r.netPct - (40 - 6 - 2 - 0.726) / 2420) < 1e-12);
  // under a year: no annualized figure
  const short = groupPositions([{ ...a, costDays: 2000 * 100 }], 'detail', () => 'taxable').sections[0].rows[0];
  assert.equal(short.cagr, null);
});

test('sortRows: numbers desc/asc, text A-Z, blanks last', async () => {
  const { sortRows } = await import('../engine/positions.js');
  const rows = [{ label: 'b', gainPct: 0.1 }, { label: 'a', gainPct: null }, { label: 'c', gainPct: -0.2 }];
  assert.deepEqual(sortRows([...rows], 'gainPct', 'desc').map((r) => r.label), ['b', 'c', 'a']);
  assert.deepEqual(sortRows([...rows], 'gainPct', 'asc').map((r) => r.label), ['c', 'b', 'a']);
  assert.deepEqual(sortRows([...rows], 'label', 'asc').map((r) => r.label), ['a', 'b', 'c']);
});

test('opening lots use the true purchase date for holding period', async () => {
  const { buildLots, unrealized } = await import('../engine/lots.js');
  const txs = [{ id: 't1', date: '2022-11-29', type: 'Delivery (Inbound)', value: 0, fees: 0, taxes: 0, shares: 5, ticker: 'BX', account: 'taxable_b', kind: 'opening', flags: [] }];
  const { lots } = buildLots(txs, { openingCostBasis: { BX: 343.79 }, openingDates: { BX: '2021-04-08' } });
  const pb = { lookup: () => ({ price: 120 }) };
  const u = unrealized(lots, pb, '2026-04-08')[0];
  assert.ok(Math.abs(u.costDays / u.cost - 1826) < 2);
});
