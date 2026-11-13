// Fails if anything that looks like plaintext portfolio data is in the tree.
// Runs in CI (guard.yml) and from the pre-commit hook.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SKIP = new Set(['.git', 'node_modules']);
const problems = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p);
    if (e.isDirectory()) { walk(p); continue; }
    if (/\.csv$/i.test(e.name) && !rel.startsWith('tests/fixtures/')) problems.push(`${rel}: CSV files are never committed`);
    if (/denylist/i.test(e.name)) problems.push(`${rel}: the denylist is local only`);
    if (/\.plain\./i.test(e.name)) problems.push(`${rel}: plaintext export`);
    if (rel === 'data/portfolio.enc.json') {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!(j.v === 1 && j.ct && j.salt && j.iv)) problems.push(`${rel}: is not an encryption envelope`);
    } else if (rel.startsWith('data/') && /\.json$/.test(e.name)) {
      const txt = fs.readFileSync(p, 'utf8');
      if (/"transactions"\s*:|"account"\s*:\s*"(taxable|tax_)/.test(txt)) problems.push(`${rel}: looks like a plaintext portfolio document`);
    }
  }
}
walk(ROOT);
if (problems.length) { console.error('GUARD FAILED:\n' + problems.map((x) => ' - ' + x).join('\n')); process.exit(1); }
console.log('guard: no plaintext portfolio data found');
