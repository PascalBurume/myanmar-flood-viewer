import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { formatMMT } from '../time'

export interface Frame {
  t: string
  isForecast: boolean
}

/** One bar of the intensity strip: area covered (0–1) and the colour of the heaviest block. */
export type StripCell = { wet: number; colour: string | null } | null

/** Playback pace. Slow enough to read the time label as it changes; slower still on request. */
const TICK_MS = 600
const TICK_REDUCED_MS = 1500
/** Ticks to rest on the last frame before wrapping, so the loop has a visible end. */
const END_HOLD_TICKS = 2

/**
 * Where "now" falls on an index-spaced slider. Frames are not evenly spaced in time — a storm fix
 * can sit between two field steps — so this interpolates between the two frames either side
 * rather than scaling the whole span. Null outside the frames: a marker pinned to an end would
 * claim the present is in the data when it is not.
 */
function nowIndex(frames: Frame[], now: number): number | null {
  if (frames.length < 2) return null
  for (let i = 0; i < frames.length - 1; i++) {
    const a = Date.parse(frames[i].t)
    const b = Date.parse(frames[i + 1].t)
    if (now >= a && now <= b) return i + (b > a ? (now - a) / (b - a) : 0)
  }
  return null
}

/**
 * The scrubber under the map: one moment, moved across every moment the data has something for.
 *
 * It is the reader's clock, not the page's. It never starts on its own, it steps slowly and more
 * slowly still under `prefers-reduced-motion`, and it says in a badge whether the moment it is
 * showing was observed or is forecast — the boundary a reader cannot otherwise see once the marker
 * is moving.
 *
 * Above the slider, a strip shows how much of the map the forecast layer covers at every step and
 * the colour of its heaviest block, so the question "when does it arrive?" is answered before
 * anyone presses play. A tick marks the present.
 *
 * `value` and `playing` are controlled by the App so that the same two pieces of state drive the
 * map, the panel and the assistant.
 */
export function Timeline({
  frames,
  value,
  onChange,
  playing,
  onPlaying,
  initTime,
  initLabel,
  initIndex = 0,
  initCount = 0,
  onInitStep,
  observedUntil,
  preload,
  strip = [],
  leadHours = null,
}: {
  frames: Frame[]
  value: string | null
  onChange: (t: string) => void
  playing: boolean
  onPlaying: (on: boolean) => void
  /** When the frames come from a model run, the run's initialisation time. */
  initTime?: string | null
  /** What to say when the model publishes no run time. Never a guessed one. */
  initLabel?: string
  /** Position in the runs kept on disk, newest first, for the stepper's ends. */
  initIndex?: number
  initCount?: number
  /** Step to an older (+1) or newer (−1) run. Absent means no stepper is drawn. */
  onInitStep?: (dir: -1 | 1) => void
  /** The newest observation; anything after it is forecast. */
  observedUntil: string | null
  /** URLs worth warming for the frames either side of the current one. */
  preload?: (t: string) => string[]
  /** One cell per frame, or empty when there is nothing to draw. */
  strip?: StripCell[]
  /** Hours from the run's init to the moment shown — only where the init is published. */
  leadHours?: number | null
}) {
  const index = useMemo(() => {
    if (!value) return -1
    const i = frames.findIndex((f) => f.t === value)
    return i >= 0 ? i : frames.findIndex((f) => f.t > value)
  }, [frames, value])
  const current = index >= 0 ? frames[index] : null
  // The frame's own flag wins when it is set: it already accounts for a forecast field whose model
  // publishes no run time, where `observedUntil` says nothing at all.
  const isForecast = current ? current.isForecast || (observedUntil ? current.t > observedUntil : false) : false

  // Motion preference is read live, not once: the reader can change it while the page is open.
  const reduced = useRef(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => {
      reduced.current = mq.matches
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // The present moves; refresh the marker every few minutes rather than every second — it is a
  // position on a three-hourly scale.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5 * 60 * 1000)
    return () => window.clearInterval(id)
  }, [])
  const nowAt = useMemo(() => nowIndex(frames, now), [frames, now])

  // Playback: one step per tick, resting briefly on the last frame, then wrapping to the start.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const held = useRef(0)
  useEffect(() => {
    if (!playing || frames.length < 2) return
    const id = window.setInterval(() => {
      if (index === frames.length - 1 && held.current < END_HOLD_TICKS) {
        held.current += 1
        return
      }
      held.current = 0
      const i = index < 0 ? 0 : (index + 1) % frames.length
      onChangeRef.current(frames[i].t)
    }, reduced.current ? TICK_REDUCED_MS : TICK_MS)
    return () => window.clearInterval(id)
  }, [playing, frames, index])

  // Warm the frames ahead (and one behind) so the next step is a cache hit, not a fetch.
  useEffect(() => {
    if (!preload || index < 0) return
    for (const j of [index - 1, index + 1, index + 2, index + 3]) {
      const f = frames[j]
      if (!f) continue
      for (const url of preload(f.t)) {
        const img = new Image()
        img.src = url
      }
    }
  }, [preload, frames, index])

  if (frames.length < 2) return null

  const label = current ? formatMMT(current.t) : '—'
  const last = frames.length - 1
  const pos = Math.max(index, 0) / last
  const hasStrip = strip.length === frames.length && strip.some((c) => c && c.wet > 0)
  const trackStyle = {
    '--pos': pos,
    '--n': last,
    ...(nowAt !== null ? { '--now': nowAt / last } : {}),
  } as CSSProperties

  return (
    <div className="timeline" role="group" aria-label="Time">
      <button
        type="button"
        className="icon-btn timeline-play"
        aria-pressed={playing}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => onPlaying(!playing)}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="timeline-body">
        <div className="timeline-head">
          <span className="timeline-label">
            {label}
            {leadHours !== null ? <span className="timeline-lead">+{leadHours} h</span> : null}
          </span>
          <span className={`timeline-badge${isForecast ? ' is-forecast' : ''}`}>
            {isForecast ? 'Forecast' : 'Observed'}
          </span>
        </div>
        <div className={`timeline-track${hasStrip ? ' has-strip' : ''}`} style={trackStyle}>
          {hasStrip ? (
            <div className="timeline-strip" aria-hidden="true">
              {strip.map((c, i) =>
                c && c.wet > 0 ? (
                  <span
                    key={frames[i].t}
                    className={`timeline-strip-bar${i === index ? ' is-current' : ''}`}
                    style={{
                      '--i': i,
                      // sqrt: coverage of a few percent is the interesting case and must be visible
                      '--h': Math.max(0.12, Math.sqrt(c.wet)),
                      '--c': c.colour ?? 'var(--track)',
                    } as CSSProperties}
                    onClick={() => {
                      onPlaying(false)
                      onChange(frames[i].t)
                    }}
                  />
                ) : null,
              )}
            </div>
          ) : null}
          {nowAt !== null ? (
            <span className="timeline-now" aria-hidden="true">
              <em>now</em>
            </span>
          ) : null}
          <input
            type="range"
            min={0}
            max={last}
            step={1}
            value={Math.max(index, 0)}
            aria-valuetext={`${label}${isForecast ? ', forecast' : ', observed'}`}
            aria-label="Moment shown on the map"
            onChange={(e) => {
              onPlaying(false)
              onChange(frames[Number(e.target.value)].t)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Home') {
                e.preventDefault()
                onChange(frames[0].t)
              } else if (e.key === 'End') {
                e.preventDefault()
                onChange(frames[last].t)
              } else if (e.key === ' ') {
                e.preventDefault()
                onPlaying(!playing)
              } else if (onInitStep && (e.key === 'PageUp' || e.key === 'PageDown')) {
                // The runs are a second axis: the same moment, forecast from an earlier start.
                e.preventDefault()
                onInitStep(e.key === 'PageUp' ? -1 : 1)
              }
            }}
          />
        </div>
        <div className="timeline-foot">
          <span>{formatMMT(frames[0].t, { short: true })}</span>
          {onInitStep ? (
            <span className="timeline-init">
              <button
                type="button"
                className="icon-btn"
                aria-label="Newer model run"
                disabled={initIndex <= 0}
                onClick={() => onInitStep(-1)}
              >
                &lsaquo;
              </button>
              <span className="timeline-init-label">
                {initTime ? `Init. ${formatMMT(initTime, { short: true })}` : (initLabel ?? 'Run time not published')}
              </span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Older model run"
                disabled={initIndex >= initCount - 1}
                onClick={() => onInitStep(1)}
              >
                &rsaquo;
              </button>
            </span>
          ) : initTime ? (
            <span className="timeline-init">Model run {formatMMT(initTime, { short: true })}</span>
          ) : null}
          <span>{formatMMT(frames[last].t, { short: true })}</span>
        </div>
      </div>
    </div>
  )
}
