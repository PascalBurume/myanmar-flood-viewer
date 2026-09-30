import { useEffect, useState } from 'react'

/**
 * The Flood Outlook: forecast likelihood against observed impact, one township at a time.
 *
 * Built by `scripts/outlook.py` into `public/data/outlook.json`. The rules (thresholds, bands and
 * the matrix) travel in the file under `method`, and everything here draws from them. The client
 * never carries its own copy, for the same reason the forecast field's palette is read from its
 * manifest: two copies of a rule drift apart, and the one on screen would be the wrong one.
 */

export type Level = 'very low' | 'low' | 'medium' | 'high'
export type Impact = 'minimal' | 'minor' | 'significant' | 'severe'

export interface RainSignal {
  /** Members whose wettest day in the window reaches the heavy-rain line. */
  members: number
  veryHeavy: number
  of: number
  pct: number
}

export interface RiverSignal {
  gauge: string
  km: number
  members: number
  of: number
  over5: number | null
  pct: number
  flow2: number
}

export interface OutlookTownship {
  name: string
  region: string
  district: string | null
  lat: number
  lon: number
  /** Null when the impact is unknown. Unknown is never read as minimal. */
  level: Level | null
  likelihood: {
    band: Level
    pct: number
    driver: 'rain' | 'river'
    rain: RainSignal
    river: RiverSignal | null
  }
  impact: {
    people: number
    date: string
    service: string
    floodedKm2: number
    band: Impact
    passes: number
    withheld: number
    peakFloodedKm2: number
  } | null
  /** ECMWF amounts at the township's 0.5° cell over the window. */
  rain: { total: number | null; wettest24: number | null } | null
}

export interface OutlookGauge {
  name: string
  lat: number
  lon: number
  returnFlow: Record<string, number>
  ensemble?: { members: number; over2: number; over5: number; window: [string, string] }
  peakAhead?: number
  peakDate?: string
}

export interface OutlookDoc {
  generatedAt: string
  window: { from: string; to: string; hours: number }
  note: string
  caveats: string[]
  method: {
    heavyMm: number
    veryHeavyMm: number
    riverKm: number
    likelihoodBands: [number, Level][]
    impactBands: [number, Impact][]
    likelihoods: Level[]
    impacts: Impact[]
    levels: Level[]
    matrix: Record<Level, Level[]>
    thresholdSource: string
    matrixSource: string
  }
  sources: {
    ensemble: { label: string; init: string | null; fetchedAt: string; members: number; cellDeg: number }
    amounts: { label: string; init: string | null; fetchedAt: string; cellDeg: number } | null
    rivers: { label: string; generatedAt: string; gauges: number } | null
    history: { label: string; services: string[]; from: string | null; to: string | null; fetchedAt: string; withheldObservations: number }
  }
  counts: Record<Level | 'unknown', number>
  /** Townships per likelihood band (rows) and impact band (columns). */
  grid: Record<Level, number[]>
  gauges: OutlookGauge[]
  townships: OutlookTownship[]
}

/** `reload` is bumped after a pipeline run; see `useHistory` for why it is needed. */
export function useOutlook(base: string, reload = 0): OutlookDoc | null {
  const [doc, setDoc] = useState<OutlookDoc | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/outlook.json?v=${reload}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = (await res.json()) as OutlookDoc
        if (!cancelled && Array.isArray(d.townships)) setDoc(d)
      } catch {
        /* the map works without an outlook */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, reload])
  return doc
}

/**
 * Green, yellow, amber, red, the colours flood guidance is read in. MapLibre cannot read CSS
 * custom properties, so these are the one copy and the panel's swatches take them inline.
 */
export const LEVEL_COLOR: Record<Level, string> = {
  'very low': '#6aa84f',
  low: '#f1c232',
  medium: '#e69138',
  high: '#cc2f24',
}

/** Text on a level's colour. Only the red is dark enough to carry white at AA (about 5.8:1). */
export const LEVEL_INK: Record<Level, string> = {
  'very low': '#0f2408',
  low: '#2b2100',
  medium: '#2b1400',
  high: '#ffffff',
}

export const LEVEL_RANK: Record<Level, number> = { 'very low': 0, low: 1, medium: 2, high: 3 }

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The one sentence that says why a township's likelihood is what it is. Figures, not adjectives. */
export function likelihoodLine(t: OutlookTownship, doc: OutlookDoc): string {
  const lk = t.likelihood
  if (lk.driver === 'river' && lk.river) {
    const r = lk.river
    return `${r.members} of ${r.of} river scenarios over the 2-year flow at ${r.gauge} (${r.km} km)`
  }
  const r = lk.rain
  return `${r.members} of ${r.of} rain scenarios bring a ≥ ${doc.method.heavyMm} mm day`
}

export function impactLine(t: OutlookTownship): string {
  const i = t.impact
  if (!i) return 'No usable population record, so no level'
  return i.people > 0
    ? `Up to ${i.people.toLocaleString('en-US')} people seen under water · ${i.date}`
    : `Looked at ${i.passes} times, nobody seen under water`
}

/** Township points for the map, carrying what the paint expressions and the popup need. */
export function outlookFeatures(doc: OutlookDoc | null): GeoJSON.FeatureCollection {
  if (!doc) return { type: 'FeatureCollection', features: [] }
  return {
    type: 'FeatureCollection',
    features: doc.townships.map((t, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: {
        name: t.name,
        region: t.region,
        level: t.level ?? 'unknown',
        rank: t.level ? LEVEL_RANK[t.level] : -1,
        impact: t.impact?.band ?? 'unknown',
        pct: t.likelihood.pct,
      },
    })),
  }
}

/** Short popup for a clicked township; the full reasoning is in the panel. */
export function outlookPopupHtml(t: OutlookTownship, doc: OutlookDoc): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  const lv = t.level
  const chip = lv
    ? `<span class="ol-chip" style="background:${LEVEL_COLOR[lv]};color:${LEVEL_INK[lv]}">${cap(lv)}</span>`
    : '<span class="ol-chip is-unknown">No level</span>'
  const amounts =
    t.rain && t.rain.total !== null
      ? `<p>ECMWF: ${t.rain.total} mm over ${doc.window.hours / 24} days, wettest day ${t.rain.wettest24} mm</p>`
      : ''
  return (
    `<div class="pop-head">Flood outlook / ${esc(t.name)}, ${esc(t.region)}</div>` +
    `<div class="pop-body ol-pop">${chip}` +
    `<p>${esc(likelihoodLine(t, doc))}</p>` +
    `<p>${esc(impactLine(t))}</p>${amounts}` +
    `<p class="ol-pop-note">Forecast-derived triage, not a warning.</p></div>`
  )
}
