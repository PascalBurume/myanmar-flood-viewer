#!/usr/bin/env python3
"""Write public/data/status.json — what the pipeline checked, and what it found.

Usage:
    python3 scripts/status.py            # write the file
    python3 scripts/status.py --print    # write it and print the tree to the terminal

Why this file exists
--------------------
A run that finds nothing used to leave no trace anywhere, so "scanned twice a day, all quiet" looked
exactly like "the scanner has been throwing errors for a fortnight". This file is written on every
run, so silence becomes evidence.

What it records
---------------
Both halves, deliberately:

  data state — which sources were checked, what they hold now, what they held before.
  run  state — which stages ran, their outcome and duration, and which machine ran them.

Run state used to be left out, on the grounds that the GitHub Actions API already knew it. That tied
the viewer to one vendor for something the pipeline can simply write down. Now the pipeline records
its own stages, so a run on a laptop or a VPS cron produces exactly the same evidence as a run on
Actions, and the viewer needs no external API at all.

The honesty rule
----------------
`conclusion` is derived from the recorded source states, never from the workflow's own success. With
`continue-on-error` those two diverge, and trusting the workflow's verdict is precisely the mistake
that produced the blind spot above. A source whose check did not complete is `failed`, and one
`failed` source makes the whole run `failed` — the viewer must never be able to render "up to date"
off a run that did not actually complete its checks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import alerts as alerts_mod
from common import INDEX_PATH, STATUS_PATH, load_manifest, utcnow

SCHEMA = 1

# The whole vocabulary. Anything outside this set is a bug, not a new state.
#   ok       - checked, nothing new
#   changed  - checked, something new was taken in
#   skipped  - deliberately not run (e.g. past SCAN_UNTIL)
#   failed   - the check did not complete; never treat as "nothing new"
STATES = ('ok', 'changed', 'skipped', 'failed')


def env(name: str, default: str = '') -> str:
    return os.environ.get(name, default) or default


def read_json(path) -> dict:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - a missing or broken file is just "nothing to report"
        return {}


def source_state(raw: str, changed: str) -> str:
    """Normalise a step's reported state, preferring an explicit one."""
    if raw in STATES:
        return raw
    return 'changed' if changed == 'true' else 'ok'


def build(
    stages: list[dict] | None = None,
    runner: str = '',
    started_at: str = '',
    seconds: float = 0.0,
    active: bool | None = None,
    adam_state: str = '',
    floodai_state: str = '',
) -> dict:
    manifest = load_manifest()
    index = read_json(INDEX_PATH)
    previous = read_json(STATUS_PATH)

    if active is None:
        active = env('WINDOW_ACTIVE', 'true') == 'true'

    # ---- WFP ADAM (Myanmar) ----
    adam_rec = manifest.get('adam') or {}
    adam = {
        'label': 'WFP ADAM — flood impact, Myanmar',
        'state': 'skipped' if not active
        else source_state(adam_state or env('ADAM_STATE'), env('ADAM_CHANGED')),
        'checkedAt': adam_rec.get('checkedAt'),
        'sourceUrl': 'https://api.adam.geospatial.wfp.org',
        'probe': 'newest Myanmar event id',
        'detail': env('ADAM_DETAIL') or (adam_rec.get('eventId') or 'no event recorded'),
        'event': {
            'id': adam_rec.get('eventId'),
            'effective': adam_rec.get('effective'),
            # ADAM publishes automated figures; `cleared: no` means no analyst has reviewed them
            # and they can be revised in place. The viewer surfaces this rather than hiding it.
            'cleared': adam_rec.get('cleared'),
            'peopleTotal': adam_rec.get('peopleTotal'),
        },
    }

    # UNOSAT is deliberately not polled: its products are 8-282 MB and the conversion needs
    # per-region tolerances, boundary files and named exclusions. Automating it would produce a
    # confidently wrong map. Recorded here so the tree can say so rather than stay silent.
    unosat = {
        'label': 'UNOSAT — flood extents, Myanmar',
        'state': 'skipped',
        'checkedAt': None,
        'sourceUrl': 'https://data.humdata.org/organization/unosat',
        'probe': 'not polled',
        'detail': 'Manual snapshot. Products are 8-282 MB and the region clipping is hand-tuned, '
        'so this source is refreshed by hand, not on a schedule.',
    }

    floodai_rec = manifest.get('floodai') or {}
    floodai = {
        'label': 'UNOSAT FloodAI — nationwide exposure',
        'state': 'skipped' if not active else source_state(floodai_state, ''),
        'checkedAt': floodai_rec.get('checkedAt'),
        'sourceUrl': 'https://unosat-rm.cern.ch/FloodAI/apps/MMR/',
        'probe': 'newest AI<date>MMR service',
        'detail': (f"{floodai_rec.get('service')} — {floodai_rec.get('popflood'):,} people across "
                   f"{floodai_rec.get('places')} townships"
                   if floodai_rec.get('service') else 'no product recorded'),
        'event': {
            'id': floodai_rec.get('service'),
            'effective': (floodai_rec.get('window') or ['', ''])[-1],
            'peopleTotal': floodai_rec.get('popflood'),
        },
    }

    sources = {'floodai': floodai, 'unosat': unosat, 'adam': adam}

    stage_failed = any(st.get('state') == 'failed' for st in (stages or []))
    if stage_failed or any(s['state'] == 'failed' for s in sources.values()):
        conclusion = 'failed'
    elif not active:
        conclusion = 'skipped'
    elif any(s['state'] == 'changed' for s in sources.values()):
        conclusion = 'changed'
    else:
        conclusion = 'ok'

    status = {
        'schema': SCHEMA,
        'generatedAt': utcnow(),
        'run': {
            'trigger': 'manual',
            'runner': runner or 'local',
            'startedAt': started_at or None,
            'seconds': seconds or None,
            'conclusion': conclusion,
            'stages': stages or [],
        },
        'scanUntil': env('SCAN_UNTIL') or None,
        'sources': sources,
        # Derived here rather than in the viewer so a `grep` on the file, a log line and the page
        # all raise exactly the same thing. Staleness is deliberately left to the reader — see
        # scripts/alerts.py for why a file cannot know it has gone stale.
        'alerts': alerts_mod.build(sources),
        'index': {
            'updated': index.get('updated'),
            'datasetIds': sorted(d['id'] for d in index.get('datasets', [])),
        },
    }

    # Carry a slim snapshot of the prior run so the viewer can diff without keeping history.
    # Slim on purpose: nesting a full previous status would grow without bound.
    if previous:
        status['previous'] = {
            'generatedAt': previous.get('generatedAt'),
            'run': {'conclusion': (previous.get('run') or {}).get('conclusion')},
            'indexUpdated': (previous.get('index') or {}).get('updated'),
            'datasets': ((previous.get('sources') or {}).get('unosat') or {}).get('datasets') or {},
            'adamEvent': (((previous.get('sources') or {}).get('adam') or {}).get('event') or {}).get('id'),
        }
    return status


def render(status: dict) -> str:
    run = status['run']
    who = run.get('runner') or 'local'
    lines = [
        f"Update pipeline on {who} "
        f"→ {run['conclusion'].upper()}"
        + (f"  [{run['seconds']}s]" if run.get('seconds') else ''),
        f"  started {run.get('startedAt') or status['generatedAt']}   "
        f"scanUntil {status.get('scanUntil')}",
    ]
    stages = run.get('stages') or []
    if stages:
        for i, st in enumerate(stages):
            edge = '└─' if i == len(stages) - 1 else '├─'
            secs = f"{st.get('seconds', 0):>6.2f}s"
            lines.append(f"  {edge} {st['label']:<44} [{st['state']:<7}] {secs}")
            if st.get('detail'):
                pad = '     ' if i == len(stages) - 1 else '  │  '
                lines.append(f"{pad}  {st['detail']}")
    else:
        for src in status['sources'].values():
            lines.append(f"  ├─ {src['label']:<42} [{src['state']}]")
            lines.append(f"  │    {src['detail']}")
    for a in (status.get('alerts') or {}).get('items', []):
        lines.append(f"  ! [{a['severity']}] {a['title']}")
    ix = status['index']
    lines.append(f"  serving {len(ix['datasetIds'])} datasets, index updated {ix.get('updated')}")
    return '\n'.join(lines)


def write(status: dict) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATUS_PATH.write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--print', action='store_true', help='also print the tree')
    args = ap.parse_args()

    status = build()
    write(status)
    print(f'wrote {STATUS_PATH} ({STATUS_PATH.stat().st_size:,} bytes) '
          f'conclusion={status["run"]["conclusion"]}')
    if args.print:
        print()
        print(render(status))
    return 0


if __name__ == '__main__':
    sys.exit(main())
