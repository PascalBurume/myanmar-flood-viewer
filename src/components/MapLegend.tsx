import { FIELD_LAYERS, activeRun, findModel, modelForLayer, type FieldState } from '../forecastField'
import { formatMMT } from '../time'

/**
 * The key for the forecast field, on the map rather than in the panel.
 *
 * The stops come from the manifest, which is the same table the pipeline classified the pixels
 * with — so the key cannot drift from what is drawn. It is on screen whenever the field is,
 * because a forecast has to carry its model and its run time wherever it is shown, and the map is
 * where it is shown.
 */
export function MapLegend({ field }: { field: FieldState }) {
  const manifest = field.manifest
  if (!manifest || !field.on) return null
  const run = activeRun(manifest, field)
  const model = findModel(manifest, modelForLayer(field.model, field.layer))
  const layer = FIELD_LAYERS.find((l) => l.key === field.layer)
  if (!run || !model) return null

  const legend = field.layer === 'precip' ? manifest.legends.precip3h : field.layer === 'wind' ? null : manifest.legends.prob

  return (
    <div className="map-legend" aria-label="Forecast field key">
      <p className="map-legend-head">
        {model.label} · <strong>forecast</strong>
      </p>
      <p className="map-legend-sub">
        {run.init ? `Run ${formatMMT(run.init, { short: true })}` : 'Run time not published'}
        {layer ? ` · ${layer.label}` : ''}
      </p>

      {legend ? (
        <div className="rain-scale" aria-label={legend.unit}>
          {legend.stops.map(([value, colour]) => (
            <div className="rain-stop" key={value}>
              <span style={{ background: colour }} />
              <em>{value}</em>
            </div>
          ))}
          <span className="rain-scale-unit">{legend.unit.replace('% of 51 members', '%')}</span>
        </div>
      ) : (
        <div className="wind-key" aria-label="Wind speed">
          {[10, 30, 60].map((kmh) => (
            <div className="wind-key-row" key={kmh}>
              <span className="wind-key-arrow" style={{ fontSize: `${9 + kmh / 6}px` }}>
                ➤
              </span>
              <em>{kmh} km/h</em>
            </div>
          ))}
          <p className="map-legend-note">Arrows point the way the wind blows.</p>
        </div>
      )}

      <p className="map-legend-attr">{manifest.attribution}</p>
    </div>
  )
}
