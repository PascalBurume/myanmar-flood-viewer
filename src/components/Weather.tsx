import { useEffect, useState } from 'react'

export interface RainDay {
  date: string
  mm: number
  prob: number | null
}

export interface RainPoint {
  name: string
  lat: number
  lon: number
  today: string
  days: RainDay[]
  past7: number
  next7: number
}

export interface RiverDay {
  date: string
  q: number
  lo: number
  hi: number
}

export interface RiverPoint {
  name: string
  lat: number
  lon: number
  today: string
  days: RiverDay[]
  now: number
  peakAhead: number
  peakDate: string
  max30: number
  cellSuspect?: boolean | null
}

export interface WeatherDoc {
  generatedAt: string
  note: string
  attribution: string
  rain: RainPoint[]
  rivers: RiverPoint[]
}

/** `reload` is bumped after a pipeline run; see `useHistory` for why it is needed. */
export function useWeather(base: string, reload = 0): WeatherDoc | null {
  const [doc, setDoc] = useState<WeatherDoc | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${base}data/weather.json?v=${reload}`, { cache: 'no-store' })
        if (!res.ok) return
        const w = (await res.json()) as WeatherDoc
        if (!cancelled) setDoc(w)
      } catch {
        /* the map works without a forecast */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [base, reload])
  return doc
}

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  })

/**
 * Rainfall, a week back and a week forward.
 *
 * The past half is not filler. Flooding is the consequence of rain that has already fallen, so what
 * landed this week explains the map as it is now; the forecast only says whether it is about to get
 * worse. Forecast bars are drawn hollow and a marker sits on the boundary, because the two halves
 * are different kinds of claim and a uniform bar chart would quietly merge them.
 */
function RainRow({ point, max }: { point: RainPoint; max: number }) {
  return (
    <div className="wx-row">
      <div className="wx-head">
        <span className="wx-name">{point.name}</span>
        <span className="wx-value">
          {point.past7} <span className="wx-unit">mm fell</span>
        </span>
      </div>
      <div className="wx-bars">
        {point.days.map((d) => {
          const ahead = d.date >= point.today
          return (
            <div
              key={d.date}
              className={`wx-bar${ahead ? ' is-forecast' : ''}${d.date === point.today ? ' is-today' : ''}`}
              style={{ height: `${Math.max((d.mm / max) * 100, 3)}%` }}
              title={
                `${shortDate(d.date)} — ${d.mm} mm` +
                (d.prob !== null ? `, ${d.prob}% chance` : '') +
                (ahead ? ' (forecast)' : ' (fell)')
              }
            />
          )
        })}
      </div>
      <div className="wx-foot">
        <span>7 days back</span>
        <span className="wx-forecast-total">{point.next7} mm forecast</span>
      </div>
    </div>
  )
}

/**
 * River discharge, which is the thing that actually floods.
 *
 * Rain is the input; flow is what overtops a bank, and it carries rain that fell days ago and
 * hundreds of kilometres upstream — so a river can still be rising under a clear sky. The forecast
 * half is drawn with the ensemble envelope behind it, because GloFAS's own spread widens from about
 * ±1% tomorrow to −11%/+38% two weeks out, and a single confident line would hide that.
 */
function RiverRow({ point }: { point: RiverPoint }) {
  const all = point.days
  const max = Math.max(...all.map((d) => d.hi || d.q), 1)
  const change = point.now > 0 ? (point.peakAhead - point.now) / point.now : 0
  return (
    <div className="wx-row">
      <div className="wx-head">
        <span className="wx-name">{point.name}</span>
        <span className="wx-value">
          {point.now.toLocaleString()} <span className="wx-unit">m³/s</span>
        </span>
      </div>
      <div className="wx-bars is-river">
        {all.map((d) => {
          const ahead = d.date > point.today
          return (
            <div
              key={d.date}
              className={`wx-q${ahead ? ' is-forecast' : ''}`}
              style={{ height: `${Math.max((d.q / max) * 100, 2)}%` }}
              title={
                `${shortDate(d.date)} — ${d.q.toLocaleString()} m³/s` +
                (ahead ? ` (forecast, range ${d.lo.toLocaleString()}–${d.hi.toLocaleString()})` : '')
              }
            >
              {ahead && d.hi > d.q ? (
                <span
                  className="wx-band"
                  style={{ height: `${((d.hi - d.q) / Math.max(d.q, 1)) * 100}%` }}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="wx-foot">
        <span>30 days back</span>
        <span className={change > 0.05 ? 'wx-rising' : 'wx-steady'}>
          {change > 0.005 ? '▲' : change < -0.005 ? '▼' : '■'}{' '}
          {Math.abs(Math.round(change * 100))}% by {shortDate(point.peakDate)}
        </span>
      </div>
      {point.cellSuspect ? (
        <p className="wx-warn">
          This flow is far from what the cell read when it was chosen — it may have drifted off the
          channel. Treat with suspicion.
        </p>
      ) : null}
    </div>
  )
}

export function Weather({ doc }: { doc: WeatherDoc }) {
  const [tab, setTab] = useState<'rain' | 'rivers'>('rivers')
  const rainMax = Math.max(...doc.rain.flatMap((p) => p.days.map((d) => d.mm)), 1)
  const rivers = [...doc.rivers].sort((a, b) => b.now - a.now)
  const rain = [...doc.rain].sort((a, b) => b.past7 + b.next7 - (a.past7 + a.next7))

  return (
    <div className="weather">
      <div className="top-controls">
        <div className="seg" role="group" aria-label="Weather view">
          <button
            type="button"
            className={`seg-btn${tab === 'rivers' ? ' is-on' : ''}`}
            aria-pressed={tab === 'rivers'}
            onClick={() => setTab('rivers')}
          >
            Rivers
          </button>
          <button
            type="button"
            className={`seg-btn${tab === 'rain' ? ' is-on' : ''}`}
            aria-pressed={tab === 'rain'}
            onClick={() => setTab('rain')}
          >
            Rainfall
          </button>
        </div>
      </div>

      {/* Said once, at the top, rather than repeated per row: everything under this heading is a
          model output about the future. Every other number in this viewer is an observation of the
          past, and the reader has no way to tell them apart unless told. */}
      <p className="wx-caveat">
        <strong>Forecast, not observation.</strong>{' '}
        {tab === 'rivers'
          ? 'GloFAS models flow globally at about 5 km with no local calibration, so it shows a river rising or falling well before it gives a reliable number for how much.'
          : 'Rainfall totals ahead of today are a weather model; the days behind it are its best estimate of what fell.'}
      </p>

      {tab === 'rivers'
        ? rivers.map((p) => <RiverRow key={p.name} point={p} />)
        : rain.map((p) => <RainRow key={p.name} point={p} max={rainMax} />)}

      <p className="stat-source">
        {doc.attribution}. Gauge points are model cells on the channel, deliberately offset from the
        towns they are named for — a cell one step off the river reports a stream, not the
        Ayeyarwady.
      </p>
    </div>
  )
}
