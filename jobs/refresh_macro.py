"""Refreshes macro series from FRED into data/macro.json. Needs FRED_API_KEY in the environment.

For each series: title, frequency, units, latest and prior observation, last-updated time, and a
history window (daily series: 4 years; others: since 2010). Also pulls the upcoming release
calendar for the releases these series belong to. Every series ID is verified against FRED; an
unknown ID is reported in `errors` and the job exits non-zero AFTER writing the file, so the
workflow still commits what it got.
"""
import os, sys
from datetime import date, timedelta
from common import DATA, get_json, write_json, log, now_iso, today

API = 'https://api.stlouisfed.org/fred'
KEY = os.environ.get('FRED_API_KEY', '').strip()

# group -> [(id, label)]
SERIES = {
    'growth': [('GDPC1', 'Real GDP'), ('RSAFS', 'Retail sales'), ('INDPRO', 'Industrial production'), ('CFNAI', 'Chicago Fed National Activity Index'),
               ('USSLIND', 'Leading index (Philadelphia Fed)'), ('GACDFSA066MSFRBPHI', 'Philly Fed manufacturing, current activity'),
               ('GACDISA066MSFRBNY', 'Empire State manufacturing, current activity')],
    'labor': [('PAYEMS', 'Nonfarm payrolls'), ('UNRATE', 'Unemployment rate'), ('ICSA', 'Initial jobless claims'), ('JTSJOL', 'JOLTS job openings'),
              ('CES0500000003', 'Average hourly earnings')],
    'inflation': [('CPIAUCSL', 'CPI, all items'), ('CPILFESL', 'CPI, core'), ('PCEPI', 'PCE price index'), ('PCEPILFE', 'Core PCE'),
                  ('PPIACO', 'PPI, all commodities'), ('T5YIE', '5-year breakeven inflation'), ('T10YIE', '10-year breakeven inflation')],
    'rates': [('FEDFUNDS', 'Fed funds effective rate'), ('DGS3MO', '3-month Treasury'), ('DGS2', '2-year Treasury'), ('DGS10', '10-year Treasury'),
              ('DGS30', '30-year Treasury'), ('DFII10', '10-year TIPS real yield'), ('T10Y2Y', '10y minus 2y spread'), ('WALCL', 'Fed balance sheet'),
              ('M2SL', 'M2 money supply')],
    'risk': [('VIXCLS', 'VIX'), ('BAMLH0A0HYM2', 'High-yield OAS'), ('DTWEXBGS', 'Broad dollar index'), ('DCOILWTICO', 'WTI crude'),
             ('UMCSENT', 'UMich consumer sentiment')],
    'housing': [('HOUST', 'Housing starts'), ('HSN1F', 'New home sales')],
}
PCT_CHANGE = {'GDPC1', 'RSAFS', 'INDPRO', 'PAYEMS', 'JTSJOL', 'CES0500000003', 'CPIAUCSL', 'CPILFESL', 'PCEPI', 'PCEPILFE', 'PPIACO', 'WALCL', 'M2SL', 'HOUST', 'HSN1F', 'DTWEXBGS', 'DCOILWTICO', 'ICSA'}
YOY = {'CPIAUCSL', 'CPILFESL', 'PCEPI', 'PCEPILFE', 'PPIACO', 'M2SL', 'CES0500000003', 'RSAFS', 'INDPRO'}


def fetch_series(sid):
    meta = get_json(f'{API}/series?series_id={sid}&api_key={KEY}&file_type=json')['seriess'][0]
    freq = meta.get('frequency_short', '')
    start = (date.today() - timedelta(days=4 * 366)).isoformat() if freq == 'D' else '2010-01-01'
    obs = get_json(f'{API}/series/observations?series_id={sid}&api_key={KEY}&file_type=json&observation_start={start}')['observations']
    hist = {o['date']: float(o['value']) for o in obs if o['value'] not in ('.', '')}
    if not hist:
        raise RuntimeError('no observations')
    dates = sorted(hist)
    latest, prior = dates[-1], dates[-2] if len(dates) > 1 else None
    out = {'title': meta['title'], 'frequency': freq, 'units': meta.get('units_short', ''), 'seasonal': meta.get('seasonal_adjustment_short', ''),
           'lastUpdated': meta.get('last_updated', ''), 'latest': {'date': latest, 'value': hist[latest]},
           'prior': {'date': prior, 'value': hist[prior]} if prior else None, 'history': hist}
    if sid in YOY:
        yr = [d for d in dates if d <= _shift_year(latest)]
        if yr:
            out['yoy'] = hist[latest] / hist[yr[-1]] - 1
    if prior and sid in PCT_CHANGE and hist[prior]:
        out['pctChange'] = hist[latest] / hist[prior] - 1
    elif prior:
        out['change'] = hist[latest] - hist[prior]
    rel = get_json(f'{API}/series/release?series_id={sid}&api_key={KEY}&file_type=json')['releases'][0]
    out['release'] = {'id': rel['id'], 'name': rel['name']}
    return out


def _shift_year(d):
    y, m, dd = d.split('-')
    return f'{int(y) - 1}-{m}-{dd}'


def upcoming(release_ids):
    end = (date.today() + timedelta(days=60)).isoformat()
    url = f'{API}/releases/dates?api_key={KEY}&file_type=json&realtime_start={today()}&realtime_end={end}&include_release_dates_with_no_data=true&limit=1000'
    try:
        dates = get_json(url)['release_dates']
    except Exception as e:  # noqa: BLE001
        log('release calendar unavailable:', e)
        return []
    want = set(release_ids)
    out = [{'date': r['date'], 'releaseId': r['release_id'], 'name': r.get('release_name', '')} for r in dates if r['release_id'] in want and r['date'] >= today()]
    return sorted(out, key=lambda r: r['date'])[:40]


def main():
    if not KEY:
        log('FRED_API_KEY is not set'); sys.exit(2)
    path = os.path.join(DATA, 'macro.json')
    out = {'asOf': now_iso(), 'source': 'FRED (Federal Reserve Bank of St. Louis)', 'groups': {}, 'series': {}, 'errors': {}}
    rel_ids = {}
    for group, items in SERIES.items():
        out['groups'][group] = [sid for sid, _ in items]
        for sid, label in items:
            try:
                s = fetch_series(sid)
                s['label'] = label
                out['series'][sid] = s
                rel_ids[s['release']['id']] = s['release']['name']
                log('ok', sid, s['latest'])
            except Exception as e:  # noqa: BLE001
                out['errors'][sid] = str(e)
                log('FAILED', sid, e)
    rel = upcoming(rel_ids.keys())
    by_rel = {}
    for sid, s in out['series'].items():
        by_rel.setdefault(s['release']['id'], []).append(sid)
    for r in rel:
        r['series'] = by_rel.get(r['releaseId'], [])
    out['upcoming'] = rel
    write_json(path, out)
    log(f"macro: {len(out['series'])} ok, {len(out['errors'])} failed")
    if out['errors']:
        sys.exit(1)


if __name__ == '__main__':
    main()
