import type { ExpressionSpecification, LayerSpecification, SourceSpecification } from 'maplibre-gl'

/** 浸水深の区分。dbf の gridcode（1〜4）と浸水深（文字列）が 1:1 で対応している。 */
export interface DepthClass {
  code: number
  label: string
  color: string
}

// 洪水浸水想定区域図の法定色ではなく青系の連続配色を使う。
// これは公表されたハザードマップではなく SNS 写真からの「推定」であり、
// 法定図と同じ色で描くと同等の根拠があるものと誤解されるため。
export const DEPTH_CLASSES: DepthClass[] = [
  { code: 1, label: '0.5m未満', color: '#c6dbef' },
  { code: 2, label: '0.5m以上1m未満', color: '#6baed6' },
  { code: 3, label: '1m以上2m未満', color: '#2171b5' },
  { code: 4, label: '2m以上', color: '#08306b' },
]

/**
 * gridcode → 色 の match 式。区分外は灰色にして取りこぼしを目視で気付けるようにする。
 * 区分を配列から展開する都合でタプル型が保てないため、式仕様へは明示的にキャストする。
 */
const depthColorExpr = [
  'match',
  ['get', 'gridcode'],
  ...DEPTH_CLASSES.flatMap((d) => [d.code, d.color]),
  '#9aa0a6',
] as unknown as ExpressionSpecification

export const ATTRIBUTION =
  '推定浸水域: <a href="https://mizu.bosai.go.jp/key/20260813" target="_blank" rel="noopener">防災科研 水・土砂防災研究部門</a>'

export function sources(base: string): Record<string, SourceSpecification> {
  return {
    floodarea: { type: 'geojson', data: `${base}data/floodarea.geojson`, attribution: ATTRIBUTION },
    inputarea: { type: 'geojson', data: `${base}data/inputarea.geojson`, attribution: ATTRIBUTION },
    inputpoint: { type: 'geojson', data: `${base}data/inputpoint.geojson`, attribution: ATTRIBUTION },
  }
}

/** パネルのトグル1つに対応するレイヤー群。 */
export interface LayerGroup {
  key: string
  label: string
  desc: string
  /** 不透明度スライダーを出すか（塗りのある浸水域のみ） */
  opacity: boolean
  /** クリックでポップアップを出す対象レイヤーID */
  queryIds: string[]
  layers: LayerSpecification[]
}

export const GROUPS: LayerGroup[] = [
  {
    key: 'floodarea',
    label: '推定浸水域',
    desc: 'SNS写真から推定した浸水深の分布。速報値であり、実際の浸水範囲・浸水深とは異なる場合があります。',
    opacity: true,
    queryIds: ['floodarea-fill'],
    layers: [
      {
        id: 'floodarea-fill',
        type: 'fill',
        source: 'floodarea',
        paint: {
          'fill-color': depthColorExpr,
          'fill-opacity': 0.7,
        },
      } as LayerSpecification,
      {
        id: 'floodarea-outline',
        type: 'line',
        source: 'floodarea',
        paint: {
          'line-color': depthColorExpr,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.3, 17, 1.2],
          'line-opacity': 0.9,
        },
      } as LayerSpecification,
    ],
  },
  {
    key: 'inputarea',
    label: '推定に使った範囲',
    desc: '浸水深の推定計算を行った対象範囲。この枠の外は計算していないため、浸水がなかったことを意味しません。',
    opacity: false,
    queryIds: [],
    layers: [
      {
        id: 'inputarea-line',
        type: 'line',
        source: 'inputarea',
        paint: {
          'line-color': '#e5533d',
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      } as LayerSpecification,
    ],
  },
  {
    key: 'inputpoint',
    label: '参照地点',
    desc: 'SNS写真から浸水深を読み取った地点。ここでの実測相当値を起点に周囲の浸水深を推定しています。',
    opacity: false,
    queryIds: ['inputpoint-circle'],
    layers: [
      {
        id: 'inputpoint-circle',
        type: 'circle',
        source: 'inputpoint',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 4, 17, 8],
          'circle-color': '#ffd400',
          'circle-stroke-color': '#333333',
          'circle-stroke-width': 1.5,
        },
      } as LayerSpecification,
    ],
  },
]

export const QUERY_LAYER_IDS = GROUPS.flatMap((g) => g.queryIds)

const LABEL_OF: Record<string, string> = {
  'floodarea-fill': '推定浸水域',
  'inputpoint-circle': '参照地点',
}

/** 同じ場所に重なった地物は最大でこの数まで並べる。 */
export const POPUP_MAX_ITEMS = 8

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  // inputpoint の浸水深は数値（m）。単位を補って浸水域側の表記と読み比べられるようにする。
  if (key === '浸水深' && typeof value === 'number') return `${value} m`
  return String(value)
}

export function popupHtml(
  features: { layer: { id: string }; properties: Record<string, unknown> | null }[],
): string {
  const items = features.slice(0, POPUP_MAX_ITEMS).map((f) => {
    const props = f.properties ?? {}
    const rows = Object.entries(props)
      // gridcode は浸水深の区分番号そのもので、隣に出す浸水深の文字列と重複するため隠す
      .filter(([k]) => k !== 'gridcode')
      .map(
        ([k, v]) =>
          `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(formatValue(k, v))}</td></tr>`,
      )
      .join('')
    const head = LABEL_OF[f.layer.id] ?? f.layer.id
    return `<div class="pop-item"><p class="pop-item-head">${escapeHtml(head)}</p><table class="pop-tbl">${rows || '<tr><td>属性なし</td></tr>'}</table></div>`
  })
  const more =
    features.length > POPUP_MAX_ITEMS
      ? `<p class="pop-item-head">ほか ${features.length - POPUP_MAX_ITEMS} 件</p>`
      : ''
  return `<div class="pop-head">地物情報</div><div class="pop-body">${items.join('')}${more}</div>`
}
