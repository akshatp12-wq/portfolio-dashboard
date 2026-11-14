// Manual "Refresh data" button: starts the refresh-public-data workflow through the GitHub API,
// follows its steps and the site redeploy, then reloads the new public data in place.
// Only public data is refreshed; nothing about the portfolio is sent (no tickers, no inputs
// beyond job=all), so the public Actions log reveals nothing.
import { S, $, esc } from './state.js';
import { guessRepoFromLocation } from '../engine/github.js';
import { rememberToken, recallToken } from './device.js';

const API = 'https://api.github.com';
const STEP_LABEL = { Quotes: 'Stock prices', Macro: 'Macro data', 'Fama-French': 'Factor data', Guard: 'Safety check', 'Commit if changed': 'Saving data' };
let running = false, onDone = async () => {};

export function initRefresh({ done }) {
  onDone = done;
  $('btn-refresh').addEventListener('click', start);
  $('rf-go').addEventListener('click', () => { const t = $('rf-token').value.trim(); if (t) { S.ghToken = t; if ($('rf-remember').checked && S.session) rememberToken(S.session, t); $('rf-token').value = ''; $('rf-ask').hidden = true; start(); } });
  $('rf-cancel').addEventListener('click', () => { $('rf-ask').hidden = true; });
  showAsOf();
}

export function showAsOf() {
  const q = S.quotes.asOf ? new Date(S.quotes.asOf) : null, m = S.macro?.asOf ? new Date(S.macro.asOf) : null;
  const f = (d) => d && !isNaN(d) ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  if (!running) $('rf-status').textContent = `Prices ${f(q)} · Macro ${f(m)}`;
}

function repo() {
  const g = guessRepoFromLocation();
  return g || { owner: $('gh-owner')?.value.trim(), repo: $('gh-repo')?.value.trim() };
}
async function gh(path, token, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (r.status === 401 || r.status === 403) { const e = new Error('The token was refused. It needs Actions: Read and write and Contents: Read and write on this repo.'); e.auth = true; throw e; }
  if (!r.ok && r.status !== 204) throw new Error(`GitHub ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function progress(text, frac) {
  $('rf-status').textContent = text;
  const bar = $('rf-bar'); bar.hidden = frac == null; if (frac != null) bar.firstElementChild.style.width = Math.round(Math.max(0.03, Math.min(1, frac)) * 100) + '%';
}

async function start() {
  if (running) return;
  if (!S.ghToken && S.session) S.ghToken = await recallToken(S.session);
  if (!S.ghToken) { $('rf-ask').hidden = false; $('rf-token').focus(); return; }
  const { owner, repo: name } = repo();
  if (!owner || !name) { progress('Open the site from its GitHub Pages address to refresh.', null); return; }
  running = true; $('btn-refresh').disabled = true;
  const t0 = Date.now(), base = `/repos/${owner}/${name}`;
  const tick = setInterval(() => { const el = $('rf-elapsed'); if (el) el.textContent = mmss((Date.now() - t0) / 1000); }, 1000);
  try {
    progress('Starting…', 0.02);
    await gh(`${base}/actions/workflows/refresh.yml/dispatches`, S.ghToken, { method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { job: 'all' } }) });
    // find the run we just started
    let run = null;
    for (let i = 0; i < 30 && !run; i++) {
      await sleep(3000);
      const j = await gh(`${base}/actions/workflows/refresh.yml/runs?event=workflow_dispatch&per_page=5`, S.ghToken);
      run = j.workflow_runs.find((r) => Date.parse(r.created_at) >= t0 - 15000);
    }
    if (!run) throw new Error('The refresh did not start. Try again in a minute.');
    // follow its steps
    for (;;) {
      const jobs = await gh(`${base}/actions/runs/${run.id}/jobs`, S.ghToken);
      const steps = (jobs.jobs[0]?.steps || []).filter((s) => STEP_LABEL[s.name]);
      const done = steps.filter((s) => s.status === 'completed').length;
      const cur = steps.find((s) => s.status === 'in_progress');
      const r = await gh(`${base}/actions/runs/${run.id}`, S.ghToken);
      if (r.status === 'completed') { run = r; break; }
      const label = r.status === 'queued' ? 'Waiting for a GitHub runner' : cur ? STEP_LABEL[cur.name] : done && done === steps.length ? 'Finishing' : 'Preparing';
      progress(`${label}… (${done}/${steps.length || 5}) `, 0.05 + 0.75 * (done / (steps.length || 5)));
      $('rf-status').insertAdjacentHTML('beforeend', '<span id="rf-elapsed"></span>');
      await sleep(5000);
    }
    if (run.conclusion !== 'success') {
      const jobs = await gh(`${base}/actions/runs/${run.id}/jobs`, S.ghToken);
      const failed = (jobs.jobs[0]?.steps || []).filter((s) => s.conclusion === 'failure').map((s) => STEP_LABEL[s.name] || s.name);
      throw new Error(`Refresh failed${failed.length ? ' at: ' + failed.join(', ') : ''}. Data that did refresh was still saved.`);
    }
    // the data commit triggers a site redeploy; wait for it so the new files are live
    progress('Publishing to the site… ', 0.85);
    const finished = Date.parse(run.updated_at);
    let deploy = null;
    for (let i = 0; i < 60; i++) {
      const j = await gh(`${base}/actions/workflows/deploy.yml/runs?per_page=5`, S.ghToken);
      deploy = j.workflow_runs.find((r) => Date.parse(r.created_at) >= finished - 120000 && r.head_sha !== run.head_sha);
      if (!deploy && i >= 4) break;                 // nothing changed, so no redeploy
      if (deploy?.status === 'completed') break;
      await sleep(5000);
    }
    progress('Loading new data…', 0.97);
    await onDone();
    running = false;
    progress(`Refreshed in ${mmss((Date.now() - t0) / 1000)}.`, null);
    setTimeout(showAsOf, 8000);
  } catch (e) {
    if (e.auth) S.ghToken = null;
    progress(e.message, null);
  } finally { running = false; clearInterval(tick); $('btn-refresh').disabled = false; }
}
