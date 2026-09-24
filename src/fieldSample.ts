/**
 * The forecast at one spot, read back from the frames the map is drawing.
 *
 * Clicking the Weather map used to do nothing unless an arrow or a storm was under the pointer, so
 * "what is forecast here?" had no answer short of reading colours off the key. This answers it
 * from the same PNGs the map shows — not from a second source that could disagree with them — by
 * finding the pixel under the click and matching its colour to the legend.
 *
 * What comes back is a legend **class**, a range such as 10–20 mm, never a single figure: the
 * frames hold classes, and inventing a number between the stops would be precision the file does
 * not contain.
 */

import { formatMMT } from './time'
import { frameUrl, type FieldLayer, type FieldModel, type FieldRun, type LegendStops } from './forecastField'

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

/**
 * The pixel under a point, or null outside the frame. Columns are linear in longitude; rows are
 * spaced in Web Mercator, because MapLibre stretches the image over its quad in Mercator — the
 * pipeline's `mercator_rows()` writes them that way, and this is its inverse.
 */
export function pixelAt(lon: number, lat: number, bbox: number[], size: number[]): [number, number] | null {
  const [w, s, e, n] = bbox
  const [width, height] = size
  if (lon < w || lon > e || lat < s || lat > n) return null
  const x = Math.min(width - 1, Math.floor(((lon - w) / (e - w)) * width))
  const y = Math.min(height - 1, Math.floor(((merc(n) - merc(lat)) / (merc(n) - merc(s))) * height))
  return [x, y]
}

/** Decoded frames, by URL. Frames are a few hundred bytes and immutable, so they are kept. */
const frames = new Map<string, Promise<ImageData | null>>()
const MAX_FRAMES = 600

function pixels(url: string): Promise<ImageData | null> {
  const hit = frames.get(url)
  if (hit) return hit
  const p = (async () => {
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d', { willReadFrequently: true })
      if (!g) return null
      g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, c.width, c.height)
    } catch {
      return null
    }
  })()
  if (frames.size >= MAX_FRAMES) frames.delete(frames.keys().next().value as string)
  frames.set(url, p)
  return p
}

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

/**
 * The legend class of one pixel: 0 for transparent (nothing forecast over the first stop), else
 * the 1-based stop whose colour is nearest. Nearest rather than exact, so a browser that colour-
 * manages the PNG by a unit or two still lands on the right stop.
 */
function classOf(data: ImageData, x: number, y: number, palette: number[][]): number {
  const i = (y * data.width + x) * 4
  if (data.data[i + 3] < 128) return 0
  let best = 0
  let bestD = Infinity
  palette.forEach(([r, g, b], k) => {
    const d = (data.data[i] - r) ** 2 + (data.data[i + 1] - g) ** 2 + (data.data[i + 2] - b) ** 2
    if (d < bestD) {
      bestD = d
      best = k + 1
    }
  })
  return best
}

export interface PointSeries {
  /** One entry per step of the run: when, and which class (0 = under the first stop). */
  steps: Array<{ t: string; cls: number }>
  /** The step on show, if the run covers it. */
  current: { t: string; cls: number } | null
}

/** Every step of a run at one point. Null when the point is outside the forecast grid. */
export async function seriesAt(
  base: string,
  model: FieldModel,
  run: FieldRun,
  layer: FieldLayer,
  legend: LegendStops,
  lon: number,
  lat: number,
  shown: string | null,
): Promise<PointSeries | null> {
  const px = pixelAt(lon, lat, model.bbox, model.size)
  if (!px) return null
  const palette = legend.stops.map(([, c]) => rgb(c))
  const steps = await Promise.all(
    run.steps.map(async (s) => {
      const url = frameUrl(base, s, layer)
      const data = url ? await pixels(url) : null
      return { t: s.valid, cls: data ? classOf(data, px[0], px[1], palette) : 0 }
    }),
  )
  return { steps, current: steps.find((s) => s.t === shown) ?? null }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** "10–20 mm / 3 h", "75 mm / 3 h and over", or "under 0.5 mm / 3 h". */
export function classRange(legend: LegendStops, cls: number, unit: string): string {
  if (cls <= 0) return `under ${legend.stops[0][0]} ${unit}`
  const lo = legend.stops[cls - 1][0]
  const hi = legend.stops[cls]?.[0]
  return hi !== undefined ? `${lo}–${hi} ${unit}` : `${lo} ${unit} and over`
}

/**
 * The popup: the class at the moment shown, the wettest step in the run, and a bar per step so
 * the whole week reads at a glance. Labelled a forecast, with its model and run time, like every
 * other surface that shows the field.
 */
export function seriesPopupHtml(opts: {
  series: PointSeries
  legend: LegendStops
  layer: FieldLayer
  modelLabel: string
  run: FieldRun
  lon: number
  lat: number
  cellDeg: number
}): string {
  const { series, legend, layer, modelLabel, run, lon, lat, cellDeg } = opts
  const unit = legend.unit.replace('% of 51 members', '% of members')
  const what = layer === 'precip' ? 'Rain in the 3 h to' : `Members over ${layer === 'prob25' ? 25 : 50} mm in the 3 h to`
  const n = legend.stops.length
  const peak = series.steps.reduce((a, b) => (b.cls > a.cls ? b : a), series.steps[0])
  const bars = series.steps
    .map((s) => {
      const colour = s.cls > 0 ? legend.stops[s.cls - 1][1] : 'transparent'
      const h = s.cls > 0 ? Math.round(18 + (82 * s.cls) / n) : 4
      const cur = series.current && s.t === series.current.t ? ' is-current' : ''
      return `<span class="pt-bar${cur}" style="height:${h}%;background:${colour}" title="${esc(`${formatMMT(s.t, { short: true })}: ${classRange(legend, s.cls, unit)}`)}"></span>`
    })
    .join('')
  const first = series.steps[0]?.t
  const last = series.steps[series.steps.length - 1]?.t
  const now = series.current
    ? `<p class="pt-now"><span>${esc(what)} ${esc(formatMMT(series.current.t, { short: true }))}</span><strong>${esc(classRange(legend, series.current.cls, unit))}</strong></p>`
    : `<p class="pt-now"><span>This run does not cover the moment on the timeline.</span></p>`
  const wettest =
    peak && peak.cls > 0
      ? `<p class="pt-peak">Heaviest in this run: <strong>${esc(classRange(legend, peak.cls, unit))}</strong>, ${esc(formatMMT(peak.t, { short: true }))}</p>`
      : `<p class="pt-peak">Nothing over ${esc(`${legend.stops[0][0]} ${unit}`)} at any step of this run.</p>`
  const init = run.init ? `run ${formatMMT(run.init, { short: true })}` : 'run time not published'
  return `<div class="pop-head">Forecast here</div>
<div class="pop-body pt">
  <p class="pt-where">${esc(modelLabel)} · ${esc(init)}<br>${lat.toFixed(2)}°N ${lon.toFixed(2)}°E · the ${cellDeg}° block around it (about ${Math.round(cellDeg * 111)} km)</p>
  ${now}
  <div class="pt-bars" role="img" aria-label="${esc(`${layer === 'precip' ? 'Rain' : 'Probability'} class at every step of the run`)}">${bars}</div>
  <div class="pt-axis"><span>${first ? esc(formatMMT(first, { short: true })) : ''}</span><span>${last ? esc(formatMMT(last, { short: true })) : ''}</span></div>
  ${wettest}
  <p class="pt-note">A forecast, not an observation. Ranges are the key's classes — the frames hold no finer figure.</p>
</div>`
}
