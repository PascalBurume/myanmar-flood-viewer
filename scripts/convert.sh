#!/usr/bin/env bash
# data/raw/*.shp を GeoJSON に変換して、配信元（public/data）と保管先（data/geojson）に置く。
#
# 元データはすべて EPSG:4326 だが、再取得したシェープファイルが別CRSだった場合に
# 気付かず配信するのを避けるため -t_srs で明示的に揃える。
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p data/geojson public/data

for name in floodarea inputarea inputpoint; do
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 "data/geojson/${name}.geojson" "data/raw/${name}.shp"
  cp "data/geojson/${name}.geojson" "public/data/${name}.geojson"
  echo "converted: ${name}"
done
