// Simulated benchmark portfolios that receive the same external flows as the real portfolio.
// Uses total-return (adjusted) prices. Supports single tickers and weighted mixes with rebalancing.

// mix: { name, weights: {VTI: 60, BND: 40}, rebalance: 'none'|'monthly'|'quarterly'|'annual' }
export function simulateBenchmark({ series, priceBook, mix }) {
  const weights = normalize(mix.weights);
  const tickers = Object.keys(weights);
  const units = Object.fromEntries(tickers.map((t) => [t, 0]));
  const out = [];
  let lastRebalKey = null;
  const missing = new Set();
  const px = (t, d) => { const p = priceBook.lookup(t, d, 'adjClose'); if (p.price == null) missing.add(t); return p.price; };
  for (const p of series) {
    const d = p.date;
    if (p.flow !== 0) {
      for (const t of tickers) { const q = px(t, d); if (q) units[t] += (p.flow * weights[t]) / q; }
    }
    const key = rebalKey(d, mix.rebalance || 'none');
    let value = tickers.reduce((s, t) => { const q = px(t, d); return s + (q ? units[t] * q : 0); }, 0);
    if (key && key !== lastRebalKey && lastRebalKey !== null && value > 0) {
      for (const t of tickers) { const q = px(t, d); if (q) units[t] = (value * weights[t]) / q; }
    }
    if (key) lastRebalKey = key;
    value = tickers.reduce((s, t) => { const q = px(t, d); return s + (q ? units[t] * q : 0); }, 0);
    out.push({ date: d, value: Math.round(value * 100) / 100, flow: p.flow });
  }
  return { series: out, missing: [...missing] };
}

function normalize(w) {
  const total = Object.values(w).reduce((s, x) => s + x, 0);
  if (!(total > 0)) throw new Error('Mix weights must sum to a positive number');
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, v / total]));
}

function rebalKey(d, freq) {
  if (freq === 'monthly') return d.slice(0, 7);
  if (freq === 'quarterly') return d.slice(0, 4) + 'Q' + Math.ceil(Number(d.slice(5, 7)) / 3);
  if (freq === 'annual') return d.slice(0, 4);
  return null;
}

export const BUILT_IN_BENCHMARKS = {
  VOO: { name: 'VOO (S&P 500)', weights: { VOO: 100 } },
  VONG: { name: 'VONG (Russell 1000 Growth)', weights: { VONG: 100 } },
  QQQ: { name: 'QQQ (Nasdaq-100)', weights: { QQQ: 100 } },
  VTI: { name: 'VTI (Total US)', weights: { VTI: 100 } },
  VTV: { name: 'VTV (Value)', weights: { VTV: 100 } },
  IWM: { name: 'IWM (Small cap)', weights: { IWM: 100 } },
  VXUS: { name: 'VXUS (International)', weights: { VXUS: 100 } },
  BND: { name: 'BND (US bonds)', weights: { BND: 100 } },
  GLD: { name: 'GLD (Gold)', weights: { GLD: 100 } },
  BIL: { name: 'BIL (T-bills)', weights: { BIL: 100 } },
  SHY: { name: 'SHY (2-year Treasury)', weights: { SHY: 100 } },
  IEF: { name: 'IEF (10-year Treasury)', weights: { IEF: 100 } },
  '60/40': { name: '60/40 (VTI/BND, quarterly)', weights: { VTI: 60, BND: 40 }, rebalance: 'quarterly' }
};

export const FACTOR_PROXIES = ['VOO', 'IWM', 'VTV', 'VONG', 'MTUM', 'QUAL', 'USMV'];
