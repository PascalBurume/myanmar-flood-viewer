/**
 * The forecast at one spot, read back from the frames the map is drawing.
 *
 * Clicking the Weather map used to do nothing unless an arrow or a storm was under the pointer, so
 * "what is forecast here?" had no answer short of reading colours off the key. This answers it
 * from the same PNGs the map shows — not from a second source that could disagree with them — by
 * finding the pixel under the click and reading its class.
 *
 * What comes back is a legend **class**, a range such as 10–20 mm, never a single figure: the
 * frames hold classes, and inventing a number between the stops would be precision the file does
 * not contain.
 */

import { formatMMT } from './time'
import { fetchPng } from './png'
import { frameUrl, type FieldLayer, type FieldModel, type FieldRun, type LegendStops } from './forecastField'

export const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
export const unmerc = (y: number) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90

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

/**
 * A frame's legend classes, one byte per pixel, read from the PNG itself.
 *
 * Reading colours back through a canvas and matching them to the key worked only while the key's
 * colours were the ones baked into the file; a palette change would have misread every frame
 * already on disk. The index is the class by construction, whatever colour it was painted.
 */
export interface FrameClasses {
  width: number
  height: number
  /** Palette index per pixel — which *is* the class: the pipeline writes index 0 as transparent
   *  "nothing" and 1..N as the legend stops, in order. */
  idx: Uint8Array
}

/** A frame's palette indices, read from the file itself (see `png.ts` for why not a canvas). */
async function decodeIndices(url: string): Promise<FrameClasses | null> {
  const png = await fetchPng(url)
  if (!png || png.channels !== 1) return null
  return { width: png.width, height: png.height, idx: png.data }
}

/** Decoded frames, by URL. Frames are a few hundred bytes and immutable, so they are kept. */
const frames = new Map<string, Promise<FrameClasses | null>>()
const MAX_FRAMES = 600

export function frameClasses(url: string): Promise<FrameClasses | null> {
  const hit = frames.get(url)
  if (hit) return hit
  const p = decodeIndices(url).catch(() => null)
  if (frames.size >= MAX_FRAMES) frames.delete(frames.keys().next().value as string)
  frames.set(url, p)
  return p
}

export const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))

/** The class at one pixel, clamped to the legend in case a file ever carries more stops. */
export function classAt(f: FrameClasses, x: number, y: number, stops: number): number {
  return Math.min(f.idx[y * f.width + x] ?? 0, stops)
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
  const steps = await Promise.all(
    run.steps.map(async (s) => {
      const url = frameUrl(base, s, layer)
      const data = url ? await frameClasses(url) : null
      return { t: s.valid, cls: data ? classAt(data, px[0], px[1], legend.stops.length) : 0 }
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
  <p class="pt-note">A forecast, not an observation. It reads the model's sample, not the smoothed drawing, and ranges are the key's classes — the frames hold no finer figure.</p>
</div>`
}
