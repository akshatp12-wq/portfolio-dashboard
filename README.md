# Portfolio dashboard

A private portfolio dashboard served from GitHub Pages. All portfolio data lives in one
encrypted file, `data/portfolio.enc.json`, decrypted in the browser with a passphrase.
All portfolio math runs in the browser. GitHub Actions only refresh public data.

## Tabs

- **Overview**: value, time-weighted return (deposit-neutral), excess vs a benchmark or
  custom mix on the same flows, XIRR (secondary), net flows.
- **Assess**: date range down to the month, benchmark overlays and user mixes with
  rebalancing, risk metrics (Sharpe, Sortino, Calmar, drawdowns, beta, capture), factor
  loadings (ETF proxies and Fama-French), sector look-through, fund overlap, costs, FIFO
  lots, realized gains, wash sales across all accounts.
- **Macro**: FRED series by group with staleness flags and the release calendar.
- **Trade**: add a position as a *Simulation* (stored separately, toggled into Overview,
  Assess and Log with "Include simulations") or as *Actually bought* (appended to the real
  ledger with a MANUAL flag). Only ticker, date, shares, price, fees, account and a short
  name are stored.
- **Log**: every transaction, filterable by account, type and source (real, simulated, manual).
- **Data**: unlock, import, scrub, merge, opening basis and cash, manual prices,
  statement reconciliation, encrypt and save to GitHub.

Scheduled jobs (`.github/workflows/refresh.yml`) refresh quotes after the close on
weekdays, macro three times a day, and Fama-French monthly. They need a `FRED_API_KEY`
repository secret; `SCREENER_UNIVERSE_URL` is an optional repository variable.

## Security model

- The repo is public. The only defense for the encrypted document is the passphrase.
  Use at least five random words. **There is no recovery.** Store it in a password manager.
- Encryption: AES-256-GCM, key from PBKDF2-SHA256 with 600,000 iterations, random
  16-byte salt and 12-byte IV per save (`engine/crypto.js`).
- Nothing with portfolio data is ever sent anywhere except the encrypted file to GitHub.
  The page's CSP limits network access to the site itself and `api.github.com`.
- Raw broker CSVs and the denylist are gitignored, blocked by the pre-commit hook, and
  checked for in CI (`scripts/guard.js`). Enable the hook once per clone:
  `git config core.hooksPath .githooks`
- **If plaintext is ever committed:** rewrite history to remove it, force-push, change the
  passphrase, re-encrypt, and treat the old data as public.

## What gets stored

Per transaction: date, type, value, fees, taxes, shares, ticker, account id, a kind code
from a closed list, flags. Accounts are stored as a type (`taxable`, `tax_deferred`,
`tax_free`, `hsa`) plus a generic label such as "Taxable A". No notes, names, account
numbers, or institution names survive the scrub. `engine/document.js` rejects any other field.
Simulations store the same closed set of fields plus a short name limited to letters,
digits, spaces and `- / . %`.

## First-time setup

1. Create the public repo, push this code, enable Pages (Settings → Pages → Source:
   GitHub Actions). The `deploy-pages` workflow publishes the site.
2. Create a fine-grained personal access token: Repository access = this repo only,
   Permissions = Contents: Read and write. Nothing else. It is entered in the page each
   session and never stored.
3. Open the site → Data tab → type a passphrase → **Start a new empty document**.
4. Drop the seven Portfolio Performance CSVs. Check the account types, paste your
   denylist (your name, bank and brokerage names), click **Scrub and check**, then
   **Add to document**.
5. Enter opening cost basis, opening cash, and any manual prices. **Apply overrides**.
6. Enter owner, repo, token, then **Encrypt and save**. Pages redeploys in a minute.
7. On any device: open the site, enter the passphrase, **Unlock**.

## Saving changes

Every change is held in memory until you **Encrypt and save**. Closing the tab discards it.
A save that conflicts with a newer version on GitHub is refused; reload and redo.

## Review flags

Rows flagged REVIEW came from the import with a judgment call attached (option
assignment, split, merger cash-out). They show in the Log tab. Confirm each against the
statement and adjust via a correcting transaction if needed.

## Tests

`npm test` runs the engine tests (Node 22, no dependencies). `python3 tests/jobs_test.py`
runs the data-job tests with mocked HTTP. `node scripts/guard.js` runs the plaintext check.
