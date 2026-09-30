#!/usr/bin/env python3
"""The Flood Outlook: where the next five days could bring flooding → public/data/outlook.json.

Usage:
    python3 scripts/outlook.py            # build from what is on disk plus the UNOSAT archive
    python3 scripts/outlook.py --print    # and print the townships that are not "very low"

What it answers
---------------
Everything else in this viewer answers one of two questions: *where was the water* (observed) or
*what will the weather do* (forecast). Neither says where to look next. This joins them, one township
at a time, on two separate axes:

- **Likelihood**, from the forecast: how many of the 51 ECMWF ensemble members bring a heavy-rain
  day to the township's cell in the next 120 hours, or, near a river gauge, how many of the 51
  GloFAS members take the river over its 2-year flow. The larger of the two is used.
- **Impact**, from observation: the most people UNOSAT's radar has seen under water in that township
  on any single pass since 2022. It measures what happened here the last time, not what is modelled
  to happen.

The two are combined in a likelihood × impact matrix, the shape the UK Flood Forecasting Centre uses
for its Flood Guidance Statement. The matrix here is modelled on that one, not copied from it.

Why a matrix and not a score
----------------------------
A single number (0.73, "high risk") would look like a calibrated probability of flooding, and
nothing here is calibrated. A matrix keeps both halves visible. The reader can see that a township
is amber because 30 of 51 scenarios bring heavy rain to a place where 20,000 people were under
water in 2024, and can disagree with either half. Every threshold is written into the output file,
so the client draws the rules it was given and never carries its own.

It is **not a warning**. Myanmar's Department of Meteorology and Hydrology issues warnings. The
file, the panel and the assistant all say so.

Honesty constraints recorded here
---------------------------------
- **No record is not no risk.** A township whose every archived pass has its population withheld
  gets impact `unknown` and no level, and is drawn hollow. It is never counted as "minimal".
- **A share of members is not a probability.** It is the spread of one model, uncalibrated.
- **The very-low row is all very low.** Without it, every township that was badly flooded once
  would carry a colour on every quiet day, and the map would stop meaning anything.
- **The cells are coarse.** The ensemble is sampled at 1° (about 110 km) and the rainfall amounts at
  0.5°. A township's figure is its cell's figure, which is said on every row.
- **River signals reach only townships within 25 km of one of eight gauge cells.** Distance to a
  channel cell is a crude stand-in for being on that river, and it is stated with the distance.
"""

from __future__ import annotations

import argparse
import json
import math
import sys

from common import INDEX_PATH, ROOT, utcnow

OUTLOOK_PATH = INDEX_PATH.parent / 'outlook.json'
FIELD_DIR = INDEX_PATH.parent / 'field'
WEATHER_PATH = INDEX_PATH.parent / 'weather.json'
HISTORY_PATH = INDEX_PATH.parent / 'history.json'
CACHE_PATH = ROOT / 'data' / 'township_history_cache.json'

UNOSAT = 'https://unosat-rm.cern.ch/server/rest/services'
PAGE = 2000

# IMD's rainfall categories for 24 hours. Myanmar's DMH publishes no numeric scale that could be
# cited here, and IMD's are the published ones for the same monsoon.
HEAVY_MM = 64.5
VERY_HEAVY_MM = 115.6
RIVER_KM = 25

# Lower bounds, highest first. Likelihood is a percentage of members.
LIKELIHOOD_BANDS = [(60, 'high'), (40, 'medium'), (20, 'low'), (0, 'very low')]
IMPACT_BANDS = [(10000, 'severe'), (1000, 'significant'), (100, 'minor'), (0, 'minimal')]
LIKELIHOODS = ['very low', 'low', 'medium', 'high']
IMPACTS = ['minimal', 'minor', 'significant', 'severe']
LEVELS = ['very low', 'low', 'medium', 'high']

# Rows are likelihood, columns are impact, both in the order above.
MATRIX = {
    'very low': ['very low', 'very low', 'very low', 'very low'],
    'low':      ['very low', 'low', 'low', 'medium'],
    'medium':   ['very low', 'low', 'medium', 'high'],
    'high':     ['low', 'medium', 'high', 'high'],
}

NOTE = ('A forecast-derived triage, not a warning. Likelihood is the share of 51 ECMWF ensemble '
        'members bringing a heavy-rain day to the township\'s cell in the next five days, or near a '
        'river gauge the share of 51 GloFAS members over the 2-year flow, whichever is larger. It is '
        'the spread of one model, not a calibrated probability. Impact is the most people UNOSAT\'s '
        'radar has seen under water in the township on one pass since 2022: what happened there '
        'before, not a prediction. For warnings, refer to the Myanmar Department of Meteorology and '
        'Hydrology.')

CAVEATS = [
    'Not a warning. The Department of Meteorology and Hydrology issues warnings for Myanmar.',
    'Likelihood is a share of ensemble members from one model. It is not calibrated and not a probability of flooding.',
    'Rain is read at the township\'s forecast cell, about 110 km across for the ensemble and 55 km for amounts, not at the town.',
    'Impact is past observation. A township whose worst pass was a narrow radar strip may be under-rated.',
    'Radar misses water under dense vegetation and between buildings, so observed impact is a floor.',
    'River signals reach only townships within 25 km of one of eight GloFAS gauge cells.',
    'No record is not no risk: townships with no usable population figure carry no level.',
]


# ---- the arithmetic (pure, unit-tested) ----

def band(value: float, bands: list[tuple[float, str]]) -> str:
    """The first band whose lower bound the value reaches. Bounds are inclusive."""
    for lower, name in bands:
        if value >= lower:
            return name
    return bands[-1][1]


def level_for(likelihood: str, impact: str | None) -> str | None:
    """The matrix cell, or None when the impact is unknown. Unknown is never read as minimal."""
    if impact is None:
        return None
    return MATRIX[likelihood][IMPACTS.index(impact)]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def cell_index(lat: float, lon: float, grid: dict) -> int:
    """Row-major index of the cell whose centre is nearest, rows running north to south."""
    lats, lons, step = grid['lats'], grid['lons'], grid['step']
    r = min(max(round((lats[0] - lat) / step), 0), len(lats) - 1)
    c = min(max(round((lon - lons[0]) / step), 0), len(lons) - 1)
    return r * len(lons) + c


def rain_likelihood(wettest: list[float | None]) -> dict:
    """Members whose wettest day reaches each threshold, out of members with a value at all."""
    vals = [v for v in wettest if v is not None]
    heavy = sum(1 for v in vals if v >= HEAVY_MM)
    return {
        'members': heavy,
        'veryHeavy': sum(1 for v in vals if v >= VERY_HEAVY_MM),
        'of': len(vals),
        'pct': round(heavy / len(vals) * 100, 1) if vals else 0.0,
    }


def impact_from_rows(rows: list[dict], withheld: set[tuple[str, str]]) -> dict | None:
    """The township's worst single pass by people exposed, skipping withheld observations.

    None when no row carries a usable population. A pass that saw zero people is a record of zero
    and counts; a pass whose population was withheld is no record.
    """
    usable = [r for r in rows if (r['service'], r['date']) not in withheld and r['people'] is not None]
    if not usable:
        return None
    worst = max(usable, key=lambda r: (r['people'], r['flooded'] or 0))
    return {
        'people': int(worst['people']),
        'date': worst['date'],
        'service': worst['service'],
        'floodedKm2': round(worst['flooded'] or 0, 1),
        'band': band(worst['people'], IMPACT_BANDS),
        'passes': len(rows),
        'withheld': len(rows) - len(usable),
        'peakFloodedKm2': round(max((r['flooded'] or 0) for r in rows), 1),
    }


def river_likelihood(lat: float, lon: float, gauges: list[dict]) -> dict | None:
    """The strongest river signal from a gauge cell within RIVER_KM, with its distance."""
    best = None
    for g in gauges:
        ens = g.get('ensemble')
        if not ens or not ens.get('members') or 'over2' not in ens:
            continue
        km = haversine_km(lat, lon, g['lat'], g['lon'])
        if km > RIVER_KM:
            continue
        pct = round(ens['over2'] / ens['members'] * 100, 1)
        cand = {'gauge': g['name'], 'km': round(km, 1), 'members': ens['over2'], 'of': ens['members'],
                'over5': ens.get('over5'), 'pct': pct, 'flow2': g['returnFlow']['2']}
        if best is None or (pct, -km) > (best['pct'], -best['km']):
            best = cand
    return best


# ---- inputs ----

def newest_accum(model: str) -> dict | None:
    """The accumulation file of the newest run that has one, by fetch time."""
    best = None
    for f in (FIELD_DIR / model).glob('*/accum.json'):
        try:
            doc = json.loads(f.read_text(encoding='utf-8'))
        except Exception:  # noqa: BLE001 - a half-written run is not a run
            continue
        if best is None or doc['fetchedAt'] > best['fetchedAt']:
            best = doc
    return best


def withheld_observations() -> set[tuple[str, str]]:
    """The (service, date) pairs whose population history.py already withholds."""
    try:
        doc = json.loads(HISTORY_PATH.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001
        return set()
    return {(p['service'], p['date']) for p in doc.get('series', []) if p.get('peopleSuspect')}


def fetch_township_rows() -> dict:
    """Single-pass rows for every township in every archived FloodAI product, keyed by township."""
    from history import api, products  # the network half; tests never import it

    towns: dict[str, dict] = {}
    services = products()
    for service in services:
        offset = 0
        while True:
            data = api(f'{UNOSAT}/Hosted/{service}_Stat/FeatureServer/0/query',
                       where='startdate = enddate',
                       outFields='admin1name,admin2name,admin3name,startdate,popflood,floodedar,observedar',
                       returnGeometry='true', outSR='4326', orderByFields='objectid',
                       resultOffset=offset, resultRecordCount=PAGE)
            if data.get('error'):
                raise RuntimeError(f"{service}: {data['error'].get('message')}")
            feats = data.get('features', [])
            for f in feats:
                a, geo = f['attributes'], f.get('geometry') or {}
                if a.get('observedar') is None or not a.get('admin3name'):
                    continue  # unobserved in that pass: not a record of anything
                key = f"{a['admin1name']}|{a['admin3name']}"
                t = towns.setdefault(key, {'name': a['admin3name'], 'region': a['admin1name'],
                                           'district': a.get('admin2name'), 'rows': []})
                if 'x' in geo:
                    t['lat'], t['lon'] = round(geo['y'], 4), round(geo['x'], 4)
                t['rows'].append({
                    'service': service, 'date': (a.get('startdate') or '').strip(),
                    'people': a.get('popflood'), 'flooded': a.get('floodedar'), 'observed': a.get('observedar'),
                })
            if len(feats) < PAGE and not data.get('exceededTransferLimit'):
                break
            offset += len(feats)
    return {'services': services, 'fetchedAt': utcnow(), 'townships': towns}


def township_history() -> tuple[dict, str | None]:
    """Fresh from UNOSAT when it answers, the last good copy when it does not."""
    try:
        doc = fetch_township_rows()
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        CACHE_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
        return doc, None
    except Exception as e:  # noqa: BLE001 - UNOSAT down: the archive does not change from day to day
        if CACHE_PATH.exists():
            doc = json.loads(CACHE_PATH.read_text(encoding='utf-8'))
            return doc, f'UNOSAT unavailable ({e}); township history from the copy of {doc["fetchedAt"][:10]}'
        raise


# ---- assembly ----

def build(history: dict, ens: dict, det: dict | None, weather: dict | None, withheld: set) -> dict:
    gauges = [g for g in (weather or {}).get('rivers', []) if g.get('returnFlow')]
    towns = []
    for t in history['townships'].values():
        if 'lat' not in t:
            continue
        rain = rain_likelihood(ens['wettest24'][cell_index(t['lat'], t['lon'], ens['grid'])])
        river = river_likelihood(t['lat'], t['lon'], gauges)
        driver = 'river' if river and river['pct'] > rain['pct'] else 'rain'
        pct = river['pct'] if driver == 'river' else rain['pct']
        lik = band(pct, LIKELIHOOD_BANDS)
        imp = impact_from_rows(t['rows'], withheld)
        amounts = None
        if det:
            i = cell_index(t['lat'], t['lon'], det['grid'])
            amounts = {'total': det['total'][i], 'wettest24': det['wettest24'][i]}
        towns.append({
            'name': t['name'], 'region': t['region'], 'district': t['district'],
            'lat': t['lat'], 'lon': t['lon'],
            'level': level_for(lik, imp['band'] if imp else None),
            'likelihood': {'band': lik, 'pct': pct, 'driver': driver, 'rain': rain, 'river': river},
            'impact': imp,
            'rain': amounts,
        })

    rank = {name: i for i, name in enumerate(LEVELS)}
    towns.sort(key=lambda t: (-(rank[t['level']] if t['level'] else -1), -t['likelihood']['pct'],
                              -((t['impact'] or {}).get('people') or 0), t['name']))
    counts = {lv: sum(1 for t in towns if t['level'] == lv) for lv in LEVELS}
    counts['unknown'] = sum(1 for t in towns if t['level'] is None)
    grid = {lk: [sum(1 for t in towns if t['likelihood']['band'] == lk and t['impact'] and t['impact']['band'] == im)
                 for im in IMPACTS] for lk in LIKELIHOODS}

    first_dates = sorted({r['date'] for t in history['townships'].values() for r in t['rows'] if r['date']})
    return {
        'generatedAt': utcnow(),
        'window': ens['window'],
        'note': NOTE,
        'caveats': CAVEATS,
        'method': {
            'heavyMm': HEAVY_MM, 'veryHeavyMm': VERY_HEAVY_MM, 'riverKm': RIVER_KM,
            'likelihoodBands': [[lo, name] for lo, name in LIKELIHOOD_BANDS],
            'impactBands': [[lo, name] for lo, name in IMPACT_BANDS],
            'likelihoods': LIKELIHOODS, 'impacts': IMPACTS, 'levels': LEVELS, 'matrix': MATRIX,
            'thresholdSource': 'India Meteorological Department rainfall categories for 24 h: heavy 64.5–115.5 mm, very heavy 115.6–204.4 mm.',
            'matrixSource': 'Likelihood × impact, modelled on the UK Flood Forecasting Centre\'s Flood Guidance Statement matrix.',
        },
        'sources': {
            'ensemble': {'label': 'ECMWF IFS 0.25° ensemble via Open-Meteo (CC BY 4.0)', 'init': ens.get('init'),
                         'fetchedAt': ens['fetchedAt'], 'members': ens.get('members'), 'cellDeg': ens['grid']['step']},
            'amounts': ({'label': 'ECMWF IFS 0.25° via Open-Meteo (CC BY 4.0)', 'init': det.get('init'),
                         'fetchedAt': det['fetchedAt'], 'window': det['window'], 'cellDeg': det['grid']['step']}
                        if det else None),
            'rivers': ({'label': 'GloFAS / Copernicus EMS via Open-Meteo; return flows from its reanalysis',
                        'generatedAt': weather.get('generatedAt'), 'gauges': len(gauges)}
                       if weather else None),
            'history': {'label': 'UNOSAT FloodAI archive, per township, single passes', 'services': history['services'],
                        'from': first_dates[0] if first_dates else None, 'to': first_dates[-1] if first_dates else None,
                        'fetchedAt': history['fetchedAt'], 'withheldObservations': len(withheld)},
        },
        'counts': counts,
        'grid': grid,
        'gauges': [{'name': g['name'], 'lat': g['lat'], 'lon': g['lon'], 'returnFlow': g['returnFlow'],
                    'ensemble': g.get('ensemble'), 'peakAhead': g.get('peakAhead'), 'peakDate': g.get('peakDate')}
                   for g in gauges],
        'townships': towns,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', action='store_true')
    args = ap.parse_args()

    ens = newest_accum('ecmwf-ens')
    if not ens:
        print('skipped: no ensemble run with accumulations yet; the next forecast-field run writes one')
        return 0
    det = newest_accum('ecmwf')
    try:
        weather = json.loads(WEATHER_PATH.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - rain alone still makes an outlook
        weather = None
    try:
        history, fallback = township_history()
    except Exception as e:  # noqa: BLE001
        print(f'skipped: township history unavailable ({e})')
        return 0

    doc = build(history, ens, det, weather, withheld_observations())
    OUTLOOK_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    c = doc['counts']
    print(f"window {doc['window']['from']} → {doc['window']['to']}")
    if fallback:
        print(f'  {fallback}')
    if args.print:
        for t in doc['townships']:
            if t['level'] in (None, 'very low'):
                continue
            imp = t['impact']
            lk = t['likelihood']
            why = (f"{lk['river']['members']}/{lk['river']['of']} over 2-yr at {lk['river']['gauge']}"
                   if lk['driver'] == 'river' else f"{lk['rain']['members']}/{lk['rain']['of']} heavy-rain day")
            print(f"  {t['level']:<8} {t['name']:<22} {t['region']:<12} {why:<44} "
                  f"worst {imp['people']:>7,} ({imp['date']})")
    print(f"\nwrote outlook.json: {c['high']} high, {c['medium']} medium, {c['low']} low, "
          f"{c['very low']} very low, {c['unknown']} unknown across {len(doc['townships'])} townships "
          f"({OUTLOOK_PATH.stat().st_size / 1000:.0f} KB)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
