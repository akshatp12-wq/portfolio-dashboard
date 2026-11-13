// Simulation layer: hypothetical trades stored in doc.simulations and merged into the
// transaction list on demand, so every view can show "with simulations" without
// touching the real ledger. "Actually bought" trades bypass this and are appended to
// doc.transactions as real rows carrying a MANUAL flag.

const SIM_FIELDS = new Set(['id', 'name', 'date', 'side', 'ticker', 'shares', 'price', 'fees', 'account', 'funding', 'createdAt', 'enabled']);
export const FUNDING = ['cash', 'deposit'];   // pay from account cash, or add a same-day Deposit to cover it

export function newSimulationId(doc) {
  const n = (doc.simulations || []).reduce((m, s) => Math.max(m, Number((s.id || '').replace(/\D/g, '')) || 0), 0);
  return `s${String(n + 1).padStart(4, '0')}`;
}

export function validateTrade(t, accounts) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) return 'Date must be yyyy-mm-dd.';
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t.ticker || '')) return 'Ticker must be letters/digits only (no names or notes).';
  if (!(t.shares > 0)) return 'Shares must be positive.';
  if (!(t.price > 0)) return 'Price must be positive.';
  if (t.fees < 0 || !Number.isFinite(t.fees ?? 0)) return 'Fees must be zero or positive.';
  if (!accounts.some((a) => a.id === t.account)) return 'Pick an account.';
  if (!['Buy', 'Sell'].includes(t.side)) return 'Side must be Buy or Sell.';
  if (t.side === 'Sell' && t.funding === 'deposit') return 'A sell needs no funding deposit.';
  return null;
}

export function validateSimulation(s) {
  for (const k of Object.keys(s)) if (!SIM_FIELDS.has(k)) throw new Error(`Unexpected simulation field ${k}`);
  if (!/^[\w \-/.%]{1,40}$/.test(s.name || '')) throw new Error('Simulation name: letters, digits, spaces, - / . % only, up to 40 characters.');
  return true;
}

// Builds the real transaction rows a trade implies. Buy: value = shares*price + fees.
// Sell: value = shares*price - fees. Optional Deposit covers the buy on the same day.
export function tradeRows(t, { idPrefix, flag, kind }) {
  const gross = round2(t.shares * t.price);
  const fees = round2(t.fees || 0);
  const rows = [];
  if (t.side === 'Buy' && t.funding === 'deposit') {
    rows.push({ id: `${idPrefix}d`, date: t.date, type: 'Deposit', value: round2(gross + fees), fees: 0, taxes: 0, shares: null, ticker: '', account: t.account, kind, flags: [flag] });
  }
  rows.push({ id: `${idPrefix}t`, date: t.date, type: t.side, value: t.side === 'Buy' ? round2(gross + fees) : round2(gross - fees), fees, taxes: 0, shares: Number(t.shares), ticker: t.ticker, account: t.account, kind, flags: [flag] });
  return rows;
}

// Real transactions plus the enabled simulations (or the given ids), as one list.
export function withSimulations(doc, ids = null) {
  const sims = (doc.simulations || []).filter((s) => (ids ? ids.includes(s.id) : s.enabled !== false));
  const extra = sims.flatMap((s) => tradeRows(s, { idPrefix: `${s.id}_`, flag: 'SIM', kind: 'simulation' }));
  return { transactions: [...doc.transactions, ...extra], applied: sims.map((s) => s.id) };
}

// Appends a real ("actually bought") trade to the document. Returns the new rows.
export function recordTrade(doc, t) {
  const n = doc.transactions.length;
  const rows = tradeRows(t, { idPrefix: `t${String(n + 1).padStart(5, '0')}`, flag: 'MANUAL', kind: 'manual' });
  rows.forEach((r, i) => { r.id = `t${String(n + 1 + i).padStart(5, '0')}`; });
  doc.transactions.push(...rows);
  return rows;
}

// Impact summary of a set of trades at a valuation date using a price book:
// weight of the ticker before/after, cash before/after, for the scoped accounts.
export function impact({ transactions, simRows, accounts, priceBook, asOf, endingState }) {
  const base = endingState(transactions.filter((t) => accounts.includes(t.account)));
  const after = endingState([...transactions, ...simRows].filter((t) => accounts.includes(t.account)));
  const value = (st) => {
    let cash = 0, hold = 0; const byT = {};
    for (const a of accounts) {
      cash += st.cash[a] || 0;
      for (const [tk, sh] of Object.entries(st.pos[a] || {})) { const p = priceBook.lookup(tk, asOf, 'close'); if (p?.price != null) { byT[tk] = (byT[tk] || 0) + sh * p.price; hold += sh * p.price; } }
    }
    return { cash, hold, total: cash + hold, byT };
  };
  const b = value(base), a = value(after);
  const tickers = [...new Set(simRows.map((r) => r.ticker).filter(Boolean))];
  return {
    before: b, after: a,
    weights: tickers.map((tk) => ({ ticker: tk, before: b.total ? (b.byT[tk] || 0) / b.total : 0, after: a.total ? (a.byT[tk] || 0) / a.total : 0 })),
    cashNegative: Object.values(after.cash).some((c) => c < -0.005)
  };
}

const round2 = (n) => Math.round(n * 100) / 100;
