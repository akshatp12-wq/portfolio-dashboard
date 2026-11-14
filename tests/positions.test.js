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
