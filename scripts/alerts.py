#!/usr/bin/env python3
"""Derive alerts from what the pipeline just observed.

Usage:
    python3 scripts/alerts.py     # print what the current data would raise

Called by `status.py` on every run; the alerts land in `status.json` under `alerts`.

Nothing is pushed anywhere. These are recorded, not sent — an alert here is a line the viewer draws
and a line a `grep` on the JSON finds, which is the whole of the alerting for now. Adding a channel
later means reading this list and posting it, and changes nothing about how it is derived.

What is deliberately *not* decided here
---------------------------------------
Staleness. A file cannot know it has gone stale — it goes stale after it is written, by sitting
still. So `status.json` carries the **thresholds** (`freshness`) and the viewer applies them to
`generatedAt` at read time. Baking a `stale: false` into the file would produce a page that
confidently reports everything current while the pipeline has been dead for a week: exactly the
blind spot this whole design exists to close.

Severities
----------
`critical` something is broken or a large event is under way · `warning` worth a look ·
`info` a normal change worth recording.
"""

from __future__ import annotations

import json
import statistics
import sys

from common import INDEX_PATH

HISTORY_PATH = INDEX_PATH.parent / 'history.json'

# How much worse than the recent norm counts as a surge. Compared against the *median* of the
# preceding passes rather than the mean, because a single large event in the window would drag a
# mean up and hide the next one.
SURGE_BASELINE_PASSES = 12
SURGE_FACTOR = 3.0
SURGE_MIN_PEOPLE = 50_000

# Hours after which the run itself, and the newest observation, stop being current. The run figure
# is twice a daily cadence, so one missed run is tolerated and two is not. The data figure is wider
# because Sentinel-1 revisit is days, not hours — a quiet week is normal for the satellite and says
# nothing about the pipeline.
FRESHNESS = {'runHours': 48, 'dataHours': 24 * 21}


def read(path) -> dict:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:  # noqa: BLE001 - absent is simply nothing to say
        return {}


def alert(kind: str, severity: str, title: str, detail: str, **extra) -> dict:
    return {'kind': kind, 'severity': severity, 'title': title, 'detail': detail, **extra}


def from_sources(sources: dict) -> list[dict]:
    """Checks that did not complete, and events that are genuinely new."""
    out = []
    for key, src in sources.items():
        if src.get('state') == 'failed':
            out.append(alert(
                'check-failed', 'critical',
                f"{src['label']} — check failed",
                src.get('detail') or 'the check did not complete',
                source=key,
            ))
        elif src.get('state') == 'changed':
            ev = src.get('event') or {}
            people = ev.get('peopleTotal')
            out.append(alert(
                'new-data', 'info',
                f"{src['label']} — new data",
                (f"{ev.get('id')} — {people:,} people" if people else src.get('detail') or 'updated'),
                source=key, event=ev.get('id'), effective=ev.get('effective'),
            ))
    return out


def from_history() -> list[dict]:
    """A surge, judged against the recent record rather than a fixed number.

    A fixed threshold would be wrong the moment the country's usual level moved, and this series
    spans four years. Comparing the newest pass with the median of the preceding ones asks the only
    question worth asking: is this unusual *for here*?
    """
    doc = read(HISTORY_PATH)
    series = [r for r in doc.get('series', []) if r.get('people') is not None]
    if len(series) < 4:
        return []

    latest = series[-1]
    baseline = [r['people'] for r in series[-(SURGE_BASELINE_PASSES + 1):-1]]
    median = statistics.median(baseline)
    out = []

    if latest['people'] >= SURGE_MIN_PEOPLE and median > 0 and latest['people'] >= median * SURGE_FACTOR:
        out.append(alert(
            'surge', 'critical',
            f"Exposure surge — {latest['people']:,} people",
            f"{latest['date']}: {latest['people']:,} people exposed, "
            f"{latest['people'] / median:.1f}x the median of the previous {len(baseline)} passes "
            f"({median:,.0f}). Flooded area {latest['flooded']:,.0f} km², "
            f"observed {latest['observed']:,.0f} km².",
            date=latest['date'], people=latest['people'], baseline=round(median),
        ))

    # The record's own integrity. Withheld population is not a flood alert, but it is something a
    # reader comparing this chart against UNOSAT's dashboard needs told rather than left to discover.
    if doc.get('suspect'):
        out.append(alert(
            'data-quality', 'warning',
            f"{doc['suspect']} observations have no population figure",
            'The source reported population an order of magnitude beyond what every other archive '
            'reports for the same flooded area. Those figures are withheld; the areas are kept.',
        ))
    return out


def build(sources: dict) -> dict:
    """The alerts block written into status.json."""
    items = from_sources(sources) + from_history()
    rank = {'critical': 0, 'warning': 1, 'info': 2}
    items.sort(key=lambda a: rank.get(a['severity'], 9))
    return {
        'items': items,
        'counts': {s: sum(1 for a in items if a['severity'] == s)
                   for s in ('critical', 'warning', 'info')},
        # Thresholds, not verdicts. See the module docstring.
        'freshness': FRESHNESS,
    }


def main() -> int:
    from common import STATUS_PATH
    status = read(STATUS_PATH)
    block = build(status.get('sources') or {})
    if not block['items']:
        print('no alerts')
        return 0
    for a in block['items']:
        print(f"[{a['severity']:<8}] {a['title']}\n           {a['detail']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
