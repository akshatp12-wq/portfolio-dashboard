// Parses CSV files in the Portfolio Performance transaction layout into raw rows.
import { csvToObjects } from './csv.js';

export const PP_TYPES = new Set([
  'Buy', 'Sell', 'Dividend', 'Interest', 'Deposit', 'Removal', 'Fees', 'Taxes',
  'Delivery (Inbound)', 'Delivery (Outbound)', 'Transfer (Inbound)', 'Transfer (Outbound)'
]);

const num = (s) => {
  if (s == null || String(s).trim() === '') return 0;
  const n = Number(String(s).replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`Bad number: ${s}`);
  return n;
};

// Strips " Cash" / " Securities" suffix so both sides of an account share one key.
export function accountKeyFromLabel(label) {
  return String(label || '').replace(/\s+(Cash|Securities)$/i, '').trim();
}

export function parsePortfolioPerformanceCsv(text, sourceName = '') {
  const objs = csvToObjects(text);
  const out = [];
  objs.forEach((o, i) => {
    const type = o['Type'];
    if (!PP_TYPES.has(type)) throw new Error(`${sourceName} line ${i + 2}: unknown Type "${type}"`);
    const date = o['Date'];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${sourceName} line ${i + 2}: Date must be yyyy-MM-dd`);
    const accountKey = accountKeyFromLabel(o['Cash Account'] || o['Securities Account']);
    if (!accountKey) throw new Error(`${sourceName} line ${i + 2}: no account`);
    out.push({
      source: `${sourceName}#${i + 2}`,
      date, type,
      value: num(o['Value']),
      currency: o['Transaction Currency'] || 'USD',
      fees: num(o['Fees']),
      taxes: num(o['Taxes']),
      shares: o['Shares'] === '' ? null : num(o['Shares']),
      ticker: (o['Ticker Symbol'] || '').toUpperCase(),
      name: o['Security Name'] || '',
      accountKey,
      rawNote: o['Note'] || ''
    });
  });
  return out;
}
