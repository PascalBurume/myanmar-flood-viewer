import { EXPOSURE_COLOR } from '../../layers'
import type { ChartSpec } from '../../chat/tools'

/**
 * A chart inside the conversation.
 *
 * Built on the panel's own bar primitives (`.stat-row` / `.stat-track` / `.stat-fill`, and
 * `.trend-bar` for a series) rather than on `Trend` or `TopAffected`. Those two are panel
 * *sections* — each owns its metric state, its segmented controls and its footnotes, and `Trend`
 * mounts a 142-bar horizontal scroller. Dropping either into a 296px bubble would drag all of that
 * along. Nothing here draws its own colours.
 *
 * The `source` line is not decoration: the tool schema refuses to render a chart that cannot name
 * its dataset and observation date.
 */
export function ChatChart({ spec, onZoom }: { spec: ChartSpec; onZoom: (lon: number, lat: number) => void }) {
  const values = spec.rows.map((r) => (typeof r.value === 'number' ? r.value : 0))
  const max = Math.max(...values, 1)
  const color = spec.unit === 'people' ? EXPOSURE_COLOR : 'var(--accent)'

  const fmt = (n: number) => {
    if (spec.unit === 'people' || spec.unit === 'count') return Math.round(n).toLocaleString()
    if (spec.unit === 'km2') return `${Math.round(n).toLocaleString()} km²`
    if (spec.unit === 'mm') return `${n.toFixed(1)} mm`
    if (spec.unit === 'm3s') return `${Math.round(n).toLocaleString()} m³/s`
    if (spec.unit === 'percent') return `${n.toFixed(1)}%`
    return String(n)
  }

  return (
    <figure className="chat-chart">
      <figcaption>{spec.title}</figcaption>

      {spec.chart === 'series' ? (
        <div className="chat-series">
          {spec.rows.map((r, i) => {
            // A withheld figure is drawn hollow at full height. Drawing it as zero would say the
            // day had no flooding, which is the opposite of what the record means.
            const withheld = r.withheld || r.value === null
            return (
              <div
                key={i}
                className={`trend-bar${withheld ? ' is-withheld' : ''}`}
                style={{ height: withheld ? '100%' : `${Math.max(((r.value ?? 0) / max) * 100, 2)}%`, background: withheld ? undefined : color }}
                title={`${r.label}: ${withheld ? 'withheld' : fmt(r.value ?? 0)}`}
              />
            )
          })}
        </div>
      ) : (
        <div className="chat-bars">
          {spec.rows.map((r, i) => {
            const withheld = r.withheld || r.value === null
            const clickable = typeof r.lon === 'number' && typeof r.lat === 'number'
            return (
              <div
                key={i}
                className={`stat-row${clickable ? ' is-clickable' : ''}${r.highlight ? ' is-subject' : ''}`}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onZoom(r.lon as number, r.lat as number) : undefined}
                onKeyDown={
                  clickable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onZoom(r.lon as number, r.lat as number)
                        }
                      }
                    : undefined
                }
              >
                <div className="stat-head">
                  <span className="stat-name">
                    {r.label}
                    {r.sub ? <span className="stat-sub"> {r.sub}</span> : null}
                  </span>
                  <span className="stat-value">{withheld ? 'withheld' : fmt(r.value ?? 0)}</span>
                </div>
                <div className="stat-track">
                  <div
                    className={`stat-fill${withheld ? ' is-withheld' : ''}`}
                    style={{
                      width: withheld ? '100%' : `${((r.value ?? 0) / max) * 100}%`,
                      // The place being asked about is drawn in the accent colour, so a reader can
                      // find it instantly among the ones it is being measured against.
                      background: withheld ? undefined : r.highlight ? 'var(--accent)' : color,
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {spec.caveat ? <p className="chat-chart-caveat">{spec.caveat}</p> : null}
      <p className="chat-chart-source">{spec.source}</p>
    </figure>
  )
}
