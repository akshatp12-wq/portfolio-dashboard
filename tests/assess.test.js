import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, drawdowns, monthlyReturns, presetWindow, rfDailyFromYields } from '../engine/metrics.js';
import { ols, factorRegression } from '../engine/regression.js';
import { buildLots, detectWashSales, summarizeRealized } from '../engine/lots.js';
import { lookThrough, concentration } from '../engine/exposure.js';
import { tx, close } from './helpers.js';

const days = (n, start = '2023-01-02') => [...Array(n)].map((_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10));

test('drawdown and monthly returns', () => {
  const d = [{ date: '2024-01-01', r: 0.1 }, { date: '2024-01-02', r: -0.5 }, { date: '2024-02-01', r: 0.2 }];
  const dd = drawdowns(d);
  assert.ok(close(dd.maxDrawdown, -0.5)); assert.equal(dd.maxDrawdownDate, '2024-01-02');
  assert.ok(close(dd.currentDrawdown, 0.66 / 1.1 - 1));
  const m = monthlyReturns(d);
  assert.equal(m.length, 2); assert.ok(close(m[0].r, 1.1 * 0.5 - 1)); assert.ok(close(m[1].r, 0.2));
});

test('metrics: identical portfolio and benchmark give beta 1, IR null, capture 1; short windows are flagged', () => {
  const ds = days(800);
  const series = ds.map((date, i) => ({ date, r: 0.0005 + 0.01 * Math.sin(i) }));
  const m = computeMetrics({ portfolio: series, benchmark: series, rfDaily: ds.map((date) => ({ date, r: 0 })) });
  assert.equal(m.quality, 'provisional');
  assert.ok(close(m.portfolio.beta, 1, 1e-9));
  assert.equal(m.portfolio.infoRatio, null);
  assert.ok(close(m.portfolio.downsideCapture, 1, 1e-9));
  assert.ok(close(m.portfolio.sharpe, m.benchmark.sharpe, 1e-12));
  assert.ok(m.portfolio.cagr != null);
  const short = computeMetrics({ portfolio: series.slice(0, 200), benchmark: series.slice(0, 200) });
  assert.equal(short.quality, 'insufficient'); assert.equal(short.portfolio.sharpe, null);
});

test('preset windows and risk-free conversion', () => {
  assert.deepEqual(presetWindow('1Y', '2026-03-15', '2020-01-01'), ['2025-03-15', '2026-03-15']);
  assert.deepEqual(presetWindow('YTD', '2026-03-15', '2020-01-01'), ['2026-01-01', '2026-03-15']);
  const rf = rfDailyFromYields({ '2026-01-01': 4.0 }, ['2026-01-02']);
  assert.ok(close(Math.pow(1 + rf[0].r, 252) - 1, 0.04, 1e-9));
});

test('OLS recovers known coefficients; factor regression aligns dates', () => {
  const X = [...Array(200)].map((_, i) => [Math.sin(i), Math.cos(i * 0.7)]);
  const y = X.map(([a, b]) => 0.001 + 0.8 * a - 0.3 * b);
  const r = ols(y, X);
  assert.ok(close(r.alpha, 0.001, 1e-9) && close(r.betas[0], 0.8, 1e-9) && close(r.betas[1], -0.3, 1e-9) && close(r.r2, 1, 1e-9));
  const ds = days(200);
  const f = { Market: ds.map((date, i) => ({ date, r: Math.sin(i) / 100 })) };
  const p = ds.map((date, i) => ({ date, r: 0.5 * Math.sin(i) / 100 }));
  const fr = factorRegression(p, f, null);
  assert.ok(close(fr.betas.Market, 0.5, 1e-9)); assert.equal(fr.n, 200);
});

test('FIFO lots, ST/LT terms, opening basis, and cross-account wash sale', () => {
  const txs = [
    tx({ date: '2022-01-10', type: 'Delivery (Inbound)', value: 0, shares: 10, ticker: 'ABC', account: 'taxable_a', kind: 'opening' }),
    tx({ date: '2023-06-01', type: 'Buy', value: 500, shares: 5, ticker: 'ABC', account: 'taxable_a' }),
    tx({ date: '2023-07-01', type: 'Sell', value: 1200, shares: 12, ticker: 'ABC', account: 'taxable_a' }),   // 10 from opening (LT), 2 from June lot (ST)
    tx({ date: '2024-02-01', type: 'Sell', value: 150, shares: 3, ticker: 'ABC', account: 'taxable_a' }),     // remaining June lot at a loss
    tx({ date: '2024-02-15', type: 'Buy', value: 160, shares: 3, ticker: 'ABC', account: 'tax_free_a' })      // IRA repurchase within 30 days
  ];
  const { lots, realized, flags } = buildLots(txs, { openingCostBasis: { ABC: 800 } });
  assert.equal(flags.length, 0);
  assert.equal(realized.length, 3);
  const [a, b, c] = realized;
  assert.equal(a.term, 'LT'); assert.ok(close(a.gain, 1000 - 800));
  assert.equal(b.term, 'ST'); assert.ok(close(b.gain, 200 - 200));
  assert.equal(c.term, 'ST'); assert.ok(close(c.gain, 150 - 300));
  const ws = detectWashSales(realized, txs);
  assert.equal(ws[2].washSale, true); assert.ok(close(ws[2].disallowed, 150)); assert.deepEqual(ws[2].replacementAccount, ['tax_free_a']);
  const s = summarizeRealized(ws, { from: '2024-01-01' });
  assert.ok(close(s.shortTerm, -150) && close(s.disallowed, 150) && s.washCount === 1);
  assert.equal(Object.values(lots).flat().filter((l) => l.shares > 0).length, 1);
  const missing = buildLots(txs.slice(0, 1));
  assert.ok(missing.flags[0].includes('no cost basis'));
});

test('look-through exposure, overlap and expense ratio', () => {
  const fundmeta = { tickers: {
    FUND: { kind: 'etf', expense: 0.001, sectors: { Tech: 50, Health: 50 }, top: { AAA: 0.2 } },
    PROXY: { kind: 'mutual_fund', proxy: 'FUND', expense: 0.0005 },
    AAA: { kind: 'stock', sector: 'Tech' }
  } };
  const r = lookThrough([{ ticker: 'FUND', value: 500 }, { ticker: 'PROXY', value: 250 }, { ticker: 'AAA', value: 250 }], fundmeta);
  const tech = r.sectors.find((s) => s.sector === 'Tech').weight;
  assert.ok(close(tech, 0.5 * 0.5 + 0.25 * 0.5 + 0.25, 1e-9));
  const aaa = r.overlap.find((o) => o.ticker === 'AAA');
  assert.ok(close(aaa.direct, 0.25) && close(aaa.viaFunds, 0.75 * 0.2));
  assert.ok(close(r.expenseRatio, 0.5 * 0.001 + 0.25 * 0.0005, 1e-12));
  assert.ok(r.notes.some((n) => /proxy/.test(n)));
  const c = concentration([{ ticker: 'A', value: 50 }, { ticker: 'B', value: 50 }]);
  assert.ok(close(c.effectiveN, 2) && close(c.top5, 1));
});
