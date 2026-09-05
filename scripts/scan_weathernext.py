#!/usr/bin/env python3
"""Gate for the WeatherNext 3 forecast field: runs the reducer only when everything it needs exists.

Usage:
    python3 scripts/scan_weathernext.py            # from the pipeline
    python3 scripts/scan_weathernext.py --check    # say what is missing and stop

This is the one stage in the pipeline that cannot be standard-library Python, and the one that
cannot run without an account. Google's WeatherNext 3 ensemble lives in Zarr v3 on a
Requester-Pays bucket: the chunks are compressed with codecs the standard library cannot decode,
and reading them needs a Google Account that Google has added to the WeatherNext allow-list. So the
reducer (`scripts/wn3_reduce.py`, written once access exists) runs under an isolated virtualenv of
Google's own recommended libraries, and this script decides whether that is possible today.

Absent configuration is the **normal** case, not an error — the same rule as the assistant with no
API key. Every missing piece prints one `skipped: <reason>` line and exits 0, so the pipeline
records the stage as skipped with that text and the panel shows the reader exactly what is missing.

The checks, in order:

1. Credentials — `WEATHERNEXT_PROJECT` (the Google Cloud project billed for Requester-Pays egress)
   and `GOOGLE_APPLICATION_CREDENTIALS`, or the gcloud application-default credentials file.
2. Libraries — `WEATHERNEXT_VENV` (default `.venv-wn3`) whose interpreter can import xarray, zarr,
   obstore and numpy. This machine's own Python is 3.9 and the zarr-3 stack needs 3.11+, so the
   venv is made from a separate interpreter and this script never assumes it is the pipeline's.
3. Terms — `WEATHERNEXT_ACCEPTED_TERMS=1`. Real-time WeatherNext output is under Google's
   experimental data terms, which restrict redistribution; output older than an hour is CC BY 4.0.
   Whether a public site may serve the field is a question the operator answers on sign-up, and
   credentials alone must not publish anything while it is open.
4. The reducer itself, if it exists.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from common import ROOT

REDUCER = ROOT / 'scripts' / 'wn3_reduce.py'
REQUIREMENTS = ROOT / 'scripts' / 'wn3_requirements.txt'
DEFAULT_VENV = ROOT / '.venv-wn3'
ADC = Path.home() / '.config' / 'gcloud' / 'application_default_credentials.json'
# Egress cap per run, in GB. The full ensemble is Requester-Pays; the reducer estimates its read
# from the chunk grid before fetching anything and stops under this figure.
DEFAULT_MAX_GB = '5'


def venv_python(venv: Path) -> Path | None:
    for rel in ('bin/python3', 'bin/python', 'Scripts/python.exe'):
        p = venv / rel
        if p.exists():
            return p
    return None


def check() -> list[str]:
    """Every reason the stage cannot run today. Empty means it can."""
    reasons = []
    if not os.environ.get('WEATHERNEXT_PROJECT'):
        reasons.append('WeatherNext credentials not configured: set WEATHERNEXT_PROJECT '
                       '(the Google Cloud project billed for egress)')
    creds = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if not ((creds and Path(creds).exists()) or ADC.exists()):
        reasons.append('WeatherNext credentials not configured: set GOOGLE_APPLICATION_CREDENTIALS '
                       'or run `gcloud auth application-default login` with an allow-listed account')

    venv = Path(os.environ.get('WEATHERNEXT_VENV') or DEFAULT_VENV)
    py = venv_python(venv)
    if not py:
        reasons.append(f'WeatherNext libs not installed: no virtualenv at {venv} '
                       f'(python3.11+ -m venv {venv.name} && {venv.name}/bin/pip install -r {REQUIREMENTS.relative_to(ROOT)})')
    else:
        probe = subprocess.run([str(py), '-c', 'import sys; assert sys.version_info >= (3, 11); import xarray, zarr, obstore, numpy'],
                               capture_output=True, text=True)
        if probe.returncode != 0:
            reasons.append(f'WeatherNext libs not installed in {venv}: {(probe.stderr or "").strip().splitlines()[-1] if probe.stderr else "import failed"}')

    if os.environ.get('WEATHERNEXT_ACCEPTED_TERMS') != '1':
        reasons.append('WeatherNext terms not accepted: set WEATHERNEXT_ACCEPTED_TERMS=1 after reading '
                       'the GDM Real-Time Weather Forecasting Experimental Data Terms and deciding '
                       'whether this site may redistribute the field')

    if not REDUCER.exists():
        reasons.append(f'reducer not present: {REDUCER.relative_to(ROOT)} is written once allow-list access exists')
    return reasons


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='report what is missing and stop')
    args = ap.parse_args()

    reasons = check()
    if args.check:
        if not reasons:
            print('ready: every requirement for the WeatherNext 3 stage is present')
        for r in reasons:
            print(f'missing: {r}')
        return 0
    if reasons:
        # One line, the first blocker: the stage detail has room for one reason and the reader
        # fixes them in this order anyway.
        print(f'skipped: {reasons[0]}')
        return 0

    venv = Path(os.environ.get('WEATHERNEXT_VENV') or DEFAULT_VENV)
    py = venv_python(venv)
    env = {**os.environ, 'WEATHERNEXT_MAX_GB': os.environ.get('WEATHERNEXT_MAX_GB', DEFAULT_MAX_GB)}
    proc = subprocess.run([str(py), str(REDUCER)], env=env, text=True, capture_output=True)
    out = (proc.stdout or '') + (proc.stderr or '')
    print(out.rstrip())
    if proc.returncode != 0:
        # The reducer's own `skipped:` (an egress estimate over the cap, say) is passed through;
        # anything else is an error the stage records as skipped with the last line as the reason.
        if not any(l.startswith('skipped:') for l in out.splitlines()):
            last = (out.strip().splitlines() or ['reducer failed'])[-1]
            print(f'skipped: {last[:200]}')
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
