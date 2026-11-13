// Look-through sector exposure, overlap and weighted expense ratio from the public fundmeta table.
// fundmeta.tickers[T] = { name, kind, sector?, proxy?, expense?, sectors?: {Sector: weight}, top?: {TICKER: weight} }

function resolveMeta(fundmeta, ticker, depth = 0) {
  const m = fundmeta.tickers?.[ticker];
  if (!m) return null;
  if (m.kind === 'stock') return { kind: 'stock', sector: m.sector || 'Unknown', expense: 0, top: { [ticker]: 1 } };
  if (m.sectors || m.top) return { kind: m.kind, sectors: m.sectors || {}, top: m.top || {}, expense: m.expense ?? null, approx: !!m.approx };
  if (m.proxy && depth < 2) { const p = resolveMeta(fundmeta, m.proxy, depth + 1); return p ? { ...p, expense: m.expense ?? p.expense, viaProxy: m.proxy } : null; }
  return { kind: m.kind, sectors: {}, top: {}, expense: m.expense ?? null };
}

// positions: [{ticker, value}] (market values). Returns sector weights, overlap, expense ratio, notes.
export function lookThrough(positions, fundmeta) {
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  const sectors = {}, top = {}, direct = {}, notes = [];
  let expWeighted = 0, expCovered = 0;
  for (const p of positions) {
    if (!p.value || total <= 0) continue;
    const w = p.value / total;
    const meta = resolveMeta(fundmeta, p.ticker);
    if (!meta) { sectors['Unclassified'] = (sectors['Unclassified'] || 0) + w; notes.push(`${p.ticker}: no reference data`); continue; }
    if (meta.kind === 'stock') { sectors[meta.sector] = (sectors[meta.sector] || 0) + w; direct[p.ticker] = (direct[p.ticker] || 0) + w; }
    else {
      const sw = Object.values(meta.sectors).reduce((s, x) => s + x, 0);
      if (sw > 0) for (const [sec, x] of Object.entries(meta.sectors)) sectors[sec] = (sectors[sec] || 0) + w * x / sw;
      else { sectors[`Fund: ${p.ticker}`] = (sectors[`Fund: ${p.ticker}`] || 0) + w; notes.push(`${p.ticker}: no sector table, shown as its own bucket`); }
      for (const [tk, x] of Object.entries(meta.top)) top[tk] = (top[tk] || 0) + w * x;
      if (meta.viaProxy) notes.push(`${p.ticker}: using ${meta.viaProxy} as a proxy`);
      if (meta.approx) notes.push(`${p.ticker}: sector table is approximate`);
    }
    if (meta.expense != null) { expWeighted += w * meta.expense; expCovered += w; }
  }
  const overlap = Object.keys({ ...direct, ...top }).map((tk) => ({ ticker: tk, direct: direct[tk] || 0, viaFunds: top[tk] || 0, total: (direct[tk] || 0) + (top[tk] || 0) })).sort((a, b) => b.total - a.total);
  return { total, sectors: Object.entries(sectors).sort((a, b) => b[1] - a[1]).map(([sector, weight]) => ({ sector, weight })), overlap, expenseRatio: expCovered > 0 ? expWeighted / expCovered : null, expenseCoverage: expCovered, notes: [...new Set(notes)] };
}

export function concentration(positions) {
  const total = positions.reduce((s, p) => s + (p.value || 0), 0);
  if (!(total > 0)) return null;
  const w = positions.map((p) => (p.value || 0) / total).sort((a, b) => b - a);
  const hhi = w.reduce((s, x) => s + x * x, 0);
  return { top5: w.slice(0, 5).reduce((s, x) => s + x, 0), top10: w.slice(0, 10).reduce((s, x) => s + x, 0), effectiveN: hhi > 0 ? 1 / hhi : null, count: w.filter((x) => x > 0).length };
}
