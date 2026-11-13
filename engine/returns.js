// Time-weighted return, XIRR, growth of 100.
import { yearsBetween } from './dates.js';

// series: [{date, value, flow}] with flow at START of day (before the day's return).
// Daily return r_t = V_t / (V_{t-1} + F_t) - 1. Days with zero denominator contribute 0.
export function dailyReturns(series) {
  const out = [];
  let prev = 0;
  for (const p of series) {
    const base = prev + p.flow;
    const r = base > 1e-9 ? p.value / base - 1 : 0;
    out.push({ date: p.date, r, base });
    prev = p.value;
  }
  return out;
}

export function twr(series) {
  if (!series.length) return { total: 0, annualized: 0, daily: [] };
  const daily = dailyReturns(series);
  let g = 1;
  for (const d of daily) g *= 1 + d.r;
  const yrs = yearsBetween(series[0].date, series[series.length - 1].date);
  const annualized = yrs >= 1 ? Math.pow(g, 1 / yrs) - 1 : null;
  return { total: g - 1, annualized, daily };
}

export function growthOf100(series) {
  let g = 100;
  return dailyReturns(series).map((d) => ({ date: d.date, value: (g *= 1 + d.r) }));
}

// XIRR: flows [{date, amount}] where investor outflows (deposits) are negative and the
// terminal value is a positive flow on the last date.
export function xirr(flows, guess = 0.1) {
  const fs = flows.filter((f) => Math.abs(f.amount) > 1e-9).sort((a, b) => a.date.localeCompare(b.date));
  if (fs.length < 2) return null;
  const t0 = fs[0].date;
  const f = (r) => fs.reduce((s, x) => s + x.amount / Math.pow(1 + r, yearsBetween(t0, x.date)), 0);
  const df = (r) => fs.reduce((s, x) => { const y = yearsBetween(t0, x.date); return s - y * x.amount / Math.pow(1 + r, y + 1); }, 0);
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const v = f(r), d = df(r);
    if (Math.abs(v) < 1e-7) return r;
    if (!Number.isFinite(d) || d === 0) break;
    const nr = r - v / d;
    if (nr <= -0.9999) { r = (r - 0.9999) / 2; continue; }
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  // bisection fallback
  let lo = -0.9999, hi = 10;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Builds XIRR flows from a daily series (flows negative, terminal value positive).
export function xirrFromSeries(series) {
  const flows = series.filter((p) => p.flow !== 0).map((p) => ({ date: p.date, amount: -p.flow }));
  const last = series[series.length - 1];
  flows.push({ date: last.date, amount: last.value });
  return xirr(flows);
}
