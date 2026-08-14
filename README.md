# chiba-flood-viewer

2026年8月13日の千葉県大雨について、防災科学技術研究所 水・土砂防災研究部門が公開した
**推定浸水域・浸水深**（速報）を地図上で閲覧するビューワです。

> 本サイトは個人が作成・配信するものであり、防災科学技術研究所の公式サイトではありません。
> 表示しているのはSNS写真から読み取った浸水深をもとに試算された**推定値**で、
> 実際の浸水範囲・浸水深とは異なります。洪水浸水想定区域図（法定図）ではありません。

- データ出典: [防災科研 水・土砂防災研究部門「2026年8月13日の千葉県での大雨」](https://mizu.bosai.go.jp/key/20260813)
- 背景地図: [国土地理院 最適化ベクトルタイル](https://github.com/gsi-cyberjapan/optimal_bvmap) / [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)

## 表示内容

| レイヤー | 元データ | 内容 |
|---|---|---|
| 推定浸水域 | `floodarea` | 浸水深を4区分（0.5m未満 / 0.5〜1m / 1〜2m / 2m以上）で着色 |
| 推定に使った範囲 | `inputarea` | 推定計算の対象範囲（この枠の外は未計算） |
| 参照地点 | `inputpoint` | SNS写真から浸水深を読み取った地点 |

浸水域の配色は青系の連続配色を使っています。洪水浸水想定区域図の法定色（黄〜赤）で描くと
法定図と同等の根拠があるものと誤解されるためです。

## 開発

```bash
npm install
npm run dev      # http://localhost:5175/
npm run build    # 型チェック + dist/ 生成
npm run preview
```

技術構成: MapLibre GL JS + Vite + TypeScript。データ量が小さいため、
ベクトルタイル化はせず GeoJSON を直接 source として読んでいます。

## データの更新

元データはリビジョンが上がることがあります。再取得する場合:

1. 元ページを開き、`action=ATTACH` リンクのファイル名の版数（末尾の `(数字)`）を確認する。

   ```bash
   curl -sS -L https://mizu.bosai.go.jp/key/20260813
   ```

2. zip を `data/raw/` に展開する（`page` / `file` パラメータはEUC-JPでURLエンコードされた日本語ページ名）。

   ```
   https://mizu.bosai.go.jp/wiki2/wiki.cgi?page=2026%C7%AF8%B7%EE13%C6%FC%A4%CE%C0%E9%CD%D5%B8%A9%A4%C7%A4%CE%C2%E7%B1%AB&action=ATTACH&file=JR%5FOami%5FStation%5Fshp%2Ezip
   ```

3. GeoJSON に変換する（`data/geojson/` と配信用の `public/data/` の両方に出力される）。

   ```bash
   npm run convert   # 内部で ogr2ogr を使用
   ```

## ディレクトリ

```
data/raw/        ダウンロードしたシェープファイル（EPSG:4326）
data/geojson/    変換後のGeoJSON（保管用）
public/data/     変換後のGeoJSON（配信用、ビューワが読む）
public/*.json    背景地図スタイル（地理院 最適化ベクトルタイル）
src/             ビューワ本体
scripts/         データ変換
```
