#!/usr/bin/env python3
"""Fetch a gridded forecast field for Myanmar from Open-Meteo → public/data/field/.

Usage:
    python3 scripts/scan_forecast_field.py
    FIELD_MODELS=ecmwf python3 scripts/scan_forecast_field.py

The Weather view draws what Google Weather Lab draws — a blocky precipitation field you can scrub
through time, with a choice of model — but from a source that needs no account: Open-Meteo, which
serves ECMWF, GFS and ICON output for lists of coordinates, and a 51-member ECMWF ensemble. Every
value here is a **forecast**; the file says so and so does every surface that shows it.

What is written
---------------
    public/data/field/manifest.json                 what exists, rebuilt from disk every run
    public/data/field/<model>/<run>/run.json         one run: init, steps, files
    public/data/field/<model>/<run>/precip3h_LLL.png 3-hour rainfall total at lead LLL hours
    public/data/field/<model>/<run>/wind.json        10 m wind on a 1° subgrid, numbers only
    public/data/field/<model>/<run>/points.json      values at the named points, for the assistant
    public/data/field/ecmwf-ens/<run>/prob25_LLL.png share of members over 25 mm in 3 h (and 50)

The grid is 0.5° (about 55 km) over 92–102°E, 9.5–28.5°N: 819 points. The models themselves are
0.25°, so each block is the *sampling*, not the weather — the panel says that too. Open-Meteo caps a
request by URL length, so the grid goes up in batches of 200.

Traps recorded here
-------------------
- **A MapLibre image source is one quad in Web Mercator.** Rows spaced evenly in latitude would land
  a cell off in the middle of a 19° span, so PNG rows are placed in Mercator (four output rows per
  cell) and the sample row for each is found by inverse projection. `mercator_rows()` is the whole
  of it and the unit test pins the middle row.
- **Open-Meteo's hourly series starts at 00:00 UTC today**, whatever the run's init, so the hours
  before the init are the previous run's forecast. A step totals the three hours *ending* at it, so
  the first step a run can claim is the one ending three hours after its init: the step stamped
  with the init itself is rain from 03–06Z when the init is 06Z, which is the previous run's. That
  step used to be kept, and the lead hours were counted from whichever step came first rather than
  from the init, so an 18Z run fetched the next morning labelled a nine-hour lead as three.
  `usable_steps()` is the one place both are decided. For models that publish no init (GFS, ICON
  here) the fetch time floored to the step stands in for it.
- **Only ECMWF publishes its initialisation time** (`/data/ecmwf_ifs025/static/meta.json`). The
  others are keyed by fetch time and the UI says "run time not published" rather than guessing.
- **Precipitation is the total of the preceding hour**, so the 3-h total ending at a step is the sum
  of the three hourly values ending at it, and wind is the value at the step.
- **Wind direction is where the wind comes from** (meteorological). The client rotates the arrow by
  180° to point downwind.
- **The limit that actually bites is per minute, not per day.** Open-Meteo counts a location as a
  call: about 800 in a burst returns `429 {"reason": "Minutely API request limit exceeded"}`, well
  before the 10,000-a-day ceiling. So batches are paced by `MINUTE_BUDGET` — the stage takes a
  couple of minutes and that is the price of the whole grid.
- **All three models come back in one request.** `models=a,b,c` returns `precipitation_<model>`
  columns for the same locations, so the grid is fetched once rather than once per model: 819
  locations instead of 2,457. A model whose current run is already on disk is dropped from that
  list, and if every wanted model is current nothing is fetched at all — which is what keeps a
  hand-clicked "Run update now" cheap.

Runs are kept — the newest `FIELD_KEEP_RUNS` per model — so the timeline's init stepper has
something to step through; Open-Meteo itself serves only the latest.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import INDEX_PATH, fetch, utcnow
from png import classify, decode_png, hex_rgb, write_png
from scan_weather import RAIN_POINTS, RIVER_POINTS

FIELD_DIR = INDEX_PATH.parent / 'field'
MANIFEST_PATH = FIELD_DIR / 'manifest.json'

FORECAST_API = 'https://api.open-meteo.com/v1/forecast'
ENSEMBLE_API = 'https://ensemble-api.open-meteo.com/v1/ensemble'
META_URL = 'https://api.open-meteo.com/data/{model}/static/meta.json'

# west, south, east, north, step. Rows run north → south (PNG order), columns west → east.
GRID = (92.0, 9.5, 102.0, 28.5, 0.5)
ENS_GRID = (92.0, 9.5, 102.0, 28.5, 1.0)
MERC_ROWS_PER_CELL = 4
STEP_H = 3
BATCH = 200
# Open-Meteo counts one location as one call and refuses a burst past roughly 800 in a minute, so
# batches are paced to stay under this. Measured, not guessed: 4 × 200 passes, the 5th is a 429.
MINUTE_BUDGET = 550
# The ensemble endpoint returns 51 members a location and is charged accordingly, so it gets a
# budget of its own; measured by walking it up until the refusal.
ENS_MINUTE_BUDGET = 110

# key, label, Open-Meteo model id, whether the init time is published
MODELS = [
    ('ecmwf', 'ECMWF IFS 0.25°', 'ecmwf_ifs025', True),
    ('gfs', 'GFS 0.25°', 'gfs_seamless', False),
    ('icon', 'ICON', 'icon_seamless', False),
]
ENS = ('ecmwf-ens', 'ECMWF IFS 0.25° ensemble, 51 members', 'ecmwf_ifs025')
PROB_THRESHOLDS = (25, 50)

# The one table behind both the pixels and the key on the map. Stops are lower bounds.
LEGENDS = {
    'precip3h': {
        'unit': 'mm / 3 h',
        'stops': [[0.5, '#c7e9c0'], [2, '#74c476'], [5, '#31a354'], [10, '#006d2c'],
                  [20, '#ffff66'], [35, '#fdae61'], [50, '#f46d43'], [75, '#d73027']],
    },
    'prob': {
        'unit': '% of 51 members',
        'stops': [[10, '#deebf7'], [25, '#9ecae1'], [50, '#4292c6'], [75, '#08519c'], [90, '#5e0f8f']],
    },
    'wind': {'unit': 'km/h', 'note': 'arrows point downwind; size by speed'},
}

ATTRIBUTION = 'Open-Meteo (CC BY 4.0) · ECMWF / NOAA / DWD'
NOTE = ('Forecasts, not observations. Global models at 0.25° sampled on a 0.5° grid (about 55 km): '
        'the blocks are the sampling, not the weather. Rainfall is the total of each 3-hour step. '
        'Probabilities are the share of the 51 ECMWF ensemble members over a threshold, not a '
        'calibrated certainty. No local calibration. For warnings, refer to the Myanmar Department '
        'of Meteorology and Hydrology.')


def run_key_for(init: str | None, fetched: str) -> str:
    """A directory name: YYYYMMDDHH of the init, or of the fetch prefixed `f` when none is published.

    Digits only, ten of them. Slicing the ISO string instead once produced `f20260905T0` — which
    both reads badly and, worse, is the same name for every run on a given day, so a second run
    would have overwritten the first.
    """
    stamp = re.sub(r'\D', '', init or fetched)[:10]
    return stamp if init else f'f{stamp}'


def refusal(e: urllib.error.HTTPError) -> str:
    """What Open-Meteo actually said. Its 429 names which limit was hit; do not guess at it."""
    try:
        reason = json.loads(e.read()).get('reason') or ''
    except Exception:  # noqa: BLE001
        reason = ''
    return f'Open-Meteo refused (HTTP {e.code}){f": {reason}" if reason else ""}'


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, '') or default)
    except ValueError:
        return default


# ---- grid ----

def grid_points(grid=GRID) -> tuple[list[float], list[float], int, int]:
    """Latitudes (north→south) and longitudes (west→east) of the cell centres, plus rows, cols."""
    w, s, e, n, step = grid
    rows = int(round((n - s) / step)) + 1
    cols = int(round((e - w) / step)) + 1
    lats = [round(n - r * step, 3) for r in range(rows)]
    lons = [round(w + c * step, 3) for c in range(cols)]
    return lats, lons, rows, cols


def bbox(grid=GRID) -> list[float]:
    w, s, e, n, step = grid
    h = step / 2
    return [w - h, s - h, e + h, n + h]


def _merc(lat: float) -> float:
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def _unmerc(y: float) -> float:
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)


def mercator_rows(grid=GRID, per_cell: int = MERC_ROWS_PER_CELL) -> list[int]:
    """For each output image row (top→bottom), the sample row it shows.

    The image is stretched over its bbox as one Web Mercator quad, so output rows are spaced in
    Mercator y. Each is mapped back to a latitude and to the 0.5° cell containing it.
    """
    w, s, e, n, step = grid
    rows = int(round((n - s) / step)) + 1
    north, south = n + step / 2, s - step / 2
    y_n, y_s = _merc(north), _merc(south)
    height = rows * per_cell
    out = []
    for j in range(height):
        y = y_n - (j + 0.5) / height * (y_n - y_s)
        lat = _unmerc(y)
        r = int((north - lat) // step)
        out.append(min(max(r, 0), rows - 1))
    return out


def cell_of(lat: float, lon: float, grid=GRID) -> tuple[int, int]:
    """The (row, col) of the cell whose centre is nearest a point."""
    w, s, e, n, step = grid
    lats, lons, rows, cols = grid_points(grid)
    r = min(range(rows), key=lambda i: abs(lats[i] - lat))
    c = min(range(cols), key=lambda i: abs(lons[i] - lon))
    return r, c


# ---- fetching ----

def api(base: str, **params) -> object:
    """One request, retried once if the per-minute allowance is hit.

    The pacer below keeps the count down, but Open-Meteo's window is rolling and ours starts at the
    first request of a batch, so the two can disagree by a few seconds at the boundary — and the
    ensemble endpoint shares the same allowance while costing more than its location count suggests.
    A single wait-and-retry settles both without slowing the ordinary path.
    """
    url = f'{base}?{urllib.parse.urlencode(params)}'
    try:
        return json.loads(fetch(url, timeout=120))
    except urllib.error.HTTPError as e:
        if e.code != 429:
            raise
        print('  per-minute allowance hit; waiting 61s and retrying once')
        time.sleep(61)
        return json.loads(fetch(url, timeout=120))


class Pacer:
    """Keeps the location count under Open-Meteo's per-minute allowance.

    A location is a call, and a burst past roughly 800 in a minute is refused — which is the limit
    a full grid meets long before the daily one. This waits rather than failing, because the whole
    grid in two paced minutes is worth more than a partial one immediately.
    """

    def __init__(self, budget: int = MINUTE_BUDGET):
        self.budget = budget
        self.spent = 0
        self.t0 = time.monotonic()

    def take(self, n: int) -> None:
        if self.spent and self.spent + n > self.budget:
            wait = 61 - (time.monotonic() - self.t0)
            if wait > 0:
                print(f'  pausing {wait:.0f}s for the per-minute allowance')
                time.sleep(wait)
            self.spent = 0
            self.t0 = time.monotonic()
        self.spent += n


def fetch_batches(base: str, lats: list[float], lons: list[float], rows: int, cols: int,
                  pacer: Pacer, **params) -> list[dict]:
    """One response object per grid point, in grid order, fetched in paced batches of BATCH."""
    pts = [(lats[r], lons[c]) for r in range(rows) for c in range(cols)]
    out: list[dict] = []
    for i in range(0, len(pts), BATCH):
        chunk = pts[i:i + BATCH]
        pacer.take(len(chunk))
        res = api(base,
                  latitude=','.join(f'{la:g}' for la, _ in chunk),
                  longitude=','.join(f'{lo:g}' for _, lo in chunk),
                  **params)
        out.extend(res if isinstance(res, list) else [res])
    if len(out) != len(pts):
        raise RuntimeError(f'expected {len(pts)} locations, got {len(out)}')
    return out


def model_init(model_id: str) -> str | None:
    """The run's initialisation time, where the model publishes one."""
    try:
        meta = json.loads(fetch(META_URL.format(model=model_id), timeout=30))
        t = meta.get('last_run_initialisation_time')
        if t:
            return datetime.fromtimestamp(int(t), timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    except Exception:  # noqa: BLE001 - absent metadata is the documented state for most models
        pass
    return None


# ---- aggregation ----

def step_indices(times: list[str]) -> list[tuple[int, int, str]]:
    """(index, hours since the series starts, valid ISO) for every 3-hourly step with a full three
    hours behind it. The middle value is *not* a lead time — see `usable_steps()`."""
    out = []
    for k in range(STEP_H, len(times), STEP_H):
        out.append((k, k, times[k] + ':00Z' if len(times[k]) == 16 else times[k]))
    return out


def _utc(t: str) -> datetime:
    return datetime.strptime(t[:16], '%Y-%m-%dT%H:%M').replace(tzinfo=timezone.utc)


def lead_hours(ref: str, valid: str) -> float:
    return (_utc(valid) - _utc(ref)).total_seconds() / 3600


def usable_steps(times: list[str], ref: str) -> list[tuple[int, int, str]]:
    """(index, lead hours from `ref`, valid ISO) for the steps a run started at `ref` can claim.

    A step is the total of the three hours ending at it, so it belongs to the run only when that
    whole window is after the start: lead ≥ STEP_H. The step stamped with the init itself is the
    previous run's rain.
    """
    out = []
    for k, _i, valid in step_indices(times):
        lead = lead_hours(ref, valid)
        if lead >= STEP_H:
            out.append((k, int(round(lead)), valid))
    return out


def sum3h(values: list, k: int) -> float | None:
    """Total of the three hourly values ending at index k. None if any is missing."""
    window = values[k - STEP_H + 1:k + 1]
    if len(window) < STEP_H or any(v is None for v in window):
        return None
    return round(sum(window), 2)


def valid_from(init: str | None, fetched: str) -> str:
    """Steps before this moment are the previous run's forecast and are dropped."""
    if init:
        return init
    t = datetime.strptime(fetched[:19], '%Y-%m-%dT%H:%M:%S').replace(tzinfo=timezone.utc)
    floored = t.replace(minute=0, second=0, microsecond=0)
    floored -= timedelta(hours=floored.hour % STEP_H)
    return floored.strftime('%Y-%m-%dT%H:%M:%SZ')


def raster(values: list[list[float | None]], stops: list[float], grid=GRID) -> list[bytes]:
    """PNG rows (Mercator-spaced) of palette indices from a rows×cols value grid."""
    return [bytes(classify(v, stops) for v in values[r]) for r in mercator_rows(grid)]


def palette(legend: dict) -> list[tuple[int, int, int]]:
    return [(0, 0, 0)] + [hex_rgb(c) for _, c in legend['stops']]


# ---- one model run ----

def write_model_runs(wanted: list[tuple[str, str, str, bool]], fetched: str, pacer: Pacer) -> tuple[list[str], list[str]]:
    """Fetch the grid once for every model still needed and write a run directory for each.

    One request carries every model, so the grid costs 819 locations however many models are
    wanted. A model whose current run is already on disk is dropped from the list first; if that
    empties it, nothing is fetched at all.
    """
    lats, lons, rows, cols = grid_points()
    todo, summaries = [], []
    for key, label, model_id, published in wanted:
        init = model_init(model_id) if published else None
        run_key = run_key_for(init, fetched)
        if (FIELD_DIR / key / run_key / 'run.json').exists():
            summaries.append(f'{key} already have run {init or run_key}')
            continue
        if not published:
            newest = newest_run(key)
            if newest and hours_between(newest['fetchedAt'], fetched) < env_int('FIELD_MIN_REFETCH_H', 5):
                summaries.append(f'{key} fetched {hours_between(newest["fetchedAt"], fetched):.1f} h ago, not refetched')
                continue
        todo.append((key, label, model_id, published, init, run_key))
    if not todo:
        return summaries, []

    locs = fetch_batches(FORECAST_API, lats, lons, rows, cols, pacer,
                         hourly='precipitation,wind_speed_10m,wind_direction_10m',
                         forecast_days=7, timezone='UTC',
                         models=','.join(m[2] for m in todo))
    # With one model the columns are unsuffixed; with several each carries its model id.
    def col(hourly: dict, name: str, model_id: str) -> list:
        return hourly.get(f'{name}_{model_id}') or hourly[name]

    times = locs[0]['hourly']['time']
    stops = [s for s, _ in LEGENDS['precip3h']['stops']]
    pal = palette(LEGENDS['precip3h'])
    written = []

    for key, label, model_id, published, init, run_key in todo:
        start = valid_from(init, fetched)
        steps = usable_steps(times, start)
        if not steps:
            written.append(f'{key} skipped: no steps after {start}')
            continue
        run_dir = FIELD_DIR / key / run_key
        tmp = run_dir.with_name(run_dir.name + '.incoming')
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True)

        step_docs, wind_steps = [], []
        for k, lead, valid in steps:
            grid_vals = [[sum3h(col(locs[r * cols + c]['hourly'], 'precipitation', model_id), k) for c in range(cols)]
                         for r in range(rows)]
            name = f'precip3h_{lead:03d}.png'
            write_png(tmp / name, cols, rows * MERC_ROWS_PER_CELL, raster(grid_vals, stops), pal)
            step_docs.append({'h': lead, 'valid': valid, 'precip': f'{key}/{run_key}/{name}'})
            kmh, dirs = [], []
            for r in range(0, rows, 2):
                for c in range(0, cols, 2):
                    h = locs[r * cols + c]['hourly']
                    kmh.append(round(col(h, 'wind_speed_10m', model_id)[k] or 0))
                    dirs.append(round(col(h, 'wind_direction_10m', model_id)[k] or 0))
            wind_steps.append({'h': lead, 'valid': valid, 'kmh': kmh, 'dir': dirs})

        (tmp / 'wind.json').write_text(json.dumps({
            'lats': [lats[r] for r in range(0, rows, 2)],
            'lons': [lons[c] for c in range(0, cols, 2)],
            'unit': 'km/h', 'directionIs': 'from', 'steps': wind_steps,
        }, separators=(',', ':')) + '\n', encoding='utf-8')

        points = []
        for name, lat, lon, *_ in RAIN_POINTS + RIVER_POINTS:
            r, c = cell_of(lat, lon)
            h = locs[r * cols + c]['hourly']
            points.append({
                'name': name, 'lat': lat, 'lon': lon, 'cell': [lons[c], lats[r]],
                'steps': [{
                    'h': d['h'], 'valid': d['valid'],
                    'mm3h': sum3h(col(h, 'precipitation', model_id), k),
                    'windKmh': round(col(h, 'wind_speed_10m', model_id)[k] or 0),
                    'windMs': round((col(h, 'wind_speed_10m', model_id)[k] or 0) / 3.6, 1),
                    'windDir': round(col(h, 'wind_direction_10m', model_id)[k] or 0),
                } for (k, _h, _v), d in zip(steps, step_docs)],
            })
        (tmp / 'points.json').write_text(json.dumps({
            'model': key, 'label': label, 'init': init, 'fetchedAt': fetched, 'unit': 'mm / 3 h',
            'cellDeg': GRID[4], 'points': points,
        }, separators=(',', ':')) + '\n', encoding='utf-8')
        (tmp / 'run.json').write_text(json.dumps({
            'key': run_key, 'model': key, 'init': init, 'fetchedAt': fetched, 'source': model_id,
            'steps': step_docs, 'wind': f'{key}/{run_key}/wind.json', 'points': f'{key}/{run_key}/points.json',
        }, indent=1) + '\n', encoding='utf-8')
        if run_dir.exists():
            shutil.rmtree(run_dir)
        tmp.rename(run_dir)
        written.append(f'{key} {init or "(run time not published)"} {len(steps)} steps')
    return summaries, written


def write_ensemble_run(fetched: str, pacer: Pacer) -> tuple[str, str] | None:
    key, label, model_id = ENS
    lats, lons, rows, cols = grid_points(ENS_GRID)
    init = model_init(f'{model_id}_ensemble') or model_init(model_id)
    run_key = run_key_for(init, fetched)
    run_dir = FIELD_DIR / key / run_key
    if (run_dir / 'run.json').exists():
        return run_key, f'{key} already have run {init or run_key}'

    # 51 members a location: the endpoint shares the same per-minute allowance but costs far more
    # than its location count, so it gets its own, much smaller budget.
    locs = fetch_batches(ENSEMBLE_API, lats, lons, rows, cols, Pacer(ENS_MINUTE_BUDGET),
                         hourly='precipitation', forecast_days=7, timezone='UTC', models=model_id)
    times = locs[0]['hourly']['time']
    members = [k for k in locs[0]['hourly'] if k.startswith('precipitation')]
    start = valid_from(init, fetched)
    steps = usable_steps(times, start)
    if not steps:
        raise RuntimeError(f'{key}: no steps after {start}')

    stops = [s for s, _ in LEGENDS['prob']['stops']]
    pal = palette(LEGENDS['prob'])
    tmp = run_dir.with_name(run_dir.name + '.incoming')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    def share(h: dict, k: int, threshold: float) -> tuple[int, float]:
        over = 0
        for m in members:
            t = sum3h(h[m], k)
            if t is not None and t > threshold:
                over += 1
        return over, round(over / len(members) * 100, 1)

    step_docs = []
    per_point: dict[int, list[dict]] = {}
    for k, lead, valid in steps:
        doc = {'h': lead, 'valid': valid}
        for th in PROB_THRESHOLDS:
            grid_vals = [[share(locs[r * cols + c]['hourly'], k, th)[1] for c in range(cols)] for r in range(rows)]
            name = f'prob{th}_{lead:03d}.png'
            write_png(tmp / name, cols, rows * MERC_ROWS_PER_CELL, raster(grid_vals, stops, ENS_GRID), pal)
            doc[f'prob{th}'] = f'{key}/{run_key}/{name}'
        step_docs.append(doc)
        for i, (name, lat, lon, *_) in enumerate(RAIN_POINTS + RIVER_POINTS):
            r, c = cell_of(lat, lon, ENS_GRID)
            h = locs[r * cols + c]['hourly']
            o25, p25 = share(h, k, 25)
            o50, p50 = share(h, k, 50)
            per_point.setdefault(i, []).append({'h': lead, 'valid': valid, 'p25Pct': p25, 'p50Pct': p50,
                                                'membersOver25': o25, 'membersOver50': o50, 'members': len(members)})

    points = [{'name': name, 'lat': lat, 'lon': lon, 'steps': per_point[i]}
              for i, (name, lat, lon, *_) in enumerate(RAIN_POINTS + RIVER_POINTS)]
    (tmp / 'points.json').write_text(json.dumps({
        'model': key, 'label': label, 'init': init, 'fetchedAt': fetched, 'members': len(members),
        'cellDeg': ENS_GRID[4], 'points': points,
    }, separators=(',', ':')) + '\n', encoding='utf-8')
    run_doc = {
        'key': run_key, 'model': key, 'init': init, 'fetchedAt': fetched, 'source': f'{model_id} ensemble',
        'members': len(members), 'steps': step_docs, 'points': f'{key}/{run_key}/points.json',
    }
    (tmp / 'run.json').write_text(json.dumps(run_doc, indent=1) + '\n', encoding='utf-8')
    if run_dir.exists():
        shutil.rmtree(run_dir)
    tmp.rename(run_dir)
    return run_key, f'{key} {init or "(run time not published)"} {len(steps)} steps, {len(members)} members'


# ---- what is on disk ----

def hours_between(a: str, b: str) -> float:
    fa = datetime.strptime(a[:19], '%Y-%m-%dT%H:%M:%S')
    fb = datetime.strptime(b[:19], '%Y-%m-%dT%H:%M:%S')
    return abs((fb - fa).total_seconds()) / 3600


def runs_on_disk(key: str) -> list[dict]:
    """Every complete run of a model, newest first (by fetch time — keys differ in form)."""
    out = []
    for d in (FIELD_DIR / key).glob('*'):
        f = d / 'run.json'
        if d.is_dir() and f.exists():
            try:
                out.append(json.loads(f.read_text(encoding='utf-8')))
            except Exception:  # noqa: BLE001 - a half-written run is simply not a run
                pass
    out.sort(key=lambda r: r['fetchedAt'], reverse=True)
    return out


def newest_run(key: str) -> dict | None:
    runs = runs_on_disk(key)
    return runs[0] if runs else None


def prune(key: str, keep: int) -> int:
    runs = runs_on_disk(key)
    dropped = 0
    for r in runs[keep:]:
        shutil.rmtree(FIELD_DIR / key / r['key'], ignore_errors=True)
        dropped += 1
    # Anything without a run.json is an abandoned .incoming directory.
    for d in (FIELD_DIR / key).glob('*.incoming'):
        shutil.rmtree(d, ignore_errors=True)
    return dropped


FRAME_LAYERS = ('precip', 'prob25', 'prob50')


def normalise_steps(run: dict) -> list[dict]:
    """The steps a run can honestly claim, with lead hours counted from its start.

    Applied to every run on disk, not only new ones: runs written before `usable_steps()` carry the
    previous run's step first and leads counted from the wrong moment, and they stay on disk for
    days. Idempotent for runs written since.
    """
    ref = run.get('init') or valid_from(None, run['fetchedAt'])
    out = []
    for s in run['steps']:
        lead = lead_hours(ref, s['valid'])
        if lead >= STEP_H:
            out.append({**s, 'h': int(round(lead))})
    return out


def frame_stats(path: Path) -> list:
    """[peak class, wet share] for one frame, read back from its own pixels.

    Peak is the highest legend class anywhere on the frame (0 = nothing drawn) and wet is the share
    of the image with any class at all. Read from the PNG rather than kept from the fetch so runs
    already on disk get the same numbers by the same path. The share is of image area, and the
    image is Mercator-spaced, so it leans very slightly north — fine for "how much of the map is
    raining", which is all it is used for.
    """
    _w, _h, rows, _pal, _t = decode_png(path.read_bytes())
    total = sum(len(r) for r in rows)
    peak = max((max(r) for r in rows if r), default=0)
    wet = sum(1 for r in rows for b in r if b)
    return [peak, round(wet / total, 3) if total else 0]


def run_stats(key: str, run: dict) -> dict:
    """Stats for every frame of a run, cached beside it in `stats.json`.

    A sidecar rather than a rewrite of run.json: run directories are written once and served
    `immutable`, and a new file added beside the others does not break that.
    """
    run_dir = FIELD_DIR / key / run['key']
    cache_path = run_dir / 'stats.json'
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - absent or unreadable: rebuild it
        cache = {}
    changed = False
    for s in run['steps']:
        for layer in FRAME_LAYERS:
            rel = s.get(layer)
            if not rel:
                continue
            name = rel.rsplit('/', 1)[-1]
            if name not in cache:
                f = run_dir / name
                if not f.exists():
                    continue
                cache[name] = frame_stats(f)
                changed = True
    if changed:
        cache_path.write_text(json.dumps(cache, separators=(',', ':')) + '\n', encoding='utf-8')
    return cache


def manifest_run(key: str, run: dict, fields: tuple[str, ...]) -> dict:
    doc = {k: run[k] for k in fields if k in run}
    stats = run_stats(key, run)
    steps = []
    for s in normalise_steps(run):
        st = {}
        for layer in FRAME_LAYERS:
            rel = s.get(layer)
            if rel and rel.rsplit('/', 1)[-1] in stats:
                peak, wet = stats[rel.rsplit('/', 1)[-1]]
                st[layer] = {'peak': peak, 'wet': wet}
        steps.append({**s, 'stats': st} if st else s)
    doc['steps'] = steps
    return doc


def build_manifest() -> dict:
    """Rebuilt from disk, so a deleted run can never linger in it."""
    lats, lons, rows, cols = grid_points()
    elats, elons, erows, ecols = grid_points(ENS_GRID)
    models = []
    for key, label, model_id, published in MODELS:
        runs = runs_on_disk(key)
        models.append({
            'key': key, 'label': label, 'source': model_id, 'initPublished': published,
            'layers': ['precip', 'wind'], 'bbox': bbox(), 'size': [cols, rows * MERC_ROWS_PER_CELL],
            'runs': [manifest_run(key, r, ('key', 'init', 'fetchedAt', 'wind', 'points')) for r in runs],
        })
    key, label, model_id = ENS
    runs = runs_on_disk(key)
    models.append({
        'key': key, 'label': label, 'source': f'{model_id} ensemble', 'initPublished': True,
        'layers': ['prob25', 'prob50'], 'bbox': bbox(ENS_GRID), 'size': [ecols, erows * MERC_ROWS_PER_CELL],
        'members': runs[0]['members'] if runs else 51,
        'runs': [manifest_run(key, r, ('key', 'init', 'fetchedAt', 'points')) for r in runs],
    })
    return {
        'generatedAt': utcnow(),
        'attribution': ATTRIBUTION,
        'note': NOTE,
        'stepHours': STEP_H,
        'grid': {'west': GRID[0], 'south': GRID[1], 'east': GRID[2], 'north': GRID[3], 'step': GRID[4], 'cols': cols, 'rows': rows},
        'projection': 'rows are spaced in Web Mercator so the image quad lands each cell where it belongs; columns are linear in longitude',
        'legends': LEGENDS,
        'models': models,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-fetch', action='store_true', help='rebuild the manifest from disk only')
    args = ap.parse_args()
    fetched = utcnow()
    wanted = [m.strip() for m in (os.environ.get('FIELD_MODELS') or 'ecmwf,gfs,icon').split(',') if m.strip()]
    keep = env_int('FIELD_KEEP_RUNS', 8)
    summaries, problems = [], []
    refused = None

    pacer = Pacer()
    if not args.no_fetch:
        try:
            kept, written = write_model_runs([m for m in MODELS if m[0] in wanted], fetched, pacer)
            for line in kept + written:
                summaries.append(line)
                print(f'  {line}')
        except urllib.error.HTTPError as e:
            refused = refusal(e)
            print(f'  models: {refused}')
        except Exception as e:  # noqa: BLE001 - the ensemble may still be fetchable
            problems.append(f'models skipped: {e}')
            print(f'  models: {e}')
        if env_int('FIELD_ENSEMBLE', 1) and not refused:
            try:
                res = write_ensemble_run(fetched, pacer)
                if res:
                    summaries.append(res[1])
                    print(f'  {res[1]}')
            except urllib.error.HTTPError as e:
                refused = refusal(e)
                print(f'  ensemble: {refused}')
            except Exception as e:  # noqa: BLE001
                problems.append(f'ensemble skipped: {e}')
                print(f'  ensemble: {e}')

    for key, *_ in MODELS + [ENS]:
        if (FIELD_DIR / key).exists():
            prune(key, keep)
    manifest = build_manifest()
    have = sum(len(m['runs']) for m in manifest['models'])
    if have == 0:
        print(f'skipped: {refused or "; ".join(problems) or "no forecast field could be fetched"}')
        return 0
    FIELD_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    size = sum(f.stat().st_size for f in FIELD_DIR.rglob('*') if f.is_file()) / 1e6
    detail = ' · '.join(summaries) if summaries else 'nothing new fetched'
    if problems:
        detail += '; ' + '; '.join(problems)
    if refused:
        detail += f'; {refused}'
    print(f'\nwrote field: {detail} ({size:.1f} MB, {have} runs kept)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
