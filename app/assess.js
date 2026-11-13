import { S, $, fmt, pct, num, esc, labelOf, nameOf, lineChart, PALETTE } from './state.js';
import { dailySeries, endingState } from '../engine/ledger.js';
import { twr, growthOf100 } from '../engine/returns.js';
import { simulateBenchmark, BUILT_IN_BENCHMARKS } from '../engine/benchmark.js';
import { PriceBook } from '../engine/prices.js';
import { todayIso } from '../engine/dates.js';
import { withSimulations } from '../engine/simulate.js';
import { computeMetrics, presetWindow, sliceWindow, rfDailyFromYields } from '../engine/metrics.js';
import { factorRegression, proxyFactors, famaFrenchFactors } from '../engine/regression.js';
import { buildLots, detectWashSales, summarizeRealized, unrealized } from '../engine/lots.js';
import { lookThrough, concentration } from '../engine/exposure.js';
import { ACCOUNT_TYPES } from '../engine/scrub.js';
import { typeLabel } from './state.js';
import { ensureQuotes, neededTickers } from './quotes.js';

const A = { scope: 'all', preset: '3Y', from: '', to: '', benches: ['VOO'], primary: 'VOO' };

export function initAssess() {
  $('as-preset').addEventListener('change', () => { A.preset = $('as-preset').value; $('as-custom').hidden = A.preset !== 'custom'; renderAssess(); });
  $('as-from').addEventListener('change', renderAssess); $('as-to').addEventListener('change', renderAssess);
  $('as-scope').addEventListener('change', () => { A.scope = $('as-scope').value; renderAssess(); });
  $('as-sim').addEventListener('change', renderAssess);
  $('as-bench-list').addEventListener('change', () => { A.benches = [...$('as-bench-list').querySelectorAll('input:checked')].map((i) => i.value); if (!A.benches.includes(A.primary)) A.primary = A.benches[0] || 'VOO'; renderAssess(); });
  $('as-primary').addEventListener('change', () => { A.primary = $('as-primary').value; renderAssess(); });
  $('btn-mix-add').addEventListener('click', addMix);
}

export function fillAssessScopes() {
  const d = S.doc; if (!d) return;
  const sel = $('as-scope'); sel.innerHTML = '<option value="all">All accounts</option>';
  for (const t of ACCOUNT_TYPES) if (d.accounts.some((a) => a.type === t)) sel.insertAdjacentHTML('beforeend', `<option value="type:${t}">${typeLabel[t]}</option>`);
  for (const a of d.accounts) sel.insertAdjacentHTML('beforeend', `<option value="${a.id}">${esc(a.label)}</option>`);
  renderBenchList();
}

export function allBenchmarks() {
  const mixes = Object.fromEntries((S.doc?.benchmarkMixes || []).map((m) => [`mix:${m.name}`, { name: `${m.name} (mix)`, weights: m.weights, rebalance: m.rebalance }]));
  return { ...BUILT_IN_BENCHMARKS, ...mixes };
}
function renderBenchList() {
  const all = allBenchmarks();
  $('as-bench-list').innerHTML = Object.entries(all).map(([k, v]) => `<label class="chk"><input type="checkbox" value="${esc(k)}" ${A.benches.includes(k) ? 'checked' : ''}> ${esc(v.name)}</label>`).join('');
  $('as-primary').innerHTML = A.benches.map((k) => `<option value="${esc(k)}" ${k === A.primary ? 'selected' : ''}>${esc(all[k]?.name || k)}</option>`).join('');
  $('mix-list').innerHTML = (S.doc?.benchmarkMixes || []).map((m, i) => `<li>${esc(m.name)}: ${Object.entries(m.weights).map(([t, w]) => `${t} ${w}%`).join(', ')}, ${m.rebalance} <button data-del-mix="${i}" class="small">remove</button></li>`).join('') || '<li class="muted">No custom mixes yet.</li>';
  $('mix-list').querySelectorAll('[data-del-mix]').forEach((b) => b.addEventListener('click', () => { S.doc.benchmarkMixes.splice(Number(b.dataset.delMix), 1); renderBenchList(); renderAssess(); }));
}
function addMix() {
  const name = $('mix-name').value.trim();
  const weights = {};
  $('mix-weights').value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).forEach((s) => { const [t, w] = s.split(/\s+|:/); if (t && Number.isFinite(Number(w))) weights[t.toUpperCase()] = Number(w); });
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!name || !Object.keys(weights).length || Math.abs(sum - 100) > 0.01) { $('mix-msg').textContent = 'Need a name and weights that sum to 100.'; return; }
  S.doc.benchmarkMixes = S.doc.benchmarkMixes || [];
  S.doc.benchmarkMixes.push({ name, weights, rebalance: $('mix-rebal').value });
  $('mix-msg').textContent = 'Added. Remember to save.'; $('mix-name').value = ''; $('mix-weights').value = '';
  renderBenchList();
}

function scopeAccounts() {
  const d = S.doc;
  return A.scope === 'all' ? d.accounts.map((a) => a.id) : A.scope.startsWith('type:') ? d.accounts.filter((a) => a.type === A.scope.slice(5)).map((a) => a.id) : [A.scope];
}

export async function renderAssess() {
  const d = S.doc; if (!d) return;
  await ensureQuotes(neededTickers(d));
  const accounts = scopeAccounts();
  const pb = new PriceBook(S.quotes, d.overrides.manualPrices);
  const to = todayIso();
  const txs = $('as-sim').checked ? withSimulations(d).transactions : d.transactions;
  const full = dailySeries({ txs, accounts, priceBook: pb, to, openingCash: d.overrides.openingCash });
  if (!full.series.length) { $('as-metrics').innerHTML = '<p class="muted">No transactions in this scope.</p>'; return; }
  const first = full.series[0].date, last = full.series[full.series.length - 1].date;
  let [from, until] = A.preset === 'custom' ? [$('as-from').value ? $('as-from').value + '-01' : first, $('as-to').value ? monthEnd($('as-to').value) : last] : presetWindow(A.preset, last, first);
  if (from < first) from = first; if (until > last) until = last;
  $('as-window').textContent = `${from} to ${until}`;

  const portDaily = sliceWindow(twr(full.series).daily, from, until);
  const dates = portDaily.map((x) => x.date);
  const rf = S.macro?.series?.DGS3MO?.history ? rfDailyFromYields(S.macro.series.DGS3MO.history, dates) : dates.map((date) => ({ date, r: 0 }));
  const all = allBenchmarks();
  const benchRuns = {};
  for (const k of A.benches) {
    if (!all[k]) continue;
    const sim = simulateBenchmark({ series: full.series, priceBook: pb, mix: all[k] });
    benchRuns[k] = { daily: sliceWindow(twr(sim.series).daily, from, until), missing: sim.missing, name: all[k].name };
  }
  const primary = benchRuns[A.primary];
  const m = primary && !primary.missing.length ? computeMetrics({ portfolio: portDaily, benchmark: primary.daily, rfDaily: rf }) : null;

  // ---- metrics table
  const qTag = m ? (m.quality === 'insufficient' ? '<span class="tag">under 12 months: ratios withheld</span>' : m.quality === 'provisional' ? '<span class="tag">under 36 months: provisional</span>' : '') : '';
  const rows = m ? [
    ['Total return (TWR)', pct(m.portfolio.total), pct(m.benchmark.total)],
    ['CAGR', pct(m.portfolio.cagr), pct(m.benchmark.cagr)],
    ['Annualized volatility', pct(m.portfolio.vol), pct(m.benchmark.vol)],
    ['Sharpe ratio', num(m.portfolio.sharpe), num(m.benchmark.sharpe)],
    ['Sortino ratio', num(m.portfolio.sortino), num(m.benchmark.sortino)],
    ['Calmar ratio', num(m.portfolio.calmar), num(m.benchmark.calmar)],
    ['Information ratio', num(m.portfolio.infoRatio), 'n/a'],
    ['Max drawdown', `${pct(m.portfolio.maxDrawdown)} (${m.portfolio.maxDrawdownDate || ''})`, `${pct(m.benchmark.maxDrawdown)} (${m.benchmark.maxDrawdownDate || ''})`],
    ['Current drawdown', pct(m.portfolio.currentDrawdown), pct(m.benchmark.currentDrawdown)],
    ['Beta', num(m.portfolio.beta), '1.00'],
    ['Downside / upside capture', `${pct(m.portfolio.downsideCapture, 0)} / ${pct(m.portfolio.upsideCapture, 0)}`, '100% / 100%'],
    ['Monthly hit rate', pct(m.portfolio.hitRate, 0), 'n/a'],
    ['Best / worst month', m.portfolio.bestMonth ? `${pct(m.portfolio.bestMonth.r)} (${m.portfolio.bestMonth.month}) / ${pct(m.portfolio.worstMonth.r)} (${m.portfolio.worstMonth.month})` : '—', '']
  ] : [];
  $('as-metrics').innerHTML = m ? `<div class="row"><span class="muted">${m.n} trading days · risk-free ${S.macro?.series?.DGS3MO ? '3-month T-bill (FRED)' : '0% until the macro job runs'}</span>${qTag}</div><div class="scroll"><table><thead><tr><th>Metric</th><th class="r">Portfolio</th><th class="r">${esc(primary.name)}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="r">${r[1]}</td><td class="r">${r[2]}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="muted">Primary benchmark has no prices for ${primary ? primary.missing.join(', ') : A.primary}. Run the quote job or add manual prices.</p>`;

  // ---- overlay chart (growth of 100 on the window)
  const windowSeries = full.series.filter((p) => p.date >= from && p.date <= until);
  const lines = [{ name: 'Portfolio', color: PALETTE[0], width: 3, points: growthOf100(rebase(windowSeries)) }];
  Object.entries(benchRuns).forEach(([k, b], i) => { if (!b.missing.length) lines.push({ name: b.name, color: PALETTE[(i + 1) % PALETTE.length], dash: '6 4', points: growthFromDaily(b.daily) }); });
  $('as-chart').innerHTML = lineChart(lines);
  $('as-bench-table').innerHTML = `<table><thead><tr><th>Benchmark</th><th class="r">Return on window</th><th class="r">Excess</th></tr></thead><tbody>${Object.entries(benchRuns).map(([k, b]) => { const r = b.missing.length ? null : compoundDaily(b.daily); const p = compoundDaily(portDaily); return `<tr><td>${esc(b.name)}</td><td class="r">${b.missing.length ? 'no prices: ' + b.missing.join(', ') : pct(r)}</td><td class="r">${r == null ? '—' : pct(p - r)}</td></tr>`; }).join('')}</tbody></table>`;

  // ---- factors
  const proxy = factorRegression(portDaily, proxyFactors(pb, dates, rf), rf);
  let ff = null;
  if (S.ff) { const f = famaFrenchFactors(S.ff); ff = factorRegression(portDaily, f.factors, f.rf); }
  const fr = (name, p, f) => `<tr><td>${name}</td><td class="r">${num(p)}</td><td class="r">${f == null ? 'n/a' : num(f)}</td><td class="r">${p != null && f != null ? num(p - f) : '—'}</td></tr>`;
  const ffMap = ff ? { Market: ff.betas['Mkt-RF'], Size: ff.betas.SMB, Value: ff.betas.HML, Momentum: ff.betas.Mom, Quality: ff.betas.RMW, LowVol: null } : {};
  $('as-factors').innerHTML = proxy.n < 60 ? '<p class="muted">Fewer than 60 overlapping days with factor prices. Run the quote job for VOO, IWM, VTV, VONG, MTUM, QUAL, USMV.</p>'
    : `<div class="scroll"><table><thead><tr><th>Factor</th><th class="r">ETF proxy</th><th class="r">Fama-French</th><th class="r">Gap</th></tr></thead><tbody>${['Market', 'Size', 'Value', 'Momentum', 'Quality', 'LowVol'].map((n) => fr(n, proxy.betas[n], ff ? ffMap[n] : null)).join('')}<tr><td>Alpha (annual)</td><td class="r">${pct(proxy.alphaAnnual)}</td><td class="r">${ff ? pct(ff.alphaAnnual) : 'n/a'}</td><td></td></tr><tr><td>R²</td><td class="r">${num(proxy.r2)}</td><td class="r">${ff ? num(ff.r2) : 'n/a'}</td><td></td></tr></tbody></table></div><p class="muted">${proxy.n} days. ${m && m.quality !== 'ok' ? 'Loadings on under 36 months are noisy; treat as provisional. ' : ''}${ff ? 'Fama-French: RMW shown under Quality; no FF equivalent for low volatility.' : 'Fama-French loadings appear once data/ff.json exists (phase 3).'}</p>`;

  // ---- exposure
  const st = endingState(txs.filter((t) => accounts.includes(t.account)));
  const positions = [];
  for (const [acct, pos] of Object.entries(st.pos)) for (const [tk, sh] of Object.entries(pos)) { const p = pb.lookup(tk, to).price; positions.push({ account: acct, ticker: tk, shares: sh, value: p == null ? null : p * sh }); }
  const priced = positions.filter((p) => p.value != null);
  const agg = Object.values(priced.reduce((o, p) => { (o[p.ticker] ??= { ticker: p.ticker, value: 0 }).value += p.value; return o; }, {}));
  const lt = lookThrough(agg, S.fundmeta);
  const conc = concentration(agg);
  const unpriced = positions.filter((p) => p.value == null).map((p) => p.ticker);
  $('as-sectors').innerHTML = priced.length ? `<ul class="bars">${lt.sectors.map((s) => `<li><span>${esc(s.sector)}</span><span class="bar"><span style="width:${(s.weight * 100).toFixed(1)}%"></span></span><span class="r">${pct(s.weight, 1)}</span></li>`).join('')}</ul><p class="muted">Weighted expense ratio ${lt.expenseRatio == null ? '—' : pct(lt.expenseRatio, 3)} (${pct(lt.expenseCoverage, 0)} of value covered). Top 5 ${pct(conc.top5, 0)}, top 10 ${pct(conc.top10, 0)}, effective holdings ${num(conc.effectiveN, 1)}. ${unpriced.length ? 'Unpriced: ' + [...new Set(unpriced)].join(', ') + '. ' : ''}${lt.notes.join(' ')}</p>` : '<p class="muted">No priced positions yet.</p>';
  $('as-overlap').innerHTML = lt.overlap.length ? `<div class="scroll"><table><thead><tr><th>Underlying</th><th class="r">Direct</th><th class="r">Via funds</th><th class="r">Total</th></tr></thead><tbody>${lt.overlap.slice(0, 15).map((o) => `<tr><td>${esc(o.ticker)} <span class="muted">${esc(nameOf(o.ticker) === o.ticker ? '' : nameOf(o.ticker))}</span></td><td class="r">${pct(o.direct, 1)}</td><td class="r">${pct(o.viaFunds, 1)}</td><td class="r">${pct(o.total, 1)}</td></tr>`).join('')}</tbody></table></div>` : '';

  // ---- lots, gains, wash sales
  const taxable = d.accounts.filter((a) => a.type === 'taxable' && accounts.includes(a.id)).map((a) => a.id);
  const { realized, flags, lots } = buildLots(txs, { openingCostBasis: d.overrides.openingCostBasis });
  const ws = detectWashSales(realized, txs);
  const sum = summarizeRealized(ws, { from, to: until, accounts: taxable });
  const unr = unrealized(lots, pb, to).filter((u) => accounts.includes(u.account));
  const unrTotal = unr.reduce((s, u) => s + (u.gain || 0), 0);
  $('as-tax').innerHTML = `<div class="kpis"><div class="kpi"><span class="l">Realized ST (taxable, window)</span><span class="v">$${fmt(sum.shortTerm)}</span></div><div class="kpi"><span class="l">Realized LT (taxable, window)</span><span class="v">$${fmt(sum.longTerm)}</span></div><div class="kpi"><span class="l">Wash sales</span><span class="v">${sum.washCount}</span><span class="muted">$${fmt(sum.disallowed)} disallowed</span></div><div class="kpi"><span class="l">Unrealized (scope)</span><span class="v">$${fmt(unrTotal)}</span><span class="muted">${unr.some((u) => u.basisMissing) ? 'opening basis missing for some lots' : ''}</span></div></div>
  ${sum.rows.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Account</th><th>Ticker</th><th class="r">Shares</th><th class="r">Proceeds</th><th class="r">Cost</th><th class="r">Gain</th><th>Term</th><th>Wash</th></tr></thead><tbody>${sum.rows.map((r) => `<tr><td>${r.date}</td><td>${esc(labelOf(r.account))}</td><td>${esc(r.ticker)}</td><td class="r">${r.shares}</td><td class="r">${fmt(r.proceeds)}</td><td class="r">${fmt(r.cost)}${r.basisMissing ? ' <span class="tag">basis?</span>' : ''}</td><td class="r">${fmt(r.gain)}</td><td>${r.term}</td><td>${r.washSale ? `<span class="tag">wash: ${r.replacementAccount.map(labelOf).join(', ')}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No realized sales in taxable accounts on this window.</p>'}
  ${flags.length ? `<ul class="issues">${flags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
  $('as-flags').innerHTML = full.flags.slice(0, 10).map((f) => `<li>${esc(f)}</li>`).join('');
}

function rebase(series) { return series.map((p, i) => (i === 0 ? { ...p, flow: p.value } : p)); }
function growthFromDaily(daily) { let g = 100; return daily.map((d) => ({ date: d.date, value: (g *= 1 + d.r) })); }
function compoundDaily(daily) { return daily.reduce((g, d) => g * (1 + d.r), 1) - 1; }
function monthEnd(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); }
