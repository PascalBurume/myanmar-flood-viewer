import {
  CYCLONE_LAYERS,
  SSHS_SCALE,
  categoryLabel,
  intensityColor,
  ktToKmh,
  positionAt,
  type CycloneDoc,
  type CycloneLayerKey,
  type CycloneShow,
  type Storm,
} from '../cyclones'
import { formatMMT } from '../time'

/**
 * The panel section for tropical cyclones, laid out the way Google Weather Lab's controls card is:
 * models (which track sources are drawn), layers (what is drawn of them), then the storms.
 *
 * Every row that is off because the data does not exist says why, rather than being hidden — a
 * reader who has seen the ensemble tracks elsewhere should learn here what this viewer lacks and
 * what it would take, not wonder whether they missed a control.
 */
export function Cyclones({
  doc,
  show,
  onShow,
  validTime,
  onZoomStorm,
}: {
  doc: CycloneDoc | null
  show: CycloneShow
  onShow: (key: CycloneLayerKey, on: boolean) => void
  validTime: string | null
  onZoomStorm: (storm: Storm) => void
}) {
  const models = CYCLONE_LAYERS.filter((l) => ['observed', 'forecast', 'ensemble'].includes(l.key))
  const layers = CYCLONE_LAYERS.filter((l) => ['wind', 'cone'].includes(l.key))
  const jtwc = doc?.sources.find((s) => s.key === 'jtwc')
  const accuracy = doc?.storms.map((s) => s.forecast?.warning.accuracyNm).find((a) => a != null)

  return (
    <div className="cy">
      <div className="controls-card">
        <p className="controls-head">Models</p>
        {models.map((l) => (
          <Row key={l.key} layer={l} checked={show[l.key]} onChange={(v) => onShow(l.key, v)} />
        ))}
        <p className="controls-head">Layers</p>
        {layers.map((l) => (
          <Row key={l.key} layer={l} checked={show[l.key]} onChange={(v) => onShow(l.key, v)} />
        ))}
      </div>

      {doc && doc.storms.length ? (
        <ul className="cy-storms">
          {doc.storms.map((storm) => (
            <StormRow key={storm.sid} storm={storm} validTime={validTime} onZoom={() => onZoomStorm(storm)} />
          ))}
        </ul>
      ) : (
        <p className="field-note">
          {doc
            ? `No active storms in the Bay of Bengal or its approaches (${doc.box[0]}–${doc.box[2]}°E, ${doc.box[1]}–${doc.box[3]}°N, observed or forecast) as of ${formatMMT(doc.generatedAt)}. Storms are kept for ${doc.retainDays} days after their last position.`
            : 'No cyclone file yet — the pipeline has not run this stage.'}
        </p>
      )}

      <div className="legend cy-legend" aria-label="Intensity">
        {SSHS_SCALE.filter((s) => s.sshs >= -1).map((s) => (
          <div className="legend-row" key={s.sshs}>
            <span className="legend-chip" style={{ background: s.color }} />
            <span>{s.label}</span>
          </div>
        ))}
        <div className="legend-row">
          <span className="legend-chip cy-legend-forecast" />
          <span>Forecast — dashed, hollow</span>
        </div>
      </div>

      {doc ? (
        <>
          <p className="wx-caveat cy-caveat">
            <strong>Forecast positions are JTWC's official forecast</strong>
            {accuracy != null ? `, from an analysed position stated accurate to within ${accuracy} nm` : ''}
            . Observed positions are provisional and get revised. Nothing here says where a storm
            will make landfall or what it will do — for warnings, see the Myanmar Department of
            Meteorology and Hydrology.
          </p>
          <p className="field-note">
            {doc.attribution}. Fetched {formatMMT(doc.generatedAt)}.
            {jtwc?.state === 'skipped' ? ` JTWC forecasts unavailable this run: ${jtwc.reason ?? 'no reason recorded'}.` : ''}
          </p>
        </>
      ) : null}
    </div>
  )
}

function Row({
  layer,
  checked,
  onChange,
}: {
  layer: (typeof CYCLONE_LAYERS)[number]
  checked: boolean
  onChange: (v: boolean) => void
}) {
  const disabled = Boolean(layer.needs)
  return (
    <div className={`cy-row${disabled ? ' is-disabled' : ''}`}>
      <label className="toggle" title={layer.needs ?? layer.desc}>
        <input
          type="checkbox"
          checked={checked && !disabled}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch" />
        <span className="t-label">{layer.label}</span>
      </label>
      <p className="layer-desc">{disabled ? layer.needs : layer.desc}</p>
    </div>
  )
}

function StormRow({ storm, validTime, onZoom }: { storm: Storm; validTime: string | null; onZoom: () => void }) {
  const last = storm.observed[storm.observed.length - 1] ?? null
  const at = validTime ? positionAt(storm, validTime) : null
  const shown = at ?? (last ? { ...last, isForecast: false } : null)
  const fc = storm.forecast
  return (
    <li className="cy-storm">
      <div className="cy-storm-head">
        <span className="legend-chip" style={{ background: intensityColor(shown?.sshs ?? null, shown?.windKt ?? null) }} />
        <strong>{storm.name.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase())}</strong>
        <span className="cy-basin">{storm.basin === 'NI' ? 'Bay of Bengal' : 'West Pacific'}</span>
        <button type="button" className="mini-btn" onClick={onZoom}>
          Zoom
        </button>
      </div>
      {shown ? (
        <p className={`cy-storm-line${shown.isForecast ? ' is-forecast' : ''}`}>
          {shown.isForecast ? 'Forecast' : 'Observed'} {formatMMT(shown.t, { short: true })}:{' '}
          {shown.lat.toFixed(1)}°N {shown.lon.toFixed(1)}°E
          {shown.windKt != null ? ` · ${shown.windKt} kt (${ktToKmh(shown.windKt)} km/h), ${categoryLabel(shown.sshs, shown.windKt).toLowerCase()}` : ''}
          {shown.presHpa != null ? ` · ${shown.presHpa} hPa` : ''}
        </p>
      ) : null}
      <p className="cy-storm-meta">
        {last ? `Last observed ${formatMMT(last.t, { short: true })}` : 'No observed positions yet'}
        {storm.peakWindKt ? ` · peak ${storm.peakWindKt} kt` : ''}
        {fc
          ? ` · ${fc.agency} forecast issued ${formatMMT(fc.issued, { short: true })}, ${fc.points.length} steps to +${fc.points[fc.points.length - 1]?.tauH ?? 0} h`
          : ' · no current forecast'}
      </p>
    </li>
  )
}
