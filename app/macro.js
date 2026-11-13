import { S, $, esc, num, pct, fmt } from './state.js';

const GROUPS = [['growth', 'Growth'], ['labor', 'Labor'], ['inflation', 'Inflation'], ['rates', 'Rates and liquidity'], ['risk', 'Risk and sentiment'], ['housing', 'Housing']];
const CYCLE_DAYS = { D: 5, W: 10, M: 45, Q: 120, A: 400 };

export function renderMacro() {
  const m = S.macro;
  const root = $('macro-root');
  if (!m) { root.innerHTML = '<div class="card"><p class="muted">No data/macro.json yet. The refresh job needs a FRED_API_KEY secret; run it once from the Actions tab.</p></div>'; return; }
  const today = new Date().toISOString().slice(0, 10);
  const stale = (s) => { const d = (Date.parse(today) - Date.parse(s.latest.date)) / 86400000; const lim = CYCLE_DAYS[s.frequency] || 45; return d > lim * 2; };
  let html = `<div class="card"><h2>Macro</h2><p class="muted">Source: ${esc(m.source)}. Refreshed ${esc(m.asOf)}. Each value shows its observation date; "released" is FRED's last update for the series.</p>${Object.keys(m.errors || {}).length ? `<ul class="issues">${Object.entries(m.errors).map(([k, v]) => `<li class="error">${esc(k)}: ${esc(v)}</li>`).join('')}</ul>` : ''}</div>`;
  if (m.upcoming?.length) html += `<div class="card"><h2>Next releases</h2><ul class="plain">${m.upcoming.slice(0, 15).map((r) => `<li><strong>${r.date}</strong> ${esc(r.name)} <span class="muted">${(r.series || []).map((s) => m.series[s]?.label || s).join(', ')}</span></li>`).join('')}</ul></div>`;
  for (const [key, title] of GROUPS) {
    const ids = (m.groups?.[key] || []).filter((id) => m.series[id]);
    if (!ids.length) continue;
    html += `<div class="card"><h2>${title}</h2><div class="scroll"><table><thead><tr><th>Series</th><th class="r">Latest</th><th class="r">Change</th><th>As of</th><th>Released</th><th>Freq</th></tr></thead><tbody>${ids.map((id) => row(id, m.series[id], stale(m.series[id]))).join('')}</tbody></table></div></div>`;
  }
  root.innerHTML = html;
}

function row(id, s, isStale) {
  const v = s.latest.value;
  const val = /percent|%/i.test(s.units) ? num(v) + '%' : fmt(v, Math.abs(v) >= 1000 ? 0 : 2);
  const chg = s.yoy != null ? `${pct(s.yoy)} y/y` : s.pctChange != null ? pct(s.pctChange) : s.change != null ? (s.change >= 0 ? '+' : '') + num(s.change) : '—';
  return `<tr><td>${esc(s.label)} <span class="muted">${esc(id)}</span></td><td class="r">${val}</td><td class="r">${chg}</td><td>${s.latest.date}${isStale ? ' <span class="tag">overdue</span>' : ''}</td><td class="muted">${esc((s.lastUpdated || '').slice(0, 10))}</td><td>${esc(s.frequency)}</td></tr>`;
}
