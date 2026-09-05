import {
  FIELD_LAYERS,
  FIELD_MODELS,
  activeRun,
  runsFor,
  type FieldLayer,
  type FieldModelKey,
  type FieldState,
} from '../forecastField'
import { formatMMT } from '../time'
import type { RainState } from './Panel'

/**
 * The Weather card, laid out the way Google Weather Lab's controls are: which model, then which of
 * its layers. Two things are deliberate.
 *
 * A model that cannot be shown keeps its row and says what it needs — a reader who has seen
 * WeatherNext elsewhere should learn here that this viewer lacks access to it, not wonder whether
 * they missed a control. And the run's initialisation time is printed wherever there is one, with
 * "run time not published" where there is not: a forecast without its run time is undated, and this
 * project does not print undated figures.
 */
export function WeatherControls({
  field,
  onField,
  rain,
  onRain,
  weathernextReason,
}: {
  field: FieldState
  onField: (patch: Partial<FieldState>) => void
  rain: RainState
  onRain: (v: RainState) => void
  /** Why WeatherNext is unavailable, in the pipeline's own words. */
  weathernextReason: string | null
}) {
  const manifest = field.manifest
  const run = activeRun(manifest, field)
  const runs = runsFor(manifest, field.model, field.layer)

  if (!manifest) {
    return (
      <p className="field-note">
        No forecast field yet — the pipeline has not run the Forecast field stage. Everything else on
        the map is unaffected.
      </p>
    )
  }

  return (
    <div className="wx">
      <div className="controls-card wx-card">
        <label className="toggle wx-master">
          <input type="checkbox" checked={field.on} onChange={(e) => onField({ on: e.target.checked })} />
          <span className="switch" />
          <span className="t-label">Weather</span>
        </label>

        <p className="controls-head">Model</p>
        {FIELD_MODELS.map((m) => {
          const entry = manifest.models.find((x) => x.key === m.key)
          const latest = entry?.runs[0]
          const disabled = Boolean(m.needs) || !entry || !entry.runs.length
          const reason = m.key === 'weathernext' ? (weathernextReason ?? m.needs) : !entry?.runs.length ? 'no run on disk yet' : null
          return (
            <div className={`wx-row${disabled ? ' is-disabled' : ''}`} key={m.key}>
              <label className="radio" title={reason ?? m.desc}>
                <input
                  type="radio"
                  name="wx-model"
                  checked={field.model === m.key && !disabled}
                  disabled={disabled}
                  onChange={() => onField({ model: m.key as FieldModelKey, run: null })}
                />
                <span className="dot" />
                <span className="t-label">{m.label}</span>
                {latest ? (
                  <span className="wx-init">{latest.init ? `init ${formatMMT(latest.init, { short: true })}` : 'run time not published'}</span>
                ) : null}
              </label>
              <p className="layer-desc">{reason ?? m.desc}</p>
            </div>
          )
        })}

        <p className="controls-head">Layers</p>
        {FIELD_LAYERS.map((l) => {
          const entry = manifest.models.find((x) => x.key === (l.model ?? field.model))
          const disabled = !entry || !entry.runs.length
          return (
            <div className={`wx-row${disabled ? ' is-disabled' : ''}`} key={l.key}>
              <label className="radio" title={l.desc}>
                <input
                  type="radio"
                  name="wx-layer"
                  checked={field.layer === l.key && !disabled}
                  disabled={disabled}
                  onChange={() => onField({ layer: l.key as FieldLayer, run: null })}
                />
                <span className="dot" />
                <span className="t-label">{l.label}</span>
              </label>
              <p className="layer-desc">{disabled ? 'no ensemble run on disk yet' : l.desc}</p>
            </div>
          )
        })}

        <input
          className="opacity"
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={field.opacity}
          aria-label="Forecast field opacity"
          onChange={(e) => onField({ opacity: Number(e.target.value) })}
        />
      </div>

      {field.on && rain.on && field.layer === 'precip' ? (
        <p className="field-note wx-both">
          Measured rainfall (GPM IMERG, {rain.date}) is drawn underneath this forecast — two rain
          layers at once.{' '}
          <button type="button" className="mini-btn" onClick={() => onRain({ ...rain, on: false })}>
            Hide the measured layer
          </button>
        </p>
      ) : null}

      <p className="wx-caveat">
        <strong>Forecasts, not observations</strong> — the only such layers in this viewer besides the
        rain and river charts below. A 0.25° global model sampled every 0.5° (about 55 km): the
        blocks are the sampling, not the shape of the weather. Rainfall is the total over each
        three-hour step; probabilities are the share of 51 ensemble members over a threshold, not a
        calibrated chance. No local calibration. For warnings, see the Myanmar Department of
        Meteorology and Hydrology.
      </p>

      <p className="field-note">
        {manifest.attribution}.{' '}
        {run
          ? `${run.init ? `Run initialised ${formatMMT(run.init)}` : 'Run time not published'} · fetched ${formatMMT(run.fetchedAt)} · ${runs.length} run${runs.length === 1 ? '' : 's'} kept.`
          : 'No run on disk for this model.'}
      </p>
    </div>
  )
}
