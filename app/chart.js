// Value vs. money put in: a filled value line over a stepped "put in" line, so the gap between
// them is the gain. Pointer or keyboard scrubbing reads out any date. Pure inline SVG.
import { esc } from './state.js';

const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
const short = (v) => (Math.abs(v) >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : Math.abs(v) >= 1e3 ? '$' + Math.round(v / 1e3) + 'k' : '$' + Math.round(v));
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// points: [{date, value, put}] in date order
export function valueChart(el, points) {
  if (!points.length) { el.innerHTML = '<p class="muted">No history in this range yet.</p>'; return; }
  // drawn at the container's real pixel width so text stays a readable size on a phone
  const W = Math.max(300, Math.round(el.clientWidth || 900)), H = W < 520 ? 210 : 260, pl = 4, pr = 46, pt = 12, pb = 24;
  const t0 = Date.parse(points[0].date), t1 = Math.max(Date.parse(points[points.length - 1].date), t0 + 864e5);
  const vals = points.flatMap((p) => [p.value, p.put]);
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo || hi || 1) * 0.08; lo = Math.max(0, lo - pad); hi += pad;
  const X = (d) => pl + ((Date.parse(d) - t0) / (t1 - t0)) * (W - pl - pr);
  const Y = (v) => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
  const line = points.map((p, i) => (i ? 'L' : 'M') + X(p.date).toFixed(1) + ' ' + Y(p.value).toFixed(1)).join(' ');
  const area = `${line} L ${X(points[points.length - 1].date).toFixed(1)} ${H - pb} L ${X(points[0].date).toFixed(1)} ${H - pb} Z`;
  let step = `M ${X(points[0].date).toFixed(1)} ${Y(points[0].put).toFixed(1)}`;
  for (let i = 1; i < points.length; i++) step += ` H ${X(points[i].date).toFixed(1)} V ${Y(points[i].put).toFixed(1)}`;
  const grid = [0, 1, 2, 3].map((i) => { const v = lo + (hi - lo) * i / 3; return `<line x1="${pl}" x2="${W - pr}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${W - pr + 6}" y="${Y(v) + 4}" class="ax">${short(v)}</text>`; }).join('');
  const last = points[points.length - 1];
  el.innerHTML = `
    <div class="chart-key"><span><i class="k-val"></i>Value</span><span><i class="k-put"></i>Money you put in</span><span class="chart-read" id="chart-read" aria-live="polite"></span></div>
    <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" tabindex="0" aria-label="Portfolio value compared with money put in, ${esc(nice(points[0].date))} to ${esc(nice(last.date))}. Use left and right arrow keys to read values.">
      ${grid}
      <path d="${area}" class="area"/><path d="${step}" class="put"/><path d="${line}" class="val"/>
      <line class="cur" y1="${pt}" y2="${H - pb}" x1="-10" x2="-10"/><circle class="dot" r="4" cx="-10" cy="-10"/>
      <text x="${pl}" y="${H - 6}" class="ax">${esc(nice(points[0].date))}</text><text x="${W - pr}" y="${H - 6}" class="ax" text-anchor="end">${esc(nice(last.date))}</text>
    </svg>`;
  const svg = el.querySelector('svg'), cur = el.querySelector('.cur'), dot = el.querySelector('.dot'), read = el.querySelector('#chart-read');
  let idx = points.length - 1;
  const show = (i) => {
    idx = Math.max(0, Math.min(points.length - 1, i)); const p = points[idx]; const x = X(p.date);
    cur.setAttribute('x1', x); cur.setAttribute('x2', x); dot.setAttribute('cx', x); dot.setAttribute('cy', Y(p.value));
    const g = p.value - p.put;
    read.textContent = `${nice(p.date)}: ${money(p.value)} value, ${money(p.put)} put in, ${g >= 0 ? 'up' : 'down'} ${money(Math.abs(g))}`;
  };
  const at = (e) => {
    const r = svg.getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W;
    const t = t0 + ((x - pl) / (W - pl - pr)) * (t1 - t0);
    let lo2 = 0, hi2 = points.length - 1;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (Date.parse(points[m].date) < t) lo2 = m + 1; else hi2 = m; }
    show(lo2);
  };
  svg.addEventListener('pointermove', at); svg.addEventListener('pointerdown', at);
  svg.addEventListener('pointerleave', () => { cur.setAttribute('x1', -10); cur.setAttribute('x2', -10); dot.setAttribute('cx', -10); read.textContent = ''; });
  svg.addEventListener('keydown', (e) => { const stepN = Math.max(1, Math.round(points.length / 60)); if (e.key === 'ArrowLeft') { show(idx - stepN); e.preventDefault(); } if (e.key === 'ArrowRight') { show(idx + stepN); e.preventDefault(); } });
}
