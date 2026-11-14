// Ledger: turns scrubbed transactions into cash balances, positions, and
// external flows per account and per day.
import { eachDay } from './dates.js';

export const INTERNAL_KINDS = new Set(['conversion_in', 'conversion_out']);

export function sortTxs(txs) {
  const prio = { 'Deposit': 0, 'Delivery (Inbound)': 0, 'Transfer (Inbound)': 0, 'Interest': 1, 'Dividend': 1,
    'Sell': 2, 'Buy': 3, 'Fees': 3, 'Taxes': 3, 'Removal': 4, 'Delivery (Outbound)': 4, 'Transfer (Outbound)': 4 };
  return [...txs].sort((a, b) => a.date.localeCompare(b.date) || (prio[a.type] - prio[b.type]) || a.id.localeCompare(b.id));
}

// Applies one transaction to a mutable state {cash:{acct}, pos:{acct:{ticker:shares}}}.
export function applyTx(state, t) {
  state.cash[t.account] ??= 0;
  state.pos[t.account] ??= {};
  const pos = state.pos[t.account];
  const addShares = (n) => { pos[t.ticker] = round6((pos[t.ticker] || 0) + n); if (Math.abs(pos[t.ticker]) < 1e-9) delete pos[t.ticker]; };
  switch (t.type) {
    case 'Buy': state.cash[t.account] -= t.value; addShares(t.shares); break;
    case 'Sell': state.cash[t.account] += t.value; addShares(-t.shares); break;
    case 'Dividend': case 'Interest': case 'Deposit': case 'Transfer (Inbound)': state.cash[t.account] += t.value; break;
    case 'Removal': case 'Fees': case 'Taxes': case 'Transfer (Outbound)': state.cash[t.account] -= t.value; break;
    case 'Delivery (Inbound)': addShares(t.shares); break;
    case 'Delivery (Outbound)': addShares(-t.shares); break;
    default: throw new Error('Unknown type ' + t.type);
  }
  state.cash[t.account] = round2(state.cash[t.account]);
}

export function endingState(txs) {
  const state = { cash: {}, pos: {} };
  sortTxs(txs).forEach((t) => applyTx(state, t));
  return state;
}

// Integrity checks: negative cash, negative shares, coverage gaps.
export function checkLedger(txs, accounts) {
  const issues = [];
  const state = { cash: {}, pos: {} };
  const lowest = {};
  const lastDate = {};
  for (const t of sortTxs(txs)) {
    applyTx(state, t);
    const c = state.cash[t.account];
    if (lowest[t.account] == null || c < lowest[t.account].cash) lowest[t.account] = { cash: c, date: t.date };
    for (const [tk, sh] of Object.entries(state.pos[t.account])) if (sh < -1e-9) issues.push({ level: 'error', account: t.account, msg: `Negative shares ${tk} ${sh} on ${t.date}` });
    if (lastDate[t.account] && gapDays(lastDate[t.account], t.date) > 45) issues.push({ level: 'warn', account: t.account, msg: `No activity ${lastDate[t.account]} to ${t.date} (${gapDays(lastDate[t.account], t.date)} days)` });
    lastDate[t.account] = t.date;
  }
  for (const [a, l] of Object.entries(lowest)) if (l.cash < -0.005) issues.push({ level: 'error', account: a, msg: `Cash goes negative: lowest ${l.cash.toFixed(2)} on ${l.date}. Add an opening cash deposit.` });
  return { issues, ending: state };
}

const gapDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Daily series for a set of accounts. Returns [{date, cash, holdingsValue, value, flow, flags}].
// External flows: Deposit/Removal always; Transfer and conversion kinds only when `scope` excludes the counterparty.
// Delivery (Inbound/Outbound) with value 0 counts as a flow at market value (performance basis).
export function dailySeries({ txs, accounts, priceBook, from, to, openingCash = {} }) {
  const ids = new Set(accounts);
  const mine = sortTxs(txs.filter((t) => ids.has(t.account)));
  const byDate = {};
  mine.forEach((t) => (byDate[t.date] ??= []).push(t));
  const state = { cash: {}, pos: {} };
  // opening cash is an external flow dated the day before the first transaction, or `from`
  const first = mine[0]?.date ?? from;
  const start = from && from < first ? from : first;
  const out = [];
  const flags = new Set();
  for (const d of eachDay(start, to)) {
    let flow = 0;
    if (d === start) for (const [a, amt] of Object.entries(openingCash)) if (ids.has(a) && amt) { state.cash[a] = (state.cash[a] || 0) + amt; flow += amt; }
    for (const t of byDate[d] || []) {
      if (t.type === 'Deposit' || t.type === 'Removal' || t.type.startsWith('Transfer')) {
        const internal = INTERNAL_KINDS.has(t.kind) && ids.size > 1 && hasCounterparty(mine, t);
        if (!internal) flow += (t.type === 'Deposit' || t.type === 'Transfer (Inbound)') ? t.value : -t.value;
      }
      if (t.type.startsWith('Delivery')) {
        const px = priceBook.lookup(t.ticker, d);
        // Delivery rows usually carry the market value in Value; only warn when neither is usable.
        const mv = px.price != null ? px.price * t.shares : t.value;
        flow += t.type === 'Delivery (Inbound)' ? mv : -mv;
      }
      applyTx(state, t);
    }
    let holdingsValue = 0;
    for (const [a, pos] of Object.entries(state.pos)) for (const [tk, sh] of Object.entries(pos)) {
      const px = priceBook.lookup(tk, d);
      if (px.price == null) { flags.add(`No price for ${tk}`); continue; }
      if (px.stale) flags.add(`Stale price for ${tk} (last ${px.date})`);
      holdingsValue += sh * px.price;
    }
    const cash = Object.values(state.cash).reduce((s, c) => s + c, 0);
    out.push({ date: d, cash: round2(cash), holdingsValue: round2(holdingsValue), value: round2(cash + holdingsValue), flow: round2(flow) });
  }
  return { series: out, flags: [...flags], ending: state };
}

function hasCounterparty(all, t) {
  const want = t.kind === 'conversion_out' ? 'conversion_in' : 'conversion_out';
  return all.some((u) => u.kind === want && u.date === t.date && Math.abs(u.value - t.value) < 0.01 && u.account !== t.account);
}

export const round2 = (n) => Math.round(n * 100) / 100;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;
