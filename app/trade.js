import { S, $, fmt, pct, esc, labelOf } from './state.js';
import { validateTrade, newSimulationId, tradeRows, recordTrade, impact, withSimulations } from '../engine/simulate.js';
import { endingState } from '../engine/ledger.js';
import { PriceBook } from '../engine/prices.js';
import { todayIso } from '../engine/dates.js';
import { ensureQuotes } from './quotes.js';

let onChange = () => {};

export function initTrade({ changed }) {
  onChange = changed;
  $('tr-date').value = todayIso();
  $('tr-mode').addEventListener('change', () => { $('tr-name-wrap').style.display = $('tr-mode').value === 'sim' ? '' : 'none'; });
  $('tr-side').addEventListener('change', () => { $('tr-funding').disabled = $('tr-side').value === 'Sell'; });
  $('btn-tr-price').addEventListener('click', fillClose);
  $('btn-tr-preview').addEventListener('click', () => preview(readForm()));
  $('btn-tr-add').addEventListener('click', add);
  $('sim-table').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sim-del]'); if (b) { S.doc.simulations = S.doc.simulations.filter((s) => s.id !== b.dataset.simDel); onChange(); renderTrade(); }
  });
  $('sim-table').addEventListener('change', (e) => {
    const c = e.target.closest('[data-sim-on]'); if (c) { const s = S.doc.simulations.find((x) => x.id === c.dataset.simOn); if (s) s.enabled = c.checked; onChange(); }
  });
}

export function fillTradeScopes() {
  const d = S.doc; if (!d) return;
  $('tr-account').innerHTML = d.accounts.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
}

function readForm() {
  const n = (id) => { const v = $(id).value.replace(/[$,]/g, '').trim(); return v === '' ? null : Number(v); };
  return {
    mode: $('tr-mode').value, side: $('tr-side').value, account: $('tr-account').value,
    ticker: $('tr-ticker').value.trim().toUpperCase(), date: $('tr-date').value,
    shares: n('tr-shares'), price: n('tr-price'), fees: n('tr-fees') ?? 0,
    funding: $('tr-side').value === 'Sell' ? 'cash' : $('tr-funding').value,
    name: $('tr-name').value.trim()
  };
}

async function fillClose() {
  const f = readForm(); if (!f.ticker || !f.date) { $('tr-msg').textContent = 'Enter a ticker and date first.'; return; }
  await ensureQuotes([f.ticker]);
  const pb = new PriceBook(S.quotes, S.doc?.overrides.manualPrices || {});
  const p = pb.lookup(f.ticker, f.date, 'close');
  if (p?.price == null) { $('tr-msg').textContent = `No quote file for ${f.ticker}. Enter the price by hand (or add a manual price on the Data tab).`; return; }
  $('tr-price').value = p.price.toFixed(2);
  $('tr-msg').textContent = `${f.ticker} close ${p.date}${p.stale ? ' (stale: carried forward)' : ''}.`;
}

async function preview(f) {
  const d = S.doc; if (!d) return;
  const err = validateTrade(f, d.accounts); if (err) { $('tr-msg').textContent = err; return null; }
  await ensureQuotes([f.ticker, ...new Set(d.transactions.map((t) => t.ticker).filter(Boolean))]);
  const pb = new PriceBook(S.quotes, d.overrides.manualPrices);
  const rows = tradeRows(f, { idPrefix: 'preview_', flag: 'SIM', kind: 'simulation' });
  const accounts = [f.account];
  const im = impact({ transactions: d.transactions, simRows: rows, accounts, priceBook: pb, asOf: todayIso(), endingState });
  const all = impact({ transactions: d.transactions, simRows: rows, accounts: d.accounts.map((a) => a.id), priceBook: pb, asOf: todayIso(), endingState });
  const w = im.weights[0] || { before: 0, after: 0 }, wa = all.weights[0] || { before: 0, after: 0 };
  $('tr-impact').innerHTML = `<div class="kpis">
    <div class="kpi"><span class="l">Trade value</span><span class="v">$${fmt(rows[rows.length - 1].value)}</span><span class="muted">${f.side} ${f.shares} ${esc(f.ticker)} @ ${fmt(f.price)}${f.fees ? ` + $${fmt(f.fees)} fees` : ''}</span></div>
    <div class="kpi"><span class="l">${esc(labelOf(f.account))} cash</span><span class="v">$${fmt(im.after.cash)}</span><span class="muted">was $${fmt(im.before.cash)}${im.cashNegative ? ' · goes negative' : ''}</span></div>
    <div class="kpi"><span class="l">${esc(f.ticker)} weight in account</span><span class="v">${pct(w.after)}</span><span class="muted">was ${pct(w.before)}</span></div>
    <div class="kpi"><span class="l">${esc(f.ticker)} weight overall</span><span class="v">${pct(wa.after)}</span><span class="muted">was ${pct(wa.before)}</span></div>
  </div>${im.cashNegative && f.funding === 'cash' ? '<p class="error">This account would not have enough cash. Switch funding to "New deposit same day" or reduce shares.</p>' : ''}`;
  $('tr-msg').textContent = '';
  return { f, rows, im };
}

async function add() {
  const d = S.doc; if (!d) { $('tr-msg').textContent = 'Unlock a document first.'; return; }
  const f = readForm();
  const err = validateTrade(f, d.accounts); if (err) { $('tr-msg').textContent = err; return; }
  if (f.mode === 'sim') {
    if (!/^[\w \-/.%]{1,40}$/.test(f.name)) { $('tr-msg').textContent = 'Simulation name: letters, digits, spaces, - / . % only, up to 40 characters.'; return; }
    d.simulations.push({ id: newSimulationId(d), name: f.name, date: f.date, side: f.side, ticker: f.ticker, shares: f.shares, price: f.price, fees: f.fees, account: f.account, funding: f.funding, createdAt: todayIso(), enabled: true });
    $('tr-msg').textContent = `Simulation "${f.name}" added. Turn on "Include simulations" in Overview or Assess to see it. Remember to save.`;
  } else {
    const rows = recordTrade(d, f);
    $('tr-msg').textContent = `Recorded ${rows.length} real transaction${rows.length > 1 ? 's' : ''} (flag MANUAL). Check it against your broker confirmation, then save.`;
  }
  onChange(); renderTrade();
}

export function renderTrade() {
  const d = S.doc; const tb = $('sim-table').querySelector('tbody'); tb.innerHTML = '';
  if (!d) return;
  for (const s of d.simulations) {
    tb.insertAdjacentHTML('beforeend', `<tr><td><input type="checkbox" class="box" data-sim-on="${s.id}" ${s.enabled !== false ? 'checked' : ''}></td><td>${esc(s.name)}</td><td>${s.date}</td><td>${s.side}</td><td>${esc(s.ticker)}</td><td class="r">${s.shares}</td><td class="r">${fmt(s.price)}</td><td class="r">${fmt(s.fees || 0)}</td><td>${esc(labelOf(s.account))}</td><td>${s.funding === 'deposit' ? 'new deposit' : 'cash'}</td><td><button data-sim-del="${s.id}">Remove</button></td></tr>`);
  }
  const on = withSimulations(d).applied.length;
  $('sim-count').textContent = d.simulations.length ? `${d.simulations.length} simulation(s), ${on} enabled.` : 'No simulations yet.';
}
