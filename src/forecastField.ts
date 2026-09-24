/**
 * The gridded forecast field: what `scripts/scan_forecast_field.py` writes, and what is drawn from it.
 *
 * The pipeline writes small paletted PNGs — one per model run per three-hour step — and the map
 * shows them through a MapLibre `image` source, one frame at a time. The palette comes from the
 * manifest, never from here: pixels and the key on the map are the same table, so they cannot drift.
 *
 * Everything in this file is a **forecast**. The panel says so, the legend says so, and the
 * timeline badges it — the viewer's other layers are all observations of something that already
 * happened, and a reader cannot tell the two apart unless told.
 */

import { useEffect, useState } from 'react'
import type { FieldStyle } from './fieldRender'

export type FieldLayer = 'precip' | 'prob25' | 'prob50' | 'wind'
export type FieldModelKey = 'ecmwf' | 'gfs' | 'icon' | 'weathernext'

/** What a frame holds, read back from its own pixels by the pipeline. */
export interface FrameStats {
  /** Highest legend class anywhere on the frame: 0 is nothing drawn, 1 is the first stop. */
  peak: number
  /** Share of the frame's area with any class at all, 0–1. */
  wet: number
}

export interface FieldStep {
  /** Lead hours from the run's init — or, for a model that publishes none, from the fetch. */
  h: number
  valid: string
  precip?: string
  prob25?: string
  prob50?: string
  /** Absent for a manifest written before the pipeline recorded it. */
  stats?: Partial<Record<'precip' | 'prob25' | 'prob50', FrameStats>>
}

export interface FieldRun {
  key: string
  /** The model run's initialisation time, where the model publishes one. */
  init: string | null
  fetchedAt: string
  steps: FieldStep[]
  wind?: string
  points: string
}

export interface FieldModel {
  key: string
  label: string
  source: string
  initPublished: boolean
  layers: string[]
  bbox: number[]
  size: number[]
  members?: number
  runs: FieldRun[]
}

export interface LegendStops {
  unit: string
  stops: Array<[number, string]>
  note?: string
}

export interface FieldManifest {
  generatedAt: string
  attribution: string
  note: string
  stepHours: number
  grid: { west: number; south: number; east: number; north: number; step: number; cols: number; rows: number }
  projection: string
  legends: { precip3h: LegendStops; prob: LegendStops; wind: { unit: string; note?: string } }
  models: FieldModel[]
}

export interface WindDoc {
  lats: number[]
  lons: number[]
  unit: string
  /** 'from' — meteorological convention. The arrow is rotated 180° to point downwind. */
  directionIs: string
  steps: Array<{ h: number; valid: string; kmh: number[]; dir: number[] }>
}

/** What the map is showing of the field. */
export interface FieldState {
  manifest: FieldManifest | null
  on: boolean
  model: FieldModelKey
  /** A run key, or null for the newest run of the selected model. */
  run: string | null
  layer: FieldLayer
  opacity: number
  /** Smooth surface or the raw blocks — a drawing choice only; the data is the same. */
  style: FieldStyle
  wind: WindDoc | null
}

/**
 * The models offered in the panel. WeatherNext 3 is listed and disabled: a reader who has seen
 * Google's Weather Lab should learn here what this viewer is missing and why, rather than wonder
 * whether they missed a control. Its reason is filled in from the pipeline's own stage detail.
 */
export const FIELD_MODELS: Array<{ key: FieldModelKey; label: string; desc: string; needs?: string }> = [
  { key: 'ecmwf', label: 'ECMWF IFS 0.25°', desc: 'The European model, and the one baseline everyone else is measured against. The only one here that publishes its run time.' },
  { key: 'gfs', label: 'GFS 0.25°', desc: 'The American model (NOAA). Open-Meteo publishes no run time for it, so the initialisation is not shown rather than guessed.' },
  { key: 'icon', label: 'ICON', desc: 'The German model (DWD). No published run time either.' },
  { key: 'weathernext', label: 'WeatherNext 3', desc: 'Google DeepMind’s AI model, 64 members.', needs: 'not configured' },
]

export const FIELD_LAYERS: Array<{ key: FieldLayer; label: string; desc: string; model?: string }> = [
  { key: 'precip', label: 'Precipitation', desc: 'Rain forecast for each three-hour step, sampled every 0.5° (about 55 km) from a 0.25° model.' },
  { key: 'prob25', label: 'Probability > 25 mm / 3 h', desc: 'Share of the 51 ECMWF ensemble members forecasting more than 25 mm in the step. A spread of opinion, not a calibrated chance.', model: 'ecmwf-ens' },
  { key: 'prob50', label: 'Probability > 50 mm / 3 h', desc: 'The same for 50 mm — the amount that turns a wet day into a flooding one.', model: 'ecmwf-ens' },
  { key: 'wind', label: 'Wind 10 m', desc: 'Arrows point the way the wind is blowing, sized by speed. Sampled every 1°.' },
]

/** Which model entry a layer is drawn from: the probability layers come from the ensemble. */
export function modelForLayer(model: FieldModelKey, layer: FieldLayer): string {
  return layer === 'prob25' || layer === 'prob50' ? 'ecmwf-ens' : model
}

export function findModel(manifest: FieldManifest | null, key: string): FieldModel | null {
  return manifest?.models.find((m) => m.key === key) ?? null
}

/** The runs available for a model and layer, newest first. */
export function runsFor(manifest: FieldManifest | null, model: FieldModelKey, layer: FieldLayer): FieldRun[] {
  return findModel(manifest, modelForLayer(model, layer))?.runs ?? []
}

export function activeRun(manifest: FieldManifest | null, state: FieldState): FieldRun | null {
  const runs = runsFor(manifest, state.model, state.layer)
  return (state.run ? runs.find((r) => r.key === state.run) : null) ?? runs[0] ?? null
}

/** Fetch the manifest. Absent means the pipeline has not run the stage — not an error. */
export function useForecastField(base: string, reload = 0): FieldManifest | null {
  const [doc, setDoc] = useState<FieldManifest | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/field/manifest.json?v=${reload}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = (await res.json()) as FieldManifest
        if (!cancelled && Array.isArray(d.models)) setDoc(d)
      } catch {
        /* the map works without a forecast field */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, reload])
  return doc
}

/**
 * Fetch the wind file for a run. One file per run rather than one per step: 55 GeoJSON files a run
 * would be tens of megabytes, and the arrows are trivial to build here from plain numbers.
 */
export function useWindDoc(base: string, run: FieldRun | null, enabled: boolean): WindDoc | null {
  const path = enabled ? run?.wind ?? null : null
  const [doc, setDoc] = useState<WindDoc | null>(null)
  useEffect(() => {
    if (!path) {
      setDoc(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/field/${path}`)
        if (!res.ok) return
        const d = (await res.json()) as WindDoc
        if (!cancelled) setDoc(d)
      } catch {
        /* no arrows, rest of the map unaffected */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, path])
  return doc
}

/** The step nearest a moment, or null outside the run — nothing is drawn for a time it does not cover. */
export function nearestStep(run: FieldRun | null, t: string | null, stepHours = 3): FieldStep | null {
  if (!run || !run.steps.length) return null
  if (!t) return run.steps[0]
  const target = Date.parse(t)
  let best: FieldStep | null = null
  let bestDt = Infinity
  for (const s of run.steps) {
    const dt = Math.abs(Date.parse(s.valid) - target)
    if (dt < bestDt) {
      best = s
      bestDt = dt
    }
  }
  return bestDt <= stepHours * 3600 * 1000 ? best : null
}

/** Run directories are written once and deleted when they age out, so no version stamp is needed. */
export function frameUrl(base: string, step: FieldStep, layer: FieldLayer): string | null {
  const path = layer === 'wind' ? null : step[layer as 'precip' | 'prob25' | 'prob50']
  return path ? `${base}data/field/${path}` : null
}

export function fieldFrames(run: FieldRun | null): Array<{ t: string; isForecast: boolean }> {
  return (run?.steps ?? []).map((s) => ({ t: s.valid, isForecast: true }))
}

/** The legend a layer is classified with, or null for wind, which has none. */
export function legendFor(manifest: FieldManifest | null, layer: FieldLayer): LegendStops | null {
  if (!manifest || layer === 'wind') return null
  return layer === 'precip' ? manifest.legends.precip3h : manifest.legends.prob
}

/** One step's stats for the layer on show, or null when the manifest does not carry them. */
export function stepStats(step: FieldStep | null, layer: FieldLayer): FrameStats | null {
  if (!step || layer === 'wind') return null
  return step.stats?.[layer] ?? null
}

/**
 * The frame to open on: the one nearest the reader's present.
 *
 * The first frame of a run is hours old by the time anyone looks at it, and opening there showed a
 * forecast for a moment already past as though it were the headline. Clamped to the ends, so a run
 * that is entirely in the past opens on its last frame rather than on nothing.
 */
export function frameNearest(frames: Array<{ t: string }>, at: number): string | null {
  if (!frames.length) return null
  let best = frames[0].t
  let bestDt = Infinity
  for (const f of frames) {
    const dt = Math.abs(Date.parse(f.t) - at)
    if (dt < bestDt) {
      best = f.t
      bestDt = dt
    }
  }
  return best
}

/**
 * The intensity strip drawn over the timeline: for each frame, how much of the map the layer
 * covers and the colour of its heaviest block. Lets a reader see when the weather arrives before
 * scrubbing to it. Frames the field does not cover (a storm fix between steps) get null, and a
 * manifest without stats gives an empty strip rather than a flat one that would read as "dry".
 */
export function fieldStrip(
  frames: Array<{ t: string }>,
  run: FieldRun | null,
  layer: FieldLayer,
  legend: LegendStops | null,
  stepHours = 3,
): Array<{ wet: number; colour: string | null } | null> {
  if (!run || !legend || !run.steps.some((s) => s.stats)) return []
  const byTime = new Map(run.steps.map((s) => [s.valid, s]))
  return frames.map((f) => {
    const st = stepStats(byTime.get(f.t) ?? nearestStep(run, f.t, stepHours), layer)
    if (!st) return null
    return { wet: st.wet, colour: st.peak > 0 ? legend.stops[Math.min(st.peak, legend.stops.length) - 1][1] : null }
  })
}

/**
 * One timeline across both systems.
 *
 * A frame is a forecast if **anything** on screen at that moment is one. Every field frame
 * qualifies by construction — the field is model output at every step — and a storm frame does
 * once it passes the newest observed fix. The two are OR-ed rather than compared against a single
 * boundary, because a model that publishes no run time (GFS, ICON) leaves that boundary empty, and
 * a missing timestamp must never turn a forecast into an observation on the badge.
 */
export function mergeFrames(
  cyclone: Array<{ t: string; isForecast: boolean }>,
  field: Array<{ t: string; isForecast: boolean }>,
  observedUntil: string | null,
): Array<{ t: string; isForecast: boolean }> {
  const fieldTimes = new Set(field.map((f) => f.t))
  const set = new Set<string>([...cyclone.map((f) => f.t), ...fieldTimes])
  return [...set].sort().map((t) => ({
    t,
    isForecast: fieldTimes.has(t) || (observedUntil ? t > observedUntil : false),
  }))
}

/** Arrow points for one step. Direction is where the wind comes *from*, so the arrow turns 180°. */
export function windFeatures(doc: WindDoc | null, t: string | null): GeoJSON.FeatureCollection {
  const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
  if (!doc || !doc.steps.length) return empty
  const step = t
    ? doc.steps.reduce((a, b) => (Math.abs(Date.parse(b.valid) - Date.parse(t)) < Math.abs(Date.parse(a.valid) - Date.parse(t)) ? b : a))
    : doc.steps[0]
  const features: GeoJSON.Feature[] = []
  let i = 0
  for (const lat of doc.lats) {
    for (const lon of doc.lons) {
      const kmh = step.kmh[i]
      const dir = step.dir[i]
      i += 1
      if (!kmh) continue
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          kmh,
          ms: Math.round((kmh / 3.6) * 10) / 10,
          dir,
          rot: (dir + 180) % 360,
          cls: windClass(kmh),
          t: step.valid,
          source: 'forecast',
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * Wind speed classes, km/h. Colour carries speed as well as size, because size alone was the
 * whole signal before and the arrows read as a uniform scatter of specks: monsoon surface winds
 * here sit in a narrow band, and a few pixels of difference is not something anyone sees.
 * Lower bounds; the same table draws the arrows and the key.
 */
export const WIND_CLASSES: Array<{ min: number; label: string; light: string; dark: string }> = [
  { min: 0, label: 'under 10', light: '#5b7896', dark: '#a9c1d9' },
  { min: 10, label: '10–20', light: '#1f6fd1', dark: '#6fb0ff' },
  { min: 20, label: '20–40', light: '#7a3fc2', dark: '#c49bff' },
  { min: 40, label: '40 and over', light: '#d2410c', dark: '#ff9255' },
]

export function windClass(kmh: number): number {
  let c = 0
  WIND_CLASSES.forEach((w, i) => {
    if (kmh >= w.min) c = i
  })
  return c
}

export const arrowId = (cls: number) => `wind-arrow-${cls}`

/**
 * One arrow icon per speed class, drawn on a canvas: a shaft and a head, the way wind is drawn on
 * every chart a reader has seen, rather than the bare chevron that preceded it.
 *
 * `setStyle` drops every registered image along with the sources, so these are re-added on each
 * style load rather than kept — which is also what lets them follow the theme — and they are drawn
 * rather than fetched so the page still contacts nothing but its own files.
 */
export function arrowImage(cls: number, theme: 'light' | 'dark'): ImageData | null {
  const size = 64
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return null
  g.translate(size / 2, size / 2)
  g.lineJoin = 'round'
  g.lineCap = 'round'
  const path = () => {
    g.beginPath()
    g.moveTo(0, -24) // tip
    g.lineTo(11, -6)
    g.lineTo(3.5, -8)
    g.lineTo(3.5, 22)
    g.lineTo(-3.5, 22)
    g.lineTo(-3.5, -8)
    g.lineTo(-11, -6)
    g.closePath()
  }
  path()
  g.lineWidth = 5
  g.strokeStyle = theme === 'dark' ? 'rgba(10,12,16,0.85)' : 'rgba(255,255,255,0.95)'
  g.stroke()
  path()
  g.fillStyle = WIND_CLASSES[cls][theme]
  g.fill()
  return g.getImageData(0, 0, size, size)
}
