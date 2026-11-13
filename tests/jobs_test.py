"""Offline tests for the data jobs: parsing with mocked HTTP. Run: python3 tests/jobs_test.py"""
import io, json, os, sys, tempfile, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'jobs'))
import common, refresh_quotes, refresh_macro, fetch_ff  # noqa: E402

fails = []
def check(name, cond):
    print(('ok  ' if cond else 'FAIL'), name)
    if not cond: fails.append(name)

# ---- quotes: yahoo parse
yahoo_payload = {'chart': {'result': [{'meta': {'shortName': 'Test ETF'}, 'timestamp': [1704153600, 1704240000, 1704326400],
    'indicators': {'quote': [{'close': [100.0, None, 102.5]}], 'adjclose': [{'adjclose': [99.0, None, 101.4]}]}}]}}
refresh_quotes.get_json = lambda url, **k: yahoo_payload
q = refresh_quotes.yahoo('TEST', '2024-01-01')
check('yahoo: skips null, keeps both fields', q['close'] == {'2024-01-02': 100.0, '2024-01-04': 102.5} and q['adjClose']['2024-01-04'] == 101.4 and q['adjusted'])
# ---- quotes: stooq parse
refresh_quotes.get = lambda url, **k: b'Date,Open,High,Low,Close,Volume\n2021-12-31,1,1,1,90,1\n2024-01-02,1,1,1,100,1\n2024-01-03,1,1,1,N/D,1\n'
s = refresh_quotes.stooq('TEST', '2022-01-01')
check('stooq: since filter and N/D skip', s['close'] == {'2024-01-02': 100.0} and not s['adjusted'])
# ---- quotes: end-to-end with mocks writing to a temp data dir
tmp = tempfile.mkdtemp()
refresh_quotes.DATA = tmp; refresh_quotes.QDIR = os.path.join(tmp, 'quotes')
refresh_quotes.sp500 = lambda: (['AAA'], {'AAA': 'Information Technology'}, {'AAA': 'Aaa Corp'})
refresh_quotes.read_json = lambda p, d=None: {'tickers': {'BBB': {}}}
calls = []
def fake_yahoo(sym, since):
    calls.append(sym)
    if sym == 'BBB': raise RuntimeError('blocked')
    return {'source': 'yahoo', 'adjusted': True, 'name': sym, 'close': {'2024-01-02': 1.0}, 'adjClose': {'2024-01-02': 1.0}}
def fake_stooq(sym, since):
    raise RuntimeError('nope')
refresh_quotes.yahoo = fake_yahoo; refresh_quotes.stooq = fake_stooq
sys.argv = ['x', '--only', 'AAA,BBB', '--sleep', '0']
try:
    refresh_quotes.main(); code = 0
except SystemExit as e:
    code = e.code
idx = json.load(open(os.path.join(tmp, 'quotes', 'index.json')))
check('quotes: partial failure keeps going, index lists failed', code in (0, None) and idx['tickers'] == ['AAA'] and 'BBB' in idx['failed'])
aaa = json.load(open(os.path.join(tmp, 'quotes', 'AAA.json')))
check('quotes: per-ticker file has sector/name from constituents', aaa['sector'] == 'Information Technology' and aaa['name'] == 'AAA')

# ---- macro: mocked FRED
def fred(url, **k):
    if '/series/observations' in url:
        return {'observations': [{'date': '2025-01-01', 'value': '100'}, {'date': '2025-02-01', 'value': '.'}, {'date': '2026-01-01', 'value': '103'}, {'date': '2026-02-01', 'value': '104'}]}
    if '/series/release' in url:
        return {'releases': [{'id': 10, 'name': 'Consumer Price Index'}]}
    if '/series?' in url:
        return {'seriess': [{'title': 'CPI', 'frequency_short': 'M', 'units_short': 'Index', 'seasonal_adjustment_short': 'SA', 'last_updated': '2026-02-11 07:31:00-06'}]}
    if '/releases/dates' in url:
        return {'release_dates': [{'release_id': 10, 'date': '2099-03-11', 'release_name': 'Consumer Price Index'}, {'release_id': 99, 'date': '2099-03-12', 'release_name': 'Other'}]}
    raise AssertionError(url)
refresh_macro.get_json = fred; refresh_macro.KEY = 'x'
refresh_macro.SERIES = {'inflation': [('CPIAUCSL', 'CPI, all items')]}
refresh_macro.DATA = tmp
try:
    refresh_macro.main(); code = 0
except SystemExit as e:
    code = e.code
m = json.load(open(os.path.join(tmp, 'macro.json')))
cpi = m['series']['CPIAUCSL']
check('macro: latest/prior/yoy and release mapping', cpi['latest']['value'] == 104 and cpi['prior']['value'] == 103 and abs(cpi['yoy'] - 0.04) < 1e-9 and m['upcoming'][0]['series'] == ['CPIAUCSL'] and len(m['upcoming']) == 1 and code in (0, None))
# bad id fails loudly but file is written
def fred_bad(url, **k):
    if 'NOPE' in url: raise RuntimeError('Bad Request')
    return fred(url, **k)
refresh_macro.get_json = fred_bad
refresh_macro.SERIES = {'inflation': [('CPIAUCSL', 'CPI'), ('NOPE', 'bad')]}
try:
    refresh_macro.main(); code = 0
except SystemExit as e:
    code = e.code
m = json.load(open(os.path.join(tmp, 'macro.json')))
check('macro: unknown id -> errors + exit 1, good series still written', code == 1 and 'NOPE' in m['errors'] and 'CPIAUCSL' in m['series'])

# ---- fama-french zip parse
def make_zip(text):
    b = io.BytesIO(); z = zipfile.ZipFile(b, 'w'); z.writestr('f.csv', text); z.close(); return b.getvalue()
five = "This file was created by CMPT_ME_BEME_RETS\n\n,Mkt-RF,SMB,HML,RMW,CMA,RF\n20141231,1,1,1,1,1,0.01\n20240102,0.5,-0.1,0.2,0.05,-0.02,0.02\n20240103,-0.3,0.1,0.0,0.1,0.0,0.02\n"
mom = "Momentum\n\n,Mom   \n20240102,0.7\n20240103,-0.2\n"
fetch_ff.get = lambda url, **k: make_zip(five if 'Momentum' not in url else mom)
fetch_ff.DATA = tmp
fetch_ff.main()
ff = json.load(open(os.path.join(tmp, 'ff.json')))
check('ff: parses both zips, aligns dates, drops pre-2015', ff['dates'] == ['2024-01-02', '2024-01-03'] and ff['Mkt-RF'] == [0.5, -0.3] and ff['Mom'] == [0.7, -0.2] and ff['RF'] == [0.02, 0.02])

print(f'\n{len(fails)} failures')
sys.exit(1 if fails else 0)
