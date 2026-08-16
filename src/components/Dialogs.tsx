import { useEffect, useRef } from 'react'

import { datasetName, type DataIndex, type Dataset } from '../layers'
import { parseRunProgress, stepsFromStatus, type RunState, type StatusDoc } from '../pipeline'
import { Stepper } from './Stepper'

/**
 * A native <dialog>, driven by an `open` prop.
 *
 * showModal() is imperative, so it has to be called in an effect rather than expressed as markup.
 * Using the real element rather than a hand-rolled overlay brings focus trapping, Escape-to-close
 * and inertness of the page behind it for free.
 */
function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className="about"
      onClose={onClose}
      // Clicking the backdrop reports the dialog itself as the target.
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="about-head">
        <h2>{title}</h2>
        <button className="icon-btn" type="button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="about-body">{children}</div>
    </dialog>
  )
}

export function AboutDialog({
  open,
  index,
  onClose,
  onFitAll,
}: {
  open: boolean
  index: DataIndex
  onClose: () => void
  onFitAll: () => void
}) {
  const group = index.datasets.find((d) => d.group)?.group
  const members = index.datasets.filter((d) => d.group === group)
  const sources = [...new Set(members.flatMap((d) => d.stats ?? []).map((s) => s.source).filter(Boolean))]

  return (
    <Modal open={open} title={`About the ${group ?? ''} data`} onClose={onClose}>
      <p>
        Flood water detected by UNOSAT in Sentinel-1 radar imagery and published through the
        Humanitarian Data Exchange. This is observed extent on a single date — the data carries no
        inundation depth, which is why every flood layer is one flat colour rather than a graded
        scale. Nothing here says how deep the water was.
      </p>
      <button type="button" className="mini-btn about-fit" onClick={onFitAll}>
        {`Fit all ${group ?? ''} regions`}
      </button>
      {members.map((ds) => (
        <div className="about-item" key={ds.id}>
          <div className="about-item-head">
            <span className="about-item-name">{datasetName(ds)}</span>
            {(ds.stats ?? []).map((s) => (
              <span className="about-chip" key={s.label}>{`${s.label} ${s.value}${s.unit ?? ''}`}</span>
            ))}
          </div>
          {ds.note ? <p className="about-note">{ds.note}</p> : null}
        </div>
      ))}
      <h3>Reading this map</h3>
      <ul>
        <li>Extent, not depth. A polygon means water was seen there on that date, nothing about how deep.</li>
        <li>
          Radar under-reports. Sentinel-1 misses water hidden by dense vegetation or inside buildings,
          so absence of a polygon is not proof the ground was dry.
        </li>
        <li>Dates differ between regions, because no single UNOSAT product covers all of them.</li>
        <li>
          Outlines are simplified so the map stays usable in a browser; they are not survey boundaries
          and should not be measured.
        </li>
      </ul>
      {sources.length ? (
        <>
          <h3>Where the figures come from</h3>
          <ul>
            {sources.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Credits</h3>
      <p className="about-note">
        Flood extents:{' '}
        <a href="https://data.humdata.org/organization/unosat" target="_blank" rel="noopener">
          UNOSAT via HDX
        </a>{' '}
        (CC BY-SA). Region boundaries:{' '}
        <a href="https://www.geoboundaries.org/" target="_blank" rel="noopener">
          geoBoundaries
        </a>{' '}
        (ODbL).
      </p>
    </Modal>
  )
}


export function PipelineDialog({
  open,
  status,
  run,
  serverAvailable,
  busy,
  message,
  onClose,
  onCheck,
  onRun,
  onApply,
  formatTime,
}: {
  open: boolean
  status: StatusDoc | null
  run: RunState | null
  serverAvailable: boolean
  busy: boolean
  message: string
  onClose: () => void
  onCheck: () => void
  onRun: () => void
  onApply: () => void
  formatTime: (iso: string) => string
}) {
  // A live run's own markers take precedence over the last recorded status: while the pipeline is
  // working, the only true account of where it is comes from the process itself.
  const liveSteps = run ? parseRunProgress(run.lines) : []
  const live = !!run?.running && liveSteps.length > 0
  const steps = liveSteps.length ? liveSteps : stepsFromStatus(status)

  return (
    <Modal open={open} title="Update pipeline" onClose={onClose}>
      {status ? (
        <p>
          {`Run ${status.run.number ? `#${status.run.number}` : '(manual)'} on ${
            status.run.runner ?? 'unknown runner'
          } · ${formatTime(status.generatedAt)}`}
          {status.run.seconds ? ` · took ${status.run.seconds}s` : ''}.
        </p>
      ) : (
        <p>
          No status file has been published yet. It is written by the pipeline, so it appears after
          the next run.
        </p>
      )}

      {steps.length ? (
        <>
          <h3>{live ? 'Running now' : 'Orchestration'}</h3>
          <Stepper steps={steps} live={live} />
        </>
      ) : null}

      {/* A run in progress, streamed from the local server. This is the part a static site could
          never do: there was nothing on the other end to ask. */}
      {run && (run.running || run.lines.length) ? (
        <>
          <h3>Output</h3>
          <pre className="run-log">
            {run.lines
              // The progress markers are for the stepper above; repeating them in the log is noise.
              .filter((l) => !l.startsWith('[[stage]] ') && !l.startsWith('[[plan]] '))
              .slice(-14)
              .join('\n')}
          </pre>
          {!run.running && run.exitCode !== null ? (
            <p className="about-note">
              {run.exitCode === 0
                ? 'Finished cleanly.'
                : `Exited with code ${run.exitCode} — a stage failed; see the tree above.`}
            </p>
          ) : null}
        </>
      ) : null}

      <h3>Actions</h3>
      <div className="pipeline-actions">
        <button type="button" className="mini-btn" onClick={onCheck} disabled={busy}>
          Check again
        </button>
        <button type="button" className="mini-btn" onClick={onApply} disabled={busy}>
          Apply to map
        </button>
        {serverAvailable ? (
          <button type="button" className="mini-btn" onClick={onRun} disabled={busy || !!run?.running}>
            {run?.running ? 'Running…' : 'Run update now'}
          </button>
        ) : null}
      </div>
      {message ? <p className="pipeline-warn">{message}</p> : null}
      <p className="about-note">
        {serverAvailable
          ? 'This page is served by the local Node server, so the button runs the pipeline directly on this machine. Runs are serialised and rate-limited so a double-click cannot start two at once.'
          : 'Served as static files, so there is no backend to accept a trigger. Start the server with `npm run serve` to enable the run button, or invoke the pipeline directly.'}
      </p>
    </Modal>
  )
}

export type { Dataset }
