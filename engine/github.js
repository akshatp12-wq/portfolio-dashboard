// GitHub Contents API read/write for one file. Token is passed per call, never stored here.
const API = 'https://api.github.com';

export async function getRepoFile({ owner, repo, path, token, ref = 'main' }) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, {
    headers: headers(token)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(j.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
  return { sha: j.sha, text };
}

// Writes `text` to `path`. If `expectedSha` no longer matches, throws {conflict:true}.
export async function putRepoFile({ owner, repo, path, token, branch = 'main', text, expectedSha, message }) {
  const current = await getRepoFile({ owner, repo, path, token, ref: branch });
  if (current && expectedSha && current.sha !== expectedSha) {
    const err = new Error('The file changed on GitHub since you loaded it.'); err.conflict = true; err.current = current; throw err;
  }
  const body = { message: message || 'Update encrypted portfolio document', content: btoa(unescape(encodeURIComponent(text))), branch };
  if (current) body.sha = current.sha;
  const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${path}`, { method: 'PUT', headers: { ...headers(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return { sha: j.content.sha, commit: j.commit.sha };
}

function headers(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}

// Guess owner/repo from a GitHub Pages URL like https://owner.github.io/repo/
export function guessRepoFromLocation(loc = globalThis.location) {
  if (!loc) return null;
  const m = /^([^.]+)\.github\.io$/.exec(loc.hostname || '');
  if (!m) return null;
  const seg = (loc.pathname || '/').split('/').filter(Boolean)[0];
  return seg ? { owner: m[1], repo: seg } : null;
}
