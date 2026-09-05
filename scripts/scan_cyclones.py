#!/usr/bin/env python3
"""Fetch tropical cyclone tracks, observed and forecast → public/data/cyclones.json.

Usage:
    python3 scripts/scan_cyclones.py
    python3 scripts/scan_cyclones.py --print

Two public sources, neither needing a key, which is the only reason they can be used here:

- **Observed** — IBTrACS `ACTIVE` (NOAA NCEI, v04r01). One CSV of every storm currently being
  tracked worldwide, refreshed about daily, with the agencies' positions, winds, pressure and the
  34/50/64 kt wind radii by quadrant. Positions are *provisional* best track: they get revised as
  the storm is re-analysed, and the file drops a storm the moment it dissipates — hence the
  rolling cache below.

- **Forecast** — JTWC warnings (US Navy, public domain). The RSS feed lists the current products;
  each `*web.txt` is a fixed-format text with the analysed position, its stated accuracy, and the
  official forecast at 12/24/36/48/72/96/120 h with winds and wind radii. This is a forecast and
  is labelled as one in the file and everywhere it is drawn.

Basins
------
Two reach Myanmar: the North Indian Ocean (Bay of Bengal), which JTWC files under the prefix
**`io`** — not `ni`, which is what IBTrACS calls the same basin — and the West Pacific (`wp`), whose
remnants cross from the South China Sea. A storm is kept if any observed **or forecast** point falls
inside `BOX`: the Bay of Bengal, the Andaman Sea, the Gulf of Thailand and the approaches from the
west Pacific — wide enough that a cyclone still far out in the Bay is on the map days before it
matters, tight enough that a typhoon off Taiwan is not. The forecast counts because that is the
whole warning: a West Pacific storm appears the moment JTWC forecasts it west of 110°E.

Why there is a cache
--------------------
`ACTIVE` is a snapshot of what is being tracked now. A storm that dissipated yesterday is simply
gone from it, so without a local memory the track of a cyclone that crossed the coast on Monday
would vanish from the map on Tuesday — exactly when a reader wants to compare it with the flood
extents. `data/cyclones_cache.json` retains every storm for `RETAIN_DAYS` after its last position.

What is deliberately not done
-----------------------------
No cone. JTWC publishes one number for the analysed position's accuracy, not a growing forecast
envelope, and drawing a cone from a made-up error growth would present an invention as data. The
wind radii are real and are drawn instead. No landfall or impact inference either: a forecast point
inside Myanmar's box raises an alert that says *where the forecast puts it*, nothing more.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from common import INDEX_PATH, ROOT, fetch, utcnow

CYCLONES_PATH = INDEX_PATH.parent / 'cyclones.json'
CACHE_PATH = ROOT / 'data' / 'cyclones_cache.json'

IBTRACS_URL = ('https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-'
               'stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv')
JTWC_RSS = 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss'
JTWC_PRODUCTS = 'https://www.metoc.navy.mil/jtwc/products/'

# IBTrACS basin codes that can reach Myanmar. JTWC's prefixes for the same two are 'io' and 'wp'.
BASINS = ('NI', 'WP')
JTWC_PREFIX_TO_BASIN = {'io': 'NI', 'wp': 'WP'}

# west, south, east, north: the Bay of Bengal and its approaches. See the module docstring.
BOX = (80.0, 3.0, 110.0, 30.0)
# Roughly Myanmar itself, for the alert that says a forecast point lies over the country.
MYANMAR_BOX = (88.0, 9.0, 102.0, 29.0)

RETAIN_DAYS = 30
# A JTWC forecast older than this is not carried forward from the cache: the storm is either
# dissipated or the feed is down, and either way a day-old track forecast should not be drawn as
# current. The issue time is in the file for anyone judging a fresher one.
FORECAST_MAX_AGE_H = 36

QUADRANTS = ('NORTHEAST', 'SOUTHEAST', 'SOUTHWEST', 'NORTHWEST')


# ---- helpers ----

def in_box(lat: float, lon: float, box=BOX) -> bool:
    w, s, e, n = box
    return s <= lat <= n and w <= lon <= e


def touches_box(storm: dict, box=BOX) -> bool:
    """Any observed point, the warning position, or any forecast point inside the box."""
    if any(in_box(p['lat'], p['lon'], box) for p in storm.get('observed') or []):
        return True
    fc = storm.get('forecast') or {}
    pts = ([fc['warning']] if fc.get('warning') else []) + list(fc.get('points') or [])
    return any(in_box(p['lat'], p['lon'], box) for p in pts)


def num(s: str | None) -> float | None:
    s = (s or '').strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def intn(s: str | None) -> int | None:
    v = num(s)
    return None if v is None else int(round(v))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_iso(s: str) -> datetime:
    return datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)


def ddhhmm(token: str, ref: datetime) -> datetime:
    """Resolve JTWC's `DDHHMM` against a reference month, tolerating a month boundary either way.

    The texts carry only day-of-month. A warning issued on the 30th forecasting to the 4th, or a
    feed read on the 1st about a warning from the 30th, both cross a month, so the candidate is
    shifted whichever way brings it within a fortnight of the reference.
    """
    day, hour, minute = int(token[0:2]), int(token[2:4]), int(token[4:6])

    def build(year: int, month: int) -> datetime | None:
        try:
            return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
        except ValueError:
            return None

    y, m = ref.year, ref.month
    prev = (y, m - 1) if m > 1 else (y - 1, 12)
    nxt = (y, m + 1) if m < 12 else (y + 1, 1)
    candidates = [c for c in (build(y, m), build(*prev), build(*nxt)) if c]
    return min(candidates, key=lambda c: abs((c - ref).total_seconds()))


# ---- IBTrACS ----

def parse_ibtracs(text: str) -> dict[str, dict]:
    """Storms by SID from the ACTIVE CSV. Only those in a relevant basin and touching the box."""
    rows = list(csv.DictReader(io.StringIO(text)))
    storms: dict[str, dict] = {}
    for r in rows:
        # The second line of the file is a units row ("Year", "degrees_north", ...), not data.
        if not (r.get('SEASON') or '').strip().isdigit():
            continue
        lat, lon = num(r.get('LAT')), num(r.get('LON'))
        if lat is None or lon is None:
            continue
        sid = r['SID'].strip()
        st = storms.setdefault(sid, {
            'sid': sid,
            'atcf': (r.get('USA_ATCF_ID') or '').strip() or None,
            'name': (r.get('NAME') or '').strip() or 'UNNAMED',
            'basins': set(),
            'observed': [],
        })
        st['basins'].add((r.get('BASIN') or '').strip())
        if not st['atcf'] and (r.get('USA_ATCF_ID') or '').strip():
            st['atcf'] = r['USA_ATCF_ID'].strip()

        def radii(kt: str) -> list[int] | None:
            vals = [intn(r.get(f'USA_R{kt}_{q}')) for q in ('NE', 'SE', 'SW', 'NW')]
            return None if all(v is None for v in vals) else [v or 0 for v in vals]

        t = (r.get('ISO_TIME') or '').strip().replace(' ', 'T') + 'Z'
        st['observed'].append({
            't': t,
            'lat': round(lat, 2), 'lon': round(lon, 2),
            'windKt': intn(r.get('USA_WIND')) or intn(r.get('WMO_WIND')),
            'presHpa': intn(r.get('USA_PRES')) or intn(r.get('WMO_PRES')),
            # Saffir-Simpson category as IBTrACS assigns it: -5..-1 below TS, 0 TS, 1-5 hurricane.
            'sshs': intn(r.get('USA_SSHS')),
            'r34': radii('34'), 'r50': radii('50'), 'r64': radii('64'),
            'trackType': (r.get('TRACK_TYPE') or '').strip() or None,
        })

    # Basin only, here: the box is judged in main() once JTWC forecasts are attached, because a
    # storm whose forecast enters the box belongs on the map before its observed track does.
    keep = {}
    for sid, st in storms.items():
        if not (st['basins'] & set(BASINS)):
            continue
        st['observed'].sort(key=lambda p: p['t'])
        # The basin the storm is filed under: the relevant one it spent time in.
        st['basin'] = next(b for b in BASINS if b in st['basins'])
        del st['basins']
        keep[sid] = st
    return keep


# ---- JTWC ----

def jtwc_products(rss: bytes) -> tuple[list[str], datetime]:
    """Current warning product ids (e.g. 'wp2326') for the two basins, and the feed's own time."""
    root = ET.fromstring(rss)
    pub = root.findtext('./channel/pubDate') or root.findtext('./channel/lastBuildDate')
    ref = parsedate_to_datetime(pub) if pub else datetime.now(timezone.utc)
    if ref.tzinfo is None:
        ref = ref.replace(tzinfo=timezone.utc)
    ids: list[str] = []
    for item in root.iter('item'):
        blob = (item.findtext('description') or '') + (item.findtext('link') or '')
        for pid in re.findall(r'products/((?:wp|io)\d{4})web\.txt', blob):
            if pid not in ids:
                ids.append(pid)
    return ids, ref


def atcf_from_product(pid: str) -> str:
    """'wp2326' → 'WP232026', the form IBTrACS records in USA_ATCF_ID."""
    return f'{pid[:2].upper()}{pid[2:4]}20{pid[4:6]}'


_POS = re.compile(r'(\d{6})Z --- (?:NEAR )?([\d.]+)([NS]) ([\d.]+)([EW])')
_TAU = re.compile(r'(\d+) HRS, VALID AT:')
_WIND = re.compile(r'MAX SUSTAINED WINDS - (\d+) KT')
_RADIUS_HEAD = re.compile(r'RADIUS OF (\d{3}) KT WINDS - (\d+) NM (\w+) QUADRANT')
_RADIUS_CONT = re.compile(r'^\s*(\d+) NM (\w+) QUADRANT')


def _block(text: str, ref: datetime) -> dict | None:
    m = _POS.search(text)
    if not m:
        return None
    tok, lat, ns, lon, ew = m.groups()
    out: dict = {
        't': iso(ddhhmm(tok, ref)),
        'lat': round(float(lat) * (1 if ns == 'N' else -1), 1),
        'lon': round(float(lon) * (1 if ew == 'E' else -1), 1),
        'windKt': None, 'r34': None, 'r50': None, 'r64': None,
    }
    w = _WIND.search(text)
    if w:
        out['windKt'] = int(w.group(1))
    radii: dict[str, list[int]] = {}
    current = None
    for line in text.splitlines():
        h = _RADIUS_HEAD.search(line)
        if h:
            current = h.group(1).lstrip('0')
            radii.setdefault(current, [0, 0, 0, 0])[QUADRANTS.index(h.group(3))] = int(h.group(2))
            continue
        c = _RADIUS_CONT.match(line)
        if c and current and c.group(2) in QUADRANTS:
            radii[current][QUADRANTS.index(c.group(2))] = int(c.group(1))
    for kt in ('34', '50', '64'):
        if kt in radii:
            out[f'r{kt}'] = radii[kt]
    if 'DISSIPAT' in text:
        out['dissipating'] = True
    return out


def parse_warning(text: str, ref: datetime, pid: str, url: str) -> dict | None:
    """One JTWC warning text → warning position plus the forecast points."""
    head = re.search(r'^\w+ PGTW (\d{6})', text, re.M)
    issued = ddhhmm(head.group(1), ref) if head else ref
    subj = re.search(r'SUBJ/(.+?) WARNING NR (\d+)', text)
    title = subj.group(1).strip() if subj else pid.upper()
    nm = re.search(r'\b(\d{2}[A-Z])\s*\(([^)]+)\)', title)

    # Blocks are separated by lines of dashes; the first with a position is the warning position,
    # every later one with "HRS, VALID AT" is a forecast tau.
    warning = None
    points = []
    for chunk in re.split(r'\n\s*---\s*\n', text):
        b = _block(chunk, ref)
        if not b:
            continue
        tau = _TAU.search(chunk)
        if tau:
            b['tauH'] = int(tau.group(1))
            points.append(b)
        elif warning is None and 'WARNING POSITION' in chunk:
            acc = re.search(r'POSITION ACCURATE TO WITHIN (\d+) NM', chunk)
            b['accuracyNm'] = int(acc.group(1)) if acc else None
            warning = b
    if warning is None:
        return None
    pres = re.search(r'MINIMUM CENTRAL PRESSURE AT \d{6}Z IS (\d+) MB', text)
    if pres:
        warning['presHpa'] = int(pres.group(1))
    return {
        'agency': 'JTWC',
        'product': pid,
        'atcf': atcf_from_product(pid),
        'number': nm.group(1) if nm else None,
        'name': (nm.group(2).strip().upper() if nm else title),
        'title': title,
        'url': url,
        'issued': iso(issued),
        'warning': warning,
        'points': sorted(points, key=lambda p: p['tauH']),
    }


def fetch_jtwc() -> tuple[list[dict], list[str]]:
    """Every current warning for the two basins. Returns (forecasts, problems)."""
    ids, ref = jtwc_products(fetch(JTWC_RSS, timeout=30))
    forecasts, problems = [], []
    for pid in ids:
        url = f'{JTWC_PRODUCTS}{pid}web.txt'
        try:
            text = fetch(url, timeout=30).decode('utf-8', 'replace')
            fc = parse_warning(text, ref, pid, url)
        except Exception as e:  # noqa: BLE001 - one bad product must not lose the others
            problems.append(f'{pid}: {e}')
            continue
        if fc is None:
            problems.append(f'{pid}: no warning position found')
            continue
        forecasts.append(fc)
    return forecasts, problems


# ---- merge ----

def load_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - a missing or corrupt cache is just an empty memory
        return {'storms': {}}


def attach_forecasts(storms: dict[str, dict], forecasts: list[dict], now: datetime) -> None:
    """Pair each JTWC warning with a storm, by ATCF id first, position second, or make a new one.

    IBTrACS lags JTWC by a day or so, so a brand-new warning often has no observed track yet. It
    still gets a storm entry — the warning position is the one analysed fix there is — flagged by
    a `JTWC:` SID so it can be merged into the IBTrACS record when that appears.
    """
    for st in storms.values():
        st['forecast'] = None
    for fc in forecasts:
        target = next((s for s in storms.values() if s.get('atcf') == fc['atcf']), None)
        if target is None:
            w = fc['warning']
            wt = parse_iso(w['t'])
            for s in storms.values():
                last = s['observed'][-1] if s['observed'] else None
                if not last:
                    continue
                close = abs(last['lat'] - w['lat']) <= 2 and abs(last['lon'] - w['lon']) <= 2
                recent = abs((parse_iso(last['t']) - wt).total_seconds()) <= 12 * 3600
                if close and recent:
                    target = s
                    break
        if target is None:
            if not touches_box({'observed': [], 'forecast': fc}):
                continue
            sid = f'JTWC:{fc["atcf"]}'
            target = storms.setdefault(sid, {
                'sid': sid, 'atcf': fc['atcf'], 'name': fc['name'],
                'basin': JTWC_PREFIX_TO_BASIN[fc['product'][:2]],
                'observed': [],
            })
            # The warning position stands in for an observation until IBTrACS has one.
            obs = {k: w.get(k) for k in ('t', 'lat', 'lon', 'windKt', 'presHpa', 'r34', 'r50', 'r64')}
            obs['sshs'] = None
            obs['trackType'] = 'JTWC warning position'
            if not any(p['t'] == obs['t'] for p in target['observed']):
                target['observed'].append(obs)
                target['observed'].sort(key=lambda p: p['t'])
        if target['name'] in ('UNNAMED', 'NOT_NAMED') and fc['name']:
            target['name'] = fc['name']
        target['forecast'] = {k: fc[k] for k in ('agency', 'product', 'url', 'issued', 'warning', 'points')}


def merge(cache: dict, fresh: dict[str, dict], now: datetime) -> dict[str, dict]:
    """Fresh IBTrACS wins for any storm it still carries; the cache keeps the rest for a month."""
    merged: dict[str, dict] = {}
    for sid, st in cache.get('storms', {}).items():
        last = st['observed'][-1]['t'] if st['observed'] else None
        if last and now - parse_iso(last) <= timedelta(days=RETAIN_DAYS):
            merged[sid] = st
    for sid, st in fresh.items():
        merged[sid] = {**merged.get(sid, {}), **st}
    # A provisional JTWC-only entry is superseded once IBTrACS carries the same ATCF id.
    for sid in [s for s in merged if s.startswith('JTWC:')]:
        atcf = merged[sid].get('atcf')
        if any(s != sid and st.get('atcf') == atcf for s, st in merged.items()):
            del merged[sid]
    return merged


def finish(storms: dict[str, dict], now: datetime) -> list[dict]:
    out = []
    for st in storms.values():
        obs = st['observed']
        st['lastObserved'] = obs[-1]['t'] if obs else None
        fc = st.get('forecast')
        if fc and now - parse_iso(fc['issued']) > timedelta(hours=FORECAST_MAX_AGE_H):
            st['forecast'] = None
        st['peakWindKt'] = max((p['windKt'] or 0 for p in obs), default=0) or None
        out.append(st)
    out.sort(key=lambda s: s['lastObserved'] or '', reverse=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', action='store_true')
    args = ap.parse_args()
    now = datetime.now(timezone.utc)
    sources = []

    print('IBTrACS ACTIVE (observed)')
    try:
        text = fetch(IBTRACS_URL, timeout=90).decode('utf-8', 'replace')
    except Exception as e:  # noqa: BLE001 - reported on stdout and by the exit code
        print(f'error: IBTrACS unreachable: {e}')
        return 1
    fresh = parse_ibtracs(text)
    sources.append({'key': 'ibtracs', 'label': 'IBTrACS v04r01 ACTIVE (NOAA NCEI)',
                    'url': IBTRACS_URL, 'fetchedAt': utcnow(), 'state': 'ok', 'reason': None})
    print(f'  {len(fresh)} storm(s) in basins {"/".join(BASINS)} touching the box')

    print('JTWC warnings (forecast)')
    try:
        forecasts, problems = fetch_jtwc()
        state = 'ok'
        reason = '; '.join(problems) or None
    except Exception as e:  # noqa: BLE001 - the observed track is still worth publishing
        forecasts, state, reason = [], 'skipped', f'JTWC unreachable: {e}'
    sources.append({'key': 'jtwc', 'label': 'JTWC warnings (US Navy)', 'url': JTWC_RSS,
                    'fetchedAt': utcnow(), 'state': state, 'reason': reason})
    print(f'  {len(forecasts)} warning(s){f"; {reason}" if reason else ""}')

    storms = merge(load_cache(), fresh, now)
    attach_forecasts(storms, forecasts, now)
    storms = {sid: st for sid, st in storms.items() if touches_box(st)}
    listed = finish(storms, now)

    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps({'updated': utcnow(), 'storms': {s['sid']: s for s in listed}},
                                     ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    doc = {
        'generatedAt': utcnow(),
        # Stated in the file, not only in the UI, so anything reading it inherits the caveat.
        'note': ('Observed positions are IBTrACS provisional best track for storms being tracked '
                 'now, and can be revised. Forecast positions are the JTWC official forecast — a '
                 'forecast, not an observation. Wind radii are the largest extent of that wind in '
                 'each quadrant. No landfall or impact inference is made here; refer to the Myanmar '
                 'Department of Meteorology and Hydrology for warnings.'),
        'attribution': 'IBTrACS v04r01 ACTIVE (NOAA NCEI) · JTWC warnings (US Navy, public domain)',
        'sources': sources,
        'box': list(BOX),
        'myanmarBox': list(MYANMAR_BOX),
        'retainDays': RETAIN_DAYS,
        'storms': listed,
    }
    CYCLONES_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n',
                             encoding='utf-8')
    with_fc = sum(1 for s in listed if s.get('forecast'))
    detail = (f'{len(listed)} storm(s), {with_fc} with a forecast' if listed
              else f'no active storms within {BOX[0]:.0f}–{BOX[2]:.0f}E {BOX[1]:.0f}–{BOX[3]:.0f}N')
    if state == 'skipped':
        detail += f'; JTWC skipped: {reason}'
    print(f'\nwrote {CYCLONES_PATH.name}: {detail} ({CYCLONES_PATH.stat().st_size / 1000:.1f} KB)')

    if args.print:
        print()
        for s in listed:
            last = s['observed'][-1] if s['observed'] else None
            fc = s.get('forecast')
            where = f"{last['lat']:.1f}N {last['lon']:.1f}E {last['windKt'] or '?'} kt at {last['t']}" if last else '—'
            print(f"  {s['basin']} {s['name']:<12} {s['sid']:<18} {len(s['observed']):>3} pts  {where}"
                  f"{'  forecast ' + fc['issued'] + ' ' + str(len(fc['points'])) + ' taus' if fc else ''}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
