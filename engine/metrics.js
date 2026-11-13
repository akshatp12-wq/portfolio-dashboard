// Risk and return metrics on daily return series. All inputs are arrays of {date, r}.
import { yearsBetween } from './dates.js';

const TRADING_DAYS = 252;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const variance = (a) => { if (a.length < 2) return 0; const m = mean(a); return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1); };
const std = (a) => Math.sqrt(variance(a));

export function sliceWindow(daily, from, to) {
  return daily.filter((d) => (!from || d.date >= from) && (!to || d.date <= to));
}

export function presetWindow(preset, lastDate, firstDate) {
  const y = Number(lastDate.slice(0, 4)), m = Number(lastDate.slice(5, 7)), d = Number(lastDate.slice(8, 10));
  const iso = (yy, mm, dd) => new Date(Date.UTC(yy, mm - 1, dd)).toISOString().slice(0, 10);
  switch (preset) {
    case '1M': return [iso(y, m - 1, d), lastDate];
    case '3M': return [iso(y, m - 3, d), lastDate];
    case 'YTD': return [`${y}-01-01`, lastDate];
    case '1Y': return [iso(y - 1, m, d), lastDate];
    case '3Y': return [iso(y - 3, m, d), lastDate];
    default: return [firstDate, lastDate];
  }
}

export function compound(daily) { return daily.reduce((g, d) => g * (1 + d.r), 1) - 1; }

export function drawdowns(daily) {
  let peak = 1, cur = 1, maxDD = 0, maxDDDate = null;
  for (const d of daily) {
    cur *= 1 + d.r;
    if (cur > peak) peak = cur;
    const dd = cur / peak - 1;
    if (dd < maxDD) { maxDD = dd; maxDDDate = d.date; }
  }
  return { maxDrawdown: maxDD, maxDrawdownDate: maxDDDate, currentDrawdown: cur / peak - 1 };
}

export function monthlyReturns(daily) {
  const out = []; let key = null, g = 1;
  for (const d of daily) {
    const k = d.date.slice(0, 7);
    if (key && k !== key) { out.push({ month: key, r: g - 1 }); g = 1; }
    key = k; g *= 1 + d.r;
  }
  if (key) out.push({ month: key, r: g - 1 });
  return out;
}

// Aligns portfolio, benchmark and risk-free daily series on common dates.
export function align(p, b, rf) {
  const bm = new Map(b.map((x) => [x.date, x.r]));
  const rm = rf ? new Map(rf.map((x) => [x.date, x.r])) : null;
  const out = [];
  for (const x of p) {
    if (!bm.has(x.date)) continue;
    out.push({ date: x.date, r: x.r, b: bm.get(x.date), rf: rm ? (rm.get(x.date) ?? 0) : 0 });
  }
  return out;
}

// Full metric set. `rfDaily` is a daily risk-free rate series (decimal per day).
export function computeMetrics({ portfolio, benchmark, rfDaily }) {
  const a = align(portfolio, benchmark, rfDaily);
  if (!a.length) return { n: 0, window: null };
  const years = yearsBetween(a[0].date, a[a.length - 1].date);
  const months = Math.round(years * 12);
  const quality = months < 12 ? 'insufficient' : months < 36 ? 'provisional' : 'ok';
  const p = a.map((x) => x.r), b = a.map((x) => x.b), ex = a.map((x) => x.r - x.rf), bex = a.map((x) => x.b - x.rf);
  const total = compound(a.map((x) => ({ r: x.r }))), btotal = compound(a.map((x) => ({ r: x.b })));
  const cagr = years >= 1 ? Math.pow(1 + total, 1 / years) - 1 : null;
  const bcagr = years >= 1 ? Math.pow(1 + btotal, 1 / years) - 1 : null;
  const vol = std(p) * Math.sqrt(TRADING_DAYS), bvol = std(b) * Math.sqrt(TRADING_DAYS);
  const dd = drawdowns(a.map((x) => ({ date: x.date, r: x.r }))), bdd = drawdowns(a.map((x) => ({ date: x.date, r: x.b })));
  const ratio = (num, den) => (quality === 'insufficient' || !(den > 0) ? null : num / den);
  const sharpe = ratio(mean(ex) * TRADING_DAYS, std(ex) * Math.sqrt(TRADING_DAYS));
  const bsharpe = ratio(mean(bex) * TRADING_DAYS, std(bex) * Math.sqrt(TRADING_DAYS));
  const downside = (xs) => Math.sqrt(mean(xs.map((x) => Math.min(x, 0) ** 2))) * Math.sqrt(TRADING_DAYS);
  const sortino = ratio(mean(ex) * TRADING_DAYS, downside(ex)), bsortino = ratio(mean(bex) * TRADING_DAYS, downside(bex));
  const calmar = cagr == null ? null : ratio(cagr, Math.abs(dd.maxDrawdown)), bcalmar = bcagr == null ? null : ratio(bcagr, Math.abs(bdd.maxDrawdown));
  const active = a.map((x) => x.r - x.b);
  const infoRatio = ratio(mean(active) * TRADING_DAYS, std(active) * Math.sqrt(TRADING_DAYS));
  const vb = variance(b);
  const cov = a.length > 1 ? a.reduce((s, x) => s + (x.r - mean(p)) * (x.b - mean(b)), 0) / (a.length - 1) : 0;
  const beta = vb > 0 ? cov / vb : null;
  const downDays = a.filter((x) => x.b < 0);
  const downsideCapture = downDays.length ? compound(downDays.map((x) => ({ r: x.r }))) / compound(downDays.map((x) => ({ r: x.b }))) : null;
  const upDays = a.filter((x) => x.b > 0);
  const upsideCapture = upDays.length ? compound(upDays.map((x) => ({ r: x.r }))) / compound(upDays.map((x) => ({ r: x.b }))) : null;
  const pm = monthlyReturns(a.map((x) => ({ date: x.date, r: x.r }))), bm = monthlyReturns(a.map((x) => ({ date: x.date, r: x.b })));
  const hits = pm.filter((m, i) => bm[i] && m.r > bm[i].r).length;
  const hitRate = pm.length ? hits / pm.length : null;
  const best = pm.length ? pm.reduce((x, y) => (y.r > x.r ? y : x)) : null, worst = pm.length ? pm.reduce((x, y) => (y.r < x.r ? y : x)) : null;
  return {
    n: a.length, window: { from: a[0].date, to: a[a.length - 1].date, years, months }, quality,
    portfolio: { total, cagr, vol, sharpe, sortino, calmar, maxDrawdown: dd.maxDrawdown, maxDrawdownDate: dd.maxDrawdownDate, currentDrawdown: dd.currentDrawdown, beta, infoRatio, downsideCapture, upsideCapture, hitRate, bestMonth: best, worstMonth: worst },
    benchmark: { total: btotal, cagr: bcagr, vol: bvol, sharpe: bsharpe, sortino: bsortino, calmar: bcalmar, maxDrawdown: bdd.maxDrawdown, maxDrawdownDate: bdd.maxDrawdownDate, currentDrawdown: bdd.currentDrawdown, beta: 1 }
  };
}

// Converts an annual yield series ({date: pctYield}) to a daily-rate lookup.
export function rfDailyFromYields(yields, dates) {
  const keys = Object.keys(yields).sort();
  let i = 0, last = null;
  return dates.map((d) => {
    while (i < keys.length && keys[i] <= d) last = yields[keys[i++]];
    const y = last == null ? 0 : last / 100;
    return { date: d, r: Math.pow(1 + y, 1 / TRADING_DAYS) - 1 };
  });
}
