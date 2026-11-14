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
  const sum = (f) => items.reduce((s, i) => s + (i[f] || 0), 0);
  const isCash = tickers.length === 1 && tickers[0] === CASH;
  // Invested (non-cash) part drives gain %, which must exclude cash rows in mixed groups.
  const inv = items.filter((i) => i.ticker !== CASH && !i.basisMissing);
  const invValue = inv.reduce((s, i) => s + (i.value || 0), 0), invCost = inv.reduce((s, i) => s + i.cost, 0);
  const costDays = inv.reduce((s, i) => s + (i.costDays || 0), 0);
  const years = invCost > 0 ? costDays / invCost / 365.25 : 0;
  const gainPct = !isCash && invCost > 0 ? invValue / invCost - 1 : null;
  // Annualized over the cost-weighted holding period. Under a year, annualizing exaggerates,
  // so the plain gain % is reported and flagged instead.
  const cagr = gainPct == null ? null : years >= 1 ? Math.pow(invValue / invCost, 1 / years) - 1 : null;
  const income = sum('income'), taxes = sum('taxes'), fees = sum('fees'), expense = sum('expense');
  const net = income - taxes - fees - expense;
  return {
    label, sub, tickers, shares, value, cost, basisMissing,
    priceMissing: items.some((i) => i.priceMissing),
    price: single && shares ? value / shares : null,
    gain: basisMissing ? null : value - cost,
    gainPct, cagr, years,
    income, taxes, fees, expense, net,
    // yield base: market value for securities, average balance for cash (items may set .base)
    netPct: (() => { const b = items.reduce((x, i) => x + (i.base === undefined ? (i.value || 0) : (i.base || 0)), 0); return b > 0 ? net / b : null; })(),
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

// Sorts rows in place by a column key; text columns sort A-Z, numbers high-to-low first.
export const SORT_KEYS = { label: 'text', sub: 'text', shares: 'num', price: 'num', value: 'num', valuePct: 'num', cost: 'num', costPct: 'num', gain: 'num', gainPct: 'num', cagr: 'num', netPct: 'num' };
export function sortRows(rows, key, dir) {
  const k = key === 'valuePct' ? 'value' : key === 'costPct' ? 'cost' : key;
  const text = SORT_KEYS[key] === 'text';
  const sign = dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;            // blanks always last
    if (y == null) return -1;
    return sign * (text ? String(x).localeCompare(String(y)) : x - y);
  });
}
