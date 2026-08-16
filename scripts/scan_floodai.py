#!/usr/bin/env python3
"""Pull UNOSAT's FloodAI monitoring statistics for Myanmar.

Usage:
    python3 scripts/scan_floodai.py            # fetch if a newer product exists
    python3 scripts/scan_floodai.py --force    # fetch regardless
    python3 scripts/scan_floodai.py --dry-run  # report what is available, write nothing

What this source is
-------------------
UNOSAT run a deep-learning flood detector over Sentinel-1 radar and publish the result as an ArcGIS
service, refreshed as new imagery arrives. Unlike their hand-produced flood-extent products — which
cover a few regions, months after the fact — this covers the **whole country** and is days old.

It answers a different question from the extent layers already in this map. Those say *where* water
was, precisely. This says *how many people were under it*, per township, everywhere.

Why the endpoints are hardcoded the way they are
------------------------------------------------
The service name carries a date (`AI20260814MMR`), so it changes with each product. The newest is
discovered from the service directory rather than pinned, which is also how a genuinely new event
gets picked up without editing this file.

Statistics live in a companion `..._Stat` FeatureServer, one point per township, with a start/end
date pair. The raster itself is an ImageServer this script does not touch: it is a tiled image
service, not something the viewer can consume as GeoJSON.

Caveats that travel with the numbers
------------------------------------
UNOSAT state both plainly, and they are carried into the data so the viewer can repeat them:

- Radar **underestimates** flooding under dense vegetation and in built-up areas, because of how the
  signal scatters. An absent polygon is not proof of dry ground.
- The population figures come from WorldPop and may **overestimate** in urban areas.
- It is a preliminary analysis, not validated in the field.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse

from common import INDEX_PATH, emit_outputs, fetch, load_manifest, save_manifest, utcnow

BASE = 'https://unosat-rm.cern.ch/server/rest/services'
DATASET_ID = 'MM_FloodAI'
STATE_OK, STATE_CHANGED, STATE_FAILED = 'ok', 'changed', 'failed'

# Townships with no observation in the window come back with every measure null. They are dropped:
# a point with no data is not the same as a point with zero flooding, and drawing it as zero would
# claim an observation that was never made.
MEASURES = ('popflood', 'floodedar', 'cropfloodedar', 'observedar')


def api(url: str, **params) -> dict:
    params.setdefault('f', 'json')
    return json.loads(fetch(f'{url}?{urllib.parse.urlencode(params)}', timeout=120))


def newest_service() -> str:
    """The most recent Myanmar FloodAI product. Named AI<YYYYMMDD>MMR, so sorting is chronological."""
    listing = api(f'{BASE}/FloodAI')
    names = [s['name'].split('/')[-1] for s in listing.get('services', [])]
    mmr = sorted((n for n in names if n.endswith('MMR') and n.startswith('AI')), reverse=True)
    if not mmr:
        raise SystemExit('error: no Myanmar FloodAI service found in the directory')
    return mmr[0]


def fetch_stats(service: str) -> list[dict]:
    url = f'{BASE}/Hosted/{service}_Stat/FeatureServer/0/query'
    data = api(url, where='1=1', outFields='*', returnGeometry='true', outSR='4326',
               resultRecordCount=2000)
    return data.get('features', [])


def build_geojson(feats: list[dict], service: str) -> tuple[dict, dict]:
    """Township points carrying the four measures, plus the national totals."""
    out, totals = [], {m: 0.0 for m in MEASURES}
    window = ('', '')
    for f in feats:
        a = f.get('attributes') or {}
        g = f.get('geometry') or {}
        if a.get('popflood') is None and a.get('floodedar') is None:
            continue  # not observed in this window
        if g.get('x') is None:
            continue
        window = ((a.get('startdate') or '').strip(), (a.get('enddate') or '').strip())
        for m in MEASURES:
            totals[m] += a.get(m) or 0
        out.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [round(g['x'], 5), round(g['y'], 5)]},
            'properties': {
                'Region': a.get('admin1name'),
                'District': a.get('admin2name'),
                'Township': a.get('admin3name'),
                'People exposed': int(a.get('popflood') or 0),
                'Flooded area (km²)': round(a.get('floodedar') or 0, 1),
                'Flooded cropland (km²)': round(a.get('cropfloodedar') or 0, 1),
                'Observed area (km²)': round(a.get('observedar') or 0, 1),
                'Observed': window[1] or None,
            },
        })
    xs = [f['geometry']['coordinates'][0] for f in out]
    ys = [f['geometry']['coordinates'][1] for f in out]
    fc = {'type': 'FeatureCollection', 'features': out}
    if xs:
        fc['bbox'] = [min(xs), min(ys), max(xs), max(ys)]
    summary = {'service': service, 'window': window, 'places': len(out), **totals}
    return fc, summary


def write_dataset(fc: dict, summary: dict, retrieved: str) -> None:
    """Add or refresh the nationwide dataset in index.json, leaving the others alone."""
    base = INDEX_PATH.parent / DATASET_ID
    base.mkdir(parents=True, exist_ok=True)
    path = base / 'exposure.geojson'
    path.write_text(json.dumps(fc, ensure_ascii=False, separators=(',', ':')) + '\n',
                    encoding='utf-8')

    index = json.loads(INDEX_PATH.read_text(encoding='utf-8'))
    start, end = summary['window']
    when = end or start
    entry = {
        'id': DATASET_ID,
        'name': 'Myanmar — nationwide flood exposure',
        'sourceFile': f"UNOSAT FloodAI {summary['service']}",
        'note': (
            f"AI-detected surface water from Sentinel-1, observed {when}, covering the whole "
            f"country — {summary['places']} townships with an observation. Radar underestimates "
            'water under dense vegetation and in built-up areas, and the population figures are '
            'modelled from WorldPop, which can overestimate in cities. Preliminary, not '
            'field-validated.'
        ),
        'layers': {'exposure': {'path': f'data/{DATASET_ID}/exposure.geojson',
                                'features': len(fc['features'])}},
        'bbox': [round(v, 6) for v in fc['bbox']] if fc.get('bbox') else None,
        'group': 'Myanmar',
        'stats': [
            {'label': 'People exposed (nationwide)', 'value': round(summary['popflood']),
             'unit': '', 'source': f"UNOSAT FloodAI {summary['service']}, observed {when}, "
                                   f'retrieved {retrieved[:10]}'},
        ],
    }
    index['datasets'] = [d for d in index.get('datasets', []) if d['id'] != DATASET_ID]
    index['datasets'].append(entry)
    index['updated'] = retrieved
    INDEX_PATH.write_text(json.dumps(index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='fetch regardless of what is recorded')
    ap.add_argument('--dry-run', action='store_true', help='report only; write nothing')
    args = ap.parse_args()

    retrieved = utcnow()
    try:
        service = newest_service()
    except Exception as e:  # noqa: BLE001
        print(f'error: could not reach the FloodAI service directory ({e})', file=sys.stderr)
        emit_outputs(floodai_changed='false', floodai_state=STATE_FAILED,
                     floodai_detail=f'directory unreachable: {e}')
        return 2

    manifest = load_manifest()
    known = (manifest.get('floodai') or {}).get('service')
    is_new = known != service
    print(f'newest FloodAI product: {service}')
    print(f'  known: {known or "(none)"} -> {"NEW" if is_new else "unchanged"}')

    if args.dry_run:
        print(f'\nchanged: {"yes" if is_new else "no"}')
        emit_outputs(floodai_changed='false',
                     floodai_state=STATE_CHANGED if is_new else STATE_OK)
        return 0

    if not is_new and not args.force:
        manifest.setdefault('floodai', {})['checkedAt'] = retrieved
        save_manifest(manifest)
        print('\nno change.')
        emit_outputs(floodai_changed='false', floodai_state=STATE_OK, floodai_detail=service)
        return 0

    try:
        feats = fetch_stats(service)
        fc, summary = build_geojson(feats, service)
    except Exception as e:  # noqa: BLE001
        print(f'error: could not read the statistics layer ({e})', file=sys.stderr)
        emit_outputs(floodai_changed='false', floodai_state=STATE_FAILED,
                     floodai_detail=f'stats: {e}')
        return 2

    if not fc['features']:
        print('error: the statistics layer returned no observed townships', file=sys.stderr)
        emit_outputs(floodai_changed='false', floodai_state=STATE_FAILED,
                     floodai_detail='no observed townships')
        return 2

    write_dataset(fc, summary, retrieved)
    print(f"  observed {summary['window'][1] or summary['window'][0]}  "
          f"{summary['places']} townships")
    print(f"  people exposed {summary['popflood']:,.0f} | flooded {summary['floodedar']:,.0f} km2 "
          f"| cropland {summary['cropfloodedar']:,.0f} km2 | monitored {summary['observedar']:,.0f} km2")

    manifest['floodai'] = {
        'service': service,
        'window': summary['window'],
        'checkedAt': retrieved,
        'changedAt': retrieved,
        'places': summary['places'],
        'popflood': round(summary['popflood']),
    }
    save_manifest(manifest)
    emit_outputs(floodai_changed='true', floodai_state=STATE_CHANGED, floodai_detail=service)
    return 0


if __name__ == '__main__':
    sys.exit(main())
