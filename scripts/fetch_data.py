#!/usr/bin/env python3
"""防災科研の公開ページを走査し、推定浸水域データが更新されていたら取得・変換する。

使い方:
    python3 scripts/fetch_data.py            # 走査して変更があれば取得・変換
    python3 scripts/fetch_data.py --force    # 変更が無くても再取得・再変換
    python3 scripts/fetch_data.py --dry-run  # 取得・変換はせず、差分の有無だけ表示

変更検知の方法（なぜこうしているか）:

- 添付ファイル名の隣に出る `(20)` のような数字は **ダウンロード数** であって版数ではない。
  数時間で 7 → 20 と増えるのを観測しており、更新の指標には使えない。
- 添付ファイルのレスポンスに Last-Modified / ETag / Content-Length が無い（chunked）。
  条件付きGETもサイズ比較もできない。
- 添付ファイル一覧ページ（action=ATTACH のみ）はログインが必要でエラーになる。

残る手段は「zip を実際に取得して中身のハッシュを比べる」ことだけ。zip は数十KBなので
半日1回の取得なら負荷はほぼ無い。加えてページHTMLの添付リンクの集合を記録しておき、
**新しい地点のzipが追加された場合**（千葉県内の他地点に広がるケース）も検出する。

出力:
    data/raw/<dataset>/        取得したzipと展開したシェープファイル
    data/geojson/<dataset>/    変換後のGeoJSON（保管用）
    public/data/<dataset>/     変換後のGeoJSON（配信用）
    public/data/index.json     ビューワが読むデータセット一覧
    data/manifest.json         走査用の指紋（zipのsha256など）
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 短縮URL。ここから meta refresh で実体ページに飛ぶ（HTTPリダイレクトではないので
# curl -L や urllib のリダイレクト追跡では追えない。HTMLを読んで自分で辿る）。
ENTRY_URL = 'https://mizu.bosai.go.jp/key/20260813'
# 実体ページのURLは meta refresh から取るが、取れなかったときの保険として持っておく
# （page パラメータはEUC-JPでURLエンコードされた日本語ページ名）。
FALLBACK_PAGE_URL = (
    'https://mizu.bosai.go.jp/wiki2/wiki.cgi'
    '?page=2026%C7%AF8%B7%EE13%C6%FC%A4%CE%C0%E9%CD%D5%B8%A9%A4%C7%A4%CE%C2%E7%B1%AB'
)
PAGE_ENCODING = 'euc_jp'

# 取り込むのはこの見出しの節にある添付だけ。ページには雨量やSNS写真など別の話題も載るため、
# 「ページ内の全zip」を対象にすると浸水域以外のデータまで取り込んでしまう。
DATA_SECTION = '推定浸水域データ'

# HTTPヘッダは latin-1 でエンコードされるため、日本語を入れると urllib が例外を投げる。ASCIIで書く。
USER_AGENT = (
    'chiba-flood-viewer-bot/1.0 '
    '(+https://github.com/shiwaku/chiba-flood-viewer; checks twice a day)'
)

# ページの見出しから採る地点名の上書き。
# 元ページの見出しは「千葉県大綱白里市」だが、正しい自治体名は「大網白里市」（綱→網）。
# 出典の表記をそのまま出すと誤字を広めてしまうため、ここだけ直して表示する。
NAME_OVERRIDES = {
    'JR_Oami_Station': '千葉県大網白里市（JR大網駅周辺）',
}

# ビューワが描き方を知っているレイヤー名。これ以外のshpが増えたら変換はするが、
# 表示にはコード変更が必要なので警告する。
KNOWN_LAYERS = {'floodarea', 'inputarea', 'inputpoint'}

MANIFEST_PATH = ROOT / 'data' / 'manifest.json'
INDEX_PATH = ROOT / 'public' / 'data' / 'index.json'


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as res:
        return res.read()


def resolve_page_url() -> str:
    """短縮URLの meta refresh を辿って実体ページのURLを得る。"""
    try:
        raw = fetch(ENTRY_URL)
    except Exception as e:  # noqa: BLE001 - 到達できない理由は問わずフォールバックする
        print(f'警告: 短縮URLの取得に失敗（{e}）。既知のページURLを使う。', file=sys.stderr)
        return FALLBACK_PAGE_URL
    text = raw.decode(PAGE_ENCODING, 'replace')
    m = re.search(
        r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]*content=["\']?\s*\d+\s*;\s*url=([^"\'>\s]+)',
        text,
        re.I,
    )
    if not m:
        print('警告: meta refresh が見つからない。既知のページURLを使う。', file=sys.stderr)
        return FALLBACK_PAGE_URL
    return urllib.parse.urljoin(ENTRY_URL, html.unescape(m.group(1)))


def strip_tags(s: str) -> str:
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', '', s))).strip()


class Attachment:
    def __init__(self, url: str, filename: str, heading: str):
        self.url = url
        self.filename = filename
        self.heading = heading
        # 「JR_Oami_Station_shp.zip」→「JR_Oami_Station」
        self.dataset_id = re.sub(r'(_shp)?\.zip$', '', filename, flags=re.I)

    @property
    def name(self) -> str:
        return NAME_OVERRIDES.get(self.dataset_id) or self.heading or self.dataset_id


def extract_section(page_html: str, title: str) -> str | None:
    """指定した見出し（h2）から次の同レベル見出しまでのHTMLを切り出す。

    ページには雨量やSNS写真など他の話題も載る。取り込むのは「推定浸水域データ」節の
    添付だけに限定したいので、節ごとに切ってから添付リンクを探す。
    """
    for m in re.finditer(r'<h2[^>]*>(.*?)</h2>', page_html, re.S | re.I):
        if strip_tags(m.group(1)) != title:
            continue
        rest = page_html[m.end():]
        nxt = re.search(r'<h2[^>]*>', rest, re.I)
        return rest[: nxt.start()] if nxt else rest
    return None


def parse_attachments(page_url: str, section_html: str, section_title: str) -> list[Attachment]:
    """節の中の添付zipリンクを、直前の見出し（地点名）とともに拾う。"""
    found: list[Attachment] = []
    for m in re.finditer(r'<a\s[^>]*href="([^"]*action=ATTACH[^"]*)"[^>]*>(.*?)</a>', section_html, re.S | re.I):
        href = html.unescape(m.group(1))
        label = strip_tags(m.group(2))
        if not label.lower().endswith('.zip'):
            continue
        # 直前の見出しを地点名として使う（例: <h3>千葉県大綱白里市</h3>）
        heads = re.findall(r'<h[3-4][^>]*>(.*?)</h[3-4]>', section_html[: m.start()], re.S | re.I)
        heading = strip_tags(heads[-1]) if heads else section_title
        found.append(Attachment(urllib.parse.urljoin(page_url, href), label, heading))
    return found


def load_manifest() -> dict:
    if MANIFEST_PATH.exists():
        return json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    return {'datasets': {}}


def convert_shapefiles(dataset_dir: Path, out_dirs: list[Path]) -> dict[str, dict]:
    """展開済みディレクトリ内の全 .shp を GeoJSON に変換し、レイヤー情報を返す。"""
    layers: dict[str, dict] = {}
    for shp in sorted(dataset_dir.glob('*.shp')):
        layer = shp.stem
        primary = out_dirs[0] / f'{layer}.geojson'
        primary.parent.mkdir(parents=True, exist_ok=True)
        if primary.exists():
            primary.unlink()
        subprocess.run(
            [
                'ogr2ogr',
                '-f', 'GeoJSON',
                # 元データは EPSG:4326 だが、再取得で別CRSに変わっても気付かず配信しないよう明示する
                '-t_srs', 'EPSG:4326',
                # 配信サイズを削るため座標は6桁（≒0.1m）に丸める。浸水域の表示には十分。
                '-lco', 'COORDINATE_PRECISION=6',
                # ビューワの初期表示範囲に使うので bbox を書き出す
                '-lco', 'WRITE_BBOX=YES',
                str(primary), str(shp),
            ],
            check=True,
        )
        gj = json.loads(primary.read_text(encoding='utf-8'))
        layers[layer] = {
            'features': len(gj.get('features', [])),
            'bbox': gj.get('bbox'),
        }
        for extra in out_dirs[1:]:
            extra.mkdir(parents=True, exist_ok=True)
            shutil.copy(primary, extra / f'{layer}.geojson')
    return layers


def union_bbox(boxes: list[list[float]]) -> list[float] | None:
    boxes = [b for b in boxes if b and len(b) == 4]
    if not boxes:
        return None
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def emit_outputs(**kv: str) -> None:
    """GitHub Actions の後続ステップ用に出力を書く（ローカル実行時は何もしない）。"""
    path = os.environ.get('GITHUB_OUTPUT')
    if not path:
        return
    with open(path, 'a', encoding='utf-8') as f:
        for k, v in kv.items():
            f.write(f'{k}={v}\n')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true', help='変更が無くても再取得・再変換する')
    ap.add_argument('--dry-run', action='store_true', help='差分の有無だけ表示する')
    args = ap.parse_args()

    page_url = resolve_page_url()
    page_html = fetch(page_url).decode(PAGE_ENCODING, 'replace')
    # 黙って「変更なし」と報告し続けるのが最悪なので、解析できない時点で失敗させる
    section = extract_section(page_html, DATA_SECTION)
    if section is None:
        print(f'エラー: 「{DATA_SECTION}」の節が見つからない。ページ構成が変わった可能性がある。', file=sys.stderr)
        return 2
    attachments = parse_attachments(page_url, section, DATA_SECTION)
    if not attachments:
        print(f'エラー: 「{DATA_SECTION}」の節に添付zipのリンクが1件も無い。', file=sys.stderr)
        return 2
    print(f'ページ: {page_url}')
    print(f'添付zip: {len(attachments)}件 -> {", ".join(a.filename for a in attachments)}')

    manifest = load_manifest()
    known: dict = manifest.get('datasets', {})
    # index.json はビューワの生命線。何かの手違いで消えていたら、ハッシュが同じでも作り直す。
    force = args.force or not INDEX_PATH.exists()
    if force and not args.force:
        print('注意: public/data/index.json が無いため再変換します。')

    changed: list[str] = []
    added: list[str] = []
    unknown_layers: list[str] = []
    datasets: list[dict] = []

    for att in attachments:
        blob = fetch(att.url)
        digest = hashlib.sha256(blob).hexdigest()
        prev = known.get(att.dataset_id)
        is_new = prev is None
        is_changed = (not is_new) and prev.get('sha256') != digest

        if is_new:
            added.append(att.dataset_id)
        if is_new or is_changed:
            changed.append(att.dataset_id)
        state = '新規' if is_new else ('更新' if is_changed else '変更なし')
        print(f'  {att.dataset_id}: {state} (sha256={digest[:12]}…, {len(blob)}バイト)')

        if args.dry_run or (not (is_new or is_changed) and not force):
            # 変換済みの情報は manifest から引き継ぐ（index.json を作り直すため）
            if prev:
                datasets.append(prev['index'])
            continue

        raw_dir = ROOT / 'data' / 'raw' / att.dataset_id
        if raw_dir.exists():
            shutil.rmtree(raw_dir)
        raw_dir.mkdir(parents=True)
        zip_path = raw_dir / att.filename
        zip_path.write_bytes(blob)
        # unzip コマンドが無い環境（このプロジェクトのWSL）でも動くよう zipfile を使う
        with tempfile.TemporaryDirectory() as tmp:
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(tmp)
            # zip内にディレクトリ階層があってもよいように、shp一式を平らに集める
            for f in Path(tmp).rglob('*'):
                if f.is_file() and f.suffix.lower() != '.zip':
                    shutil.copy(f, raw_dir / f.name)

        layers = convert_shapefiles(
            raw_dir,
            [ROOT / 'public' / 'data' / att.dataset_id, ROOT / 'data' / 'geojson' / att.dataset_id],
        )
        if not layers:
            print(f'エラー: {att.dataset_id} にシェープファイルが無い。', file=sys.stderr)
            return 2
        for layer in layers:
            if layer not in KNOWN_LAYERS:
                unknown_layers.append(f'{att.dataset_id}/{layer}')

        entry = {
            'id': att.dataset_id,
            'name': att.name,
            'sourceFile': att.filename,
            'layers': {
                name: {
                    'path': f'data/{att.dataset_id}/{name}.geojson',
                    'features': info['features'],
                }
                for name, info in layers.items()
            },
            'bbox': union_bbox([info['bbox'] for info in layers.values()]),
        }
        datasets.append(entry)
        known[att.dataset_id] = {'sha256': digest, 'size': len(blob), 'index': entry}

    if args.dry_run:
        print(f'\n差分: {"あり" if changed else "なし"}')
        emit_outputs(changed='false')
        return 0

    if not changed and not force:
        print('\n変更なし。')
        emit_outputs(changed='false', added='', unknown='')
        return 0

    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    datasets.sort(key=lambda d: d['id'])
    INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INDEX_PATH.write_text(
        json.dumps(
            {'updated': now, 'source': page_url, 'datasets': datasets},
            ensure_ascii=False,
            indent=2,
        )
        + '\n',
        encoding='utf-8',
    )
    manifest = {'checkedAt': now, 'source': page_url, 'datasets': known}
    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )

    print(f'\n更新: {", ".join(changed) if changed else "(再変換のみ)"}')
    if unknown_layers:
        print(f'注意: ビューワが知らないレイヤーがある -> {", ".join(unknown_layers)}')
    emit_outputs(
        changed='true',
        added=' '.join(added),
        unknown=' '.join(unknown_layers),
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
