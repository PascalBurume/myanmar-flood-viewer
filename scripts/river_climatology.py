#!/usr/bin/env python3
"""Return-period flows for the eight GloFAS gauges → data/river_climatology.json.

Usage:
    python3 scripts/river_climatology.py            # build once; a no-op if the file exists
    python3 scripts/river_climatology.py --refresh  # rebuild it

Why this exists
---------------
A river forecast in m³/s says nothing to a reader until it is set against the river's own normal.
`weather.json` could only compare the forecast with the last 30 days ("higher than it has been all
month"), which in October, after the monsoon peak, says almost nothing. The question the Outlook
needs answered is whether the forecast reaches a flow that, historically, **floods**.

GloFAS answers that for its own alerts with **return-period thresholds**. It fits a Gumbel
distribution to the annual maxima of its reanalysis and flags the 2-, 5- and 20-year flows. This
script does the same, from the same model's reanalysis as Open-Meteo serves it, for the same channel
cells `scan_weather.py` reads. The forecast and its threshold therefore come from one model at one
cell. A threshold from a different source would be measuring a different river.

What it costs, and why it is kept
---------------------------------
Open-Meteo weighs a request by its length: more than two weeks of data for one location counts as
several calls. Twenty-five seasons for eight gauges is about 3,000 against a free allowance of 10,000
a day, which is too much to spend on every run. And a 25-year climatology does not change from one
run to the next. So it is **built once and committed**, and rebuilt only by hand.

Traps
-----
- **The reanalysis here starts between 1995 and 2000.** It was probed at this cell: 1985, 1990 and
  1995 return nulls, and 2000 has data. A season with any null day is dropped rather than letting a
  gap become a low maximum.
- **Only May–November is fetched.** Every annual peak on these rivers falls in the south-west
  monsoon, or with a Bay of Bengal cyclone in May or October–November. Asking for the dry season as
  well would double the cost for days that can never be the maximum. `peakMonths` records where the
  maxima actually fell, so the assumption is checkable in the output, not only asserted here.
- **Method of moments, not maximum likelihood.** It is short, it is standard for Gumbel, and at 25
  maxima the two differ by less than the model's own error at a single cell.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.parse
from pathlib import Path

from common import ROOT, fetch, utcnow
from scan_forecast_field import Pacer
from scan_weather import RIVER_POINTS

CLIMATOLOGY_PATH = ROOT / 'data' / 'river_climatology.json'
FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood'
FIRST_YEAR, LAST_YEAR = 2000, 2024
SEASON = ('05-01', '11-30')
# Euler–Mascheroni: the Gumbel mode sits this many scale units below the mean.
EULER = 0.5772156649
RETURN_PERIODS = (2, 5, 20)
# Open-Meteo counts every started fortnight of one location as a call.
DAYS_PER_CALL = 14
# The flood endpoint shares the per-minute allowance; stay well inside it.
MINUTE_BUDGET = 500


def gumbel(maxima: list[float]) -> dict:
    """Gumbel location and scale by the method of moments, and the flow for each return period.

    x_T = u − α·ln(−ln(1 − 1/T)), with α = s·√6/π and u = mean − γ·α.
    """
    n = len(maxima)
    if n < 2:
        raise ValueError('need at least two annual maxima')
    mean = sum(maxima) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in maxima) / (n - 1))
    alpha = sd * math.sqrt(6) / math.pi
    u = mean - EULER * alpha
    return {
        'location': u,
        'scale': alpha,
        'levels': {str(t): u - alpha * math.log(-math.log(1 - 1 / t)) for t in RETURN_PERIODS},
    }


def season_calls(days: int, locations: int) -> int:
    return math.ceil(days / DAYS_PER_CALL) * locations


def fetch_season(year: int, pacer: Pacer) -> list[list[tuple[str, float | None]]]:
    """Daily flow for every gauge through one season, in RIVER_POINTS order."""
    start, end = f'{year}-{SEASON[0]}', f'{year}-{SEASON[1]}'
    days = 214
    pacer.take(season_calls(days, len(RIVER_POINTS)))
    url = FLOOD_API + '?' + urllib.parse.urlencode({
        'latitude': ','.join(f'{p[1]:g}' for p in RIVER_POINTS),
        'longitude': ','.join(f'{p[2]:g}' for p in RIVER_POINTS),
        'daily': 'river_discharge', 'start_date': start, 'end_date': end,
    })
    res = json.loads(fetch(url, timeout=120))
    res = res if isinstance(res, list) else [res]
    if len(res) != len(RIVER_POINTS):
        raise RuntimeError(f'{year}: expected {len(RIVER_POINTS)} locations, got {len(res)}')
    return [list(zip(r['daily']['time'], r['daily']['river_discharge'])) for r in res]


def build() -> dict:
    pacer = Pacer(MINUTE_BUDGET)
    per_gauge: list[list[tuple[int, float, str]]] = [[] for _ in RIVER_POINTS]
    dropped: list[list[int]] = [[] for _ in RIVER_POINTS]
    for year in range(FIRST_YEAR, LAST_YEAR + 1):
        for attempt in range(2):
            try:
                seasons = fetch_season(year, pacer)
                break
            except Exception as e:  # noqa: BLE001 - one retry, then the year is reported missing
                if attempt:
                    print(f'  {year}: {e}')
                    seasons = None
                else:
                    time.sleep(61)
        if seasons is None:
            for g in dropped:
                g.append(year)
            continue
        for i, days in enumerate(seasons):
            if not days or any(q is None for _, q in days):
                dropped[i].append(year)
                continue
            date, q = max(days, key=lambda d: d[1])
            per_gauge[i].append((year, q, date))
        print(f'  {year} ' + ' '.join(f'{int(s[-1][1]) if s and s[-1][0] == year else "-":>7}' for s in per_gauge))

    gauges = []
    for (name, lat, lon, _typical), maxima, gaps in zip(RIVER_POINTS, per_gauge, dropped):
        fit = gumbel([q for _, q, _ in maxima])
        months = sorted({d[5:7] for _, _, d in maxima})
        gauges.append({
            'name': name, 'lat': lat, 'lon': lon,
            'years': [y for y, _, _ in maxima],
            'yearsDropped': gaps,
            'annualMax': [round(q) for _, q, _ in maxima],
            'peakMonths': months,
            'gumbel': {'location': round(fit['location'], 1), 'scale': round(fit['scale'], 1)},
            'returnFlow': {k: round(v) for k, v in fit['levels'].items()},
        })
    return {
        'builtAt': utcnow(),
        'source': 'GloFAS v4 reanalysis via Open-Meteo flood API (CC BY 4.0), daily river discharge',
        'method': (f'Gumbel fitted by the method of moments to the annual maximum daily flow, '
                   f'{FIRST_YEAR}–{LAST_YEAR}, {SEASON[0]} to {SEASON[1]} of each year. GloFAS '
                   'derives its own flood thresholds the same way.'),
        'unit': 'm³/s',
        'returnPeriods': list(RETURN_PERIODS),
        'gauges': gauges,
    }


def load() -> dict | None:
    try:
        return json.loads(CLIMATOLOGY_PATH.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - absent: the Outlook runs without river thresholds
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='rebuild even if the file exists')
    args = ap.parse_args()
    if CLIMATOLOGY_PATH.exists() and not args.refresh:
        print(f'{CLIMATOLOGY_PATH.name} exists; pass --refresh to rebuild it')
        return 0
    seasons = LAST_YEAR - FIRST_YEAR + 1
    print(f'GloFAS reanalysis, {seasons} seasons x {len(RIVER_POINTS)} gauges '
          f'(about {seasons * season_calls(214, len(RIVER_POINTS)):,} Open-Meteo calls)')
    doc = build()
    CLIMATOLOGY_PATH.parent.mkdir(parents=True, exist_ok=True)
    CLIMATOLOGY_PATH.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print()
    for g in doc['gauges']:
        rf = g['returnFlow']
        print(f"  {g['name']:<26} 2y {rf['2']:>8,}  5y {rf['5']:>8,}  20y {rf['20']:>8,}  "
              f"({len(g['years'])} yrs, peaks in months {','.join(g['peakMonths'])})")
    print(f'\nwrote {CLIMATOLOGY_PATH.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
