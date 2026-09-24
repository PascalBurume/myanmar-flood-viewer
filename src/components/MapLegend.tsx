import {
  FIELD_LAYERS,
  WIND_CLASSES,
  activeRun,
  findModel,
  legendFor,
  modelForLayer,
  stepStats,
  type FieldState,
  type FieldStep,
} from '../forecastField'
import { formatMMT } from '../time'
import type { ViewKey } from '../view'

/**
 * The key for the forecast field, on the map rather than in the panel.
 *
 * The stops come from the manifest, which is the same table the pipeline classified the pixels
 * with — so the key cannot drift from what is drawn. It is on screen whenever the field is,
 * because a forecast has to carry its model and its run time wherever it is shown, and the map is
 * where it is shown.
 *
 * It also answers the question an empty map raises. The probability layers are blank at most
 * steps — more than a tenth of 51 members agreeing on 25 mm in three hours is rare — and a blank
 * layer with nothing said about it reads as a layer that failed to load. The step's own stats say
 * which it is, and the heaviest class present is marked on the scale.
 */
export function MapLegend({
  field,
  step,
  view,
  onField,
}: {
  field: FieldState
  step: FieldStep | null
  view: ViewKey
  onField: (patch: Partial<FieldState>) => void
}) {
  const manifest = field.manifest
  if (!manifest) return null
  // Hidden from here, the key folds to one line on the Weather view rather than vanishing, so the
  // same place that hid the forecast can bring it back.
  if (!field.on) {
    return view === 'weather' ? (
      <div className="map-legend is-folded" aria-label="Forecast field key">
        <span>Forecast hidden</span>
        <button type="button" className="mini-btn" onClick={() => onField({ on: true })}>
          Show
        </button>
      </div>
    ) : null
  }
  const run = activeRun(manifest, field)
  const model = findModel(manifest, modelForLayer(field.model, field.layer))
  const layer = FIELD_LAYERS.find((l) => l.key === field.layer)
  if (!run || !model) return null

  const legend = legendFor(manifest, field.layer)
  const stats = stepStats(step, field.layer)
  const unit = legend?.unit.replace('% of 51 members', '%') ?? ''
  const peakStop = stats && legend && stats.peak > 0 ? legend.stops[Math.min(stats.peak, legend.stops.length) - 1] : null
  const nextStop = stats && legend && stats.peak > 0 ? legend.stops[stats.peak] : null

  let reading: string | null = null
  if (!step) reading = 'This run does not cover the moment on the timeline.'
  else if (stats && legend) {
    if (stats.peak === 0) {
      // Said for the whole run when it holds for the whole run, so nobody scrubs through fifty
      // empty frames looking for the one that is not.
      const anywhere = run.steps.some((s) => (stepStats(s, field.layer)?.peak ?? 0) > 0)
      const when = anywhere ? 'at this step' : 'at any step of this run'
      reading =
        field.layer === 'precip'
          ? `No block reaches ${legend.stops[0][0]} ${legend.unit} ${when}.`
          : `No block has ${legend.stops[0][0]}% of members over ${field.layer === 'prob25' ? 25 : 50} mm ${when}.`
    } else if (peakStop) {
      const range = nextStop ? `${peakStop[0]}–${nextStop[0]}` : `${peakStop[0]} and over`
      reading = `Heaviest block: ${range} ${unit}${stats.wet < 0.01 ? '' : ` · ${Math.round(stats.wet * 100)}% of the map`}`
    }
  }

  return (
    <div className="map-legend" aria-label="Forecast field key" key={`${model.key}|${field.layer}`}>
      <div className="map-legend-top">
        <p className="map-legend-head">
          {model.label} · <strong>forecast</strong>
        </p>
        <button
          type="button"
          className="legend-eye"
          aria-label="Hide the forecast"
          title="Hide the forecast"
          onClick={() => onField({ on: false })}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M12 5C6.5 5 2.7 9.4 1.6 11.4a1.3 1.3 0 0 0 0 1.2C2.7 14.6 6.5 19 12 19s9.3-4.4 10.4-6.4a1.3 1.3 0 0 0 0-1.2C21.3 9.4 17.5 5 12 5zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8z" fill="currentColor" />
          </svg>
        </button>
      </div>
      <p className="map-legend-sub">
        {run.init ? `Run ${formatMMT(run.init, { short: true })}` : 'Run time not published'}
        {layer ? ` · ${layer.label}` : ''}
      </p>

      {legend ? (
        <div className="rain-scale" aria-label={legend.unit}>
          {legend.stops.map(([value, colour], i) => (
            <div className={`rain-stop${stats && stats.peak === i + 1 ? ' is-peak' : ''}`} key={value}>
              <span style={{ background: colour }} />
              <em>{value}</em>
            </div>
          ))}
          <span className="rain-scale-unit">{unit}</span>
        </div>
      ) : (
        <div className="wind-key" aria-label="Wind speed, km/h">
          {WIND_CLASSES.map((w, i) => (
            <div className="wind-key-row" key={w.min}>
              <svg
                className="wind-key-arrow"
                viewBox="-12 -25 24 50"
                width={10 + i * 2}
                height={20 + i * 4}
                aria-hidden="true"
                style={{ ['--wind-light' as string]: w.light, ['--wind-dark' as string]: w.dark }}
              >
                <path d="M0-24 11-6 3.5-8V22h-7V-8L-11-6z" />
              </svg>
              <em>{w.label} km/h</em>
            </div>
          ))}
          <p className="map-legend-note">Arrows point the way the wind blows; colour and size by speed.</p>
        </div>
      )}

      {/* How strongly the forecast is drawn over the map — "density" in the reader's word for it,
          opacity underneath. Here as well as in the panel because this is where the eye is. */}
      <label className="legend-density">
        <span>Density</span>
        <input
          type="range"
          min={0.15}
          max={1}
          step={0.05}
          value={field.opacity}
          aria-label="Forecast density"
          onChange={(e) => onField({ opacity: Number(e.target.value) })}
        />
        <em>{Math.round(field.opacity * 100)}%</em>
      </label>

      {reading ? (
        <p className={`map-legend-reading${stats && stats.peak === 0 ? ' is-empty' : ''}`}>
          {reading}
        </p>
      ) : null}

      <p className="map-legend-attr">{manifest.attribution}</p>
    </div>
  )
}
