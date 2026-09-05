import { useEffect, useMemo, useRef } from 'react'
import { formatMMT } from '../time'

export interface Frame {
  t: string
  isForecast: boolean
}

/**
 * The scrubber under the map: one moment, moved across every moment the data has something for.
 *
 * It is the reader's clock, not the page's. It never starts on its own, it steps slowly and stops
 * stepping altogether under `prefers-reduced-motion`, and it says in a badge whether the moment it
 * is showing was observed or is forecast — the boundary a reader cannot otherwise see once the
 * marker is moving.
 *
 * `value` and `playing` are controlled by the App so that the same two pieces of state drive the
 * map, the panel and, later, the assistant.
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

  // Playback: one step per tick, wrapping to the start, slower when motion is to be reduced.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useEffect(() => {
    if (!playing || frames.length < 2) return
    const id = window.setInterval(() => {
      const i = index < 0 ? 0 : (index + 1) % frames.length
      onChangeRef.current(frames[i].t)
    }, reduced.current ? 1500 : 500)
    return () => window.clearInterval(id)
  }, [playing, frames, index])

  // Warm the frames either side so the next step is a cache hit, not a fetch.
  useEffect(() => {
    if (!preload || index < 0) return
    for (const j of [index - 2, index - 1, index + 1, index + 2]) {
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

  return (
    <div className="timeline" role="group" aria-label="Time">
      <button
        type="button"
        className="icon-btn timeline-play"
        aria-pressed={playing}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => onPlaying(!playing)}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div className="timeline-body">
        <div className="timeline-head">
          <span className="timeline-label">{label}</span>
          <span className={`timeline-badge${isForecast ? ' is-forecast' : ''}`}>
            {isForecast ? 'Forecast' : 'Observed'}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          step={1}
          value={Math.max(index, 0)}
          aria-valuetext={label}
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
              onChange(frames[frames.length - 1].t)
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
          <span>{formatMMT(frames[frames.length - 1].t, { short: true })}</span>
        </div>
      </div>
    </div>
  )
}
