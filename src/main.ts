import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'

import { getBasemapStyle, BASEMAP_LABELS, type Basemap } from './basemap'
import {
  DEPTH_CLASSES,
  LAYER_KINDS,
  layerId,
  loadIndex,
  popupHtml,
  sourceId,
  sourceSpec,
  type DataIndex,
  type KindKey,
} from './layers'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import './style.css'

let theme: Theme = initialTheme()
let base: Basemap = 'pale'
applyThemeAttr(theme)

const BASE_URL = import.meta.env.BASE_URL

// 地理院 最適化ベクトルタイルは PMTiles 単一ファイル配信のため、プロトコル登録が要る。
maplibregl.addProtocol('pmtiles', new Protocol().tile)

/**
 * 表示対象は public/data/index.json から実行時に決める。
 * 半日1回の自動走査（.github/workflows/update-data.yml）で地点が増えることがあり、
 * その都度ビューワのコードを直さずに地図へ出せるようにするため。
 */
const index: DataIndex = await loadIndex(BASE_URL)

/** 種類ごとの表示ON/OFFと不透明度。背景地図を切り替えるとスタイルごと差し替わるため、ここに持って復元する。 */
const kindVisible = new Map<KindKey, boolean>(LAYER_KINDS.map((k) => [k.key, true]))
const kindOpacity = new Map<KindKey, number>(LAYER_KINDS.map((k) => [k.key, 0.7]))
/** 地点ごとの表示ON/OFF。 */
const datasetVisible = new Map<string, boolean>(index.datasets.map((d) => [d.id, true]))

/** ポップアップの見出し（レイヤーID → 「地点名 / 種類名」）。 */
const headings = new Map<string, string>()
/** クリック判定の対象レイヤー。 */
const queryLayerIds: string[] = []

for (const kind of LAYER_KINDS) {
  for (const ds of index.datasets) {
    if (!ds.layers[kind.key]) continue
    for (const spec of kind.specs(ds.id)) {
      headings.set(spec.id, `${ds.name} / ${kind.label}`)
    }
    if (kind.query) queryLayerIds.push(layerId(ds.id, kind.key, kind.key === 'inputpoint' ? 'circle' : 'fill'))
  }
}

const unionBbox = ((): [number, number, number, number] | null => {
  const boxes = index.datasets.map((d) => d.bbox).filter((b): b is [number, number, number, number] => !!b)
  if (!boxes.length) return null
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ]
})()

// 初期表示はデータの範囲に合わせる。地点が増減しても自動で収まるようにするため、
// 中心・ズームの決め打ちは URL に位置が無く範囲も分からないときのフォールバックに留める。
// （生成後の fitBounds は初期カメラに反映されないので、コンストラクタの bounds で渡す。）
// 左のパネル（デスクトップ幅で320px）の下に浸水域が隠れないよう、その分の余白を空ける。
const isNarrow = window.matchMedia('(max-width: 640px)').matches
const fitPadding = isNarrow
  ? { top: 40, right: 40, bottom: 40, left: 40 }
  : { top: 40, right: 40, bottom: 40, left: 360 }

const initialCamera =
  !location.hash && unionBbox
    ? { bounds: unionBbox, fitBoundsOptions: { padding: fitPadding } }
    : { center: [140.3095, 35.5268] as [number, number], zoom: 13.6 }

const map = new maplibregl.Map({
  container: 'map',
  style: await getBasemapStyle(base, theme),
  ...initialCamera,
  minZoom: 8,
  maxZoom: 19,
  // 地図位置を URL の #ズーム/緯度/経度 に反映（共有・リロード時の位置維持）
  hash: true,
  attributionControl: false,
})

map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: false },
    fitBoundsOptions: { maxZoom: 17 },
    trackUserLocation: true,
    showUserLocation: true,
  }),
  'top-right',
)
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

/**
 * 背景スタイルのラベル（symbol）より下にオーバーレイを差し込むためのID。
 * 地名・駅名が浸水域の塗りで隠れると場所が特定できなくなるため。
 * 写真・白図スタイルには symbol が無いので、その場合は最前面に積む。
 */
function firstSymbolId(): string | undefined {
  return map.getStyle().layers.find((l) => l.type === 'symbol')?.id
}

/** スタイル差し替え後に、浸水域などのオーバーレイを積み直す。 */
function addOverlay(): void {
  const before = firstSymbolId()
  // 種類を外側、地点を内側に回して積む。地点が増えても重なり順（浸水域→範囲→参照地点）を保つため。
  for (const kind of LAYER_KINDS) {
    for (const ds of index.datasets) {
      const info = ds.layers[kind.key]
      if (!info) continue
      const src = sourceId(ds.id, kind.key)
      if (!map.getSource(src)) map.addSource(src, sourceSpec(BASE_URL, info))
      for (const spec of kind.specs(ds.id)) {
        if (!map.getLayer(spec.id)) map.addLayer(spec, before)
      }
    }
    applyVisibility(kind.key)
    applyOpacity(kind.key)
  }
}

function applyVisibility(key: KindKey): void {
  const kind = LAYER_KINDS.find((k) => k.key === key)
  if (!kind) return
  for (const ds of index.datasets) {
    if (!ds.layers[key]) continue
    // 種類と地点の両方がONのときだけ出す
    const v = kindVisible.get(key) && datasetVisible.get(ds.id) ? 'visible' : 'none'
    for (const spec of kind.specs(ds.id)) {
      if (map.getLayer(spec.id)) map.setLayoutProperty(spec.id, 'visibility', v)
    }
  }
}

function applyOpacity(key: KindKey): void {
  const kind = LAYER_KINDS.find((k) => k.key === key)
  if (!kind?.opacity) return
  const o = kindOpacity.get(key) ?? 0.7
  for (const ds of index.datasets) {
    if (!ds.layers[key]) continue
    for (const spec of kind.specs(ds.id)) {
      if (!map.getLayer(spec.id)) continue
      // 塗りと縁取りで paint プロパティ名が違う。縁取りは薄くしすぎると境界を見失うため下限を設ける。
      if (spec.type === 'fill') map.setPaintProperty(spec.id, 'fill-opacity', o)
      else if (spec.type === 'line') map.setPaintProperty(spec.id, 'line-opacity', Math.max(o, 0.4))
    }
  }
}

// 背景地図・テーマの切り替えは setStyle でスタイルごと入れ替わり、オーバーレイも消える。
// 'style.load' は初回読み込みと setStyle の両方で、addLayer 可能になった時点で発火する。
// （'styledata' + isStyleLoaded() での判定は、ソース読み込み完了が最後の発火より後になると
//   再追加の機会を逃してオーバーレイが消えたままになる。）
map.on('style.load', addOverlay)

/** setStyle をこの関数に集約する。await 中に別の切替が始まっても、最後の指定だけが残るようにする。 */
let styleSeq = 0
async function applyStyle(): Promise<void> {
  const seq = ++styleSeq
  const style = await getBasemapStyle(base, theme)
  if (seq !== styleSeq) return
  map.setStyle(style)
}

// ---- ポップアップ ----

const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '320px' })

map.on('click', (e) => {
  const ids = queryLayerIds.filter((id) => map.getLayer(id))
  const features = map.queryRenderedFeatures(e.point, { layers: ids })
  if (!features.length) {
    popup.remove()
    return
  }
  popup.setLngLat(e.lngLat).setHTML(popupHtml(features, headings)).addTo(map)
})

map.on('mousemove', (e) => {
  const ids = queryLayerIds.filter((id) => map.getLayer(id))
  const hit = ids.length > 0 && map.queryRenderedFeatures(e.point, { layers: ids }).length > 0
  map.getCanvas().style.cursor = hit ? 'pointer' : ''
})

// ---- パネル UI ----

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** トグルのラベル要素（チェックボックス＋スイッチ＋文字）を作る。 */
function toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const el = document.createElement('label')
  el.className = 'toggle'
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = checked
  cb.addEventListener('change', () => onChange(cb.checked))
  const sw = document.createElement('span')
  sw.className = 'switch'
  const text = document.createElement('span')
  text.className = 't-label'
  text.textContent = label
  el.append(cb, sw, text)
  return el
}

/** レイヤー種類のトグル（＋不透明度スライダー）。全地点に一括で効く。 */
function buildKindToggles(): void {
  const box = $('layers')
  for (const kind of LAYER_KINDS) {
    // どの地点にも無い種類はトグルを出さない（データ側の構成が変わった場合に空振りさせない）
    if (!index.datasets.some((d) => d.layers[kind.key])) continue

    const item = document.createElement('div')
    item.className = 'layer-item'
    item.append(
      toggle(kind.label, kindVisible.get(kind.key) ?? true, (v) => {
        kindVisible.set(kind.key, v)
        applyVisibility(kind.key)
      }),
    )

    const desc = document.createElement('p')
    desc.className = 'layer-desc'
    desc.textContent = kind.desc
    item.append(desc)

    if (kind.opacity) {
      const row = document.createElement('div')
      row.className = 'layer-opacity'
      const range = document.createElement('input')
      range.type = 'range'
      range.min = '0'
      range.max = '100'
      range.step = '5'
      range.value = String(Math.round((kindOpacity.get(kind.key) ?? 0.7) * 100))
      range.setAttribute('aria-label', `${kind.label}の不透明度`)
      const val = document.createElement('span')
      val.className = 'op-val'
      val.textContent = `${range.value}%`
      range.addEventListener('input', () => {
        kindOpacity.set(kind.key, Number(range.value) / 100)
        val.textContent = `${range.value}%`
        applyOpacity(kind.key)
      })
      row.append(range, val)
      item.append(row)
    }

    box.append(item)
  }
}

/** 地点（データセット）の一覧。公開されている地点が増えるとここに増える。 */
function buildDatasetList(): void {
  const box = $('datasets')
  for (const ds of index.datasets) {
    const item = document.createElement('div')
    item.className = 'layer-item ds-item'
    item.append(
      toggle(ds.name, datasetVisible.get(ds.id) ?? true, (v) => {
        datasetVisible.set(ds.id, v)
        for (const kind of LAYER_KINDS) applyVisibility(kind.key)
      }),
    )
    if (ds.bbox) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mini-btn'
      btn.textContent = '移動'
      btn.title = `${ds.name}の範囲に移動`
      btn.addEventListener('click', () => map.fitBounds(ds.bbox!, { padding: fitPadding }))
      item.append(btn)
    }
    box.append(item)
  }
}

/** 浸水深の凡例。塗りの色分けは gridcode 由来なので、layers.ts の定義から生成する。 */
function buildLegend(): void {
  const box = $('legend')
  for (const d of DEPTH_CLASSES) {
    const row = document.createElement('div')
    row.className = 'legend-row'
    const chip = document.createElement('span')
    chip.className = 'legend-chip'
    chip.style.background = d.color
    const label = document.createElement('span')
    label.textContent = d.label
    row.append(chip, label)
    box.append(row)
  }
}

/** 背景地図スイッチャー（右下）。 */
function buildBasemapSwitch(): void {
  const box = $('basemap')
  for (const key of Object.keys(BASEMAP_LABELS) as Basemap[]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = BASEMAP_LABELS[key]
    btn.setAttribute('aria-selected', String(key === base))
    btn.addEventListener('click', () => {
      if (base === key) return
      base = key
      for (const b of box.querySelectorAll('button')) {
        b.setAttribute('aria-selected', String(b === btn))
      }
      void applyStyle()
    })
    box.append(btn)
  }
}

function syncThemeBtn(): void {
  const btn = $('theme-btn')
  btn.textContent = theme === 'dark' ? '☀' : '☾'
  btn.title = theme === 'dark' ? 'ライトテーマへ' : 'ダークテーマへ'
}

/** データ取得時刻をJSTで出す。自動更新で中身が入れ替わるので、いつ時点のデータかを示す。 */
function formatUpdated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const jst = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
  return `${jst} JST`
}

buildLegend()
buildKindToggles()
buildDatasetList()
buildBasemapSwitch()
syncThemeBtn()

$('theme-btn').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark'
  applyThemeAttr(theme)
  syncThemeBtn()
  void applyStyle()
})

$('collapse-btn').addEventListener('click', () => {
  const panel = $('panel')
  panel.classList.toggle('collapsed')
  $('collapse-btn').textContent = panel.classList.contains('collapsed') ? '▾' : '▴'
})

$('data-updated').textContent = `データ取得: ${formatUpdated(index.updated)}`
$('build-ver').textContent = `build ${__BUILD_TIME__}`
