#!/usr/bin/env python3
"""Scan WFP ADAM for new Myanmar flood events and refresh the per-region impact figures.

Usage:
    python3 scripts/scan_adam.py            # scan, and refresh figures if a new event appeared
    python3 scripts/scan_adam.py --force    # refresh even when the newest event is already known
    python3 scripts/scan_adam.py --dry-run  # only report whether anything is new

Why ADAM
--------
UNOSAT publishes precise traced flood outlines, but rarely and long after the fact — the newest
vector product covering these regions is from September 2024. ADAM (Automated Disaster Analysis and
Mapping) is WFP's operational system: it processes events within hours and exposes them through a
public API with no key. It is the only source that keeps the Myanmar side of this map current.

What it does and does not give
------------------------------
ADAM gives *impact by administrative unit* — flooded hectares, flooded cropland, and a modelled
affected population — not a flood outline. The outline lives in a GeoTIFF this script does not
touch. So this refreshes the numbers in the panel, not the polygons on the map.

Change detection is deliberately cheap: one ~20 KB request lists every Myanmar flood event, and the
newest event id is compared against data/manifest.json. Nothing large is downloaded unless that id
has moved.

The backfill limit
------------------
Only the newest event's impact table is publicly readable; every older event's table returns 403.
There is therefore no way to build a history from this source — the scanner tracks the head of the
list and nothing else.

The figures are also automated and often carry `cleared: no`, meaning no analyst has reviewed them
and they may be revised in place under the same URL. The event id and retrieval date are written
alongside every figure so a stale number can always be traced.
"""

from __future__ import annotations

import argparse
import collections
import io
import json
import re
import sys
import zipfile

from common import INDEX_PATH, emit_outputs, fetch, load_manifest, save_manifest, utcnow

EVENTS_URL = (
    'https://api.adam.geospatial.wfp.org/api/collections/adam.adam_fl_events/items'
    '?iso3=MMR&limit=500'
)

# Region names as ADAM writes them, mapped onto the dataset ids this viewer already uses.
# ADAM splits Bago into East and West; the viewer has a single Bago Region dataset, so both fold in.
REGION_TO_DATASET = {
    'Yangon': 'MM_Yangon',
    'Bago (East)': 'MM_Bago',
    'Bago (West)': 'MM_Bago',
    'Bago': 'MM_Bago',
    'Mandalay': 'MM_Mandalay',
    'Nay Pyi Taw': 'MM_NayPyiTaw',
    'Nay Pyi Taw (Union Territory)': 'MM_NayPyiTaw',
}

STAT_LABEL = 'Flood impact (people)'

# The state names handed to the workflow, and from there to scripts/status.py. Must stay in step
# with STATES there — 'unchanged' is not one of them, it is spelled 'ok'.
STATE_OK, STATE_CHANGED, STATE_FAILED = 'ok', 'changed', 'failed'


def newest_event() -> dict:
    """The most recent Myanmar flood event ADAM knows about."""
    raw = fetch(EVENTS_URL, accept='application/json')
    data = json.loads(raw)
    items = data if isinstance(data, list) else data.get('features') or []
    if not items:
        raise SystemExit('error: ADAM returned no Myanmar flood events')
    flat = []
    for it in items:
        props = it if 'itemId' in it else it.get('properties', {})
        flat.append(props)
    return max(flat, key=lambda p: (p.get('effective') or '', p.get('itemId') or ''))


def parse_impact_table(blob: bytes) -> dict[str, dict[str, float]]:
    """Read ADAM's per-district impact xlsx into {region: {area, cropland, people}}.

    Two traps in these sheets, both learned the hard way:
      - numbers are stored as inline strings with thousands separators ("27,010"), not as numeric
        cells, so a plain numeric match drops almost every row;
      - the admin-1 name appears only on the first row of each group and is blank thereafter, so it
        has to be carried forward or the rows land under the wrong region.
    """
    z = zipfile.ZipFile(io.BytesIO(blob))
    xml = z.read('xl/worksheets/sheet1.xml').decode('utf-8', 'replace')

    def col_index(ref: str) -> int:
        letters = re.match(r'([A-Z]+)', ref).group(1)
        n = 0
        for ch in letters:
            n = n * 26 + (ord(ch) - 64)
        return n - 1

    rows: list[dict[int, str]] = []
    for rm in re.finditer(r'<row[^>]*r="(\d+)"[^>]*>(.*?)</row>', xml, re.S):
        cells: dict[int, str] = {}
        for cm in re.finditer(r'<c\s+r="([A-Z]+\d+)"[^>]*?>(.*?)</c>', rm.group(2), re.S):
            body = cm.group(2)
            t = re.search(r'<t[^>]*>(.*?)</t>', body, re.S)
            v = re.search(r'<v>(.*?)</v>', body, re.S)
            val = (t.group(1) if t else (v.group(1) if v else '')).strip()
            if val:
                cells[col_index(cm.group(1))] = val
        if cells:
            rows.append(cells)

    def num(s: str) -> float | None:
        s = (s or '').replace(',', '')
        return float(s) if re.fullmatch(r'\d+(\.\d+)?', s) else None

    out: dict[str, dict[str, float]] = collections.defaultdict(
        lambda: {'area': 0.0, 'cropland': 0.0, 'people': 0.0}
    )
    region = None
    for cells in rows:
        if cells.get(0):
            region = cells[0]
        area = num(cells.get(2, ''))
        if not region or area is None:
            continue
        out[region]['area'] += area
        out[region]['cropland'] += num(cells.get(3, '')) or 0.0
        out[region]['people'] += num(cells.get(4, '')) or 0.0
    return dict(out)


def apply_to_index(event: dict, by_region: dict[str, dict[str, float]], retrieved: str) -> list[str]:
    """Write the ADAM figures into index.json as an additional Stat per dataset.

    The supplied "Flood risk share" figures are left alone. They measure something different —
    risk rather than observed impact — and the two disagree sharply for Yangon and Bago, so
    overwriting one with the other would quietly destroy information. Both are shown, each labelled.
    """
    if not INDEX_PATH.exists():
        return []
    index = json.loads(INDEX_PATH.read_text(encoding='utf-8'))

    totals: dict[str, dict[str, float]] = collections.defaultdict(
        lambda: {'area': 0.0, 'cropland': 0.0, 'people': 0.0}
    )
    for region, vals in by_region.items():
        ds_id = REGION_TO_DATASET.get(region.strip())
        if not ds_id:
            continue
        for k in ('area', 'cropland', 'people'):
            totals[ds_id][k] += vals[k]

    event_id = event.get('itemId', '')
    effective = event.get('effective', '')
    source = f'WFP ADAM event {event_id} ({effective}), retrieved {retrieved[:10]}'

    touched = []
    for ds in index.get('datasets', []):
        vals = totals.get(ds['id'])
        stats = [s for s in ds.get('stats', []) if s.get('label') != STAT_LABEL]
        if vals and vals['people'] > 0:
            stats.append(
                {
                    'label': STAT_LABEL,
                    'value': round(vals['people']),
                    'unit': '',
                    'source': source,
                }
            )
            touched.append(ds['id'])
        ds['stats'] = stats

    index['adamEvent'] = {
        'id': event_id,
        'effective': effective,
        'cleared': event.get('cleared'),
        'retrieved': retrieved,
        'peopleTotal': round(sum(v['people'] for v in totals.values())),
    }
    INDEX_PATH.write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )
    return touched


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='refresh even with no new event')
    ap.add_argument('--dry-run', action='store_true', help='only report whether anything is new')
    args = ap.parse_args()

    checked_at = utcnow()
    try:
        event = newest_event()
    except Exception as e:  # noqa: BLE001 - the reason does not change what we report
        # Loud, not silent: a scanner that reports "unchanged" when it never reached the source is
        # worse than one that fails, because nobody goes looking.
        print(f'error: could not reach the ADAM API ({e})', file=sys.stderr)
        emit_outputs(adam_changed='false', adam_state=STATE_FAILED, adam_detail=f'unreachable: {e}')
        return 2

    event_id = event.get('itemId', '')
    effective = event.get('effective', '')
    manifest = load_manifest()
    known = manifest.get('adam', {})
    is_new = known.get('eventId') != event_id

    print(f'newest Myanmar flood event: {event_id} (effective {effective})')
    print(f'  known: {known.get("eventId") or "(none)"} -> {"NEW" if is_new else "unchanged"}')

    if args.dry_run:
        print(f'\nchanged: {"yes" if is_new else "no"}')
        emit_outputs(adam_changed='false', adam_state=STATE_CHANGED if is_new else STATE_OK)
        return 0

    if not is_new and not args.force:
        manifest.setdefault('adam', {})['checkedAt'] = checked_at
        save_manifest(manifest)
        print('\nno change.')
        emit_outputs(adam_changed='false', adam_state=STATE_OK, adam_detail=event_id)
        return 0

    table_url = event.get('output_table_url')
    if not table_url:
        print('error: the newest event exposes no impact table', file=sys.stderr)
        emit_outputs(adam_changed='false', adam_state=STATE_FAILED, adam_detail='no impact table')
        return 2

    try:
        blob = fetch(table_url, timeout=120)
        by_region = parse_impact_table(blob)
    except Exception as e:  # noqa: BLE001
        print(f'error: could not read the impact table ({e})', file=sys.stderr)
        emit_outputs(adam_changed='false', adam_state=STATE_FAILED, adam_detail=f'table: {e}')
        return 2

    touched = apply_to_index(event, by_region, checked_at)
    people = sum(v['people'] for v in by_region.values())
    print(f'  regions in table: {len(by_region)}, people {people:,.0f}')
    print(f'  datasets updated: {", ".join(touched) if touched else "(none matched)"}')

    manifest['adam'] = {
        'eventId': event_id,
        'effective': effective,
        'cleared': event.get('cleared'),
        'checkedAt': checked_at,
        'changedAt': checked_at,
        'peopleTotal': round(people),
    }
    save_manifest(manifest)

    emit_outputs(
        adam_changed='true',
        adam_state=STATE_CHANGED,
        adam_detail=f'{event_id} ({effective})',
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
