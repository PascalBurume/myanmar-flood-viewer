import { useEffect, useMemo, useState } from 'react'

import { EXPOSURE_COLOR, type DataIndex } from '../layers'

export interface Place {
  region: string
  district: string
  township: string
  people: number
  flooded: number
  cropland: number
  lon: number
  lat: number
  /**
   * The date UNOSAT actually observed this township. Carried per-feature rather than taken from the
   * dataset as a whole because a single product stitches together several passes, so two townships
   * in one file can have been looked at on different days. Any figure quoted from this row has to
   * be able to name it.
   */
  observed: string
}

/**
 * Load the nationwide exposure points as a plain list.
 *
 * The same file is already a map source, but reading it again here keeps the ranking independent of
 * whether the layer is switched on — a reader who has hidden the circles still wants the table.
 */
export function useExposure(index: DataIndex, base: string): Place[] {
  const [places, setPlaces] = useState<Place[]>([])
  const path = index.datasets.find((d) => d.layers.exposure)?.layers.exposure?.path

  useEffect(() => {
    if (!path) {
      setPlaces([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}${path}?v=${encodeURIComponent(index.updated)}`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const fc = (await res.json()) as {
          features: { geometry: { coordinates: [number, number] }; properties: Record<string, unknown> }[]
        }
        if (cancelled) return
        setPlaces(
          fc.features.map((f) => ({
            region: String(f.properties.Region ?? ''),
            district: String(f.properties.District ?? ''),
            township: String(f.properties.Township ?? ''),
            people: Number(f.properties['People exposed'] ?? 0),
            flooded: Number(f.properties['Flooded area (km²)'] ?? 0),
            cropland: Number(f.properties['Flooded cropland (km²)'] ?? 0),
            lon: f.geometry.coordinates[0],
            lat: f.geometry.coordinates[1],
            observed: String(f.properties.Observed ?? ''),
          })),
        )
      } catch {
        /* the map still works without the table */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, base, index.updated])

  return places
}

/**
 * When these figures were observed.
 *
 * Read from the rows themselves rather than from a dataset-level field, because one UNOSAT product
 * stitches together several passes and two townships in the same file can have been looked at on
 * different days — so the honest answer is sometimes a range, not a date.
 */
export function observedRange(places: Place[]): string | null {
  const dates = [...new Set(places.map((p) => p.observed).filter(Boolean))].sort()
  if (!dates.length) return null
  return dates.length === 1 ? dates[0] : `${dates[0]} to ${dates.at(-1)}`
}

/** National totals, derived rather than stored, so they can never disagree with the rows. */
export function nationalTotals(places: Place[]) {
  return places.reduce(
    (a, p) => ({
      people: a.people + p.people,
      flooded: a.flooded + p.flooded,
      cropland: a.cropland + p.cropland,
      places: a.places + 1,
    }),
    { people: 0, flooded: 0, cropland: 0, places: 0 },
  )
}

export type Measure = 'people' | 'flooded' | 'cropland'

export interface RankedRow {
  key: string
  name: string
  sub: string
  value: number
  lon: number
  lat: number
}

/**
 * The worst-affected places, ranked.
 *
 * Lifted out of the panel's render body so the assistant can call it too. That is the whole point:
 * two rankings computed two ways would eventually disagree about "worst affected", and the reader
 * would have no way to tell which one to believe.
 */
export function rankPlaces(
  places: Place[],
  { measure = 'people', groupBy = 'region', limit = 15 }: {
    measure?: Measure
    groupBy?: 'township' | 'region'
    limit?: number
  } = {},
): RankedRow[] {
  if (groupBy === 'township') {
    return [...places]
      .sort((a, b) => b[measure] - a[measure])
      .slice(0, limit)
      .map((p) => ({
        key: `${p.region}/${p.township}`,
        name: p.township || p.district,
        sub: p.region,
        value: p[measure],
        lon: p.lon,
        lat: p.lat,
      }))
  }
  const agg = new Map<string, { value: number; lon: number; lat: number; n: number; w: number }>()
  for (const p of places) {
    const cur = agg.get(p.region) ?? { value: 0, lon: 0, lat: 0, n: 0, w: 0 }
    cur.value += p[measure]
    cur.n += 1
    // Centre weighted by the measure, so "zoom to region" lands on where the impact actually is
    // rather than on the region's geometric middle.
    const w = Math.max(p[measure], 0.0001)
    cur.lon += p.lon * w
    cur.lat += p.lat * w
    cur.w += w
    agg.set(p.region, cur)
  }
  return [...agg.entries()]
    .map(([name, v]) => ({
      key: name,
      name,
      sub: `${v.n} township${v.n === 1 ? '' : 's'}`,
      value: v.value,
      lon: v.lon / v.w,
      lat: v.lat / v.w,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}

/**
 * Find places by name, across township, district and region.
 *
 * Only townships where water was actually detected appear in this file at all, so an empty result
 * means "not in this observation" and never "dry" — callers have to say which.
 */
export function findPlaces(places: Place[], query: string, limit = 5): Place[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hit = (p: Place) =>
    p.township.toLowerCase().includes(q) ||
    p.district.toLowerCase().includes(q) ||
    p.region.toLowerCase().includes(q)
  return places.filter(hit).sort((a, b) => b.people - a.people).slice(0, limit)
}

const MEASURES: { key: Measure; label: string; short: string; fmt: (n: number) => string }[] = [
  { key: 'people', label: 'People exposed', short: 'People', fmt: (n) => n.toLocaleString() },
  { key: 'flooded', label: 'Flooded area', short: 'Flooded', fmt: (n) => `${n.toFixed(0)} km²` },
  { key: 'cropland', label: 'Flooded cropland', short: 'Cropland', fmt: (n) => `${n.toFixed(0)} km²` },
]

/**
 * The worst-affected places, ranked. Grouped by region by default rather than township, because a
 * township ranking buries the shape of an event: twenty townships of one region each look small
 * next to a single large one elsewhere.
 */
export function TopAffected({
  places,
  onZoom,
}: {
  places: Place[]
  onZoom: (lon: number, lat: number) => void
}) {
  const [measure, setMeasure] = useState<Measure>('people')
  const [byRegion, setByRegion] = useState(true)

  const rows = useMemo(
    () => rankPlaces(places, { measure, groupBy: byRegion ? 'region' : 'township', limit: 15 }),
    [places, measure, byRegion],
  )

  if (!places.length) return null
  const max = Math.max(...rows.map((r) => r.value), 1)
  const observed = observedRange(places)
  const fmt = MEASURES.find((m) => m.key === measure)!.fmt

  return (
    <div className="top-affected">
      <div className="top-controls">
        <div className="seg" role="group" aria-label="Measure">
          {MEASURES.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`seg-btn${measure === m.key ? ' is-on' : ''}`}
              aria-pressed={measure === m.key}
              onClick={() => setMeasure(m.key)}
            >
              {m.short}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mini-btn"
          onClick={() => setByRegion((v) => !v)}
          title="Switch between regions and individual townships"
        >
          {byRegion ? 'By region' : 'By township'}
        </button>
      </div>

      {rows.map((r, i) => (
        <div
          className="stat-row stat-clickable"
          key={r.key}
          tabIndex={0}
          title={`Zoom to ${r.name}`}
          onClick={() => onZoom(r.lon, r.lat)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onZoom(r.lon, r.lat)
            }
          }}
        >
          <div className="stat-head">
            <span className="stat-name">
              <span className="rank">{i + 1}</span>
              {r.name}
              <span className="rank-sub">{r.sub}</span>
            </span>
            <span className="stat-value">{fmt(r.value)}</span>
          </div>
          <div className="stat-track">
            <div
              className="stat-fill"
              style={{ width: `${(r.value / max) * 100}%`, background: EXPOSURE_COLOR }}
            />
          </div>
        </div>
      ))}

      {/* When, and from what. The panel's own standard is that no figure appears without its source
          and date; this section carried neither, while the assistant beside it cited both. */}
      {observed ? (
        <p className="stat-source">{`UNOSAT FloodAI — observed ${observed}. Only townships where water was detected appear.`}</p>
      ) : null}
    </div>
  )
}
