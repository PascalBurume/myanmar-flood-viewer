#!/usr/bin/env python3
"""Fetch rainfall and river-discharge forecasts for Myanmar → public/data/weather.json.

Usage:
    python3 scripts/scan_weather.py
    python3 scripts/scan_weather.py --print

What this adds that nothing else here has: **what happens next.**

Every other number in this viewer is an observation of something that already happened — a radar
pass, a traced extent, a counted population. These two are forecasts. That is a different kind of
claim and it is labelled as one everywhere it appears, in the file and in the UI.

The two sources
---------------
Both from Open-Meteo, free and without an API key, which is why they can be used at all here:

- **Rainfall** (`api.open-meteo.com`) — daily totals, seven days back and seven forward, per region.
  The back half matters as much as the forward half: flooding is the consequence of rain that has
  already fallen, so "how much has landed this week" explains the map as it is now, while the
  forecast says whether it is about to get worse.

- **River discharge** (`flood-api.open-meteo.com`) — GloFAS, the Copernicus global flood model, as
  daily mean flow in m³/s with the ensemble spread. Rain is the input; discharge is what actually
  overtops a bank, and it integrates rain that fell days ago hundreds of kilometres upstream. For a
  country whose flooding is the Ayeyarwady, this is the more direct signal.

Why the gauge coordinates are what they are
-------------------------------------------
**GloFAS cells that are not on the channel read as a trickle.** The model is gridded at about 5 km,
so a point a single cell off the Ayeyarwady returns a local stream rather than the river. Asking for
"Magway" at the town's own coordinates returned **113 m³/s**; the actual channel nearby carries
**30,338**. A 270-fold error, and nothing about the response says it is wrong.

So every coordinate below was found by probing a grid around the town and keeping the cell with the
largest flow, then sanity-checked against the river's known size. They are gauge points on a
channel, not town centres, and `offsetFromTown` records that they were moved. Do not "correct" them
towards the towns they are named for.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse

from common import INDEX_PATH, fetch, utcnow

WEATHER_PATH = INDEX_PATH.parent / 'weather.json'

# Region rainfall points. Town centres are fine here — rainfall is a smooth field, unlike discharge.
RAIN_POINTS = [
    ('Sagaing Region', 21.88, 95.98),
    ('Ayeyarwady Region', 16.78, 95.23),
    ('Bago Region', 17.34, 96.48),
    ('Yangon Region', 16.87, 96.20),
    ('Mandalay Region', 21.98, 96.08),
    ('Magway Region', 20.15, 94.92),
    ('Nay Pyi Taw', 19.75, 96.10),
]

# Verified GloFAS channel cells. See the module docstring — these are NOT town coordinates.
# `typical` is the flow observed when the point was chosen, kept as a tripwire: if a future run
# returns something orders of magnitude away, the cell has probably drifted off the channel.
RIVER_POINTS = [
    ('Ayeyarwady at Hinthada', 17.45, 95.56, 34513),
    ('Ayeyarwady at Pyay', 18.71, 95.11, 31914),
    ('Ayeyarwady near Magway', 19.85, 95.12, 30338),
    ('Ayeyarwady at Mandalay', 21.95, 96.03, 15030),
    ('Thanlwin near Hpa-An', 16.69, 97.53, 13182),
    ('Chindwin near Monywa', 22.21, 95.03, 10185),
    ('Sittaung near Toungoo', 18.84, 96.44, 1971),
    ('Bago River at Bago', 17.44, 96.38, 442),
]

# A cell this far from the flow it was chosen at is more likely to have moved off the channel than
# to be a real event, so it is flagged rather than published as a hundredfold flood.
DRIFT_FACTOR = 20


def api(base: str, **params) -> dict:
    return json.loads(fetch(f'{base}?{urllib.parse.urlencode(params)}', timeout=60))


def rainfall() -> list[dict]:
    out = []
    for name, lat, lon in RAIN_POINTS:
        d = api(
            'https://api.open-meteo.com/v1/forecast',
            latitude=lat, longitude=lon,
            daily='precipitation_sum,precipitation_probability_max',
            past_days=7, forecast_days=7, timezone='Asia/Yangon',
        )
        day = d['daily']
        days = [
            {'date': t, 'mm': round(p or 0, 1), 'prob': pr}
            for t, p, pr in zip(day['time'], day['precipitation_sum'],
                                day['precipitation_probability_max'])
        ]
        # The split is by date against the run, not a fixed index: Open-Meteo returns however many
        # past days it has, and assuming "the first seven" would silently mislabel the chart.
        today = utcnow()[:10]
        out.append({
            'name': name, 'lat': lat, 'lon': lon, 'days': days, 'today': today,
            'past7': round(sum(x['mm'] for x in days if x['date'] < today), 1),
            'next7': round(sum(x['mm'] for x in days if x['date'] >= today), 1),
        })
        print(f"  {name:<20} {out[-1]['past7']:>6.1f} mm fell / {out[-1]['next7']:>6.1f} mm forecast")
    return out


def rivers() -> list[dict]:
    out = []
    for name, lat, lon, typical in RIVER_POINTS:
        d = api(
            'https://flood-api.open-meteo.com/v1/flood',
            latitude=lat, longitude=lon,
            daily='river_discharge,river_discharge_mean,river_discharge_min,river_discharge_max',
            past_days=30, forecast_days=14,
        )
        day = d['daily']
        days = [
            {'date': t, 'q': round(q or 0), 'lo': round(lo or 0), 'hi': round(hi or 0)}
            for t, q, lo, hi in zip(day['time'], day['river_discharge'],
                                    day['river_discharge_min'], day['river_discharge_max'])
        ]
        today = utcnow()[:10]
        now = next((x for x in days if x['date'] >= today), days[-1])
        ahead = [x for x in days if x['date'] > today]
        past = [x for x in days if x['date'] < today]
        peak = max(ahead, key=lambda x: x['q']) if ahead else now
        drifted = now['q'] > typical * DRIFT_FACTOR or now['q'] * DRIFT_FACTOR < typical

        out.append({
            'name': name, 'lat': lat, 'lon': lon, 'days': days, 'today': today,
            'now': now['q'],
            'peakAhead': peak['q'], 'peakDate': peak['date'],
            # Against the last 30 days rather than a climatology: GloFAS gives no normal through
            # this API, and "higher than it has been all month" is a claim the data can support.
            'max30': max((x['q'] for x in past), default=now['q']),
            'typicalWhenChosen': typical,
            'cellSuspect': drifted or None,
            'offsetFromTown': True,
        })
        flag = '  ** flow is far from the value this cell was chosen at' if drifted else ''
        print(f"  {name:<26} now {now['q']:>8,} m3/s   peak ahead {peak['q']:>8,} "
              f"on {peak['date']}{flag}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', action='store_true')
    args = ap.parse_args()

    print('rainfall (7 days back, 7 forward)')
    rain = rainfall()
    print('\nriver discharge — GloFAS (30 days back, 14 forward)')
    river = rivers()

    doc = {
        'generatedAt': utcnow(),
        # Stated in the file, not only in the UI, so anything reading it inherits the caveat.
        'note': ('Forecasts, not observations — unlike every other figure in this viewer. Rainfall '
                 'is Open-Meteo; river discharge is GloFAS (Copernicus), a global model at roughly '
                 '5 km, which is coarse for a single channel and carries no local calibration. '
                 'Gauge points are cells on the river, deliberately offset from the towns they are '
                 'named for.'),
        'attribution': 'Open-Meteo (CC BY 4.0) · GloFAS / Copernicus Emergency Management Service',
        'rain': rain,
        'rivers': river,
    }
    WEATHER_PATH.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')) + '\n',
                            encoding='utf-8')
    print(f'\nwrote {WEATHER_PATH.name}: {len(rain)} rain points, {len(river)} river gauges '
          f'({WEATHER_PATH.stat().st_size / 1000:.1f} KB)')

    if args.print:
        print()
        for r in sorted(river, key=lambda r: -r['now']):
            trend = r['peakAhead'] - r['now']
            arrow = '^' if trend > 0 else 'v'
            print(f"  {r['name']:<26} {r['now']:>8,} {arrow} {abs(trend):>7,} to {r['peakDate']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
