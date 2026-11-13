// Lazy loader for data/quotes/<TICKER>.json. Fetches only what the current view needs.
import { S } from './state.js';
import { BUILT_IN_BENCHMARKS, FACTOR_PROXIES } from '../engine/benchmark.js';

let index = null;
const inflight = {};

export async function loadQuoteIndex() {
  if (index) return index;
  try { index = await (await fetch('data/quotes/index.json', { cache: 'no-store' })).json(); }
  catch { index = { tickers: [], asOf: null, names: {}, sectors: {} }; }
  S.quotes.asOf = index.asOf;
  S.quotes.names = index.names || {};
  S.quotes.sectors = index.sectors || {};
  return index;
}

export async function ensureQuotes(tickers) {
  await loadQuoteIndex();
  const have = new Set(index.tickers || []);
  const need = [...new Set(tickers)].filter((t) => t && have.has(t) && !S.quotes.tickers[t]);
  await Promise.all(need.map((t) => (inflight[t] ??= fetch(`data/quotes/${t}.json`, { cache: 'no-store' }).then((r) => r.json()).then((j) => { S.quotes.tickers[t] = j; }).catch(() => {}))));
  return [...new Set(tickers)].filter((t) => t && !S.quotes.tickers[t]);
}

// Every ticker a full render could touch: holdings, all benchmarks and mixes, factor proxies.
export function neededTickers(doc) {
  const out = new Set(FACTOR_PROXIES);
  doc.transactions.forEach((t) => { if (t.ticker) out.add(t.ticker); });
  Object.values(BUILT_IN_BENCHMARKS).forEach((b) => Object.keys(b.weights).forEach((t) => out.add(t)));
  (doc.benchmarkMixes || []).forEach((m) => Object.keys(m.weights).forEach((t) => out.add(t)));
  return [...out];
}
