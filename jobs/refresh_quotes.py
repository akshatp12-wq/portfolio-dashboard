"""Refreshes end-of-day prices for a broad public universe into data/quotes/<TICKER>.json.

Universe = S&P 500 constituents (public dataset) + benchmark/proxy ETFs + every ticker in
data/fundmeta.json + optional extra list from SCREENER_UNIVERSE_URL. Prices are fetched per
ticker from Yahoo's chart endpoint (close and adjusted close); stooq is the fallback
(close only, adjusted = close, flagged). A ticker that fails keeps its previous file.

Usage: python jobs/refresh_quotes.py [--since 2022-01-01] [--only VOO,QQQ] [--sleep 0.4]
Exit code 0 even with partial failures (they are listed in data/quotes/index.json) unless
EVERY ticker failed, which usually means the source is blocking the runner.
"""
import argparse, csv, io, os, sys, time
from datetime import datetime, timezone
from common import DATA, get, get_json, read_json, write_json, log, now_iso

QDIR = os.path.join(DATA, 'quotes')
CORE = ['VOO', 'VONG', 'QQQ', 'VTI', 'VTV', 'IWM', 'VXUS', 'BND', 'AGG', 'GLD', 'BIL', 'SHV', 'SHY', 'IEF', 'TLT',
        'MTUM', 'QUAL', 'USMV', 'SPY', 'IVV', 'VUG', 'VB', 'VEA', 'VWO', 'SCHD', 'SCHG', 'SCHX', 'SPYM', 'SPLG', 'DIA', 'IWF', 'IWD',
        'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB', 'XLRE', 'XLC', 'VNQ', 'ARKK', 'PICK', 'SLV', 'USO']
SP500_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv'


def sp500():
    try:
        txt = get(SP500_URL).decode('utf-8')
        rows = list(csv.DictReader(io.StringIO(txt)))
        syms = [r['Symbol'].strip().replace('.', '-') for r in rows if r.get('Symbol')]
        sectors = {r['Symbol'].strip().replace('.', '-'): r.get('GICS Sector', '') for r in rows}
        names = {r['Symbol'].strip().replace('.', '-'): r.get('Security', '') for r in rows}
        return syms, sectors, names
    except Exception as e:  # noqa: BLE001
        log('S&P 500 list unavailable:', e)
        return [], {}, {}


def yahoo(symbol, since):
    start = int(datetime.strptime(since, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp())
    url = f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={start}&period2=9999999999&interval=1d&events=div%2Csplits'
    j = get_json(url)
    res = j['chart']['result'][0]
    ts = res['timestamp']
    q = res['indicators']['quote'][0]['close']
    adj = res['indicators'].get('adjclose', [{}])[0].get('adjclose') or q
    close, adjclose = {}, {}
    for t, c, a in zip(ts, q, adj):
        if c is None:
            continue
        d = datetime.fromtimestamp(t, tz=timezone.utc).strftime('%Y-%m-%d')
        close[d] = round(c, 4)
        adjclose[d] = round(a if a is not None else c, 4)
    name = res.get('meta', {}).get('shortName') or res.get('meta', {}).get('longName') or ''
    divs = {}
    for ev in (res.get('events', {}) or {}).get('dividends', {}).values():
        if ev.get('amount') is not None and ev.get('date') is not None:
            divs[datetime.fromtimestamp(ev['date'], tz=timezone.utc).strftime('%Y-%m-%d')] = round(float(ev['amount']), 6)
    return {'source': 'yahoo', 'adjusted': True, 'name': name, 'close': close, 'adjClose': adjclose, 'dividends': dict(sorted(divs.items()))}


def stooq(symbol, since):
    url = f'https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d'
    txt = get(url).decode('utf-8')
    close = {}
    for r in csv.DictReader(io.StringIO(txt)):
        if r.get('Date', '') >= since and r.get('Close') not in (None, '', 'N/D'):
            close[r['Date']] = round(float(r['Close']), 4)
    if not close:
        raise RuntimeError('stooq returned no rows')
    return {'source': 'stooq', 'adjusted': False, 'name': '', 'close': close, 'adjClose': dict(close)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='2022-01-01')
    ap.add_argument('--only', default='')
    ap.add_argument('--sleep', type=float, default=0.4)
    a = ap.parse_args()

    syms, sectors, names = sp500()
    fundmeta = read_json(os.path.join(DATA, 'fundmeta.json'), {'tickers': {}})
    universe = set(CORE) | set(syms) | set(fundmeta.get('tickers', {}).keys())
    extra_url = os.environ.get('SCREENER_UNIVERSE_URL', '').strip()
    if extra_url:
        try:
            ext = get_json(extra_url)
            extra = ext if isinstance(ext, list) else ext.get('tickers', [])
            universe |= {str(t).upper() for t in extra}
        except Exception as e:  # noqa: BLE001
            log('screener universe unavailable:', e)
    if a.only:
        universe = {s.strip().upper() for s in a.only.split(',') if s.strip()}
    universe = sorted(t for t in universe if t and ' ' not in t)

    ok, failed = [], {}
    for i, sym in enumerate(universe):
        data = None
        for fn in (yahoo, stooq):
            try:
                data = fn(sym, a.since)
                if data['close']:
                    break
            except Exception as e:  # noqa: BLE001
                data = None
                err = f'{fn.__name__}: {e}'
        if not data:
            failed[sym] = err
            continue
        last = max(data['close'])
        obj = {'ticker': sym, 'source': data['source'], 'adjusted': data['adjusted'], 'asOf': last, 'fetchedAt': now_iso(),
               'name': data['name'] or names.get(sym, ''), 'sector': sectors.get(sym, ''), 'close': data['close'], 'adjClose': data['adjClose'], 'dividends': data.get('dividends', {})}
        write_json(os.path.join(QDIR, f'{sym}.json'), obj, pretty_lines=True)
        ok.append(sym)
        if (i + 1) % 50 == 0:
            log(f'{i + 1}/{len(universe)}')
        time.sleep(a.sleep)

    index = {'asOf': now_iso(), 'since': a.since, 'count': len(ok), 'tickers': ok, 'failed': failed,
             'sectors': {s: sectors[s] for s in ok if sectors.get(s)}, 'names': {s: names[s] for s in ok if names.get(s)}}
    write_json(os.path.join(QDIR, 'index.json'), index)
    log(f'quotes: {len(ok)} ok, {len(failed)} failed')
    if ok == [] and universe:
        sys.exit(1)


if __name__ == '__main__':
    main()
