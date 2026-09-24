/**
 * The 3D view's flood scenes: what `scripts/build_scenes.py` writes, and the water drawn from it.
 *
 * A scene is a ~14 km window where the traced extents hold the most water. Its `water.png` carries,
 * per pixel, *when* on the scene's timeline the ground goes under (R) and when it drains (G), on a
 * scale where each satellite pass lands exactly on a whole step — so at every observed date the
 * water drawn is exactly the extent UNOSAT traced, and only the moments between are simulated.
 * The pipeline's docstring has the model; this file only reads it and paints it.
 */

import { useEffect, useState } from 'react'
import { fetchPng } from './png'

export interface SceneObservation {
  /** Position on the scene's timeline: observation k sits at T = k. */
  t: number
  date: string
  sensor: string
  layer: string
  waterKm2: number
  buildingsInWater: number
}

export interface Scene {
  id: string
  /** "south-east of Thanatpin" — bearing from the nearest township FloodAI reports. */
  name: string
  region: string
  dataset: string
  event: string
  product: string | null
  center: [number, number]
  bbox: [number, number, number, number]
  size: [number, number]
  pixelMetres: number
  /** Area of one pixel, km², exactly as the pipeline counted the observations' water. */
  pixelKm2: number
  /** Observations on the timeline, which therefore runs 0 → steps. */
  steps: number
  observations: SceneObservation[]
  buildings: { count: number; truncated: boolean }
  /** Where the most buildings stood in the water — the "houses" camera. Null when none did. */
  focus: [number, number] | null
  water: string
  buildingsFile: string
}

export interface SceneIndex {
  generatedAt: string
  note: string
  sources: { extents: string; terrain: string; buildings: string }
  rasterZoom: number
  scenes: Scene[]
}

/** The index, fetched only once the 3D view is asked for. Absent is not an error. */
export function useSceneIndex(base: string, enabled: boolean): SceneIndex | null {
  const [doc, setDoc] = useState<SceneIndex | null>(null)
  useEffect(() => {
    if (!enabled || doc) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/scenes/index.json`)
        if (!res.ok) return
        const d = (await res.json()) as SceneIndex
        if (!cancelled && Array.isArray(d.scenes)) setDoc(d)
      } catch {
        /* no scenes: the 3D view still shows the country */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, enabled, doc])
  return doc
}

/** Byte value for a moment on the timeline — the same rounding the pipeline used. */
export const NEVER = 255
export function stepByte(t: number, steps: number): number {
  return (t / steps) * 254
}

export interface SceneData {
  scene: Scene
  width: number
  height: number
  on: Uint8Array
  off: Uint8Array
  shade: Uint8Array
  buildings: GeoJSON.FeatureCollection
  bOn: Uint8Array
  bOff: Uint8Array
}

/**
 * A nominal height for a footprint that has none, by its area. The footprints carry no heights in
 * Myanmar; this is drawing, and the legend says so. Small houses read as one storey, large
 * compounds as two or three.
 */
function nominalHeight(areaM2: number): number {
  return Math.max(3.2, Math.min(12, 2.6 + Math.sqrt(areaM2) / 4))
}

export async function loadScene(base: string, scene: Scene): Promise<SceneData | null> {
  const [png, bres] = await Promise.all([fetchPng(`${base}data/${scene.water}`), fetch(`${base}data/${scene.buildingsFile}`)])
  if (!png || png.channels !== 3 || !bres.ok) return null
  const n = png.width * png.height
  const on = new Uint8Array(n)
  const off = new Uint8Array(n)
  const shade = new Uint8Array(n)
  for (let p = 0; p < n; p++) {
    on[p] = png.data[p * 3]
    off[p] = png.data[p * 3 + 1]
    shade[p] = png.data[p * 3 + 2]
  }
  const doc = (await bres.json()) as { origin: [number, number]; unit: number; b: Array<[number, number, number[]]> }
  const [ox, oy] = doc.origin
  const u = doc.unit
  const mPerDegY = 110570
  const mPerDegX = 111320 * Math.cos((scene.center[1] * Math.PI) / 180)
  const features: GeoJSON.Feature[] = []
  const bOn = new Uint8Array(doc.b.length)
  const bOff = new Uint8Array(doc.b.length)
  doc.b.forEach(([o, f, c], i) => {
    let x = c[0]
    let y = c[1]
    const ring: number[][] = [[ox + x * u, oy + y * u]]
    for (let k = 2; k < c.length; k += 2) {
      x += c[k]
      y += c[k + 1]
      ring.push([ox + x * u, oy + y * u])
    }
    ring.push(ring[0])
    let a = 0
    for (let k = 0; k < ring.length - 1; k++) {
      a += ring[k][0] * mPerDegX * (ring[k + 1][1] * mPerDegY) - ring[k + 1][0] * mPerDegX * (ring[k][1] * mPerDegY)
    }
    bOn[i] = o
    bOff[i] = f
    features.push({
      type: 'Feature',
      id: i,
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { on: o, off: f, h: Math.round(nominalHeight(Math.abs(a) / 2) * 10) / 10 },
    })
  })
  return {
    scene,
    width: png.width,
    height: png.height,
    on,
    off,
    shade,
    buildings: { type: 'FeatureCollection', features },
    bOn,
    bOff,
  }
}

/** How much of the timeline, in byte units, a front of new water glows for while playing. */
const FOAM = 5
/** Output pixels per scene pixel, each way. */
const SUPERSAMPLE = 2

/**
 * Paints a scene's water at a moment onto a canvas the map drapes over the terrain.
 *
 * The scene holds one on/off pair per ~18 m pixel. Drawn one-for-one the shoreline was a staircase
 * at street zoom, so the canvas is twice as fine and each output pixel takes the *wetness* of the
 * four scene pixels around it, bilinearly: the shore falls where that crosses one half, with a
 * short alpha ramp across it for anti-aliasing. The wet area is still counted on the scene's own
 * pixels, so the readout matches the observations' figures to the pixel.
 *
 * Colour follows distance from the shore (the `shade` channel) — deeper-looking in the middle of a
 * sheet of water, bright at its edge — which is drawing, not depth; no depth is claimed anywhere.
 * While the simulation plays, water that has only just arrived is lit as a moving front. Paused,
 * nothing is added: an observed frame shows exactly the observed extent and no decoration.
 */
export class WaterPainter {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly img: ImageData
  private readonly lut: Uint8ClampedArray
  private readonly wet: Uint8Array
  private readonly foam: Uint8Array
  private readonly cols: { x0: Int32Array; x1: Int32Array; fx: Float32Array; xn: Int32Array }
  private readonly rows: { y0: Int32Array; y1: Int32Array; fy: Float32Array; yn: Int32Array }

  constructor(private readonly data: SceneData) {
    const W = data.width
    const H = data.height
    this.canvas = document.createElement('canvas')
    this.canvas.width = W * SUPERSAMPLE
    this.canvas.height = H * SUPERSAMPLE
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('no 2D canvas')
    this.ctx = ctx
    this.img = ctx.createImageData(this.canvas.width, this.canvas.height)
    this.wet = new Uint8Array(W * H)
    this.foam = new Uint8Array(W * H)
    // Where each output column and row samples the scene grid — the same every frame.
    const axis = (n: number) => {
      const m = n * SUPERSAMPLE
      const a0 = new Int32Array(m)
      const a1 = new Int32Array(m)
      const f = new Float32Array(m)
      const near = new Int32Array(m)
      for (let i = 0; i < m; i++) {
        const u = (i + 0.5) / SUPERSAMPLE - 0.5
        const lo = Math.max(0, Math.min(n - 1, Math.floor(u)))
        a0[i] = lo
        a1[i] = Math.min(n - 1, lo + 1)
        f[i] = Math.max(0, Math.min(1, u - lo))
        near[i] = Math.max(0, Math.min(n - 1, Math.round(u)))
      }
      return { a0, a1, f, near }
    }
    const c = axis(W)
    const r = axis(H)
    this.cols = { x0: c.a0, x1: c.a1, fx: c.f, xn: c.near }
    this.rows = { y0: r.a0, y1: r.a1, fy: r.f, yn: r.near }
    // Shore → open water: a bright, clear teal at the edge deepening to a dense blue.
    const shore = [96, 196, 230]
    const open = [18, 72, 150]
    this.lut = new Uint8ClampedArray(256 * 4)
    for (let s = 0; s < 256; s++) {
      const t = Math.pow(s / 255, 0.6)
      this.lut[s * 4] = shore[0] + (open[0] - shore[0]) * t
      this.lut[s * 4 + 1] = shore[1] + (open[1] - shore[1]) * t
      this.lut[s * 4 + 2] = shore[2] + (open[2] - shore[2]) * t
      this.lut[s * 4 + 3] = 150 + 90 * t
    }
  }

  /** Paint moment `t` (0 → steps); returns the wet pixel count on the scene's own grid. */
  paint(t: number, density: number, playing: boolean): number {
    const { on, off, shade, width: W } = this.data
    const q = stepByte(t, this.data.scene.steps)
    const wet = this.wet
    const foam = this.foam
    let count = 0
    for (let p = 0; p < on.length; p++) {
      const a = on[p]
      if (a <= q && q < off[p]) {
        wet[p] = 255
        count++
        foam[p] = playing && q - a < FOAM ? Math.round((1 - (q - a) / FOAM) * 255) : 0
      } else {
        wet[p] = 0
      }
    }
    const px = this.img.data
    const lut = this.lut
    const { x0, x1, fx, xn } = this.cols
    const { y0, y1, fy, yn } = this.rows
    const OW = this.canvas.width
    const OH = this.canvas.height
    for (let j = 0, k = 0; j < OH; j++) {
      const ra = y0[j] * W
      const rb = y1[j] * W
      const rn = yn[j] * W
      const vy = fy[j]
      for (let i = 0; i < OW; i++, k += 4) {
        const a = wet[ra + x0[i]]
        const b = wet[ra + x1[i]]
        const c = wet[rb + x0[i]]
        const d = wet[rb + x1[i]]
        if ((a | b | c | d) === 0) {
          px[k + 3] = 0
          continue
        }
        const ux = fx[i]
        const w = ((a * (1 - ux) + b * ux) * (1 - vy) + (c * (1 - ux) + d * ux) * vy) / 255
        if (w < 0.35) {
          px[k + 3] = 0
          continue
        }
        const edge = w >= 0.65 ? 1 : (w - 0.35) / 0.3
        const pn = rn + xn[i]
        const s = shade[pn] * 4
        let r = lut[s]
        let g = lut[s + 1]
        let bl = lut[s + 2]
        let alpha = lut[s + 3]
        const f = foam[pn]
        if (f) {
          const ff = f / 255
          r += (235 - r) * ff
          g += (250 - g) * ff
          bl += (255 - bl) * ff
          alpha += (255 - alpha) * ff
        }
        px[k] = r
        px[k + 1] = g
        px[k + 2] = bl
        px[k + 3] = alpha * density * edge
      }
    }
    this.ctx.putImageData(this.img, 0, 0)
    return count
  }

  /** Buildings the water reaches at `t`, by the same rule as the pixels. */
  buildingsReached(t: number): number {
    const q = stepByte(t, this.data.scene.steps)
    const { bOn, bOff } = this.data
    let n = 0
    for (let i = 0; i < bOn.length; i++) if (bOn[i] <= q && q < bOff[i]) n++
    return n
  }
}

/** The observation a moment is, if it is one — otherwise the moment is simulated. */
export function observationAt(scene: Scene, t: number): SceneObservation | null {
  return scene.observations.find((o) => Math.abs(o.t - t) < 1e-6) ?? null
}

export function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
