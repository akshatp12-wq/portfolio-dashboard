// Shared in-memory state and small helpers. Nothing here persists.
export const S = { doc: null, pass: '', sha: null, rawRows: [], rawByFile: {}, pending: null, quotes: { tickers: {} }, fundmeta: { tickers: {} }, macro: null, ff: null };
export const $ = (id) => document.getElementById(id);
export const fmt = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const pct = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : (n * 100).toFixed(d) + '%');
export const num = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toFixed(d));
export const typeLabel = { taxable: 'Taxable', tax_deferred: 'Tax-deferred', tax_free: 'Tax-free', hsa: 'HSA' };
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export const labelOf = (id) => S.doc?.accounts.find((a) => a.id === id)?.label || id;
export const nameOf = (t) => S.fundmeta.tickers?.[t]?.name || t;

// Inline SVG line chart. series: [{name, color, points: [{date, value}]}]
export function lineChart(series, { height = 220, logScale = false } = {}) {
  const all = series.flatMap((s) => s.points);
  if (!all.length) return '<p class="muted">No data for this window.</p>';
  const xs = [...new Set(all.map((p) => p.date))].sort();
  const x0 = Date.parse(xs[0]), x1 = Date.parse(xs[xs.length - 1]) || x0 + 1;
  let lo = Math.min(...all.map((p) => p.value)), hi = Math.max(...all.map((p) => p.value));
  if (lo === hi) { lo -= 1; hi += 1; }
  const W = 800, H = height, padL = 46, padR = 8, padT = 8, padB = 22;
  const X = (d) => padL + ((Date.parse(d) - x0) / (x1 - x0)) * (W - padL - padR);
  const Y = (v) => padT + (1 - ((logScale ? Math.log(v) : v) - (logScale ? Math.log(lo) : lo)) / ((logScale ? Math.log(hi) : hi) - (logScale ? Math.log(lo) : lo))) * (H - padT - padB);
  const ticks = 4;
  const grid = [...Array(ticks + 1)].map((_, i) => { const v = lo + (hi - lo) * i / ticks; return `<line x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}" stroke="currentColor" stroke-opacity="0.12"/><text x="${padL - 6}" y="${Y(v) + 4}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.7">${v.toFixed(0)}</text>`; }).join('');
  const paths = series.map((s) => `<path d="${s.points.map((p, i) => (i ? 'L' : 'M') + X(p.date).toFixed(1) + ' ' + Y(p.value).toFixed(1)).join(' ')}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`).join('');
  const legend = series.map((s) => `<span class="lg"><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');
  return `<div class="legend">${legend}</div><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">${grid}${paths}<text x="${padL}" y="${H - 6}" font-size="11" fill="currentColor" fill-opacity="0.7">${xs[0]}</text><text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.7">${xs[xs.length - 1]}</text></svg>`;
}
export const PALETTE = ['#0F6E5E', '#B45309', '#1F5FBF', '#6B3FA0', '#B3261E', '#2E7D32', '#5B6270', '#C2185B'];
