import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailySeries } from '../engine/ledger.js';
import { twr, xirrFromSeries, growthOf100 } from '../engine/returns.js';
import { simulateBenchmark } from '../engine/benchmark.js';
import { book, tx, close } from './helpers.js';

// Price doubles linearly from 100 to 200 over 2024 (so returns are not trivial).
const px = (d) => 100 + 100 * ((Date.parse(d) - Date.parse('2024-01-01')) / (Date.parse('2024-12-31') - Date.parse('2024-01-01')));

test('TWR ignores an interim deposit; XIRR does not', () => {
  const pb = book({ ABC: px }, '2024-01-01', '2024-12-31');
  const base = [
    tx({ date: '2024-01-01', type: 'Deposit', value: 1000, account: 'taxable_a' }),
    tx({ date: '2024-01-01', type: 'Buy', value: 1000, shares: 10, ticker: 'ABC', account: 'taxable_a' })
  ];
  const withDeposit = [...base,
    tx({ date: '2024-07-01', type: 'Deposit', value: 5000, account: 'taxable_a' }),
    tx({ date: '2024-07-01', type: 'Buy', value: 5000, shares: 5000 / px('2024-07-01'), ticker: 'ABC', account: 'taxable_a' })
  ];
  const a = dailySeries({ txs: base, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  const b = dailySeries({ txs: withDeposit, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  const ta = twr(a.series).total, tb = twr(b.series).total;
  assert.ok(close(ta, 1.0, 1e-6), `buy-and-hold TWR should be +100%, got ${ta}`);
  // The deposit is invested at that day's close, so it earns nothing for one day.
  // TWR may differ by at most that one day's dilution, never by the size of the deposit.
  const oneDay = px('2024-07-01') / px('2024-06-30') - 1;
  assert.ok(Math.abs(ta - tb) < 2 * oneDay, `deposit changed TWR by more than one day's return: ${ta} vs ${tb}`);
  const xa = xirrFromSeries(a.series), xb = xirrFromSeries(b.series);
  assert.ok(Math.abs(xa - xb) > 0.05, 'XIRR should differ when a large deposit arrives mid-year');
});

test('a deposit held as cash on a flat-price day leaves TWR exactly unchanged', () => {
  const flatThenUp = (d) => (d <= '2024-06-30' ? 100 : 150);
  const pb = book({ ABC: flatThenUp }, '2024-01-01', '2024-12-31');
  const base = [
    tx({ date: '2024-01-01', type: 'Deposit', value: 1000, account: 'taxable_a' }),
    tx({ date: '2024-01-01', type: 'Buy', value: 1000, shares: 10, ticker: 'ABC', account: 'taxable_a' })
  ];
  const withDeposit = [...base,
    tx({ date: '2024-03-01', type: 'Deposit', value: 9000, account: 'taxable_a' }),
    tx({ date: '2024-03-02', type: 'Buy', value: 9000, shares: 90, ticker: 'ABC', account: 'taxable_a' })
  ];
  const a = dailySeries({ txs: base, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  const b = dailySeries({ txs: withDeposit, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  assert.ok(close(twr(a.series).total, 0.5, 1e-9));
  assert.ok(close(twr(a.series).total, twr(b.series).total, 1e-9), 'deposit on a flat day must not move TWR');
});

test('buy-and-hold value equals shares × price every day', () => {
  const pb = book({ ABC: px }, '2024-01-01', '2024-12-31');
  const txs = [
    tx({ date: '2024-01-01', type: 'Deposit', value: 1000, account: 'taxable_a' }),
    tx({ date: '2024-01-01', type: 'Buy', value: 1000, shares: 10, ticker: 'ABC', account: 'taxable_a' })
  ];
  const { series } = dailySeries({ txs, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  for (const p of series) assert.ok(close(p.value, 10 * px(p.date), 0.01), `${p.date}: ${p.value} vs ${10 * px(p.date)}`);
});

test('opening Delivery (Inbound) at zero cost uses market value as performance basis', () => {
  const pb = book({ ABC: px }, '2024-01-01', '2024-12-31');
  const txs = [tx({ date: '2024-01-01', type: 'Delivery (Inbound)', value: 0, shares: 10, ticker: 'ABC', account: 'taxable_a', kind: 'opening' })];
  const { series } = dailySeries({ txs, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  assert.equal(series[0].flow, 1000);
  const t = twr(series);
  assert.ok(Number.isFinite(t.total) && close(t.total, 1.0, 1e-6), `expected +100%, got ${t.total}`);
});

test('Roth conversion nets out in a combined view but is a flow per account', () => {
  const pb = book({}, '2024-01-01', '2024-01-10');
  const txs = [
    tx({ date: '2024-01-01', type: 'Deposit', value: 7000, account: 'tax_deferred_a' }),
    tx({ date: '2024-01-05', type: 'Removal', value: 7000, account: 'tax_deferred_a', kind: 'conversion_out' }),
    tx({ date: '2024-01-05', type: 'Deposit', value: 7000, account: 'tax_free_a', kind: 'conversion_in' })
  ];
  const combined = dailySeries({ txs, accounts: ['tax_deferred_a', 'tax_free_a'], priceBook: pb, to: '2024-01-10' });
  assert.equal(combined.series.find((p) => p.date === '2024-01-05').flow, 0);
  const roth = dailySeries({ txs, accounts: ['tax_free_a'], priceBook: pb, to: '2024-01-10' });
  assert.equal(roth.series.find((p) => p.date === '2024-01-05').flow, 7000);
});

test('100% VOO portfolio matches the VOO benchmark simulation exactly', () => {
  const pb = book({ VOO: px }, '2024-01-01', '2024-12-31');
  const txs = [
    tx({ date: '2024-01-01', type: 'Deposit', value: 1000, account: 'taxable_a' }),
    tx({ date: '2024-01-01', type: 'Buy', value: 1000, shares: 10, ticker: 'VOO', account: 'taxable_a' }),
    tx({ date: '2024-04-01', type: 'Deposit', value: 500, account: 'taxable_a' }),
    tx({ date: '2024-04-01', type: 'Buy', value: 500, shares: 500 / px('2024-04-01'), ticker: 'VOO', account: 'taxable_a' })
  ];
  const { series } = dailySeries({ txs, accounts: ['taxable_a'], priceBook: pb, to: '2024-12-31' });
  const bench = simulateBenchmark({ series, priceBook: pb, mix: { weights: { VOO: 100 } } });
  for (let i = 0; i < series.length; i++) assert.ok(close(series[i].value, bench.series[i].value, 0.02), `${series[i].date}: ${series[i].value} vs ${bench.series[i].value}`);
  assert.ok(close(twr(series).total, twr(bench.series).total, 1e-6));
});

test('user-defined 50/50 mix with monthly rebalancing matches a hand computation', () => {
  // A flat at 100, B doubles over Jan then flat. Monthly rebalance on Feb 1.
  const pA = () => 100;
  const pB = (d) => (d <= '2024-01-31' ? 100 + 100 * (Number(d.slice(8, 10)) - 1) / 30 : 200);
  const pb = book({ A: pA, B: pB }, '2024-01-01', '2024-02-29');
  const series = [...Array(60)].map((_, i) => { const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10); return { date: d, value: 0, flow: i === 0 ? 1000 : 0 }; });
  const r = simulateBenchmark({ series, priceBook: pb, mix: { weights: { A: 50, B: 50 }, rebalance: 'monthly' } });
  const jan31 = r.series.find((p) => p.date === '2024-01-31').value; // 500 in A + 5 units of B at 200 = 1500
  assert.ok(close(jan31, 1500, 0.01), `jan31 ${jan31}`);
  const feb1 = r.series.find((p) => p.date === '2024-02-01').value; // rebalanced, value unchanged on the day
  assert.ok(close(feb1, 1500, 0.01), `feb1 ${feb1}`);
  // After rebalance: 750 in A (7.5 units), 750 in B (3.75 units). Both flat in Feb → still 1500.
  assert.ok(close(r.series[r.series.length - 1].value, 1500, 0.01));
});

test('growth of 100 starts at the first day return', () => {
  const series = [{ date: '2024-01-01', value: 110, flow: 100 }, { date: '2024-01-02', value: 121, flow: 0 }];
  const g = growthOf100(series);
  assert.ok(close(g[0].value, 110) && close(g[1].value, 121));
});
