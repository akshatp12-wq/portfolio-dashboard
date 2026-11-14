// Groups open positions (plus cash) for the Overview table: by account type bucket or by
// comparable security. Pure functions so they can be tested without a browser.

export const BUCKETS = [
  { key: 'taxable', label: 'Taxable' },
  { key: 'tax_deferred', label: '401k / Traditional IRA' },
  { key: 'tax_free', label: 'Roth IRA' },
  { key: 'hsa', label: 'HSA' }
];

// Funds that track the same index are treated as one holding in the "by security" view.
export const COMPARABLE = [
  { key: 'SP500', label: 'S&P 500 index', tickers: ['VOO', 'FXAIX', 'VINIX', 'SPYM', 'SPLG', 'IVV', 'SPY', 'VFIAX', 'SWPPX'] },
  { key: 'LCG', label: 'US large-cap growth', tickers: ['VONG', 'SCHG', 'FSPGX', 'VUG', 'IWF', 'MGK'] }
];
const GROUP_OF = Object.fromEntries(COMPARABLE.flatMap((g) => g.tickers.map((t) => [t, g])));
export const CASH = 'CASH';

// Merges items into one row. Shares and price only make sense for a single ticker.
function merge(label, items, sub = '') {
  const tickers = [...new Set(items.map((i) => i.ticker))];
  const single = tickers.length === 1 && tickers[0] !== CASH;
  const value = items.reduce((s, i) => s + (i.value || 0), 0);
  const basisMissing = items.some((i) => i.basisMissing);
  const cost = items.reduce((s, i) => s + (i.basisMissing ? 0 : i.cost), 0);
  const shares = single ? items.reduce((s, i) => s + i.shares, 0) : null;
  return {
    label, sub, tickers, shares, value, cost, basisMissing,
    priceMissing: items.some((i) => i.priceMissing),
    price: single && shares ? value / shares : null,
    gain: basisMissing ? null : value - cost,
    accounts: [...new Set(items.map((i) => i.account))].length
  };
}
const byValue = (a, b) => (b.value || 0) - (a.value || 0) || a.label.localeCompare(b.label);
function groupBy(items, keyFn) {
  const m = new Map();
  for (const i of items) { const k = keyFn(i); if (!m.has(k)) m.set(k, []); m.get(k).push(i); }
  return m;
}

// items: [{account, ticker, shares, value, cost, basisMissing, priceMissing}], with cash as ticker 'CASH'.
// typeOf: account id -> account type. Returns { sections: [{label, rows, total}], total }.
export function groupPositions(items, mode, typeOf, labelOf = (a) => a) {
  if (mode === 'type') {
    const sections = [];
    for (const b of BUCKETS) {
      const inB = items.filter((i) => typeOf(i.account) === b.key);
      if (!inB.length) continue;
      const rows = [...groupBy(inB, (i) => i.ticker)].map(([t, arr]) => merge(t === CASH ? 'Cash' : t, arr, arr.length > 1 ? `${arr.length} accounts` : labelOf(arr[0].account))).sort(byValue);
      sections.push({ label: b.label, rows, total: merge(b.label, inB) });
    }
    return { sections, total: merge('Total', items) };
  }
  if (mode === 'security') {
    const rows = [...groupBy(items, (i) => (i.ticker === CASH ? CASH : GROUP_OF[i.ticker]?.key || i.ticker))].map(([k, arr]) => {
      const g = COMPARABLE.find((c) => c.key === k);
      const tickers = [...new Set(arr.map((i) => i.ticker))];
      const label = k === CASH ? 'Cash' : g ? g.label : k;
      const sub = g ? tickers.join(', ') : '';
      return merge(label, arr, sub);
    }).sort(byValue);
    return { sections: [{ label: null, rows, total: null }], total: merge('Total', items) };
  }
  // detail: one row per account and ticker
  const rows = items.map((i) => merge(i.ticker === CASH ? 'Cash' : i.ticker, [i], labelOf(i.account))).sort(byValue);
  return { sections: [{ label: null, rows, total: null }], total: merge('Total', items) };
}
