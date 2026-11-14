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
loadPublic();
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
  const owner = $('gh-owner').value.trim(), repo = $('gh-repo').value.trim(), branch = $('gh-branch').value.trim() || 'main', token = $('gh-token').value;
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
  const d = S.doc; const k = $('ov-kpis'); const fl = $('ov-flags'); k.innerHTML = ''; fl.innerHTML = '';
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
  const deposits = series.reduce((s, p) => s + p.flow, 0);
  const kpi = (l, v, s = '') => k.insertAdjacentHTML('beforeend', `<div class="kpi"><span class="l">${l}</span><span class="v">${v}</span><span class="muted">${s}</span></div>`);
  kpi('Total value' + (sim.applied.length ? ' (with simulations)' : ''), '$' + fmt(last.value), `cash $${fmt(last.cash)} · holdings $${fmt(last.holdingsValue)}`);
  kpi('Time-weighted return', pct(t.total), t.annualized != null ? `${pct(t.annualized)} annualized` : 'under 1 year');
  const benchName = (allBenchmarks()[benchKey] || BUILT_IN_BENCHMARKS.VOO).name;
  kpi(`Excess vs ${esc(benchName)}`, bench.missing.length ? '—' : pct(t.total - bt.total), bench.missing.length ? `no prices for ${bench.missing.join(', ')}` : `${benchKey} ${pct(bt.total)} on the same flows`);
  kpi('Money-weighted (XIRR)', pct(x), 'secondary metric');
  kpi('Net external flows', '$' + fmt(deposits), `${series[0].date} to ${to}`);
  const missingBasis = [...new Set(sim.transactions.filter((t) => t.kind === 'opening' && t.type === 'Delivery (Inbound)' && accounts.includes(t.account) && d.overrides.openingCostBasis[t.ticker] == null).map((t) => t.ticker))];
  if (missingBasis.length) fl.insertAdjacentHTML('beforeend', `<li class="warn">Opening cost basis missing for ${missingBasis.join(', ')}: unrealized gains and lot terms are incomplete until you enter it on the Data tab. Returns are unaffected.</li>`);
  flags.slice(0, 12).forEach((f) => fl.insertAdjacentHTML('beforeend', `<li>${esc(f)}</li>`));
  $('ov-note').textContent = S.quotes.asOf ? `Quotes as of ${S.quotes.asOf}.${unquoted.length ? ' No quote file for: ' + unquoted.join(', ') + '.' : ''}` : 'No quote files yet, so holdings are valued only where manual prices exist. Run the refresh workflow once.';
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
