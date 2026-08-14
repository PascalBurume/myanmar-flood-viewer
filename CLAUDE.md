# chiba-flood-viewer

2026年8月13日の千葉県大雨（NIED 水・土砂防災研究部門 速報）に関する推定浸水域データを、
Webブラウザ上の地図で閲覧できるようにするプロジェクト。

## 背景・データソース

- 元ページ: https://mizu.bosai.go.jp/key/20260813
  （短縮URL。実体は `https://mizu.bosai.go.jp/wiki2/wiki.cgi?page=2026年8月13日の千葉県での大雨`）
- ページ内容: 2026/8/13、千葉県で大雨特別警報級の大雨。千葉市周辺で風の収束により雨雲が発達。
  6時間積算雨量が「数年〜数十年に一度」の稀な規模。SNS写真から浸水深を推定し、
  千葉県大網白里市周辺の推定浸水域・浸水深を試算・公開している。
- 対象は大網白里市（Oami）だけでなく、今後千葉県内の他地点にも広がる可能性があるため、
  リポジトリ名は `oami-flood-viewer` ではなく `chiba-flood-viewer` とした。

## データ

元ページの「推定浸水域データ」節にある添付zipを `scripts/fetch_data.py` が取得・変換する。
半日に1回 GitHub Actions で自動実行（後述）。すべて CRS: GCS_WGS_1984 / EPSG:4326。

**訂正**: 以前このファイルに「2026-08-14時点でリビジョン(7)」と書いていたが、
添付ファイル名の隣の `(7)` `(20)` という数字は**ダウンロード数**であって版数ではない。
数時間で 7 → 20 に増えるのを観測した一方、zipのsha256は同一だった。更新の判定には使えない。

| ファイル | 内容 | 形状 | 属性 |
|---|---|---|---|
| `floodarea.*`  | 推定浸水域（本命データ） | Polygon × 4 | `gridcode`(1〜4), `浸水深`(区分の文字列) |
| `inputarea.*`  | 推定に使った入力範囲 | Polygon × 1 | `Shape_Leng`, `Shape_Area`（いずれも0） |
| `inputpoint.*` | 浸水深を読み取った参照地点 | Point × 1 | `浸水深`(0.5、単位m) |

`floodarea` の `gridcode` と `浸水深` は 1:1 対応（1=0.5m未満 / 2=0.5m以上1m未満 /
3=1m以上2m未満 / 4=2m以上）。着色は `gridcode` を使う（文字列より表記ゆれに強いため）。

### 自動更新（scripts/fetch_data.py + .github/workflows/update-data.yml）

`npm run update-data` / 半日1回のcron（JST 10:00・22:00）で走査 → 変更があれば取得・変換 →
main にコミット → Pages 再デプロイ。`npm run check-data` は差分確認のみ。

出典サイト側の事情でハマった点（作り直すとき同じ罠を踏まないように）:

- 短縮URL `https://mizu.bosai.go.jp/key/20260813` は **meta refresh** で実体ページに飛ぶ。
  HTTPリダイレクトではないので `curl -L` では追えない。HTMLを読んで自分で辿る。
- 添付ファイル名の隣の `(数字)` はダウンロード数（上記の訂正参照）。
- 添付のレスポンスに `Last-Modified` / `ETag` / `Content-Length` が無い（chunked）ため、
  条件付きGETもサイズ比較も不可。**zipを取得してsha256を比べる**しかない。
- 添付一覧ページ（`action=ATTACH` のみ）はログイン必須で400。
- 取り込むのは「推定浸水域データ」節の添付のみ（ページには雨量やSNS写真の節もある）。
- HTTPヘッダは latin-1 でエンコードされるため、User-Agent に日本語を入れると urllib が落ちる。
- ページはEUC-JP。地点の表示名は添付リンク直前の `<h3>` から採る。ただし元ページの見出しは
  「大綱白里市」と誤字（正: 大網白里市）なので `NAME_OVERRIDES` で上書きしている。

## ビューワ

参考にしたリポジトリ: https://github.com/shiwaku/dm-converter/tree/main/viewer
（MapLibre GL JS + Vite + TypeScript、パネルUI・テーマ切替・背景切替の実装を踏襲。
`src/basemap.ts` `src/theme.ts` `src/style.css` はそこから持ってきて本プロジェクト用に削っている。）

- データ量が小さいため PMTiles 化はせず、GeoJSON を直接 source として読む。
- 背景地図: 淡色 / 標準（`public/pale.json` `public/std.json`、地理院 最適化ベクトルタイル、
  PMTiles配信のため `pmtiles` プロトコル登録が必要）/ 写真（地理院ラスタ）/ 白図。
- ダークテーマは背景スタイルの色を明度反転して生成（`src/basemap.ts` の `recolor`）。
- 浸水域の配色は青系の連続配色。洪水浸水想定区域図の法定色（黄〜赤）は、法定図と同等の根拠が
  あるものと誤解されるため使わない。

### 実装上の注意

- **表示対象は `public/data/index.json` を実行時に読んで決める。** 地点が増えてもコードを
  変えずに地図へ出すため、レイヤー定義をビルド時に固定しない。種類（`LAYER_KINDS`）× 地点で
  ソース・レイヤーを組み立て、レイヤーIDは `<地点>--<種類>-<部位>`。
- **背景・テーマ切替後のオーバーレイ再追加は `map.on('style.load', …)` で行う。**
  `styledata` + `isStyleLoaded()` での判定は、ソースの読み込み完了が最後の `styledata` 発火より
  後になると再追加の機会を逃し、浸水域が消えたままになる（実際に踏んだ）。
- オーバーレイは背景スタイル最初の symbol レイヤーの下に差し込む（地名・駅名が塗りで隠れると
  場所が特定できなくなるため）。写真・白図には symbol が無いので最前面になる。
  積む順は「種類を外側、地点を内側」。地点が増えても浸水域→範囲→参照地点の重なり順を保つ。
- トグル・不透明度の状態は `setStyle` で失われるので `src/main.ts` の Map に持って復元する。
- **初期表示範囲は `new Map()` の `bounds` で渡す。** 生成直後に `fitBounds()` を呼んでも
  初期カメラには反映されない（hashに初期center/zoomが残るのを観測）。URLに位置がある場合は
  そちらを優先する。

## 環境メモ

- 実行環境: WSL、`/mnt/c/Users/yshiw/Documents/GIS/chiba-flood-viewer`
- `ogr2ogr`(GDAL) / `node`(v20) / `npm` / `tippecanoe` いずれも利用可。
  ※ 過去の環境メモにあった「GDALもpipも使えない」は解消済み。
- `unzip` コマンドは無い → Pythonの`zipfile`モジュールで代用。
- /mnt/c 上のため Vite は `watch.usePolling` を有効にしている（inotifyが届かない）。

## 進捗ログ

- [x] git初期化（`main`ブランチ）
- [x] NIEDページ確認・データダウンロード・展開
- [x] GeoJSON変換（ogr2ogr）
- [x] MapLibre + Vite + TS のビューワ作成（レイヤー切替・凡例・不透明度・ポップアップ・
      背景/テーマ切替）
- [x] ヘッドレスChromiumで表示確認（淡色/写真/ダーク、ポップアップ）
- [x] GitHub Pages へデプロイ（https://shiwaku.github.io/chiba-flood-viewer/ ）
      `npm run deploy` で `gh-pages` ブランチへ publish。`vite.config.ts` の `base` は
      `/chiba-flood-viewer/`。リポジトリ名を変えたらここも直すこと。
- [x] 半日1回の自動走査・取得・変換・再デプロイ（`scripts/fetch_data.py` +
      `.github/workflows/update-data.yml`）。地点が増えてもビューワ側は無改修で反映。
- [ ] `SCAN_UNTIL`（2026-09-14）到達時に、走査を延長するか止めるかを判断する
- [ ] 新レイヤー種別（`floodarea`/`inputarea`/`inputpoint` 以外）が来た場合の描画追加
