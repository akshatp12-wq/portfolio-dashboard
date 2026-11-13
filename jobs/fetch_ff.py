"""Fetches Ken French daily factor files (5 factors + momentum) into data/ff.json.
Values are in percent, as published. Dates since 2015."""
import csv, io, os, sys, zipfile
from common import DATA, get, write_json, log, now_iso

BASE = 'https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/'
FIVE = 'F-F_Research_Data_5_Factors_2x3_daily_CSV.zip'
MOM = 'F-F_Momentum_Factor_daily_CSV.zip'
SINCE = '20150101'


def read_zip_csv(name):
    z = zipfile.ZipFile(io.BytesIO(get(BASE + name)))
    txt = z.read(z.namelist()[0]).decode('latin-1')
    rows = {}
    header = None
    for line in txt.splitlines():
        parts = [p.strip() for p in line.split(',')]
        if len(parts) > 1 and parts[0] == '' and header is None:
            header = parts[1:]
            continue
        if header and len(parts) == len(header) + 1 and parts[0].isdigit() and len(parts[0]) == 8:
            if parts[0] >= SINCE:
                try:
                    rows[parts[0]] = [float(x) for x in parts[1:]]
                except ValueError:
                    pass
    return header, rows


def main():
    h5, r5 = read_zip_csv(FIVE)
    hm, rm = read_zip_csv(MOM)
    dates = sorted(set(r5) & set(rm))
    if not dates:
        log('no overlapping dates'); sys.exit(1)
    out = {'asOf': now_iso(), 'source': 'Kenneth R. French Data Library', 'units': 'percent per day',
           'dates': [f'{d[:4]}-{d[4:6]}-{d[6:]}' for d in dates]}
    for i, name in enumerate(h5):
        out[name] = [r5[d][i] for d in dates]
    out['Mom'] = [rm[d][0] for d in dates]
    write_json(os.path.join(DATA, 'ff.json'), out)
    log(f'ff: {len(dates)} days, factors {list(h5) + ["Mom"]}')


if __name__ == '__main__':
    main()
