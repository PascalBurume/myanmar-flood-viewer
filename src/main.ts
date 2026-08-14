import maplibregl from 'maplibre-gl'
import { Protocol } from 'pmtiles'
import 'maplibre-gl/dist/maplibre-gl.css'

import { getBasemapStyle, BASEMAP_LABELS, type Basemap } from './basemap'
import {
  DEPTH_CLASSES,
  GROUPS,
  QUERY_LAYER_IDS,
  popupHtml,
  sources,
} from './layers'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import './style.css'

let theme: Theme = initialTheme()
let base: Basemap = 'pale'
applyThemeAttr(theme)

// 地理院 最適化ベクトルタイルは PMTiles 単一ファイル配信のため、プロトコル登録が要る。
maplibregl.addProtocol('pmtiles', new Protocol().tile)

/** トグルとスライダーの状態。背景地図を切り替えるとスタイルごと差し替わるため、ここに持って復元する。 */
const visible = new Map<string, boolean>(GROUPS.map((g) => [g.key, true]))
const opacity = new Map<string, number>(GROUPS.map((g) => [g.key, 0.7]))

const map = new maplibregl.Map({
  container: 'map',
  style: await getBasemapStyle(base, theme),
  // 大網白里市・JR大網駅周辺（推定浸水域の重心付近）
  center: [140.3095, 35.5268],
  zoom: 13.6,
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
  const src = sources(import.meta.env.BASE_URL)
  for (const [id, spec] of Object.entries(src)) {
    if (!map.getSource(id)) map.addSource(id, spec)
  }
  const before = firstSymbolId()
  for (const group of GROUPS) {
    for (const layer of group.layers) {
      if (map.getLayer(layer.id)) continue
      map.addLayer(layer, before)
    }
    applyVisibility(group.key)
    applyOpacity(group.key)
  }
}

function applyVisibility(key: string): void {
  const group = GROUPS.find((g) => g.key === key)
  if (!group) return
  const v = visible.get(key) ? 'visible' : 'none'
  for (const layer of group.layers) {
    if (map.getLayer(layer.id)) map.setLayoutProperty(layer.id, 'visibility', v)
  }
}

function applyOpacity(key: string): void {
  const group = GROUPS.find((g) => g.key === key)
  if (!group?.opacity) return
  const o = opacity.get(key) ?? 0.7
  for (const layer of group.layers) {
    if (!map.getLayer(layer.id)) continue
    // 塗りと縁取りで paint プロパティ名が違う。縁取りは薄くしすぎると境界を見失うため下限を設ける。
    if (layer.type === 'fill') map.setPaintProperty(layer.id, 'fill-opacity', o)
    else if (layer.type === 'line') map.setPaintProperty(layer.id, 'line-opacity', Math.max(o, 0.4))
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
  const ids = QUERY_LAYER_IDS.filter((id) => map.getLayer(id))
  const features = map.queryRenderedFeatures(e.point, { layers: ids })
  if (!features.length) {
    popup.remove()
    return
  }
  popup.setLngLat(e.lngLat).setHTML(popupHtml(features)).addTo(map)
})

map.on('mouseenter', 'floodarea-fill', () => {
  map.getCanvas().style.cursor = 'pointer'
})
map.on('mouseleave', 'floodarea-fill', () => {
  map.getCanvas().style.cursor = ''
})

// ---- パネル UI ----

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** レイヤートグル（＋不透明度スライダー）を組み立てる。 */
function buildLayerToggles(): void {
  const box = $('layers')
  for (const group of GROUPS) {
    const item = document.createElement('div')
    item.className = 'layer-item'

    const label = document.createElement('label')
    label.className = 'toggle'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = visible.get(group.key) ?? true
    cb.addEventListener('change', () => {
      visible.set(group.key, cb.checked)
      applyVisibility(group.key)
    })
    const sw = document.createElement('span')
    sw.className = 'switch'
    const text = document.createElement('span')
    text.className = 't-label'
    text.textContent = group.label
    label.append(cb, sw, text)

    const desc = document.createElement('p')
    desc.className = 'layer-desc'
    desc.textContent = group.desc

    item.append(label, desc)

    if (group.opacity) {
      const row = document.createElement('div')
      row.className = 'layer-opacity'
      const range = document.createElement('input')
      range.type = 'range'
      range.min = '0'
      range.max = '100'
      range.step = '5'
      range.value = String(Math.round((opacity.get(group.key) ?? 0.7) * 100))
      range.setAttribute('aria-label', `${group.label}の不透明度`)
      const val = document.createElement('span')
      val.className = 'op-val'
      val.textContent = `${range.value}%`
      range.addEventListener('input', () => {
        opacity.set(group.key, Number(range.value) / 100)
        val.textContent = `${range.value}%`
        applyOpacity(group.key)
      })
      row.append(range, val)
      item.append(row)
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

buildLayerToggles()
buildLegend()
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

$('build-ver').textContent = `build ${__BUILD_TIME__}`
