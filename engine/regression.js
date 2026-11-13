// Ordinary least squares with intercept, Gaussian elimination. No dependencies.
// y: number[], X: number[][] (rows = observations). Returns {alpha, betas, r2, n}.
export function ols(y, X) {
  const n = y.length, k = X[0]?.length ?? 0;
  if (n < k + 2) return { alpha: null, betas: Array(k).fill(null), r2: null, n };
  const A = X.map((row) => [1, ...row]);
  const p = k + 1;
  const XtX = Array.from({ length: p }, () => Array(p).fill(0));
  const Xty = Array(p).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < p; a++) { Xty[a] += A[i][a] * y[i]; for (let b = 0; b < p; b++) XtX[a][b] += A[i][a] * A[i][b]; }
  const coef = solve(XtX, Xty);
  if (!coef) return { alpha: null, betas: Array(k).fill(null), r2: null, n };
  const yhat = A.map((row) => row.reduce((s, v, j) => s + v * coef[j], 0));
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const ssTot = y.reduce((s, v) => s + (v - ybar) ** 2, 0), ssRes = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  return { alpha: coef[0], betas: coef.slice(1), r2: ssTot > 0 ? 1 - ssRes / ssTot : null, n };
}

function solve(M, v) {
  const n = v.length, A = M.map((r, i) => [...r, v[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}

// Daily returns from a price series field via a PriceBook, on given dates (carry-forward).
export function returnsFromPrices(priceBook, ticker, dates, field = 'adjClose') {
  const out = []; let prev = null;
  for (const d of dates) {
    const p = priceBook.lookup(ticker, d, field).price;
    if (p == null) { prev = null; out.push({ date: d, r: null }); continue; }
    out.push({ date: d, r: prev == null ? null : p / prev - 1 }); prev = p;
  }
  return out;
}

// Factor regression of portfolio excess returns on factor excess returns.
// factors: {name: [{date, r}]} already in excess-of-rf terms where appropriate.
export function factorRegression(portfolio, factors, rf) {
  const names = Object.keys(factors);
  const maps = names.map((nm) => new Map(factors[nm].map((x) => [x.date, x.r])));
  const rfm = rf ? new Map(rf.map((x) => [x.date, x.r])) : null;
  const y = [], X = [];
  for (const p of portfolio) {
    if (p.r == null) continue;
    const row = maps.map((m) => m.get(p.date));
    if (row.some((v) => v == null || !Number.isFinite(v))) continue;
    y.push(p.r - (rfm ? (rfm.get(p.date) ?? 0) : 0)); X.push(row);
  }
  const r = ols(y, X);
  return { names, alphaAnnual: r.alpha == null ? null : r.alpha * 252, betas: Object.fromEntries(names.map((nm, i) => [nm, r.betas[i]])), r2: r.r2, n: r.n };
}

// ETF-proxy factors: market = VOO − rf; size = IWM − VOO; value = VTV − VONG; momentum = MTUM − VOO; quality = QUAL − VOO; lowvol = USMV − VOO.
export function proxyFactors(priceBook, dates, rf) {
  const R = (t) => returnsFromPrices(priceBook, t, dates);
  const rfm = rf ? new Map(rf.map((x) => [x.date, x.r])) : null;
  const voo = R('VOO'), iwm = R('IWM'), vtv = R('VTV'), vong = R('VONG'), mtum = R('MTUM'), qual = R('QUAL'), usmv = R('USMV');
  const diff = (a, b) => a.map((x, i) => ({ date: x.date, r: x.r == null || b[i].r == null ? null : x.r - b[i].r }));
  const market = voo.map((x) => ({ date: x.date, r: x.r == null ? null : x.r - (rfm ? (rfm.get(x.date) ?? 0) : 0) }));
  return { Market: market, Size: diff(iwm, voo), Value: diff(vtv, vong), Momentum: diff(mtum, voo), Quality: diff(qual, voo), LowVol: diff(usmv, voo) };
}

// Fama-French daily file shape: {dates:[...], 'Mkt-RF':[...], SMB:[...], HML:[...], RMW:[...], CMA:[...], Mom:[...], RF:[...]} in percent.
export function famaFrenchFactors(ff) {
  const names = ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA', 'Mom'].filter((n) => ff[n]);
  const out = Object.fromEntries(names.map((n) => [n, ff.dates.map((d, i) => ({ date: d, r: ff[n][i] / 100 }))]));
  const rf = ff.dates.map((d, i) => ({ date: d, r: (ff.RF?.[i] ?? 0) / 100 }));
  return { factors: out, rf };
}
