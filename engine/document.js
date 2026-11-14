import { KINDS, FLAGS } from './scrub.js';
// The single encrypted document: shape, defaults, and validation.
export const DOC_VERSION = 1;

export function emptyDocument() {
  return {
    version: DOC_VERSION,
    accounts: [],          // [{id, type, label}]
    transactions: [],      // scrubbed rows
    overrides: { openingCostBasis: {}, openingDates: {}, openingCash: {}, manualPrices: {} },
    simulations: [],
    savedViews: [],
    benchmarkMixes: [],
    statementChecks: {},   // {accountId: {date, cash, holdings:{ticker:shares}}}
    settings: { benchmark: 'VOO', timezone: 'America/Chicago' }
  };
}

const ALLOWED_TOP = new Set(Object.keys(emptyDocument()));
const TX_FIELDS = new Set(['id', 'date', 'type', 'value', 'fees', 'taxes', 'shares', 'ticker', 'account', 'kind', 'flags']);
const SIM_FIELDS = new Set(['id', 'name', 'date', 'side', 'ticker', 'shares', 'price', 'fees', 'account', 'funding', 'createdAt', 'enabled']);

// Throws if the document has any field outside the closed schema (defense against
// free text sneaking in through a future UI change).
export function validateDocument(doc) {
  for (const k of Object.keys(doc)) if (!ALLOWED_TOP.has(k)) throw new Error(`Unexpected top-level field ${k}`);
  for (const t of doc.transactions) {
    for (const k of Object.keys(t)) if (!TX_FIELDS.has(k)) throw new Error(`Unexpected transaction field ${k}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error(`Bad date ${t.date}`);
  }
  const ids = new Set(doc.accounts.map((a) => a.id));
  // Value-level guard: every stored string must come from a closed shape, so free text cannot ride along.
  for (const t of doc.transactions) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) throw new Error(`Transaction ${t.id}: bad date`);
    if (t.ticker !== '' && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t.ticker)) throw new Error(`Transaction ${t.id}: ticker is not a plain symbol`);
    if (!KINDS.has(t.kind)) throw new Error(`Transaction ${t.id}: unknown kind`);
    if (!Array.isArray(t.flags) || t.flags.some((f) => !FLAGS.has(f))) throw new Error(`Transaction ${t.id}: unknown flag`);
  }
  for (const a of doc.accounts) if (!/^(Taxable|Tax-deferred|Tax-free|HSA) [A-Z]$/.test(a.label)) throw new Error(`Account ${a.id}: label must be a generic label`);
  for (const t of doc.transactions) if (!ids.has(t.account)) throw new Error(`Transaction ${t.id} references unknown account ${t.account}`);
  for (const s of doc.simulations || []) {
    for (const k of Object.keys(s)) if (!SIM_FIELDS.has(k)) throw new Error(`Unexpected simulation field ${k}`);
    if (!/^[\w \-/.%]{1,40}$/.test(s.name || '')) throw new Error(`Simulation ${s.id}: name must be letters, digits, spaces, - / . % only, up to 40 characters`);
    if (!ids.has(s.account)) throw new Error(`Simulation ${s.id} references unknown account ${s.account}`);
  }
  return true;
}

export function mergeImport(doc, { accounts, transactions }) {
  const next = structuredClone(doc);
  const byId = Object.fromEntries(next.accounts.map((a) => [a.id, a]));
  accounts.forEach((a) => { byId[a.id] = a; });
  next.accounts = Object.values(byId).sort((a, b) => a.id.localeCompare(b.id));
  // Legitimate duplicates exist (two identical withdrawals on one day), so de-duplication
  // compares occurrence COUNTS per key: re-importing the same file adds nothing, but a
  // second identical row in the source is kept.
  const key = (t) => [t.date, t.type, t.value, t.shares, t.ticker, t.account].join('|');
  const have = {};
  next.transactions.forEach((t) => { have[key(t)] = (have[key(t)] || 0) + 1; });
  const incoming = {};
  transactions.forEach((t) => { incoming[key(t)] = (incoming[key(t)] || 0) + 1; });
  const seenNow = {};
  let added = 0, skipped = 0;
  for (const t of transactions) {
    const k = key(t);
    seenNow[k] = (seenNow[k] || 0) + 1;
    if (seenNow[k] <= (have[k] || 0)) { skipped++; continue; }
    next.transactions.push(t); added++;
  }
  next.transactions.forEach((t, i) => { t.id = `t${String(i + 1).padStart(5, '0')}`; });
  return { doc: next, added, skipped };
}
