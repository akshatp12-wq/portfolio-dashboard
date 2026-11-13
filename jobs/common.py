"""Shared helpers for the public-data jobs. Standard library only."""
import json, os, sys, time, urllib.request, urllib.error
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
UA = 'portfolio-dashboard-jobs/1.0 (+https://github.com)'


def today():
    return date.today().isoformat()


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def get(url, retries=3, backoff=2.0, timeout=30, headers=None):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 400):
                raise
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(backoff * (i + 1))
    raise last


def get_json(url, **kw):
    return json.loads(get(url, **kw).decode('utf-8'))


def write_json(path, obj, pretty_lines=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        if pretty_lines:
            # One top-level key per line keeps git deltas small for daily appends.
            f.write(json.dumps(obj, separators=(',', ':'), indent=0).replace('\n', '\n'))
        else:
            json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def log(*a):
    print(*a, file=sys.stderr, flush=True)
