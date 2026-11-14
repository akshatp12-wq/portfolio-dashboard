// FIFO tax lots, realized gains by term, cross-account wash-sale detection, unrealized by lot.
import { sortTxs } from './ledger.js';
import { daysBetween } from './dates.js';

// openingCostBasis: {ticker: totalCost} applied to opening Delivery (Inbound) lots.
// openingDates: {ticker: yyyy-mm-dd} true purchase date of an opening lot (holding period, terms).
export function buildLots(txs, { openingCostBasis = {}, openingDates = {} } = {}) {
  const lots = {};         // key account|ticker -> [{date, shares, cost, origDate, flags}]
  const realized = [];     // {date, account, ticker, shares, proceeds, cost, gain, term, holdDays, lotDate}
  const flags = [];
  const key = (t) => `${t.account}|${t.ticker}`;
  for (const t of sortTxs(txs)) {
    if (!t.ticker) continue;
    const k = key(t); lots[k] ??= [];
    if (t.type === 'Buy') lots[k].push({ date: t.date, shares: t.shares, cost: t.value, origDate: t.date, kind: t.kind });
    else if (t.type === 'Delivery (Inbound)') {
      if (t.kind === 'split' && lots[k].length) {
        // Split shares inherit the earliest lot's date and carry zero incremental cost.
        lots[k].push({ date: lots[k][0].origDate, shares: t.shares, cost: 0, origDate: lots[k][0].origDate, kind: 'split' });
      } else {
        const basis = t.kind === 'opening' ? openingCostBasis[t.ticker] : t.value;
        if (t.kind === 'opening' && basis == null) flags.push(`Opening lot ${t.ticker} in ${t.account} has no cost basis; gain/loss will be overstated`);
        const since = (t.kind === 'opening' && openingDates[t.ticker]) || t.date;
        lots[k].push({ date: since, shares: t.shares, cost: basis ?? 0, origDate: since, kind: t.kind, basisMissing: t.kind === 'opening' && basis == null });
      }
    } else if (t.type === 'Sell' || t.type === 'Delivery (Outbound)') {
      let remaining = t.shares;
      const proceedsPerShare = t.type === 'Sell' ? t.value / t.shares : 0;
      while (remaining > 1e-9 && lots[k].length) {
        const lot = lots[k][0];
        const take = Math.min(remaining, lot.shares);
        const cost = lot.cost * (take / lot.shares);
        const holdDays = daysBetween(lot.origDate, t.date);
        if (t.type === 'Sell') realized.push({ date: t.date, account: t.account, ticker: t.ticker, shares: take, proceeds: proceedsPerShare * take, cost, gain: proceedsPerShare * take - cost, term: holdDays > 365 ? 'LT' : 'ST', holdDays, lotDate: lot.origDate, basisMissing: !!lot.basisMissing });
        lot.shares -= take; lot.cost -= cost; remaining -= take;
        if (lot.shares <= 1e-9) lots[k].shift();
      }
      if (remaining > 1e-9) flags.push(`Sold ${remaining} ${t.ticker} in ${t.account} with no lot to match on ${t.date}`);
    }
  }
  return { lots, realized, flags };
}

// Wash sales: a realized loss where the same ticker was bought in ANY account within 30 days
// before or after. Returns realized rows annotated with {washSale, disallowed, replacementAccount}.
export function detectWashSales(realized, txs) {
  const buys = sortTxs(txs).filter((t) => t.type === 'Buy' && t.ticker);
  return realized.map((r) => {
    if (r.gain >= 0) return { ...r, washSale: false, disallowed: 0 };
    const repl = buys.filter((b) => b.ticker === r.ticker && Math.abs(daysBetween(b.date, r.date)) <= 30 && !(b.date === r.date && b.account === r.account && b.shares === r.shares));
    if (!repl.length) return { ...r, washSale: false, disallowed: 0 };
    const replShares = repl.reduce((s, b) => s + b.shares, 0);
    const frac = Math.min(1, replShares / r.shares);
    return { ...r, washSale: true, disallowed: -r.gain * frac, replacementAccount: [...new Set(repl.map((b) => b.account))] };
  });
}

export function summarizeRealized(rows, { from, to, accounts } = {}) {
  const sel = rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to) && (!accounts || accounts.includes(r.account)));
  const sum = (f) => sel.filter(f).reduce((s, r) => s + r.gain, 0);
  return { shortTerm: sum((r) => r.term === 'ST'), longTerm: sum((r) => r.term === 'LT'), disallowed: sel.reduce((s, r) => s + (r.disallowed || 0), 0), washCount: sel.filter((r) => r.washSale).length, rows: sel };
}

// Unrealized by position using current prices. Returns [{account, ticker, shares, cost, value, gain, basisMissing}].
export function unrealized(lots, priceBook, date) {
  const out = [];
  for (const [k, arr] of Object.entries(lots)) {
    if (!arr.length) continue;
    const [account, ticker] = k.split('|');
    const shares = arr.reduce((s, l) => s + l.shares, 0), cost = arr.reduce((s, l) => s + l.cost, 0);
    // cost-weighted holding days over lots with a known basis, for an annualized return
    const costDays = arr.reduce((s, l) => s + (l.basisMissing ? 0 : l.cost * Math.max(0, daysBetween(l.origDate, date))), 0);
    const px = priceBook.lookup(ticker, date).price;
    out.push({ account, ticker, shares, cost, costDays, value: px == null ? null : px * shares, gain: px == null ? null : px * shares - cost, basisMissing: arr.some((l) => l.basisMissing), priceMissing: px == null });
  }
  return out;
}
