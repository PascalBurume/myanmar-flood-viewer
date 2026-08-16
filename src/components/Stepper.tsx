import { useEffect, useRef, useState } from 'react'

import type { RunStep } from '../pipeline'

const WORD: Record<RunStep['state'], string> = {
  pending: 'waiting',
  running: 'running',
  ok: 'no change',
  changed: 'new data',
  skipped: 'not scanned',
  failed: 'failed',
}

/** The mark inside each node. Kept to one glyph so a node stays a node at any size. */
const GLYPH: Record<RunStep['state'], string> = {
  pending: '',
  running: '',
  ok: '✓',
  changed: '✓',
  skipped: '–',
  failed: '!',
}

/**
 * The run as a horizontal track.
 *
 * Laid out along a line rather than as a list because a pipeline is a sequence, and the question
 * being asked of this display is "where is it now, and what is left" — which a vertical list of
 * equal rows answers badly. The connector between two nodes carries the state of the step *before*
 * it, so the filled portion of the line is exactly the work already done.
 *
 * A skipped stage is drawn, not omitted. "UNOSAT is not polled" is a decision the tree should state;
 * leaving a hole where a source used to be looks like an oversight instead.
 */
export function Stepper({ steps, live }: { steps: RunStep[]; live: boolean }) {
  const [picked, setPicked] = useState<string | null>(null)
  const track = useRef<HTMLDivElement>(null)

  const activeKey = steps.find((s) => s.state === 'running')?.key
  // While a run is live the selection follows the pipeline; once it stops, the reader's own choice
  // stands. Without the reset, a finished run would stay pinned to whatever was last running.
  const shown = steps.find((s) => s.key === (picked ?? activeKey)) ?? steps[steps.length - 1]

  useEffect(() => {
    if (!live) return
    setPicked(null)
    const el = track.current?.querySelector<HTMLElement>('[data-state="running"]')
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [activeKey, live])

  if (!steps.length) return null
  const done = steps.filter((s) => s.state !== 'pending' && s.state !== 'running').length

  return (
    <div className="stepper">
      <div className="stepper-track" ref={track}>
        {steps.map((s, i) => (
          <div
            className={`step is-${s.state}${s.key === shown?.key ? ' is-shown' : ''}`}
            key={s.key}
            data-state={s.state}
          >
            {/* The connector belongs to the step on its right but reports the one on its left, so
                the line fills only as far as the work that is actually finished. */}
            {i > 0 ? <span className={`step-line is-${steps[i - 1].state}`} /> : null}
            <button
              type="button"
              className="step-btn"
              onClick={() => setPicked(s.key)}
              aria-pressed={s.key === shown?.key}
              title={`${s.title ?? s.label} — ${WORD[s.state]}`}
            >
              <span className="step-node">{GLYPH[s.state] || i + 1}</span>
              <span className="step-label">{s.label}</span>
            </button>
          </div>
        ))}
      </div>

      <div className="stepper-foot">
        <span>
          {live
            ? `Step ${Math.min(done + 1, steps.length)} of ${steps.length}`
            : `${steps.length} stages`}
        </span>
        <span>{done === steps.length ? 'complete' : `${done} done`}</span>
      </div>

      {shown ? (
        <div className={`step-detail is-${shown.state}`}>
          <div className="step-detail-head">
            <span className="step-detail-name">{shown.title ?? shown.label}</span>
            <span className={`about-chip pipeline-chip pipeline-${shown.state}`}>
              {WORD[shown.state]}
            </span>
          </div>
          <p className="step-detail-body">
            {shown.detail ||
              {
                pending: 'Not started yet.',
                running: 'Working — the result appears here when this stage finishes.',
              }[shown.state as 'pending' | 'running'] ||
              'No detail recorded.'}
          </p>
          {shown.seconds !== undefined ? (
            <span className="step-detail-time">{shown.seconds.toFixed(2)}s</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
