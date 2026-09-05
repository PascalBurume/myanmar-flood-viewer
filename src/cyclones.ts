/**
 * Tropical cyclones: the file `scripts/scan_cyclones.py` writes, and everything derived from it.
 *
 * The file carries numbers — positions, winds, radii in nautical miles by quadrant — and nothing
 * drawn. Geometry is built here, in the browser, so the assistant and the panel read the same
 * numbers and the map is the only consumer that ever sees a polygon.
 *
 * Two kinds of point, kept visibly apart everywhere: **observed** (IBTrACS provisional best track,
 * or a JTWC warning position standing in until IBTrACS catches up) and **forecast** (the JTWC
 * official forecast at 12–120 h). A forecast point is drawn hollow and its track dashed, the same
 * rule as the hollow forecast bars in the weather panel.
 */

import { useEffect, useState } from 'react'

export interface CyclonePoint {
  t: string
  lat: number
  lon: number
  windKt: number | null
  presHpa: number | null
  /** Saffir-Simpson category as IBTrACS assigns it: -5..-1 below tropical storm, 0 TS, 1–5. */
  sshs: number | null
  /** Largest extent of 34/50/64 kt winds in each quadrant, nautical miles: [NE, SE, SW, NW]. */
  r34: number[] | null
  r50: number[] | null
  r64: number[] | null
  trackType?: string | null
}

export interface ForecastPoint {
  tauH: number
  t: string
  lat: number
  lon: number
  windKt: number | null
  r34: number[] | null
  r50: number[] | null
  r64: number[] | null
  dissipating?: boolean
}

export interface CycloneForecast {
  agency: string
  product: string
  url: string
  issued: string
  warning: Omit<ForecastPoint, 'tauH'> & { accuracyNm: number | null; presHpa?: number }
  points: ForecastPoint[]
}

export interface Storm {
  sid: string
  atcf: string | null
  name: string
  basin: 'NI' | 'WP'
  lastObserved: string | null
  peakWindKt: number | null
  observed: CyclonePoint[]
  forecast: CycloneForecast | null
}

export interface CycloneSource {
  key: string
  label: string
  url: string
  fetchedAt: string
  state: 'ok' | 'skipped'
  reason: string | null
}

export interface CycloneDoc {
  generatedAt: string
  note: string
  attribution: string
  sources: CycloneSource[]
  box: number[]
  myanmarBox: number[]
  retainDays: number
  storms: Storm[]
}

/** Which of the cyclone layers are drawn. Cone and ensemble wait for WeatherNext members. */
export interface CycloneShow {
  observed: boolean
  forecast: boolean
  wind: boolean
  ensemble: boolean
  cone: boolean
}

export const DEFAULT_SHOW: CycloneShow = {
  observed: true,
  forecast: true,
  wind: true,
  ensemble: false,
  cone: false,
}

export type CycloneLayerKey = keyof CycloneShow

/** Reader-facing descriptions, used by the panel and quoted by the assistant's `layer_reference`. */
export const CYCLONE_LAYERS: Array<{
  key: CycloneLayerKey
  label: string
  desc: string
  /** Why the toggle is disabled, when it is. */
  needs?: string
}> = [
  {
    key: 'observed',
    label: 'Observed track',
    desc: 'IBTrACS provisional best track: where the storm has been, coloured by intensity. ' +
      'Positions are revised as the storm is re-analysed.',
  },
  {
    key: 'forecast',
    label: 'Forecast track',
    desc: 'The JTWC official forecast at 12–120 h, dashed and hollow because it is a forecast. ' +
      'The issue time and the analysed position’s stated accuracy are in every popup.',
  },
  {
    key: 'wind',
    label: 'Wind radii',
    desc: 'How far 34, 50 and 64 kt winds reach in each quadrant at the time shown — the ' +
      'extent of gale, storm and hurricane-force wind, not a pressure field.',
  },
  {
    key: 'ensemble',
    label: 'Ensemble tracks',
    desc: 'One track per WeatherNext 3 member.',
    needs: 'needs WeatherNext 3 members (not configured)',
  },
  {
    key: 'cone',
    label: 'Cone',
    desc: 'The spread of the ensemble members at each lead time — a measured spread, not a drawn ' +
      'error envelope.',
    needs: 'needs WeatherNext 3 members (not configured)',
  },
]

/** Fetch the cyclone file. Absent or unreachable is simply "no storms to draw". */
export function useCyclones(base: string, reload = 0): CycloneDoc | null {
  const [doc, setDoc] = useState<CycloneDoc | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/cyclones.json?v=${reload}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = (await res.json()) as CycloneDoc
        if (!cancelled && Array.isArray(d.storms)) setDoc(d)
      } catch {
        /* the map works without storms */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, reload])
  return doc
}

// ---- intensity ----

/**
 * The Saffir-Simpson scale as IBTrACS codes it. The colours are the ones Wikipedia's tropical
 * cyclone maps use, which is the closest thing to a convention readers already carry.
 */
export const SSHS_SCALE: Array<{ sshs: number; label: string; color: string }> = [
  { sshs: -5, label: 'Unknown', color: '#c0c0c0' },
  { sshs: -4, label: 'Post-tropical', color: '#c0c0c0' },
  { sshs: -3, label: 'Disturbance', color: '#c0c0c0' },
  { sshs: -2, label: 'Subtropical', color: '#c0c0c0' },
  { sshs: -1, label: 'Depression', color: '#5ebaff' },
  { sshs: 0, label: 'Tropical storm', color: '#00faf4' },
  { sshs: 1, label: 'Category 1', color: '#ffffcc' },
  { sshs: 2, label: 'Category 2', color: '#ffe775' },
  { sshs: 3, label: 'Category 3', color: '#ffc140' },
  { sshs: 4, label: 'Category 4', color: '#ff8f20' },
  { sshs: 5, label: 'Category 5', color: '#ff6060' },
]

/** Category from wind alone, for points where IBTrACS gives no SSHS (a JTWC warning position). */
export function sshsFromWind(kt: number | null): number {
  if (kt === null) return -5
  if (kt < 34) return -1
  if (kt < 64) return 0
  if (kt < 83) return 1
  if (kt < 96) return 2
  if (kt < 113) return 3
  if (kt < 137) return 4
  return 5
}

export function intensityColor(sshs: number | null, windKt: number | null): string {
  const s = sshs ?? sshsFromWind(windKt)
  return SSHS_SCALE.find((x) => x.sshs === s)?.color ?? '#c0c0c0'
}

export function categoryLabel(sshs: number | null, windKt: number | null): string {
  const s = sshs ?? sshsFromWind(windKt)
  return SSHS_SCALE.find((x) => x.sshs === s)?.label ?? 'Unknown'
}

export const ktToKmh = (kt: number): number => Math.round(kt * 1.852)

// ---- geometry ----

const NM_TO_KM = 1.852
const EARTH_KM = 6371.0088
const QUADRANT_START = [0, 90, 180, 270] // NE, SE, SW, NW — bearing where each quadrant begins

/** Great-circle destination from a point along a bearing (degrees) for a distance in nm. */
export function destination(lat: number, lon: number, bearing: number, nm: number): [number, number] {
  const d = (nm * NM_TO_KM) / EARTH_KM
  const φ1 = (lat * Math.PI) / 180
  const λ1 = (lon * Math.PI) / 180
  const θ = (bearing * Math.PI) / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(θ))
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [Number(((λ2 * 180) / Math.PI).toFixed(4)), Number(((φ2 * 180) / Math.PI).toFixed(4))]
}

/** A closed ring for one quadrant: centre, the arc every 10°, back to the centre. */
export function quadrantWedge(lat: number, lon: number, nm: number, quadrant: number): [number, number][] {
  const start = QUADRANT_START[quadrant]
  const ring: [number, number][] = [[lon, lat]]
  for (let b = start; b <= start + 90; b += 10) ring.push(destination(lat, lon, b, nm))
  ring.push([lon, lat])
  return ring
}

type Feature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>

/** Wedge polygons for one track point's radii. Nothing is drawn for a quadrant reported as 0. */
export function windRadiiFeatures(
  p: { lat: number; lon: number; t: string; r34: number[] | null; r50: number[] | null; r64: number[] | null },
  storm: Storm,
  isForecast: boolean,
): Feature[] {
  const out: Feature[] = []
  for (const kt of [34, 50, 64] as const) {
    const radii = p[`r${kt}` as 'r34' | 'r50' | 'r64']
    if (!radii) continue
    radii.forEach((nm, q) => {
      if (!nm) return
      out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [quadrantWedge(p.lat, p.lon, nm, q)] },
        properties: {
          name: storm.name,
          kt,
          quadrant: ['NE', 'SE', 'SW', 'NW'][q],
          radiusNm: nm,
          radiusKm: Math.round(nm * NM_TO_KM),
          t: p.t,
          isForecast,
          source: isForecast ? 'JTWC forecast' : 'observed',
        },
      })
    })
  }
  return out
}

// ---- time ----

interface TrackSample {
  t: string
  lat: number
  lon: number
  windKt: number | null
  presHpa: number | null
  sshs: number | null
  r34: number[] | null
  r50: number[] | null
  r64: number[] | null
  isForecast: boolean
  tauH?: number
}

/** Observed points followed by the forecast points that come after them, one time-ordered list. */
export function trackSamples(storm: Storm): TrackSample[] {
  const obs: TrackSample[] = storm.observed.map((p) => ({ ...p, isForecast: false }))
  const last = storm.lastObserved ?? ''
  const fc: TrackSample[] = (storm.forecast?.points ?? [])
    .filter((p) => p.t > last)
    .map((p) => ({ ...p, presHpa: null, sshs: null, isForecast: true }))
  return [...obs, ...fc].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
}

/**
 * Where the storm is at a moment, linearly between the two samples around it. Null outside the
 * span — there is nothing to say about a storm before it formed or after the forecast ends.
 */
export function positionAt(storm: Storm, t: string): TrackSample | null {
  const s = trackSamples(storm)
  if (s.length === 0 || t < s[0].t || t > s[s.length - 1].t) return null
  const i = s.findIndex((p) => p.t >= t)
  if (i <= 0 || s[i].t === t) return s[Math.max(i, 0)]
  const a = s[i - 1]
  const b = s[i]
  const span = Date.parse(b.t) - Date.parse(a.t)
  const f = span > 0 ? (Date.parse(t) - Date.parse(a.t)) / span : 0
  // Radii are not interpolated: they belong to the nearer sample, which is what the popup names.
  const near = f < 0.5 ? a : b
  return {
    ...near,
    t,
    lat: a.lat + (b.lat - a.lat) * f,
    lon: a.lon + (b.lon - a.lon) * f,
    windKt: a.windKt !== null && b.windKt !== null ? Math.round(a.windKt + (b.windKt - a.windKt) * f) : near.windKt,
    isForecast: b.isForecast,
  }
}

/** Every distinct time any storm has a sample at, sorted. What the timeline scrubs across. */
export function cycloneFrames(doc: CycloneDoc | null): Array<{ t: string; isForecast: boolean }> {
  if (!doc) return []
  const until = observedUntil(doc) ?? ''
  const set = new Set<string>()
  for (const st of doc.storms) for (const p of trackSamples(st)) set.add(p.t)
  return [...set].sort().map((t) => ({ t, isForecast: t > until }))
}

/** The newest observation across every storm: the boundary between observed and forecast. */
export function observedUntil(doc: CycloneDoc | null): string | null {
  if (!doc) return null
  const ts = doc.storms.map((s) => s.lastObserved).filter((t): t is string => Boolean(t))
  return ts.length ? ts.sort()[ts.length - 1] : null
}

// ---- features for the map ----

export interface CycloneCollections {
  observedLine: GeoJSON.FeatureCollection
  observedPoints: GeoJSON.FeatureCollection
  forecastLine: GeoJSON.FeatureCollection
  forecastPoints: GeoJSON.FeatureCollection
  wind: GeoJSON.FeatureCollection
  now: GeoJSON.FeatureCollection
}

const fc = (features: Feature[]): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features })

/**
 * The GeoJSON the map draws, built for one moment. Tracks are the whole record; the wind wedges
 * and the "now" marker are for `validTime` (or the newest observation when there is none).
 */
export function toFeatureCollections(doc: CycloneDoc | null, validTime: string | null): CycloneCollections {
  const observedLine: Feature[] = []
  const observedPoints: Feature[] = []
  const forecastLine: Feature[] = []
  const forecastPoints: Feature[] = []
  const wind: Feature[] = []
  const now: Feature[] = []
  if (!doc) return { observedLine: fc([]), observedPoints: fc([]), forecastLine: fc([]), forecastPoints: fc([]), wind: fc([]), now: fc([]) }

  for (const storm of doc.storms) {
    const base = { name: storm.name, basin: storm.basin, sid: storm.sid }
    const obs = storm.observed
    if (obs.length > 1) {
      // One segment per pair so each carries its own intensity colour.
      for (let i = 1; i < obs.length; i++) {
        observedLine.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[obs[i - 1].lon, obs[i - 1].lat], [obs[i].lon, obs[i].lat]] },
          properties: { ...base, color: intensityColor(obs[i].sshs, obs[i].windKt) },
        })
      }
    }
    for (const p of obs) {
      observedPoints.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          ...base,
          t: p.t,
          windKt: p.windKt,
          windKmh: p.windKt === null ? null : ktToKmh(p.windKt),
          presHpa: p.presHpa,
          category: categoryLabel(p.sshs, p.windKt),
          color: intensityColor(p.sshs, p.windKt),
          source: p.trackType ?? 'observed',
        },
      })
    }
    const f = storm.forecast
    if (f && f.points.length) {
      const chain = [f.warning, ...f.points]
      forecastLine.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: chain.map((p) => [p.lon, p.lat]) },
        properties: { ...base, issued: f.issued },
      })
      for (const p of f.points) {
        forecastPoints.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          properties: {
            ...base,
            t: p.t,
            tauH: p.tauH,
            windKt: p.windKt,
            windKmh: p.windKt === null ? null : ktToKmh(p.windKt),
            category: categoryLabel(null, p.windKt),
            color: intensityColor(null, p.windKt),
            issued: f.issued,
            accuracyNm: f.warning.accuracyNm,
            source: `${f.agency} forecast (+${p.tauH} h)`,
          },
        })
      }
    }

    // The moment being looked at: the marker and the wind radii belong to it.
    const at = validTime ? positionAt(storm, validTime) : null
    const sample = at ?? (obs.length ? { ...obs[obs.length - 1], isForecast: false } : null)
    if (sample) {
      now.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [sample.lon, sample.lat] },
        properties: {
          ...base,
          t: sample.t,
          windKt: sample.windKt,
          windKmh: sample.windKt === null ? null : ktToKmh(sample.windKt),
          category: categoryLabel(sample.sshs, sample.windKt),
          color: intensityColor(sample.sshs, sample.windKt),
          isForecast: sample.isForecast,
          source: sample.isForecast ? `${f?.agency ?? 'JTWC'} forecast` : 'observed',
        },
      })
      // Radii: the nearest sample that has any, within six hours of the moment.
      const withRadii = trackSamples(storm).filter((p) => p.r34 || p.r50 || p.r64)
      const nearest = withRadii
        .map((p) => ({ p, dt: Math.abs(Date.parse(p.t) - Date.parse(sample.t)) }))
        .sort((a, b) => a.dt - b.dt)[0]
      if (nearest && nearest.dt <= 6 * 3600 * 1000) wind.push(...windRadiiFeatures(nearest.p, storm, nearest.p.isForecast))
    }
  }
  return {
    observedLine: fc(observedLine),
    observedPoints: fc(observedPoints),
    forecastLine: fc(forecastLine),
    forecastPoints: fc(forecastPoints),
    wind: fc(wind),
    now: fc(now),
  }
}

/** Bounding box of one storm's whole track, for the panel's Zoom button. */
export function stormBounds(storm: Storm): [[number, number], [number, number]] | null {
  const pts = trackSamples(storm)
  if (!pts.length) return null
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const p of pts) {
    w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat)
  }
  return [[w, s], [e, n]]
}
