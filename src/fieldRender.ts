/**
 * The forecast field drawn as a continuous surface rather than as blocks.
 *
 * The frames hold one legend class per sample, 0.5° apart (1° for the ensemble). Drawn as they
 * are, nearest-neighbour, the field reads as a mosaic of 55 km squares, and a reader who has seen
 * Google Weather Lab asked for rain that looks like rain. So the classes are interpolated between
 * sample centres — bilinearly, in the frame's own Mercator space — onto an image ten times finer,
 * and cut back into the same classes. The result has the contoured, organic edges of Weather Lab's
 * rain with exactly the palette and the classes the key shows; nothing is invented past the
 * samples except where between them a boundary falls.
 *
 * That is still a drawing choice with a cost, and it is said where the field is described: the
 * shapes finer than 55 km are drawn, not forecast. "Blocks" draws the samples themselves, and is
 * one click away.
 *
 * Both styles are drawn here, from the frames' palette indices and the manifest's colours. The
 * index is the class by construction, so the key's colours can change without misreading any frame
 * already on disk — and Blocks then shows the same colours as Smooth and the key, rather than
 * whatever palette was current when the file was written.
 *
 * Everything runs from the PNGs already on disk: no refetch, and runs written before this existed
 * render the same way.
 */

import { classAt, frameClasses, merc, pixelAt, rgb, unmerc, type FrameClasses } from './fieldSample'
import type { FieldModel, LegendStops } from './forecastField'

export type FieldStyle = 'smooth' | 'grid'

/** Output pixels per sample, each way. Ten keeps a 0.5° cell's edge smooth at the zooms used;
 *  blocks need only enough to keep their edges on the cell boundaries. */
const UPSAMPLE = { smooth: 10, grid: 4 } as const
/**
 * Samples over which the grid's own edge fades. The forecast covers a rectangle, 92–102°E by
 * 9.5–28.5°N, and at three-quarters of a sample the fade still read as a ruled line down the Bay
 * of Bengal. Two samples (1° on the main grid) turn the rectangle into a vignette. What it softens
 * lies outside Myanmar on every side, and the point forecast still reads the full value there.
 */
const EDGE_FADE = 2
/** Drizzle is drawn lighter, the way Weather Lab lets the lightest rain recede. */
const FIRST_CLASS_ALPHA = 0.8

/** The class at each sample centre, north→south by west→east, read from a frame's pixels. */
function sampleGrid(data: FrameClasses, model: FieldModel, legend: LegendStops) {
  const [w, s, e, n] = model.bbox
  const cols = model.size[0]
  const cell = (e - w) / cols
  const rows = Math.round((n - s) / cell)
  const grid = new Float32Array(rows * cols)
  for (let r = 0; r < rows; r++) {
    const lat = n - (r + 0.5) * cell
    for (let c = 0; c < cols; c++) {
      const px = pixelAt(w + (c + 0.5) * cell, lat, model.bbox, model.size)
      grid[r * cols + c] = px ? classAt(data, px[0], px[1], legend.stops.length) : 0
    }
  }
  return { grid, rows, cols, cell }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Draw one frame in a style; resolves to an object URL of the PNG. */
async function draw(url: string, model: FieldModel, legend: LegendStops, style: FieldStyle): Promise<string | null> {
  const data = await frameClasses(url)
  if (!data) return null
  const { grid, rows, cols, cell } = sampleGrid(data, model, legend)
  const [, s, , n] = model.bbox
  const W = cols * UPSAMPLE[style]
  const H = rows * UPSAMPLE[style]
  const colours = legend.stops.map(([, c]) => rgb(c))
  const top = colours.length

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const g = canvas.getContext('2d')
  if (!g) return null
  const out = g.createImageData(W, H)
  const px = out.data
  const yN = merc(n)
  const yS = merc(s)

  for (let j = 0; j < H; j++) {
    // Output rows are Mercator-spaced, like the frame's, because MapLibre stretches the image over
    // its quad in Mercator; the fractional sample row is then found in degrees.
    const lat = unmerc(yN - ((j + 0.5) / H) * (yN - yS))
    const rf = (n - lat) / cell - 0.5
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(rf)))
    const r1 = Math.min(rows - 1, r0 + 1)
    const fr = clamp01(rf - r0)
    const edgeR = Math.min(rf + 0.5, rows - 0.5 - rf)
    const rn = Math.max(0, Math.min(rows - 1, Math.round(rf)))
    for (let i = 0; i < W; i++) {
      const cf = ((i + 0.5) / W) * cols - 0.5
      if (style === 'grid') {
        // The sample itself, square: the honest drawing, in the key's colours.
        const cls = Math.min(top, grid[rn * cols + Math.max(0, Math.min(cols - 1, Math.round(cf)))])
        if (cls <= 0) continue
        const [R, G, B] = colours[cls - 1]
        const k = (j * W + i) * 4
        px[k] = R
        px[k + 1] = G
        px[k + 2] = B
        px[k + 3] = 255
        continue
      }
      const c0 = Math.max(0, Math.min(cols - 1, Math.floor(cf)))
      const c1 = Math.min(cols - 1, c0 + 1)
      const fc = clamp01(cf - c0)
      const v =
        (grid[r0 * cols + c0] * (1 - fc) + grid[r0 * cols + c1] * fc) * (1 - fr) +
        (grid[r1 * cols + c0] * (1 - fc) + grid[r1 * cols + c1] * fc) * fr
      // Cut back into the key's classes halfway between them, so every colour on the map is one
      // the key shows; the outermost edge gets a short ramp instead of a stair-step.
      const cls = Math.min(top, Math.floor(v + 0.5))
      if (cls <= 0) continue
      const edge = Math.min(edgeR, Math.min(cf + 0.5, cols - 0.5 - cf))
      let a = cls === 1 ? FIRST_CLASS_ALPHA : 1
      a *= clamp01((v - 0.5) / 0.18 + 0.35)
      a *= clamp01(edge / EDGE_FADE)
      const [R, G, B] = colours[cls - 1]
      const k = (j * W + i) * 4
      px[k] = R
      px[k + 1] = G
      px[k + 2] = B
      px[k + 3] = Math.round(a * 255)
    }
  }
  g.putImageData(out, 0, 0)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  return blob ? URL.createObjectURL(blob) : null
}

/** Drawn frames by source URL. Bounded; an evicted frame's object URL is released. */
const drawn = new Map<string, Promise<string | null>>()
const MAX_DRAWN = 240

/** A frame drawn in a style, once, and kept. Null if it could not be drawn. */
export function drawnFrame(url: string, model: FieldModel, legend: LegendStops, style: FieldStyle): Promise<string | null> {
  const key = `${url}|${style}|${legend.stops.map(([v, c]) => `${v}${c}`).join()}`
  const hit = drawn.get(key)
  if (hit) return hit
  if (drawn.size >= MAX_DRAWN) {
    const [oldKey, old] = drawn.entries().next().value as [string, Promise<string | null>]
    drawn.delete(oldKey)
    // Released a little later, so a swap already under way with it can still complete.
    void old.then((u) => u && window.setTimeout(() => URL.revokeObjectURL(u), 5000))
  }
  const p = draw(url, model, legend, style).catch(() => null)
  drawn.set(key, p)
  return p
}

/** What the image source should load for a frame in a style: the drawn surface, or the frame. */
export async function frameSource(
  url: string,
  style: FieldStyle,
  model: FieldModel | null,
  legend: LegendStops | null,
): Promise<string> {
  if (model && legend) {
    const u = await drawnFrame(url, model, legend, style)
    if (u) return u
  }
  // A frame that could not be drawn: the file itself, decoded so the swap is a cache hit.
  const img = new Image()
  img.src = url
  await img.decode().catch(() => undefined)
  return url
}
