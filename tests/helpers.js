import { PriceBook } from '../engine/prices.js';
import { eachDay } from '../engine/dates.js';

// Builds a PriceBook with a constant or function price for each ticker across a date range.
export function book(spec, from, to) {
  const tickers = {};
  for (const [t, fn] of Object.entries(spec)) {
    const close = {}, adjClose = {};
    for (const d of eachDay(from, to)) { const p = typeof fn === 'function' ? fn(d) : fn; close[d] = p; adjClose[d] = p; }
    tickers[t] = { source: 'test', asOf: to, close, adjClose };
  }
  return new PriceBook({ tickers });
}

export const ACCTS = [
  { id: 'taxable_a', type: 'taxable', label: 'Taxable A' },
  { id: 'tax_free_a', type: 'tax_free', label: 'Roth IRA' },
  { id: 'tax_deferred_a', type: 'tax_deferred', label: 'Traditional IRA' }
];

let n = 0;
export function tx(o) {
  n++;
  return { id: `t${String(n).padStart(5, '0')}`, fees: 0, taxes: 0, shares: null, ticker: '', kind: '', flags: [], ...o };
}

export const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
