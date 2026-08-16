#!/usr/bin/env python3
"""Helpers shared by the scanner scripts.

Shared by scripts/scan_adam.py and scripts/status.py — one copy of the User-Agent rule and the
GITHUB_OUTPUT convention is worth more than two that drift apart.

Standard library only, like the rest of scripts/.
"""

from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# HTTP headers are encoded as latin-1, so Japanese in here makes urllib raise. Keep it ASCII.
# Identifies this client to the APIs it polls. Third-party services are entitled to know who is
# calling them and roughly how often.
USER_AGENT = 'myanmar-flood-viewer/1.0 (flood map data updater; checks twice a day)'

MANIFEST_PATH = ROOT / 'data' / 'manifest.json'
INDEX_PATH = ROOT / 'public' / 'data' / 'index.json'
STATUS_PATH = ROOT / 'public' / 'data' / 'status.json'


def utcnow() -> str:
    """Timestamp used everywhere the pipeline records when something happened."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fetch(url: str, timeout: int = 60, accept: str | None = None) -> bytes:
    headers = {'User-Agent': USER_AGENT}
    if accept:
        headers['Accept'] = accept
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    return {'datasets': {}}


def save_manifest(manifest: dict) -> None:
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )


def emit_outputs(**kv: str) -> None:
    """Write outputs for later GitHub Actions steps (a no-op when run locally)."""
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as f:
        for k, v in kv.items():
            f.write(f'{k}={v}\n')
