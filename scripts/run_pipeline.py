#!/usr/bin/env python3
"""Run the whole update pipeline, from anywhere.

Usage:
    python3 scripts/run_pipeline.py                    # scan and write status
    python3 scripts/run_pipeline.py --publish /var/www/flood   # also build and publish the site
    python3 scripts/run_pipeline.py --commit                    # also commit changed data to git
    python3 scripts/run_pipeline.py --force            # refresh even with no new event
    python3 scripts/run_pipeline.py --dry-run          # probe only, write nothing

Why this exists
---------------
This is the only entrypoint. A cron on a server, a systemd timer, or a laptop all invoke the same
command and produce byte-identical output — there is no CI service in the loop and nothing to
configure in anyone else's dashboard.

Recording its own history
-------------------------
Every stage it runs — name, state, detail and duration — is recorded into status.json. That is what
lets the viewer draw the orchestration tree without asking any external API.

Self-hosting
------------
`--publish DIR` builds the site and swaps it into a directory your own web server serves. No git, no
tokens, no third-party service — the pipeline and the site are then entirely yours. The swap is
atomic (build beside the target, rename into place) so a visitor never sees a half-copied site.

`--commit` remains for keeping the generated data in version control; it is independent of how the
site is served.

Exit codes: 0 fine, 1 a stage failed, 2 the run could not start (e.g. past the scan deadline is 0,
because stopping on purpose is not a failure).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import status as status_mod
from common import ROOT, utcnow

# The scan deadline. Past this the pipeline stops touching the source APIs, so an abandoned
# deployment cannot keep polling someone else's service forever. Overridable by env for the runner.
SCAN_UNTIL = os.environ.get('SCAN_UNTIL', '2026-09-14')
os.environ['SCAN_UNTIL'] = SCAN_UNTIL


# Progress markers. `status.json` records what a run *did*, after the fact — which is useless to
# anyone watching a run that takes half a minute. These lines are emitted as it goes, so the viewer
# can draw the steps live off the same process that is doing the work. They are printed unbuffered
# because the server streams stdout line by line; a buffered stage boundary would arrive with the
# next one and the display would jump two steps at a time.
MARK_PLAN = '[[plan]]'
MARK_STAGE = '[[stage]]'


def announce(*parts: str) -> None:
    print(' '.join(parts), flush=True)


# The stages this run intends to execute, announced before any of them start. Sent from here rather
# than hardcoded in the viewer, so the drawn plan can never drift from the code that runs it — and
# so a run that skips a stage still shows it, greyed, rather than silently omitting it.
PLAN = [
    ('gate', 'Scan window'),
    ('unosat', 'UNOSAT extents'),
    ('floodai', 'FloodAI exposure'),
    ('adam', 'WFP ADAM impact'),
    ('history', 'Flood history'),
    ('weather', 'Rain & rivers'),
    ('publish', 'Build & publish'),
    ('status', 'Write status'),
]


class Stage:
    """One step of the pipeline, recorded whether it passes, fails or is skipped."""

    def __init__(self, key: str, label: str):
        self.key = key
        self.label = label
        self.state = 'skipped'
        self.detail = ''
        self.started = utcnow()
        self.t0 = time.monotonic()
        self.seconds = 0.0
        announce(MARK_STAGE, key, 'running', label)

    def finish(self, state: str, detail: str = '') -> 'Stage':
        self.state = state
        self.detail = detail
        self.seconds = round(time.monotonic() - self.t0, 2)
        announce(MARK_STAGE, self.key, state, f'{self.seconds:.2f}s', detail.replace('\n', ' ')[:160])
        return self

    def as_dict(self) -> dict:
        return {
            'key': self.key,
            'label': self.label,
            'state': self.state,
            'detail': self.detail,
            'startedAt': self.started,
            'seconds': self.seconds,
        }


def runner_name() -> str:
    """Who ran this. Recorded so a stale status file can be traced back to a machine."""
    return socket.gethostname()


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, **kw)


def stage_gate(stages: list[Stage]) -> bool:
    st = Stage('gate', f'Scan window (until {SCAN_UNTIL})')
    stages.append(st)
    today = date.today().isoformat()
    if today > SCAN_UNTIL:
        st.finish('skipped', f'past the deadline {SCAN_UNTIL}; nothing was checked')
        return False
    st.finish('ok', f'today {today} is within the window')
    return True


def stage_adam(stages: list[Stage], force: bool, dry_run: bool) -> tuple[str, str]:
    st = Stage('adam', 'WFP ADAM — flood impact, Myanmar')
    stages.append(st)
    cmd = [sys.executable, 'scripts/scan_adam.py']
    if force:
        cmd.append('--force')
    if dry_run:
        cmd.append('--dry-run')
    proc = run(cmd)
    out = (proc.stdout or '') + (proc.stderr or '')
    print(out.rstrip())
    if proc.returncode != 0:
        # A scanner that cannot reach its source must say so. Reporting "nothing new" here would be
        # indistinguishable from a healthy quiet run, which is the failure mode this design exists
        # to prevent.
        detail = next((l for l in out.splitlines() if l.startswith('error:')), 'scan failed')
        st.finish('failed', detail.replace('error: ', ''))
        return 'failed', st.detail
    changed = 'changed: yes' in out or 'datasets updated' in out
    event = next((l.split(':', 1)[1].strip() for l in out.splitlines()
                  if l.startswith('newest Myanmar flood event')), '')
    st.finish('changed' if changed else 'ok', event or 'no change')
    return st.state, st.detail


def stage_floodai(stages: list[Stage], force: bool, dry_run: bool) -> tuple[str, str]:
    """UNOSAT FloodAI — nationwide, near-current, per-township exposure."""
    st = Stage('floodai', 'UNOSAT FloodAI — nationwide exposure')
    stages.append(st)
    cmd = [sys.executable, 'scripts/scan_floodai.py']
    if force:
        cmd.append('--force')
    if dry_run:
        cmd.append('--dry-run')
    proc = run(cmd)
    out = (proc.stdout or '') + (proc.stderr or '')
    print(out.rstrip())
    if proc.returncode != 0:
        detail = next((l for l in out.splitlines() if l.startswith('error:')), 'scan failed')
        st.finish('failed', detail.replace('error: ', ''))
        return 'failed', st.detail
    changed = 'people exposed' in out
    svc = next((l.split(':', 1)[1].strip() for l in out.splitlines()
                if l.startswith('newest FloodAI product')), '')
    people = next((l.strip() for l in out.splitlines() if l.strip().startswith('people exposed')), '')
    st.finish('changed' if changed else 'ok', people or svc or 'no change')
    return st.state, st.detail


def stage_history(stages: list[Stage]) -> None:
    """Rebuild the multi-year series from every FloodAI archive.

    Cheap and idempotent — five grouped-statistics queries returning a few hundred rows — so it runs
    on every active run rather than only when the newest product changes. That matters because
    UNOSAT revise archived products in place: a run that finds no *new* product can still find
    corrected figures inside the old ones.
    """
    st = Stage('history', 'Flood history — multi-year series')
    stages.append(st)
    proc = run([sys.executable, 'scripts/history.py'])
    out = (proc.stdout or '') + (proc.stderr or '')
    print(out.rstrip())
    if proc.returncode != 0:
        detail = next((l for l in out.splitlines() if l.startswith('error:')), 'history failed')
        st.finish('failed', detail.replace('error: ', ''))
        return
    wrote = next((l for l in out.splitlines() if l.startswith('wrote history.json')), '')
    st.finish('ok', wrote.replace('wrote history.json: ', '') or 'rebuilt')


def stage_weather(stages: list[Stage]) -> None:
    """Rainfall and river-discharge forecasts.

    Fetched by the pipeline rather than by the page, so the served site still contacts nothing but
    the basemap tiles. A forecast refreshed twice a day is current enough for daily rainfall totals
    and a 14-day discharge run, and `generatedAt` is on the page for anyone who needs to judge that.

    Never fatal to the run. A forecast is the one thing here that is genuinely optional: the flood
    map is complete without it, so an outage at Open-Meteo must not turn a good run red.
    """
    st = Stage('weather', 'Rainfall and river forecast')
    stages.append(st)
    proc = run([sys.executable, 'scripts/scan_weather.py'])
    out = (proc.stdout or '') + (proc.stderr or '')
    print(out.rstrip())
    if proc.returncode != 0:
        st.finish('skipped', 'forecast unavailable; the flood data is unaffected')
        return
    wrote = next((l for l in out.splitlines() if l.startswith('wrote weather.json')), '')
    st.finish('ok', wrote.replace('wrote weather.json: ', '') or 'refreshed')


def stage_unosat(stages: list[Stage]) -> None:
    # Recorded as a stage even though nothing runs, so the tree says why it is not automated
    # rather than leaving a silent hole where a source used to be.
    st = Stage('unosat', 'UNOSAT — flood extents, Myanmar')
    stages.append(st)
    st.finish('skipped',
              'hand-traced extents are not polled: products are 8-282 MB and the clipping is '
              'hand-tuned. The FloodAI stage covers the same source automatically.')


def stage_commit(stages: list[Stage], changed: bool) -> None:
    st = Stage('commit', 'Commit the changed data')
    stages.append(st)
    if not changed:
        st.finish('skipped', 'nothing changed')
        return
    run(['git', 'add', 'public/data'])
    if run(['git', 'diff', '--cached', '--quiet']).returncode == 0:
        st.finish('skipped', 'the scan reported a change but the output is identical')
        return
    msg = f'Update data: {utcnow()[:16].replace("T", " ")} UTC'
    proc = run(['git', 'commit', '-m', msg, '-m', 'Automated by scripts/run_pipeline.py.'])
    if proc.returncode != 0:
        st.finish('failed', (proc.stderr or proc.stdout).strip()[:200])
        return
    push = run(['git', 'push'])
    st.finish('ok' if push.returncode == 0 else 'failed',
              'committed and pushed' if push.returncode == 0 else (push.stderr or '').strip()[:200])


def stage_publish(stages: list[Stage], target: str, finalize) -> None:
    """Build the site and swap it into the directory the web server serves.

    Swapped rather than copied in place: a `cp -r` over a live directory means visitors can load a
    new index.html against old assets, or vice versa, for as long as the copy takes. Building
    alongside and renaming makes the change instant from the server's point of view.

    `finalize` writes this run's status into the staged copy just before the swap. That ordering
    matters: `npm run build` copies public/ into dist/, so it captures the status file as it was at
    the *start* of the run. Without writing it again into the staging directory, every publish would
    serve the previous run's status and "Last checked" would be permanently one run stale.
    """
    st = Stage('publish', f'Build and publish to {target}')
    stages.append(st)

    dest = Path(target).expanduser().resolve()
    env = {**os.environ}
    # Assets are addressed from wherever the server mounts the site; default to the domain root,
    # which is what a self-hosted site normally is.
    env.setdefault('BASE_PATH', '/')

    build = run(['npm', 'run', 'build'], env=env)
    if build.returncode != 0:
        st.finish('failed', 'build failed: ' + (build.stderr or build.stdout).strip()[-300:])
        return

    dist = ROOT / 'dist'
    if not dist.is_dir():
        st.finish('failed', 'the build produced no dist/ directory')
        return

    staging = dest.with_name(dest.name + '.incoming')
    previous = dest.with_name(dest.name + '.previous')
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(dist, staging)
        if previous.exists():
            shutil.rmtree(previous)
        size = sum(f.stat().st_size for f in staging.rglob('*') if f.is_file())
        # Mark the stage done *before* stamping the status, so the copy that goes live describes the
        # publish that carried it. A file cannot contain the outcome of its own delivery, but the
        # delivery is the rename below: if that fails this copy never becomes visible, so anything
        # reading it is by definition reading a successful publish.
        st.finish('ok', f'published {size / 1e6:.1f} MB to {dest}')
        finalize(staging / 'data' / 'status.json')

        if dest.exists():
            dest.rename(previous)
        staging.rename(dest)
        # Keep the previous copy only until the new one is in place, then drop it — a rollback
        # window measured in milliseconds, not a backup.
        if previous.exists():
            shutil.rmtree(previous)
    except Exception as e:  # noqa: BLE001 - any failure here must be recorded, not raised
        st.finish('failed', f'could not publish to {dest}: {e}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='refresh even with no new event')
    ap.add_argument('--dry-run', action='store_true', help='probe only; write nothing')
    ap.add_argument('--commit', action='store_true', help='commit and push changed data (git hosting)')
    ap.add_argument(
        '--publish',
        metavar='DIR',
        help='build and swap the site into DIR for your own web server to serve. '
        'Needs no git and no external service.',
    )
    args = ap.parse_args()

    started = utcnow()
    t0 = time.monotonic()
    stages: list[Stage] = []
    print(f'pipeline start {started}  runner={runner_name()}')

    # The intended shape of this run, before anything begins. A watcher can then draw every step
    # from the outset — including the ones that will be skipped — instead of having them appear one
    # at a time and the line growing under the reader.
    plan = [p for p in PLAN if p[0] != 'publish' or args.publish]
    announce(MARK_PLAN, '|'.join(f'{k}:{lab}' for k, lab in plan))

    active = stage_gate(stages)
    if active:
        stage_unosat(stages)
        floodai_state, _ = stage_floodai(stages, args.force, args.dry_run)
        adam_state, _ = stage_adam(stages, args.force, args.dry_run)
        if not args.dry_run:
            stage_history(stages)
            stage_weather(stages)
    else:
        floodai_state = adam_state = 'skipped'

    if args.dry_run:
        print('\ndry run: nothing written.')
        return 0

    changed = 'changed' in (adam_state, floodai_state)
    if args.commit:
        stage_commit(stages, changed)

    # Written last, and always — a run that changed nothing still has to leave evidence that it
    # happened, or "quiet" and "broken" look identical from the outside.
    status_stage = Stage('status', 'Write the pipeline status')

    def compose() -> dict:
        doc = status_mod.build(
            stages=[s.as_dict() for s in stages] + [status_stage.as_dict()],
            runner=runner_name(),
            started_at=started,
            seconds=round(time.monotonic() - t0, 2),
            active=active,
            adam_state=adam_state,
            floodai_state=floodai_state,
        )
        status_stage.finish('ok', f'conclusion {doc["run"]["conclusion"]}')
        doc['run']['stages'][-1] = status_stage.as_dict()
        return doc

    if args.publish:
        # The publish stage writes the final status into the staged site itself, so the served copy
        # describes this run rather than the last one.
        def finalize(path) -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(compose(), ensure_ascii=False, indent=2) + '\n',
                            encoding='utf-8')
        stage_publish(stages, args.publish, finalize)

    doc = compose()
    status_mod.write(doc)

    print()
    print(status_mod.render(doc))
    return 1 if doc['run']['conclusion'] == 'failed' else 0


if __name__ == '__main__':
    sys.exit(main())
