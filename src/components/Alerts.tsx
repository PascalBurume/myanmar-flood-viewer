import { useState } from 'react'

import { liveAlerts, type Alert, type StatusDoc } from '../pipeline'

const ICON: Record<Alert['severity'], string> = {
  critical: '!',
  warning: '!',
  info: 'i',
}

/**
 * What the pipeline raised, plus the one thing only the reader can raise.
 *
 * `liveAlerts` prepends a staleness alert computed against the clock now, rather than a verdict
 * baked into the file when it was written — see `freshness()` for why that distinction is
 * load-bearing rather than pedantic.
 *
 * Nothing is pushed anywhere. These are recorded and displayed; wiring a channel later means
 * reading the same list.
 */
export function Alerts({ status }: { status: StatusDoc | null }) {
  const [open, setOpen] = useState(true)
  const items = liveAlerts(status)
  if (!items.length) return null

  const critical = items.filter((a) => a.severity === 'critical').length
  const shown = open ? items : items.slice(0, 1)

  return (
    <div className="alerts">
      <div className="alerts-head">
        <span className={`alert-count${critical ? ' is-critical' : ''}`}>
          {items.length} alert{items.length === 1 ? '' : 's'}
        </span>
        {items.length > 1 ? (
          <button type="button" className="mini-btn" onClick={() => setOpen((v) => !v)}>
            {open ? 'Collapse' : `Show all ${items.length}`}
          </button>
        ) : null}
      </div>

      {shown.map((a, i) => (
        <div className={`alert alert-${a.severity}`} key={`${a.kind}-${a.date ?? i}`}>
          <span className="alert-icon" aria-hidden="true">
            {ICON[a.severity]}
          </span>
          <div className="alert-body">
            <span className="alert-title">{a.title}</span>
            <span className="alert-detail">{a.detail}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
