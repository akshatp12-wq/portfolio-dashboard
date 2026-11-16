import { parsePortfolioPerformanceCsv } from '../engine/parse.js';
import { buildAccountMap, scrubRows, accountsFromMap, findDenylisted, findAccountNumberLike, ACCOUNT_TYPES } from '../engine/scrub.js';
import { emptyDocument, validateDocument, mergeImport } from '../engine/document.js';
import { encryptWithKey, unlockWithPassphrase, decryptWithKey, newSession, passphraseStrength } from '../engine/crypto.js';
import { rememberDevice, recallDevice, forgetDevice } from './device.js';
import { putRepoFile, getRepoFile, guessRepoFromLocation } from '../engine/github.js';
import { checkLedger, endingState, dailySeries, sortTxs } from '../engine/ledger.js';
import { twr, xirrFromSeries } from '../engine/returns.js';
import { simulateBenchmark, BUILT_IN_BENCHMARKS } from '../engine/benchmark.js';
import { PriceBook } from '../engine/prices.js';
import { todayIso, addDays } from '../engine/dates.js';
import { toCsv } from '../engine/csv.js';

import { S, $, fmt, pct, typeLabel, esc, labelOf } from './state.js';
import { initAssess, fillAssessScopes, renderAssess, allBenchmarks } from './assess.js';
import { renderMacro } from './macro.js';
import { ensureQuotes, neededTickers } from './quotes.js';
import { initTrade, fillTradeScopes, renderTrade } from './trade.js';
import { withSimulations } from '../engine/simulate.js';
import { buildLots, unrealized } from '../engine/lots.js';
import { groupPositions, sortRows, CASH } from '../engine/positions.js';
import { presetWindow, compound } from '../engine/metrics.js';
import { yearsBetween } from '../engine/dates.js';
import { valueChart } from './chart.js';
import { initRefresh, showAsOf } from './refresh.js';
import { resetQuotes, loadQuoteIndex } from './quotes.js';
initAssess();
initTrade({ changed: () => renderDocument() });

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tabpane').forEach((p) => { p.hidden = p.id !== 'tab-' + b.dataset.tab; });
  if (b.dataset.tab === 'overview') renderOverview();
  if (b.dataset.tab === 'log') renderLog();
  if (b.dataset.tab === 'assess') renderAssess();
  if (b.dataset.tab === 'macro') renderMacro();
  if (b.dataset.tab === 'trade') renderTrade();
}));

// ---------- public data ----------
async function loadPublic() {
  try { S.fundmeta = await (await fetch('data/fundmeta.json', { cache: 'no-store' })).json(); } catch { S.fundmeta = { tickers: {} }; }
  try { S.macro = await (await fetch('data/macro.json', { cache: 'no-store' })).json(); } catch { S.macro = null; }
  try { S.ff = await (await fetch('data/ff.json', { cache: 'no-store' })).json(); } catch { S.ff = null; }
}
loadPublic().then(() => loadQuoteIndex()).then(showAsOf);
initRefresh({ done: async () => {
  resetQuotes(); await loadPublic(); await loadQuoteIndex(); showAsOf();
  const tab = document.querySelector('.tab.active')?.dataset.tab;
  if (tab === 'overview') await renderOverview(); else if (tab === 'assess') await renderAssess(); else if (tab === 'macro') renderMacro();
} });
const guess = guessRepoFromLocation();
if (guess) { $('gh-owner').value = guess.owner; $('gh-repo').value = guess.repo; }

// ---------- unlock ----------
function enter(doc, session, label) {
  S.doc = doc; S.session = session;
  validateDocument(S.doc);
  $('lock').hidden = true; $('topbar').hidden = false; $('app').hidden = false;
  $('status').textContent = label;
  $('pass').value = '';
  renderDocument(); renderOverview(); refreshDeviceState();
}

async function fetchEnvelope() {
  const res = await fetch('data/portfolio.enc.json', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load the document (${res.status}).`);
  return res.json();
}

$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = $('pass').value; if (!pass) return;
  const msg = $('unlock-msg'); msg.textContent = 'Decrypting…'; $('btn-unlock').disabled = true;
  try {
    const env = await fetchEnvelope();
    if (!env) { msg.textContent = 'No document is published yet.'; $('lock-new').hidden = false; return; }
    const { doc, key, salt, iter } = await unlockWithPassphrase(env, pass);
    const session = { key, salt, iter }; S.loadedIv = env.iv;
    if ($('remember').checked) await rememberDevice(session); else await forgetDevice();
    enter(doc, session, 'Unlocked');
  } catch (err) { msg.textContent = err.message; }
  finally { $('btn-unlock').disabled = false; }
});

$('btn-new').addEventListener('click', async () => {
  const pass = $('pass').value, st = passphraseStrength(pass);
  if (!st.ok) { $('unlock-msg').textContent = st.reason; return; }
  $('unlock-msg').textContent = 'Deriving key…';
  const session = await newSession(pass);
  S.sha = null;
  if ($('remember').checked) await rememberDevice(session);
  enter(emptyDocument(), session, 'Unlocked (new)');
  document.querySelector('[data-tab="data"]').click();
});

$('btn-lock').addEventListener('click', () => { try { sessionStorage.setItem('pd-skip-auto', '1'); } catch {} location.reload(); });

async function refreshDeviceState() {
  const rec = await recallDevice();
  $('device-state').textContent = rec ? 'This device is remembered: it opens without the passphrase until you forget it.' : 'Not remembered on this device. You will type the passphrase each visit.';
}
$('btn-forget').addEventListener('click', async () => { await forgetDevice(); $('device-msg').textContent = 'Forgotten. The next visit asks for the passphrase.'; refreshDeviceState(); });
$('btn-change-pass').addEventListener('click', async () => {
  if (!S.doc) return;
  const np = $('new-pass').value, st = passphraseStrength(np);
  if (!st.ok) { $('device-msg').textContent = st.reason; return; }
  $('device-msg').textContent = 'Deriving key…';
  S.session = await newSession(np); $('new-pass').value = '';
  await forgetDevice(); refreshDeviceState();
  $('device-msg').textContent = 'New passphrase applied in this tab. Save to GitHub to publish it; other remembered devices will ask for it once.';
});

// Auto-unlock a remembered device (skipped right after pressing Lock). The lock screen is shown
// only once this has finished without unlocking, so remembered devices never see it flash.
(async () => {
  try {
    let skip = false; try { skip = sessionStorage.getItem('pd-skip-auto') === '1'; sessionStorage.removeItem('pd-skip-auto'); } catch {}
    if (skip) return;
    const rec = await recallDevice(); if (!rec) return;
    try {
      const env = await fetchEnvelope(); if (!env || env.salt !== rec.salt) return;
      S.loadedIv = env.iv;
      enter(await decryptWithKey(env, rec.key), { key: rec.key, salt: rec.salt, iter: rec.iter }, 'Unlocked');
    } catch { await forgetDevice(); }
  } finally {
    if ($('app').hidden) { $('lock').hidden = false; $('pass').focus(); }
  }
})();

// ---------- import ----------
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files));
$('files').addEventListener('change', (e) => handleFiles(e.target.files));

async function handleFiles(files) {
  S.rawRows = []; S.rawByFile = {};
  const errors = [];
  for (const f of files) {
    try { const rows = parsePortfolioPerformanceCsv(await f.text(), f.name); S.rawByFile[f.name] = rows.length; S.rawRows.push(...rows); }
    catch (e) { errors.push(e.message); }
  }
  $('scrub-msg').textContent = errors.length ? errors.join(' | ') : `${S.rawRows.length} rows from ${Object.keys(S.rawByFile).length} file(s).`;
  const map = buildAccountMap(S.rawRows);
  const tb = $('acct-table').querySelector('tbody'); tb.innerHTML = '';
  const counts = {}; S.rawRows.forEach((r) => { counts[r.accountKey] = (counts[r.accountKey] || 0) + 1; });
  for (const [key, a] of Object.entries(map)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(key)}</td><td><select data-key="${esc(key)}">${ACCOUNT_TYPES.map((t) => `<option value="${t}" ${t === a.type ? 'selected' : ''}>${typeLabel[t]}</option>`).join('')}</select></td><td class="stored-label">${esc(a.label)}</td><td>${counts[key]}</td>`;
    tb.appendChild(tr);
  }
  $('import-accounts').hidden = false; $('scrub-preview').hidden = true; $('btn-merge').hidden = true;
}

$('btn-scrub').addEventListener('click', () => {
  if (!S.doc) { $('scrub-msg').textContent = 'Unlock or start a document first.'; return; }
  const assignments = {};
  $('acct-table').querySelectorAll('select').forEach((s) => { assignments[s.dataset.key] = { type: s.value }; });
  const map = buildAccountMap(S.rawRows, assignments);
  $('acct-table').querySelectorAll('tbody tr').forEach((tr) => { const key = tr.querySelector('select').dataset.key; tr.querySelector('.stored-label').textContent = map[key].label; });
  const accounts = accountsFromMap(map);
  const transactions = scrubRows(S.rawRows, map);
  const terms = $('denylist').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const candidate = { accounts, transactions };
  const hits = findDenylisted(candidate, terms);
  const nums = findAccountNumberLike(candidate);
  const preview = JSON.stringify(transactions.slice(0, 5), null, 1);
  $('scrub-preview').textContent = `Stored fields per row: ${Object.keys(transactions[0] || {}).join(', ')}\n\nFirst rows after scrubbing:\n${preview}`;
  $('scrub-preview').hidden = false;
  if (hits.length || nums.length) {
    $('scrub-msg').textContent = `Blocked: ${hits.length} denylist hit(s) ${hits.slice(0, 3).map((h) => h.path + ':' + h.term).join(', ')} ${nums.length ? `and ${nums.length} account-number-like value(s)` : ''}`;
    S.pending = null; $('btn-merge').hidden = true; return;
  }
  S.pending = candidate;
  $('scrub-msg').textContent = `Clean. ${transactions.length} rows ready; no free text, no names, no account numbers.`;
  $('btn-merge').hidden = false;
});

$('btn-merge').addEventListener('click', () => {
  if (!S.pending) return;
  const { doc, added, skipped } = mergeImport(S.doc, S.pending);
  validateDocument(doc);
  S.doc = doc; S.pending = null; $('btn-merge').hidden = true;
  $('scrub-msg').textContent = `Added ${added} rows, skipped ${skipped} already present. Remember to save.`;
  S.rawRows = []; // drop plaintext originals
  renderDocument();
});

// ---------- document summary and checks ----------
function renderDocument() {
  const d = S.doc; if (!d) return;
  $('doc-summary').textContent = `${d.transactions.length} transactions, ${d.accounts.length} accounts. Unsaved changes live only in this tab.`;
  const { issues, ending } = checkLedger(d.transactions, d.accounts);
  const tb = $('acct-summary').querySelector('tbody'); tb.innerHTML = '';
  for (const a of d.accounts) {
    const rows = d.transactions.filter((t) => t.account === a.id);
    const dates = rows.map((t) => t.date).sort();
    const pos = Object.entries(ending.pos[a.id] || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    tb.insertAdjacentHTML('beforeend', `<tr><td>${esc(a.label)}</td><td>${typeLabel[a.type]}</td><td class="r">${rows.length}</td><td>${dates[0] || ''}</td><td>${dates[dates.length - 1] || ''}</td><td class="r">${fmt(ending.cash[a.id] || 0)}</td><td>${esc(pos)}</td></tr>`);
  }
  $('acct-summary').hidden = false;
  const ul = $('issues'); ul.innerHTML = '';
  const openingCash = d.overrides.openingCash || {};
  issues.forEach((i) => { if (i.level === 'error' && /Cash goes negative/.test(i.msg) && openingCash[i.account]) return; ul.insertAdjacentHTML('beforeend', `<li class="${i.level}">${esc(labelOf(i.account))}: ${esc(i.msg)}</li>`); });
  const reviews = d.transactions.filter((t) => t.flags.includes('REVIEW')).length;
  if (reviews) ul.insertAdjacentHTML('beforeend', `<li>${reviews} transaction(s) carry a REVIEW flag. See the Log tab.</li>`);
  if (!ul.children.length) ul.insertAdjacentHTML('beforeend', '<li class="ok">No ledger issues.</li>');
  renderOverrides(); renderRecon(); fillScopes(); fillAssessScopes(); fillTradeScopes(); renderTrade();
}

function renderOverrides() {
  const d = S.doc;
  const ob = $('opening-basis'); ob.innerHTML = '';
  const openings = d.transactions.filter((t) => t.kind === 'opening' && t.type === 'Delivery (Inbound)');
  for (const t of openings) {
    const v = d.overrides.openingCostBasis[t.ticker] ?? '';
    ob.insertAdjacentHTML('beforeend', `<label>${esc(t.ticker)} · ${t.shares} sh · ${esc(labelOf(t.account))}<input data-basis="${esc(t.ticker)}" inputmode="decimal" placeholder="total cost $" value="${v}"></label>`);
  }
  if (!openings.length) ob.innerHTML = '<span class="muted">No opening positions.</span>';
  const oc = $('opening-cash'); oc.innerHTML = '';
  for (const a of d.accounts) oc.insertAdjacentHTML('beforeend', `<label>${esc(a.label)}<input data-ocash="${a.id}" inputmode="decimal" placeholder="opening cash $" value="${d.overrides.openingCash[a.id] ?? ''}"></label>`);
  $('manual-prices').value = Object.entries(d.overrides.manualPrices).flatMap(([t, m]) => Object.entries(m).map(([dt, p]) => `${t},${dt},${p}`)).join('\n');
}
$('btn-apply-overrides').addEventListener('click', () => {
  const d = S.doc; if (!d) return;
  $('opening-basis').querySelectorAll('input').forEach((i) => { const v = Number(i.value.replace(/[$,]/g, '')); if (i.value.trim() && Number.isFinite(v)) d.overrides.openingCostBasis[i.dataset.basis] = v; else delete d.overrides.openingCostBasis[i.dataset.basis]; });
  $('opening-cash').querySelectorAll('input').forEach((i) => { const v = Number(i.value.replace(/[$,]/g, '')); if (i.value.trim() && Number.isFinite(v)) d.overrides.openingCash[i.dataset.ocash] = v; else delete d.overrides.openingCash[i.dataset.ocash]; });
  const mp = {};
  $('manual-prices').value.split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => { const [t, dt, p] = l.split(',').map((s) => s.trim()); if (t && /^\d{4}-\d{2}-\d{2}$/.test(dt) && Number.isFinite(Number(p))) (mp[t.toUpperCase()] ??= {})[dt] = Number(p); });
  d.overrides.manualPrices = mp;
  $('override-msg').textContent = 'Applied. Remember to save.';
  renderDocument();
});

// ---------- reconciliation ----------
function renderRecon() {
  const d = S.doc; const g = $('recon'); g.innerHTML = '';
  for (const a of d.accounts) {
    const sc = d.statementChecks[a.id] || {};
    g.insertAdjacentHTML('beforeend', `<label>${esc(a.label)} statement date<input type="date" data-rdate="${a.id}" value="${sc.date || ''}"></label><label>${esc(a.label)} cash<input data-rcash="${a.id}" inputmode="decimal" value="${sc.cash ?? ''}"></label><label>${esc(a.label)} holdings (TICKER shares, comma-separated)<input data-rhold="${a.id}" value="${Object.entries(sc.holdings || {}).map(([k, v]) => k + ' ' + v).join(', ')}"></label>`);
  }
}
$('btn-recon').addEventListener('click', () => {
  const d = S.doc; if (!d) return;
  const tb = $('recon-table').querySelector('tbody'); tb.innerHTML = '';
  for (const a of d.accounts) {
    const date = $('recon').querySelector(`[data-rdate="${a.id}"]`).value;
    const cash = Number($('recon').querySelector(`[data-rcash="${a.id}"]`).value.replace(/[$,]/g, ''));
    const holdings = {};
    $('recon').querySelector(`[data-rhold="${a.id}"]`).value.split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => { const [t, n] = s.split(/\s+/); if (t && Number.isFinite(Number(n))) holdings[t.toUpperCase()] = Number(n); });
    if (!date) continue;
    d.statementChecks[a.id] = { date, cash: Number.isFinite(cash) ? cash : null, holdings };
    const st = endingState(d.transactions.filter((t) => t.account === a.id && t.date <= date));
    const ledgerCash = (st.cash[a.id] || 0) + (d.overrides.openingCash[a.id] || 0);
    if (Number.isFinite(cash)) tb.insertAdjacentHTML('beforeend', row(a.label, 'Cash', cash, ledgerCash));
    const all = new Set([...Object.keys(holdings), ...Object.keys(st.pos[a.id] || {})]);
    for (const t of all) tb.insertAdjacentHTML('beforeend', row(a.label, t, holdings[t] ?? 0, st.pos[a.id]?.[t] ?? 0, 3));
  }
  $('recon-table').hidden = false;
  function row(acct, item, stmt, ledger, dp = 2) { const diff = stmt - ledger; return `<tr><td>${esc(acct)}</td><td>${esc(item)}</td><td class="r">${fmt(stmt, dp)}</td><td class="r">${fmt(ledger, dp)}</td><td class="r">${Math.abs(diff) < 0.006 ? '<span class="tag" style="background:var(--ok-bg);color:var(--ok-ink)">match</span>' : fmt(diff, dp)}</td></tr>`; }
});

// ---------- save ----------
$('btn-save').addEventListener('click', async () => {
  if (!S.doc) return;
  const owner = $('gh-owner').value.trim(), repo = $('gh-repo').value.trim(), branch = $('gh-branch').value.trim() || 'main', token = $('gh-token').value || S.ghToken || '';
  if (!owner || !repo || !token) { $('save-msg').textContent = 'Owner, repo and token are required.'; return; }
  try {
    validateDocument(S.doc);
    $('save-msg').textContent = 'Encrypting…';
    const env = await encryptWithKey(S.doc, S.session);
    $('save-msg').textContent = 'Checking GitHub for newer changes…';
    const cur = await getRepoFile({ owner, repo, path: 'data/portfolio.enc.json', token, ref: branch });
    if (cur && S.loadedIv) { let ivNow = null; try { ivNow = JSON.parse(cur.text).iv; } catch {} if (ivNow && ivNow !== S.loadedIv) { const e = new Error('changed'); e.conflict = true; throw e; } }
    $('save-msg').textContent = 'Writing to GitHub…';
    const r = await putRepoFile({ owner, repo, path: 'data/portfolio.enc.json', token, branch, text: JSON.stringify(env), expectedSha: cur?.sha, message: 'Update encrypted portfolio document' });
    S.sha = r.sha; S.loadedIv = env.iv;
    $('save-msg').textContent = `Saved. Commit ${r.commit.slice(0, 7)}. Pages redeploys in a minute or two.`;
  } catch (e) {
    if (e.conflict) $('save-msg').textContent = 'Conflict: the file changed on GitHub since you loaded it. Reload the page, unlock, and re-apply your changes.';
    else $('save-msg').textContent = e.message;
  }
});
$('btn-download').addEventListener('click', async () => {
  if (!S.doc) return;
  validateDocument(S.doc);
  const env = await encryptWithKey(S.doc, S.session);
  download('portfolio.enc.json', JSON.stringify(env), 'application/json');
  $('save-msg').textContent = 'Downloaded. Commit it to data/portfolio.enc.json yourself.';
});
$('btn-export').addEventListener('click', () => {
  if (!S.doc) return;
  const cols = ['id', 'date', 'account', 'type', 'ticker', 'shares', 'value', 'fees', 'taxes', 'kind', 'flags'];
  const rows = sortTxs(S.doc.transactions).map((t) => ({ ...t, account: labelOf(t.account), flags: t.flags.join(' ') }));
  download('portfolio-backup.csv', toCsv(rows, cols), 'text/csv');
});
$('btn-clear').addEventListener('click', () => { location.reload(); });

// ---------- overview (phase 1: value, TWR, XIRR, one benchmark) ----------
function fillScopes() {
  const d = S.doc; const sel = $('ov-scope'); sel.innerHTML = '<option value="all">All accounts</option>';
  for (const t of ACCOUNT_TYPES) if (d.accounts.some((a) => a.type === t)) sel.insertAdjacentHTML('beforeend', `<option value="type:${t}">${typeLabel[t]}</option>`);
  for (const a of d.accounts) sel.insertAdjacentHTML('beforeend', `<option value="${a.id}">${esc(a.label)}</option>`);
  const b = $('ov-bench'); b.innerHTML = Object.entries(allBenchmarks()).map(([k, v]) => `<option value="${k}" ${k === (d.settings.benchmark || 'VOO') ? 'selected' : ''}>${v.name}</option>`).join('');
  const la = $('log-acct'); la.innerHTML = '<option value="">All</option>' + d.accounts.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('');
  const lt = $('log-type'); lt.innerHTML = '<option value="">All</option>' + [...new Set(d.transactions.map((t) => t.type))].sort().map((t) => `<option>${t}</option>`).join('');
}
['ov-scope', 'ov-bench', 'ov-sim'].forEach((id) => $(id).addEventListener('change', renderOverview));
async function renderOverview() {
  const d = S.doc;
  if (!d) return;
  const unquoted = await ensureQuotes(neededTickers(d));
  { // keep the benchmark list in sync with mixes added on the Assess tab
    const b = $('ov-bench'), cur = b.value, all = allBenchmarks();
    if (b.options.length !== Object.keys(all).length) { b.innerHTML = Object.entries(all).map(([k, v]) => `<option value="${esc(k)}">${esc(v.name)}</option>`).join(''); b.value = all[cur] ? cur : (d.settings.benchmark || 'VOO'); }
  }
  const scope = $('ov-scope').value || 'all';
  const accounts = scope === 'all' ? d.accounts.map((a) => a.id) : scope.startsWith('type:') ? d.accounts.filter((a) => a.type === scope.slice(5)).map((a) => a.id) : [scope];
  const pb = new PriceBook(S.quotes, d.overrides.manualPrices);
  const to = todayIso();
  const sim = $('ov-sim').checked ? withSimulations(d) : { transactions: d.transactions, applied: [] };
  const { series, flags } = dailySeries({ txs: sim.transactions, accounts, priceBook: pb, to, openingCash: d.overrides.openingCash });
  if (!series.length) return;
  const last = series[series.length - 1];
  const t = twr(series);
  const x = xirrFromSeries(series);
  const benchKey = $('ov-bench').value;
  const bench = simulateBenchmark({ series, priceBook: pb, mix: allBenchmarks()[benchKey] || BUILT_IN_BENCHMARKS.VOO });
  const bt = twr(bench.series);
  S.ov = { series, t, bt, x, benchName: ((n) => (/\(([^)]+)\)/.exec(n) || [null, n])[1])((allBenchmarks()[benchKey] || BUILT_IN_BENCHMARKS.VOO).name), benchMissing: bench.missing, simOn: sim.applied.length > 0 };
  renderHero();
  {
    const { lots } = buildLots(sim.transactions, { openingCostBasis: d.overrides.openingCostBasis, openingDates: d.overrides.openingDates || {} });
    const rows = unrealized(lots, pb, to).filter((u) => accounts.includes(u.account) && u.shares > 1e-9)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // cash per account, including any opening cash override, so totals match Total value
    const st = endingState(sim.transactions.filter((t) => accounts.includes(t.account)));
    const cashItems = accounts.map((a) => ({ account: a, ticker: CASH, shares: null, value: (st.cash[a] || 0) + (d.overrides.openingCash?.[a] || 0), cost: (st.cash[a] || 0) + (d.overrides.openingCash?.[a] || 0), basisMissing: false, priceMissing: false }))
      .filter((c) => Math.abs(c.value) >= 0.005);
    // trailing-12-month income, withheld tax and account fees per holding
    const since = addDays(to, -365);
    const ttm = sim.transactions.filter((t) => t.date > since && t.date <= to && accounts.includes(t.account));
    const items = [...rows, ...cashItems].map((i) => ({ ...i, income: 0, withheld: 0, fees: 0 }));
    const find = (a, tk) => items.find((i) => i.account === a && i.ticker === tk);
    for (const t of ttm) {
      if (t.type === 'Dividend' && t.ticker) { const i = find(t.account, t.ticker); if (i) { i.income += t.value; i.withheld += t.taxes || 0; } }
      else if (t.type === 'Interest') { const i = find(t.account, t.ticker || CASH) || find(t.account, CASH); if (i) { i.income += t.value; i.withheld += t.taxes || 0; } }
      else if (t.type === 'Fees' || t.type === 'Taxes') {
        const amt = t.value || 0; const direct = t.ticker && find(t.account, t.ticker);
        if (direct) { if (t.type === 'Fees') direct.fees += amt; else direct.withheld += amt; continue; }
        const held = items.filter((i) => i.account === t.account && i.ticker !== CASH && i.value > 0);
        const tot = held.reduce((x, i) => x + i.value, 0);
        held.forEach((i) => { const part = tot ? amt * i.value / tot : 0; if (t.type === 'Fees') i.fees += part; else i.withheld += part; });
      }
    }
    // Securities: trailing-12-month dividends per share from market data x shares held now, so a
    // recent purchase still shows its real yield. Falls back to dividends in the ledger when the
    // quote file has no dividend history yet. Cash: interest over the average month-end balance.
    for (const i of items) {
      if (i.ticker === CASH) {
        const pts = []; for (let m = 0; m <= 12; m++) { const dt = addDays(to, -30.4 * m | 0); const stM = endingState(sim.transactions.filter((t) => t.account === i.account && t.date <= dt)); pts.push((stM.cash[i.account] || 0) + (d.overrides.openingCash?.[i.account] || 0)); }
        const avg = pts.reduce((x, y) => x + y, 0) / pts.length;
        i.base = avg >= 500 ? avg : null;   // yield on a few dollars of cash is noise
        continue;
      }
      const divs = S.quotes.tickers[i.ticker]?.dividends;
      if (divs && i.shares) { const ps = Object.entries(divs).filter(([dt]) => dt > since && dt <= to).reduce((x, [, v]) => x + v, 0); i.income = ps * i.shares; i.incomeSource = 'market'; }
      i.base = i.value || 0;
    }
    S.posItems = items.map((i) => ({ ...i, expense: (i.value || 0) * (S.fundmeta.tickers?.[i.ticker]?.expense || 0) }));
    renderPositions();
    const noPx = rows.filter((u) => u.priceMissing).length;
    $('ov-pos-total').textContent = noPx ? `${noPx} position(s) without a price yet; they count as zero until the refresh finishes.` : '';
  }
  $('ov-note').textContent = S.quotes.asOf ? '' : 'No prices have been loaded yet, so holdings show as zero. Press Refresh at the top.';
}

// ---------- overview: hero ----------
let ovRange = 'ALL';
try { ovRange = localStorage.getItem('pd-range') || 'ALL'; } catch {}
$('ov-range').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]'); if (!b) return;
  ovRange = b.dataset.range; try { localStorage.setItem('pd-range', ovRange); } catch {}
  renderHero();
});
const usd = (n) => (n == null || !Number.isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.round(Math.abs(n)).toLocaleString('en-US'));
const move = (x, d = 1) => (x == null || !Number.isFinite(x) ? '<span class="muted">—</span>' : Math.abs(x) < 0.0005 ? `<span class="flat">0.0%</span>` : `<span class="${x < 0 ? 'neg' : 'pos'}">${x < 0 ? '▼' : '▲'} ${(Math.abs(x) * 100).toFixed(d)}%</span>`);
function renderHero() {
  const o = S.ov; if (!o) return;
  document.querySelectorAll('#ov-range [data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === ovRange));
  const { series } = o; const last = series[series.length - 1], first = series[0].date;
  const [from] = presetWindow(ovRange, last.date, first);
  const all = ovRange === 'ALL' || from <= first; const start = all ? first : from;
  let cum = 0; const pts = series.map((p) => ({ date: p.date, value: p.value, put: (cum += p.flow) }));
  const win = pts.filter((p) => p.date >= start);
  const before = all ? null : pts.filter((p) => p.date < start).pop();
  const gain = (last.value - (before?.value || 0)) - (pts[pts.length - 1].put - (before?.put || 0));
  const inWin = (d) => d.date >= start;
  const ret = compound(o.t.daily.filter(inWin)), bret = compound(o.bt.daily.filter(inWin));
  const yrs = yearsBetween(start, last.date);
  const perYear = yrs >= 1 ? Math.pow(1 + ret, 1 / yrs) - 1 : null;
  const span = { '1M': 'in the past month', '3M': 'in the past 3 months', YTD: 'this year', '1Y': 'in the past year', ALL: 'since you started' }[all ? 'ALL' : ovRange];
  $('ov-hero-label').textContent = 'Total value' + (o.simOn ? ', including simulated trades' : '');
  $('ov-value').textContent = usd(last.value);
  const putAll = pts[pts.length - 1].put, putWin = putAll - (before?.put || 0);
  const tail = all ? `, on ${usd(putAll)} put in` : Math.abs(putWin) >= 1 ? `. You ${putWin < 0 ? 'took out' : 'added'} ${usd(Math.abs(putWin))} in that time` : '';
  $('ov-sub').innerHTML = `<span class="${gain < 0 ? 'neg' : 'pos'}">${gain < 0 ? '▼' : '▲'} ${usd(Math.abs(gain))}</span> ${gain < 0 ? 'lost' : 'gained'} ${span}${tail}`;
  const diff = ret - bret;
  const stat = (l, v, sub, tip = '') => `<div class="stat"${tip ? ` title="${esc(tip)}"` : ''}><span class="l">${l}</span><span class="v">${v}</span><span class="muted">${sub}</span></div>`;
  let html = stat('Your return', move(ret), perYear != null ? `${pct(perYear, 1)} a year` : span, 'Ignores when you deposited, so it compares fairly with an index.');
  html += stat(`${esc(o.benchName)}, same deposits`, o.benchMissing.length ? '—' : move(bret), o.benchMissing.length ? 'no prices yet' : Math.abs(diff) < 0.0005 ? 'you are level with it' : `you are ${(Math.abs(diff) * 100).toFixed(1)} points ${diff < 0 ? 'behind' : 'ahead'}`, 'What this index fund would have returned with your exact deposit dates.');
  if (all && o.x != null) html += stat('On your dollars', `${pct(o.x, 1)} <small>a year</small>`, 'counts when you deposited', 'Money-weighted return: recent large deposits have had less time to grow.');
  html += stat('Cash', usd(last.cash), `${pct(last.value ? last.cash / last.value : 0, 1)} of the total, not invested`);
  $('ov-kpis').innerHTML = html;
  valueChart($('ov-chart'), win);
}

let rsz; window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(renderHero, 150); });

// ---------- overview: allocation ribbon and holdings list ----------
let posView = 'type', posSort = { key: 'value', dir: 'desc' }, posFocus = null, posInit = false;
const posOpen = new Set(), posShut = new Set();
try { posView = localStorage.getItem('pd-pos-view') || 'type'; const r = localStorage.getItem('pd-tax-rate'); if (r != null) $('ov-taxrate').value = r; } catch {}
$('ov-taxrate').addEventListener('input', () => { try { localStorage.setItem('pd-tax-rate', $('ov-taxrate').value); } catch {} renderPositions(); });
$('ov-view').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]'); if (!b) return;
  posView = b.dataset.view; posFocus = null; try { localStorage.setItem('pd-pos-view', posView); } catch {}
  renderPositions();
});
$('ov-sort').addEventListener('change', () => { const [key, dir] = $('ov-sort').value.split(':'); posSort = { key, dir }; renderPositions(); });
$('ov-legend').addEventListener('click', (e) => { const b = e.target.closest('[data-focus]'); if (!b) return; posFocus = posFocus === b.dataset.focus ? null : b.dataset.focus; if (posFocus) posShut.delete(posFocus); renderPositions(); });
$('ov-positions').addEventListener('click', (e) => {
  const h = e.target.closest('[data-sortkey]');
  if (h) { const k = h.dataset.sortkey; posSort = posSort.key === k ? { key: k, dir: posSort.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'label' ? 'asc' : 'desc' }; renderPositions(); return; }
  const g = e.target.closest('[data-group]');
  if (g) { const k = g.dataset.group; if (posShut.has(k)) posShut.delete(k); else posShut.add(k); renderPositions(); return; }
  const r = e.target.closest('[data-row]');
  if (r) { const k = r.dataset.row; if (posOpen.has(k)) posOpen.delete(k); else posOpen.add(k); renderPositions(); }
});
const RIBBON = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `var(--r${i})`);   // themed in app.css
const sharesText = (n) => Number(n.toFixed(4)).toLocaleString('en-US', { maximumFractionDigits: 4 });
function renderPositions() {
  document.querySelectorAll('#ov-view [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === posView));
  if (!S.doc) return;
  const rate = Math.max(0, Math.min(100, Number($('ov-taxrate').value) || 0)) / 100;
  const typeOf = (id) => S.doc.accounts.find((a) => a.id === id)?.type;
  // estimated tax only where income is taxed now (taxable accounts); withheld tax always counts
  const items = (S.posItems || []).map((i) => ({ ...i, taxes: (i.withheld || 0) + (typeOf(i.account) === 'taxable' ? rate * Math.max(0, i.income || 0) : 0) }));
  const { sections, total } = groupPositions(items, posView, typeOf, labelOf);
  sections.forEach((sec) => sortRows(sec.rows, posSort.key, posSort.dir));
  const opt = [...$('ov-sort').options].find((o) => o.value === `${posSort.key}:${posSort.dir}`); if (opt) $('ov-sort').value = opt.value;
  const grouped = sections.some((s) => s.label);
  if (grouped && !posInit) { posInit = true; if (window.matchMedia('(max-width: 720px)').matches) sections.forEach((s) => posShut.add(s.label)); }
  const share = (x) => (total.value > 0 && x != null ? x / total.value : null);

  // ribbon: one bar for the whole portfolio; the legend carries dollars and percent
  let segs = grouped ? sections.map((s) => ({ label: s.label, value: s.total.value, focus: s.label }))
    : [...sections[0].rows].sort((a, b) => (b.value || 0) - (a.value || 0)).map((r) => ({ label: r.label, value: r.value, cash: r.tickers[0] === CASH && r.tickers.length === 1 }));
  segs = segs.filter((x) => x.value > 0);
  if (segs.length > 7) { const rest = segs.slice(6); segs = [...segs.slice(0, 6), { label: `${rest.length} smaller holdings`, value: rest.reduce((a, x) => a + x.value, 0), other: true }]; }
  const sum = segs.reduce((a, x) => a + x.value, 0) || 1;
  let ci = 0; segs.forEach((x) => { x.color = x.cash ? 'var(--cash)' : x.other ? 'var(--other)' : RIBBON[ci++ % RIBBON.length]; });
  $('ov-ribbon').innerHTML = segs.map((x) => `<span style="flex:${(x.value / sum).toFixed(4)} 1 0;background:${x.color}"${posFocus && x.focus !== posFocus ? ' class="dim"' : ''} title="${esc(x.label)} ${usd(x.value)}"></span>`).join('');
  $('ov-legend').innerHTML = segs.map((x) => { const inner = `<i style="background:${x.color}"></i><span class="n">${esc(x.label)}</span><span class="a">${usd(x.value)}</span><span class="p">${pct(x.value / sum, 1)}</span>`; return x.focus ? `<li><button type="button" data-focus="${esc(x.focus)}" aria-pressed="${posFocus === x.focus}">${inner}</button></li>` : `<li><div>${inner}</div></li>`; }).join('');

  // holdings list
  const arrow = (k) => (posSort.key === k ? (posSort.dir === 'asc' ? ' ▲' : ' ▼') : '');
  const head = [['label', posView === 'security' ? 'Security' : 'Holding', ''], ['value', 'Value', 'r'], ['valuePct', 'Share', 'r c-share'], ['gainPct', 'Gain', 'r'], ['cagr', 'Per year', 'r c-wide'], ['netPct', 'Income', 'r c-wide']];
  let html = `<div class="hrow hhead">${head.map(([k, t, c]) => `<button type="button" class="hc ${c}" data-sortkey="${k}">${t}${arrow(k)}</button>`).join('')}</div>`;
  const cellsOf = (r) => {
    const sh = share(r.value);
    const yr = r.cagr != null ? move(r.cagr) : r.gainPct != null ? '<span class="muted" title="Invested for under a year on average">&lt;1 yr</span>' : '<span class="muted">—</span>';
    return `<span class="hc r v">${usd(r.value)}${r.priceMissing ? ' <span class="tag">no price</span>' : ''}</span>
      <span class="hc r c-share"><span class="pbar"><i style="width:${Math.max(0, Math.min(100, (sh || 0) * 100)).toFixed(1)}%"></i></span>${sh == null ? '—' : pct(sh, 1)}</span>
      <span class="hc r g">${r.basisMissing ? '<span class="muted">no cost</span>' : move(r.gainPct)}${r.gain != null && r.gainPct != null ? `<small>${r.gain < 0 ? '-' : '+'}${usd(Math.abs(r.gain))}</small>` : ''}</span>
      <span class="hc r c-wide">${yr}</span>
      <span class="hc r c-wide">${r.netPct == null ? '<span class="muted">—</span>' : pct(r.netPct, 2)}</span>`;
  };
  const detail = (r) => {
    const f = (l, v) => `<div><dt>${l}</dt><dd>${v}</dd></div>`;
    return `<dl class="hdetail">
      ${r.shares != null ? f('Shares', sharesText(r.shares)) + f('Price', '$' + fmt(r.price)) : ''}
      ${f('Cost basis', r.basisMissing ? 'missing' : '$' + fmt(r.cost))}${f('Share of total cost', r.basisMissing || !total.cost ? '—' : pct(r.cost / total.cost, 1))}
      ${f('Gain in dollars', r.gain == null ? '—' : (r.gain < 0 ? '-$' : '$') + fmt(Math.abs(r.gain)))}${f('Gain per year', r.cagr != null ? pct(r.cagr, 1) : r.gainPct != null ? `under a year held (${r.years.toFixed(1)} yr)` : '—')}
      ${f('Income, last 12 months', '$' + fmt(r.income))}${f('Less tax, fees, fund costs', '$' + fmt(r.taxes + r.fees + r.expense))}${f('Net income', r.netPct == null ? '—' : `$${fmt(r.net)} (${pct(r.netPct, 2)})`)}
      ${r.accounts > 1 ? f('Held in', `${r.accounts} accounts`) : ''}
    </dl>`;
  };
  for (const sec of sections) {
    if (posFocus && sec.label !== posFocus) continue;
    const shut = sec.label && posShut.has(sec.label);
    if (sec.label) html += `<button type="button" class="hrow hgroup" data-group="${esc(sec.label)}" aria-expanded="${!shut}"><span class="hc"><span class="chev">${shut ? '▸' : '▾'}</span><span class="gn">${esc(sec.label)}</span><small>${sec.rows.length} ${sec.rows.length === 1 ? 'line' : 'lines'}</small></span>${cellsOf(sec.total)}</button>`;
    if (shut) continue;
    for (const r of sec.rows) {
      const key = `${sec.label || ''}|${r.label}|${r.sub}`; const open = posOpen.has(key);
      html += `<button type="button" class="hrow hitem${sec.label ? ' in' : ''}" data-row="${esc(key)}" aria-expanded="${open}"><span class="hc"><span class="nm">${esc(r.label)}</span><small>${esc(r.sub)}</small></span>${cellsOf(r)}</button>${open ? detail(r) : ''}`;
    }
  }
  const n = items.filter((i) => i.ticker !== CASH).length;
  if (!posFocus) html += `<div class="hrow htotal"><span class="hc">Total<small>${n} positions and cash</small></span>${cellsOf(total)}</div>`;
  else html += `<p class="muted small focusnote">Showing ${esc(posFocus)} only. Tap it again in the legend above to show everything.</p>`;
  $('ov-positions').innerHTML = html;
}

// ---------- log ----------
['log-q', 'log-acct', 'log-type', 'log-src'].forEach((id) => $(id).addEventListener('input', renderLog));
function renderLog() {
  const d = S.doc; const tb = $('log-table').querySelector('tbody'); tb.innerHTML = '';
  if (!d) return;
  const q = $('log-q').value.toLowerCase(), acct = $('log-acct').value, type = $('log-type').value, src = $('log-src').value;
  const base = src === '' ? d.transactions : src === 'sim' ? withSimulations(d).transactions.filter((t) => t.flags.includes('SIM')) : src === 'manual' ? d.transactions.filter((t) => t.flags.includes('MANUAL')) : withSimulations(d).transactions;
  const rows = sortTxs(base).reverse().filter((t) => (!acct || t.account === acct) && (!type || t.type === type) && (!q || [t.ticker, t.type, t.kind, String(t.value), t.date].join(' ').toLowerCase().includes(q)));
  rows.slice(0, 500).forEach((t) => tb.insertAdjacentHTML('beforeend', `<tr><td>${t.date}</td><td>${esc(labelOf(t.account))}</td><td>${t.type}</td><td>${esc(t.ticker)}</td><td class="r">${t.shares ?? ''}</td><td class="r">${fmt(t.value)}</td><td class="r">${t.fees ? fmt(t.fees) : ''}</td><td>${esc(t.kind)}</td><td>${t.flags.map((f) => `<span class="tag">${f}</span>`).join(' ')}</td></tr>`));
  $('log-count').textContent = `${rows.length} rows${rows.length > 500 ? ' (showing 500)' : ''}`;
}

// ---------- utils ----------
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
window.addEventListener('beforeunload', () => { S.doc = null; S.session = null; });
