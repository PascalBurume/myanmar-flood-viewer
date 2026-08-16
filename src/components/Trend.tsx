import { Fragment, useEffect, useMemo, useRef, useState } from 'react'

import { EXPOSURE_COLOR } from '../layers'

export interface Observation {
  date: string
  service: string
  people: number | null
  flooded: number
  cropland: number
  observed: number
  peopleSuspect?: boolean
}

export interface History {
  generatedAt: string
  note: string
  suspect?: number
  series: Observation[]
}

/** `reload` is bumped after a pipeline run, so a refreshed series reaches the chart without a
 *  page reload — the file path never changes, so nothing else would trigger a refetch. */
export function useHistory(base: string, reload = 0): History | null {
  const [history, setHistory] = useState<History | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/history.json?v=${reload}`, { cache: 'no-store' })
        if (!res.ok) return
        const doc = (await res.json()) as History
        if (!cancelled) setHistory(doc)
      } catch {
        /* the map works without the history */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, reload])
  return history
}

type Metric = 'people' | 'flooded'
type Window = 365 | 1095 | 0

const WINDOWS: { key: Window; label: string }[] = [
  { key: 0, label: 'All' },
  { key: 1095, label: '3y' },
  { key: 365, label: '1y' },
]

/** Days between passes beyond which the record is broken rather than merely sparse. */
const GAP_DAYS = 120

function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

const km2 = (n: number) => `${Math.round(n).toLocaleString()} km²`

function longDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * What one pass actually measured, shown on hover.
 *
 * A bar carries one number — whichever metric is selected — but the reader needs the other three to
 * judge it. `observed` above all: a pass covers a strip, so 200 km² of water inside 5,000 km² looked
 * at means something completely different from the same 200 inside 250,000, and a bar alone cannot
 * say which happened. All four travel together here so the comparison is always available.
 */
function Readout({ row, metric }: { row: Observation; metric: Metric }) {
  const withheld = row.people === null
  const rows: Array<[string, string, boolean]> = [
    [
      'People exposed',
      withheld ? 'withheld' : row.people!.toLocaleString(),
      metric === 'people',
    ],
    ['Flooded', km2(row.flooded), metric === 'flooded'],
    ['Cropland', km2(row.cropland), false],
    ['Area observed', km2(row.observed), false],
  ]
  return (
    <div className="trend-readout" role="status" aria-live="polite">
      <div className="readout-date">
        {longDate(row.date)}
        <span className="readout-service">{row.service}</span>
      </div>
      {rows.map(([label, val, on]) => (
        <div className={`readout-row${on ? ' is-metric' : ''}`} key={label}>
          <span className="readout-label">{label}</span>
          <span className={`readout-value${withheld && label === 'People exposed' ? ' is-withheld' : ''}`}>
            {val}
          </span>
        </div>
      ))}
      {withheld ? (
        <p className="readout-note">
          The source reported a population far beyond what every other archive gives for this much
          water, so it is not shown. The areas are unaffected.
        </p>
      ) : (
        <p className="readout-note">
          {row.observed > 0
            ? `${((row.flooded / row.observed) * 100).toFixed(1)}% of what this pass looked at was under water.`
            : 'No observed area recorded for this pass.'}
        </p>
      )}
    </div>
  )
}

/**
 * The flood record over time.
 *
 * Drawn as bars rather than a line, deliberately. A line implies the value moved continuously
 * between two points, but these are discrete satellite passes days apart with nothing observed in
 * between — joining them would invent data. Bars say "these are the observations we have".
 */
export function Trend({ history }: { history: History }) {
  const [metric, setMetric] = useState<Metric>('people')
  const [days, setDays] = useState<Window>(0)
  // Which pass the pointer is over. Null falls back to the latest, so the readout is never an empty
  // box waiting to be hovered — before you touch it, it already answers "what is the situation now".
  const [hover, setHover] = useState<Observation | null>(null)
  const chart = useRef<HTMLDivElement>(null)

  // The record overflows its width, and the newest pass — the one a reader has come for — is at the
  // far right. Left alone the chart opens on 2022 and looks like it has no current data at all.
  useEffect(() => {
    const el = chart.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [metric, days, history.series])

  const rows = useMemo(() => {
    let s = history.series
    if (days) {
      const cut = new Date()
      cut.setUTCDate(cut.getUTCDate() - days)
      const iso = cut.toISOString().slice(0, 10)
      s = s.filter((r) => r.date >= iso)
    }
    return s
  }, [history.series, days])

  const usable = rows.filter((r) => (metric === 'people' ? r.people !== null : true))
  if (!usable.length) {
    return (
      <p className="about-note">
        No observations in this window. Try a longer range.
      </p>
    )
  }

  const value = (r: Observation) => (metric === 'people' ? (r.people ?? 0) : r.flooded)
  const max = Math.max(...usable.map(value), 1)
  const latest = usable[usable.length - 1]
  const prev = usable.length > 1 ? usable[usable.length - 2] : null
  const change = prev && value(prev) > 0 ? (value(latest) - value(prev)) / value(prev) : null
  const peak = usable.reduce((a, b) => (value(b) > value(a) ? b : a))
  const fmt = (n: number) =>
    metric === 'people' ? Math.round(n).toLocaleString() : `${Math.round(n).toLocaleString()} km²`

  return (
    <div className="trend">
      <div className="top-controls">
        <div className="seg" role="group" aria-label="Metric">
          <button
            type="button"
            className={`seg-btn${metric === 'people' ? ' is-on' : ''}`}
            aria-pressed={metric === 'people'}
            onClick={() => setMetric('people')}
          >
            People
          </button>
          <button
            type="button"
            className={`seg-btn${metric === 'flooded' ? ' is-on' : ''}`}
            aria-pressed={metric === 'flooded'}
            onClick={() => setMetric('flooded')}
          >
            Flooded
          </button>
        </div>
        <div className="seg" role="group" aria-label="Range">
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              type="button"
              className={`seg-btn${days === w.key ? ' is-on' : ''}`}
              aria-pressed={days === w.key}
              onClick={() => setDays(w.key)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bars are evenly spaced, one per pass — not a time axis. UNOSAT keep only a handful of
          archives, so the record has real holes in it (nothing at all through 2025). A gap marker
          is drawn wherever consecutive passes are months apart, because even spacing would
          otherwise read as an unbroken record and make a four-year jump look like a week. */}
      {/* One handler on the container rather than one per bar: 142 bars means 142 listeners
          otherwise, and the pass is already on the element as a data attribute. */}
      <div
        className="trend-chart"
        ref={chart}
        role="img"
        aria-label={`${usable.length} observations, latest ${fmt(value(latest))} on ${latest.date}`}
        onPointerMove={(e) => {
          const el = (e.target as HTMLElement).closest<HTMLElement>('[data-date]')
          const date = el?.dataset.date
          if (date && date !== hover?.date) setHover(rows.find((r) => r.date === date) ?? null)
          else if (!date) setHover(null)
        }}
        onPointerLeave={() => setHover(null)}
      >
        {rows.map((r, i) => {
          const withheld = metric === 'people' && r.people === null
          const h = withheld ? 100 : (value(r) / max) * 100
          const gap = i > 0 ? daysBetween(rows[i - 1].date, r.date) : 0
          return (
            <Fragment key={r.date}>
              {gap > GAP_DAYS ? (
                <div
                  className="trend-gap"
                  title={`No observations for ${Math.round(gap / 30)} months — ${rows[i - 1].date} to ${r.date}. UNOSAT keep a limited number of archives, so this is a hole in the record, not a dry spell.`}
                />
              ) : null}
              <div
                data-date={r.date}
                className={
                  `trend-bar${withheld ? ' is-withheld' : ''}` +
                  `${r === latest ? ' is-latest' : ''}${r.date === hover?.date ? ' is-hover' : ''}`
                }
                style={{ height: `${Math.max(h, 2)}%` }}
              />
            </Fragment>
          )
        })}
      </div>
      <div className="trend-axis">
        <span>{rows[0]?.date.slice(0, 7)}</span>
        <span>{rows[rows.length - 1]?.date.slice(0, 7)}</span>
      </div>

      <div className="trend-facts">
        <div>
          <span className="trend-value">{fmt(value(latest))}</span>
          <span className="trend-label">latest · {latest.date}</span>
        </div>
        {change !== null && prev ? (
          <div>
            <span className={`trend-value ${change >= 0 ? 'up' : 'down'}`}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(Math.round(change * 100))}%
            </span>
            {/* Naming the date rather than saying "previous pass": the previous usable pass can be
                two years back across a hole in the archive, and an unqualified "previous" would
                read as "last week". */}
            <span className="trend-label" title={`Compared with the pass of ${prev.date}`}>
              {daysBetween(prev.date, latest.date) > GAP_DAYS
                ? `vs ${prev.date}`
                : 'vs previous pass'}
            </span>
          </div>
        ) : null}
        <div>
          <span className="trend-value">{fmt(value(peak))}</span>
          <span className="trend-label">peak · {peak.date}</span>
        </div>
      </div>

      {/* Defaults to the latest pass rather than sitting empty, so the panel answers "what is it
          now" before anyone hovers, and hovering just moves the same readout along the record. */}
      <Readout row={hover ?? latest} metric={metric} />
      {!hover ? (
        <p className="trend-hint">Hover any bar for that pass in full.</p>
      ) : null}

      <p className="stat-source">
        {`${usable.length} satellite passes. `}
        Bars are one per pass, evenly spaced — not a time axis; hatched gaps mark months with no
        archive at all. A pass covers a strip, not the country, so a low bar can mean a narrow swath
        rather than less water — hover for the area actually observed.
        {history.suspect
          ? ` ${history.suspect} observation${history.suspect === 1 ? '' : 's'} had an implausible population figure in the source and are shown hollow, area only.`
          : ''}
      </p>
    </div>
  )
}

export const TREND_COLOR = EXPOSURE_COLOR
