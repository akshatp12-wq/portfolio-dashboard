// Scrubs raw rows into the stored transaction shape. Drops every free-text field,
// including the security name (display names come from the public fundmeta.json).
// Only the ticker, numbers, dates, account TYPE and a closed set of kind/flag codes survive.

export const ACCOUNT_TYPES = ['taxable', 'tax_deferred', 'tax_free', 'hsa'];

export function inferAccountType(key) {
  const k = key.toLowerCase();
  if (/\bhsa\b|health/.test(k)) return 'hsa';
  if (/roth/.test(k)) return 'tax_free';
  if (/traditional|401|403|457|sep|simple|rollover/.test(k)) return 'tax_deferred';
  return 'taxable';
}

const GENERIC_LABEL = { taxable: 'Taxable', tax_deferred: 'Tax-deferred', tax_free: 'Tax-free', hsa: 'HSA' };

// Builds account ids/labels from raw keys. `assignments` lets the UI override types.
export function buildAccountMap(rawRows, assignments = {}) {
  const keys = [...new Set(rawRows.map((r) => r.accountKey))].sort();
  const counters = {};
  const map = {};
  keys.forEach((key) => {
    const type = assignments[key]?.type || inferAccountType(key);
    counters[type] = (counters[type] || 0) + 1;
    const suffix = String.fromCharCode(64 + counters[type]); // A, B, C
    const id = `${type}_${suffix.toLowerCase()}`;
    map[key] = { id, type, label: assignments[key]?.label || `${GENERIC_LABEL[type]} ${suffix}` };
  });
  return map;
}

// Closed vocabulary derived from the note. Anything not matched is dropped.
const KIND_RULES = [
  [/opening position/i, 'opening'],
  [/reinvest/i, 'reinvest'],
  [/money-market|money market/i, 'mm_interest'],
  [/conversion out/i, 'conversion_out'],
  [/conversion in/i, 'conversion_in'],
  [/employer match/i, 'contrib_employer'],
  [/employee deferral/i, 'contrib_employee'],
  [/recordkeeping/i, 'fee_plan'],
  [/covered-call|option premium|premium/i, 'option_premium'],
  [/split/i, 'split'],
  [/cash-out at merger|merger/i, 'merger'],
  [/contribution/i, 'contribution'],
  [/transfer of assets/i, 'transfer_in'],
  [/dividend/i, 'dividend'],
  [/interest/i, 'interest']
];

export const KINDS = new Set(['', 'manual', 'simulation', ...KIND_RULES.map((r) => r[1])]);
export const FLAGS = new Set(['REVIEW', 'MANUAL', 'SIM']);

export function classifyNote(note) {
  const flags = [];
  if (/REVIEW/.test(note)) flags.push('REVIEW');
  let kind = '';
  for (const [re, k] of KIND_RULES) if (re.test(note)) { kind = k; break; }
  return { kind, flags };
}

export function scrubRows(rawRows, accountMap) {
  return rawRows.map((r, i) => {
    const acct = accountMap[r.accountKey];
    if (!acct) throw new Error(`No account mapping for ${r.accountKey}`);
    const { kind, flags } = classifyNote(r.rawNote);
    return {
      id: `t${String(i + 1).padStart(5, '0')}`,
      date: r.date,
      type: r.type,
      value: round2(r.value),
      fees: round2(r.fees),
      taxes: round2(r.taxes),
      shares: r.shares,
      ticker: r.ticker,
      account: acct.id,
      kind,
      flags
    };
  });
}

export function accountsFromMap(accountMap) {
  const seen = {};
  Object.values(accountMap).forEach((a) => { seen[a.id] = { id: a.id, type: a.type, label: a.label }; });
  return Object.values(seen).sort((a, b) => a.id.localeCompare(b.id));
}

// Scans every string in a value for denylisted terms. Returns [{path, term}].
export function findDenylisted(value, terms) {
  const hits = [];
  const needles = terms.map((t) => String(t).trim()).filter(Boolean).map((t) => t.toLowerCase());
  const walk = (v, path) => {
    if (typeof v === 'string') {
      const low = v.toLowerCase();
      needles.forEach((n) => { if (low.includes(n)) hits.push({ path, term: n }); });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
  };
  walk(value, '');
  return hits;
}

// Patterns that look like account numbers, regardless of the denylist.
export function findAccountNumberLike(value) {
  const hits = [];
  const re = /\b(?:\d{3}-\d{6}-\d|\d{8,}|X{2,}\d{3,})\b/i;
  const walk = (v, path) => {
    if (typeof v === 'string' && re.test(v)) hits.push({ path, sample: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, path ? `${path}.${k}` : k));
  };
  walk(value, '');
  return hits;
}

const round2 = (n) => Math.round(n * 100) / 100;
