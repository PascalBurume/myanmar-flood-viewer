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

export type FieldLayer = 'precip' | 'prob25' | 'prob50' | 'wind'
export type FieldModelKey = 'ecmwf' | 'gfs' | 'icon' | 'weathernext'

export interface FieldStep {
  h: number
  valid: string
  precip?: string
  prob25?: string
  prob50?: string
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
  { key: 'precip', label: 'Precipitation', desc: 'Rain forecast for each three-hour step. Blocks are the 0.5° sampling of a 0.25° model — about 55 km — not the shape of the weather.' },
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
          t: step.valid,
          source: 'forecast',
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/**
 * The arrow icon, drawn once on a canvas.
 *
 * `setStyle` drops every registered image along with the sources, so this is re-added on each
 * style load rather than kept — and it is drawn rather than fetched so the page still contacts
 * nothing but its own files.
 */
export function arrowImage(): ImageData | null {
  const size = 44
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return null
  g.translate(size / 2, size / 2)
  g.beginPath()
  g.moveTo(0, -16)
  g.lineTo(9, 6)
  g.lineTo(0, 1)
  g.lineTo(-9, 6)
  g.closePath()
  g.fillStyle = '#1b3a5c'
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 2.5
  g.stroke()
  g.fill()
  return g.getImageData(0, 0, size, size)
}
