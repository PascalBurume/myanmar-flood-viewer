#!/usr/bin/env python3
"""Build the flood history series from every UNOSAT FloodAI product for Myanmar.

Usage:
    python3 scripts/history.py            # refresh public/data/history.json
    python3 scripts/history.py --print    # and print the series

Why this exists
---------------
`status.json` keeps one run back, which answers "did anything change" but not "is this getting
worse". UNOSAT's own dashboard cannot answer that either — it shows one window at a time. But every
archived FloodAI product keeps its observation windows, so a real multi-year series can be
reconstructed once and extended on each run.

What one point means, and what it does not
------------------------------------------
Each point is a **single Sentinel-1 pass**: rows where startdate equals enddate. The service also
holds cumulative ranges (2024-07-01 → 2024-07-06 and so on); those are dropped, because mixing a
one-day observation with a six-day cumulative one in the same series would produce a chart that
climbs for reasons that have nothing to do with flooding.

The catch worth understanding: **a satellite pass covers a strip, not the country.** A low figure
can mean a narrow swath rather than less water. `observed` (the monitored area for that pass) is
therefore carried alongside, so the viewer can show how much was actually looked at and the reader
can tell "less flooding" apart from "less looking".

One archive is known bad
------------------------
`AI20230724MMR` reports population figures roughly 125x too high — a single township credited with
13.6 million people against 575 km2 of water, where the township holds about 200,000. Its 25
observations would otherwise put a 107-million-person spike on the chart, twice the population of
the country.

Rather than name that product and move on, every observation is checked against the ratio the other
four archives agree on (100-180 people per km2 flooded, remarkably stable across 2022, 2023, 2024
and 2026). Anything an order of magnitude beyond that has its population dropped and is flagged
`peopleSuspect`; the flooded and cropland areas, which look sound, are kept. A future bad archive is
then caught by the same rule instead of being plotted.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse

from common import INDEX_PATH, fetch, utcnow

BASE = 'https://unosat-rm.cern.ch/server/rest/services'
HISTORY_PATH = INDEX_PATH.parent / 'history.json'


def api(url: str, **params) -> dict:
    params.setdefault('f', 'json')
    return json.loads(fetch(f'{url}?{urllib.parse.urlencode(params)}', timeout=180))


def products() -> list[str]:
    listing = api(f'{BASE}/FloodAI')
    names = [s['name'].split('/')[-1] for s in listing.get('services', [])]
    return sorted((n for n in names if n.endswith('MMR') and n.startswith('AI')), reverse=True)


def series_for(service: str) -> list[dict]:
    """Single-pass observations for one product, newest first."""
    stats = [
        {'onStatisticField': 'popflood', 'outStatisticFieldName': 'people', 'statisticType': 'sum'},
        {'onStatisticField': 'floodedar', 'outStatisticFieldName': 'flooded', 'statisticType': 'sum'},
        {'onStatisticField': 'cropfloodedar', 'outStatisticFieldName': 'cropland', 'statisticType': 'sum'},
        {'onStatisticField': 'observedar', 'outStatisticFieldName': 'observed', 'statisticType': 'sum'},
    ]
    data = api(
        f'{BASE}/Hosted/{service}_Stat/FeatureServer/0/query',
        where='1=1',
        groupByFieldsForStatistics='startdate,enddate',
        outStatistics=json.dumps(stats),
        outFields='startdate,enddate',
        returnGeometry='false',
        resultRecordCount=2000,
    )
    out = []
    for f in data.get('features', []):
        a = f.get('attributes') or {}
        start = (a.get('startdate') or '').strip()
        end = (a.get('enddate') or '').strip()
        # Only discrete passes. See the module docstring for why cumulative ranges are dropped.
        if not end or start != end or a.get('people') is None:
            continue
        out.append({
            'date': end,
            'service': service,
            'people': round(a.get('people') or 0),
            'flooded': round(a.get('flooded') or 0, 1),
            'cropland': round(a.get('cropland') or 0, 1),
            'observed': round(a.get('observed') or 0, 1),
        })
    return out


# People per km2 of detected water, as the sound archives report it. Flooding is not uniformly
# populated, so the real spread is wide — this ceiling is an order of magnitude above the observed
# norm and only catches figures that are impossible rather than merely unusual.
MAX_PEOPLE_PER_KM2 = 2000


def flag_implausible(series: list[dict]) -> int:
    """Drop population figures that cannot be true, keeping the areas. Returns how many."""
    dropped = 0
    for r in series:
        if r['flooded'] > 0 and r['people'] / r['flooded'] > MAX_PEOPLE_PER_KM2:
            r['peopleSuspect'] = True
            r['peopleReported'] = r['people']
            r['people'] = None
            dropped += 1
    return dropped


def build() -> list[dict]:
    merged: dict[str, dict] = {}
    for svc in products():
        try:
            rows = series_for(svc)
        except Exception as e:  # noqa: BLE001 - one unavailable archive must not lose the rest
            print(f'  {svc}: unavailable ({str(e)[:60]})', file=sys.stderr)
            continue
        print(f'  {svc}: {len(rows)} passes')
        for r in rows:
            # A date can appear in two overlapping products. Keep the one that observed more, since
            # the wider swath is the more complete picture of that day.
            prev = merged.get(r['date'])
            if prev is None or r['observed'] > prev['observed']:
                merged[r['date']] = r
    return sorted(merged.values(), key=lambda r: r['date'])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', action='store_true', help='print the series')
    args = ap.parse_args()

    print('building flood history from the FloodAI archives')
    series = build()
    if not series:
        print('error: no observations could be read', file=sys.stderr)
        return 2

    dropped = flag_implausible(series)
    if dropped:
        bad = sorted({r['service'] for r in series if r.get('peopleSuspect')})
        print(f'\n  {dropped} observation(s) had implausible population figures and were flagged; '
              f'areas kept. Affected: {", ".join(bad)}')

    doc = {
        'generatedAt': utcnow(),
        'note': ('One point per Sentinel-1 pass. A pass covers a strip, not the country, so a low '
                 'figure can mean a narrow swath rather than less water — compare against '
                 '"observed". Points with peopleSuspect had population figures an order of '
                 'magnitude beyond what every other archive reports; their population is withheld '
                 'and only areas are shown.'),
        'suspect': sum(1 for r in series if r.get('peopleSuspect')),
        'series': series,
    }
    HISTORY_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n',
                            encoding='utf-8')
    span = f"{series[0]['date']} … {series[-1]['date']}"
    print(f'\nwrote {HISTORY_PATH.name}: {len(series)} observations, {span} '
          f'({HISTORY_PATH.stat().st_size / 1000:.1f} KB)')

    if args.print:
        print()
        usable = [r for r in series if r['people'] is not None]
        peak = max(usable, key=lambda r: r['people'])
        for r in series[-16:]:
            if r['people'] is None:
                print(f"  {r['date']}  {'(withheld)':>10}  — implausible population in the source")
                continue
            bar = '#' * max(1, round(40 * r['people'] / peak['people']))
            print(f"  {r['date']}  {r['people']:>9,}  {bar}")
        print(f"\n  peak of {len(usable)} usable observations: "
              f"{peak['date']} — {peak['people']:,} people")
    return 0


if __name__ == '__main__':
    sys.exit(main())
