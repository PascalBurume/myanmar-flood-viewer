import { useRef, useState } from 'react'

import {
  EARLY_COLOR,
  EXPOSURE_COLOR,
  EXTENT_COLOR,
  LAYER_KINDS,
  WATER_COLOR,
  datasetName,
  type DataIndex,
  type Dataset,
  type KindKey,
} from '../layers'
import type { Theme } from '../theme'
import { TopAffected, nationalTotals, observedRange, type Place } from './TopAffected'
import { Assistant } from './chat/Assistant'
import type { ChatContext } from '../chat/tools'
import { Trend, type History } from './Trend'
import { Cyclones } from './Cyclones'
import { WeatherControls } from './WeatherControls'
import type { FieldState } from '../forecastField'
import type { CycloneDoc, CycloneLayerKey, CycloneShow, Storm } from '../cyclones'
import { Weather, type WeatherDoc } from './Weather'
import { defaultRainDate } from '../basemap'

export interface RainState {
  on: boolean
  date: string
  opacity: number
}

function shiftDay(iso: string, by: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

// The product's own colour ramp, read from NASA's GPM_Precipitation_Rate colour map rather than
// invented, so the key matches the pixels exactly. The scale is logarithmic — the steps are 0.1,
// 0.5, 1, 2.5, 5, 10, 25, 50 — which is why heavy rain is not simply "twice as red" as light.
const RAIN_SCALE: Array<[string, string]> = [
  ['rgb(0,118,78)', '0.1'],
  ['rgb(78,195,0)', '0.5'],
  ['rgb(195,228,0)', '1'],
  ['rgb(255,144,17)', '2.5'],
  ['rgb(255,66,51)', '5'],
  ['rgb(231,0,0)', '10'],
  ['rgb(131,0,0)', '25'],
  ['rgb(57,0,0)', '50'],
]

/**
 * Measured rainfall over the map, on its own date.
 *
 * Kept separate from the imagery-date control because the two lag differently: reflectance imagery
 * is up to yesterday, IMERG is assembled about two days back and returns 404 rather than an empty
 * tile if asked for a day it has not built. Sharing one date would silently blank the rain whenever
 * the reader stepped the imagery to yesterday.
 */
function RainControl({ rain, onRain }: { rain: RainState; onRain: (v: RainState) => void }) {
  return (
    <div className="rain-control">
      <Toggle
        label="Rainfall (measured)"
        checked={rain.on}
        onChange={(on) => onRain({ ...rain, on })}
      />
      {rain.on ? (
        <>
          <div className="imagery-date">
            <button
              type="button"
              className="icon-btn"
              aria-label="Previous day"
              onClick={() => onRain({ ...rain, date: shiftDay(rain.date, -1) })}
            >
              &lsaquo;
            </button>
            <input
              type="date"
              value={rain.date}
              max={defaultRainDate()}
              onChange={(e) => e.target.value && onRain({ ...rain, date: e.target.value })}
              aria-label="Rainfall date"
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Next day"
              disabled={rain.date >= defaultRainDate()}
              onClick={() => onRain({ ...rain, date: shiftDay(rain.date, 1) })}
            >
              &rsaquo;
            </button>
          </div>
          <input
            className="opacity"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={rain.opacity}
            aria-label="Rainfall opacity"
            onChange={(e) => onRain({ ...rain, opacity: Number(e.target.value) })}
          />
          <div className="rain-scale" aria-label="Rainfall rate, mm per hour">
            {RAIN_SCALE.map(([colour, label]) => (
              <div className="rain-stop" key={label}>
                <span style={{ background: colour }} />
                <em>{label}</em>
              </div>
            ))}
            <span className="rain-scale-unit">mm/hr</span>
          </div>
          <p className="field-note">
            GPM IMERG precipitation rate, as the satellites recorded it &mdash; an observation, not a
            forecast. Step it back to the day a flood was detected to see the rain that caused it.
            The scale is logarithmic, so the step from red to dark red is a far bigger jump than
            green to yellow. Gridded and coarse by design: it stops sharpening past about zoom 6.
          </p>
        </>
      ) : null}
    </div>
  )
}

/** A checkbox styled as a switch. The input stays in the DOM for keyboard and screen-reader use. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" />
      <span className="t-label">{label}</span>
    </label>
  )
}

function Field({
  label,
  action,
  children,
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        {action ? <div className="field-actions">{action}</div> : null}
      </div>
      {children}
    </div>
  )
}

function Legend({ index }: { index: DataIndex }) {
  const has = (k: KindKey) => index.datasets.some((d) => d.layers[k])
  const rows: Array<[string, string]> = []
  if (has('waterextent')) rows.push([WATER_COLOR, 'All surface water (incl. permanent)'])
  if (has('floodextentearly')) rows.push([EARLY_COLOR, 'Flood water, earlier pass'])
  if (has('floodextent')) rows.push([EXTENT_COLOR, 'Detected flood water (extent only)'])
  if (has('exposure')) rows.push([EXPOSURE_COLOR, 'People exposed — circle size'])
  return (
    <div className="legend">
      {rows.map(([color, text]) => (
        <div className="legend-row" key={text}>
          <span className="legend-chip" style={{ background: color }} />
          <span>{text}</span>
        </div>
      ))}
    </div>
  )
}

function LayerToggles({
  index,
  kindVisible,
  kindOpacity,
  onVisible,
  onOpacity,
}: {
  index: DataIndex
  kindVisible: Record<string, boolean>
  kindOpacity: Record<string, number>
  onVisible: (k: KindKey, v: boolean) => void
  onOpacity: (k: KindKey, v: number) => void
}) {
  return (
    <div className="toggles">
      {LAYER_KINDS.filter((kind) => index.datasets.some((d) => d.layers[kind.key])).map((kind) => (
        <div className="layer-item" key={kind.key}>
          <Toggle
            label={kind.label}
            checked={kindVisible[kind.key] ?? true}
            onChange={(v) => onVisible(kind.key, v)}
          />
          <p className="layer-desc">{kind.desc}</p>
          {kind.opacity ? (
            <div className="layer-opacity">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                aria-label={`${kind.label} opacity`}
                value={Math.round((kindOpacity[kind.key] ?? 0.7) * 100)}
                onChange={(e) => onOpacity(kind.key, Number(e.target.value) / 100)}
              />
              <span className="op-val">{Math.round((kindOpacity[kind.key] ?? 0.7) * 100)}%</span>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function LocationList({
  index,
  datasetVisible,
  onVisible,
  onZoom,
}: {
  index: DataIndex
  datasetVisible: Record<string, boolean>
  onVisible: (id: string, v: boolean) => void
  onZoom: (ds: Dataset) => void
}) {
  return (
    <div className="toggles">
      {index.datasets.map((ds) => (
        <div className="layer-item ds-item" key={ds.id}>
          <Toggle
            label={datasetName(ds)}
            checked={datasetVisible[ds.id] ?? true}
            onChange={(v) => onVisible(ds.id, v)}
          />
          {ds.bbox ? (
            <button
              type="button"
              className="mini-btn"
              title={`Zoom to ${datasetName(ds)}`}
              onClick={() => onZoom(ds)}
            >
              Zoom
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * Per-location figures as a ranked bar list. Bars are scaled against the largest value present
 * rather than against 100, so the comparison stays readable whatever range the figures span.
 */
/** A statistic handed to the assistant, with everything needed to talk about it. */
export interface ExplainRequest {
  id: number
  dataset: string
  label: string
  value: number
  unit: string
  source: string | null
}

function Stats({
  index,
  onZoom,
  onExplain,
}: {
  index: DataIndex
  onZoom: (ds: Dataset) => void
  onExplain: (req: Omit<ExplainRequest, 'id'>) => void
}) {
  const rows = index.datasets.flatMap((ds) => (ds.stats ?? []).map((stat) => ({ ds, stat })))
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.stat.value))
  // Numbered rather than merely listed. These rows come from three different places — a nationwide
  // AI detection, a WFP impact table, and a set of figures whose provenance was never established —
  // and a flat list at the bottom left no way to tell which number came from which. A reader
  // deciding how much to trust "53.3%" has to be able to find that it is the unsourced one.
  const sources = [...new Set(rows.map((r) => r.stat.source).filter(Boolean))] as string[]
  const cite = (src?: string) => (src ? sources.indexOf(src) + 1 : 0)
  const sorted = [...rows].sort((a, b) => b.stat.value - a.stat.value)

  return (
    <div className="stats">
      {sorted.map(({ ds, stat }) => (
        <div
          className={`stat-row${ds.bbox ? ' stat-clickable' : ''}`}
          key={`${ds.id}-${stat.label}`}
          tabIndex={ds.bbox ? 0 : undefined}
          title={ds.bbox ? `Zoom to ${datasetName(ds)}` : undefined}
          onClick={() => ds.bbox && onZoom(ds)}
          onKeyDown={(e) => {
            if (ds.bbox && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              onZoom(ds)
            }
          }}
        >
          <div className="stat-head">
            {/* The marker sits outside .stat-name: that span truncates with an ellipsis, which
                would swallow the very thing it is there to make visible. */}
            <span className="stat-name">{`${datasetName(ds)} — ${stat.label}`}</span>
            {stat.unverified ? (
              <span
                className="stat-unverified"
                title="No established source. See the numbered note below — this figure disagrees with the measured data in this viewer."
              >
                unverified
              </span>
            ) : null}
            {cite(stat.source) ? <sup className="stat-cite">{cite(stat.source)}</sup> : null}
            <span className="stat-value">{`${stat.value.toLocaleString()}${stat.unit ?? ''}`}</span>
            <button
              type="button"
              className="stat-explain"
              title="Ask the assistant about this figure"
              aria-label={`Explain ${stat.label}`}
              onClick={(e) => {
                // The row itself zooms the map. Without this the reader would get both.
                e.stopPropagation()
                onExplain({
                  dataset: datasetName(ds),
                  label: stat.label,
                  value: stat.value,
                  unit: stat.unit ?? '',
                  source: stat.source ?? null,
                })
              }}
            >
              ?
            </button>
          </div>
          <div className="stat-track">
            <div className="stat-fill" style={{ width: `${max > 0 ? (stat.value / max) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
      {sources.map((src, i) => (
        <p className="stat-source" key={src}>
          <sup className="stat-cite">{i + 1}</sup> {src}
        </p>
      ))}
    </div>
  )
}

export function Panel({
  index,
  theme,
  kindVisible,
  kindOpacity,
  datasetVisible,
  onKindVisible,
  onKindOpacity,
  onDatasetVisible,
  onZoom,
  onToggleTheme,
  onOpenAbout,
  onOpenPipeline,
  pipelineSummary,
  footer,
  places,
  onZoomTo,
  history,
  weather,
  rain,
  onRain,
  cyclones,
  cycloneShow,
  onCycloneShow,
  validTime,
  onZoomStorm,
  view,
  onView,
  field,
  onField,
  weathernextReason,
  chat,
  onRunPipeline,
  runBusy,
  onFitAll,
  picked,
  onClearPicked,
}: {
  index: DataIndex
  theme: Theme
  kindVisible: Record<string, boolean>
  kindOpacity: Record<string, number>
  datasetVisible: Record<string, boolean>
  onKindVisible: (k: KindKey, v: boolean) => void
  onKindOpacity: (k: KindKey, v: number) => void
  onDatasetVisible: (id: string, v: boolean) => void
  onZoom: (ds: Dataset) => void
  onToggleTheme: () => void
  onOpenAbout: () => void
  onOpenPipeline: () => void
  pipelineSummary: React.ReactNode
  footer: React.ReactNode
  places: Place[]
  onZoomTo: (lon: number, lat: number) => void
  history: History | null
  weather: WeatherDoc | null
  rain: RainState
  onRain: (v: RainState) => void
  cyclones: CycloneDoc | null
  cycloneShow: CycloneShow
  onCycloneShow: (k: CycloneLayerKey, v: boolean) => void
  validTime: string | null
  onZoomStorm: (storm: Storm) => void
  view: 'floods' | 'weather'
  onView: (v: 'floods' | 'weather') => void
  field: FieldState
  onField: (patch: Partial<FieldState>) => void
  weathernextReason: string | null
  chat: ChatContext
  onRunPipeline: () => void
  runBusy: boolean
  onFitAll: () => void
  picked: { lon: number; lat: number; label: string } | null
  onClearPicked: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [tab, setTab] = useState<'layers' | 'assistant'>('layers')
  /** A statistic the reader asked about. The counter lets the same one be asked about twice. */
  const [explain, setExplain] = useState<ExplainRequest | null>(null)
  const explainSeq = useRef(0)
  const totals = nationalTotals(places)
  const observed = observedRange(places)
  const group = index.datasets.find((d) => d.group)?.group

  return (
    <section id="panel" className={`panel${collapsed ? ' collapsed' : ''}`} aria-label="Control panel">
      <header className="panel-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            🌊
          </span>
          <h1>Myanmar Floods</h1>
        </div>
        {/* One map, two readings of it: what the water has done, and what the weather is about to
            do. Kept in the header so it stays reachable when the panel is collapsed. */}
        <div className="view-switch seg" role="tablist" aria-label="View">
          {(['floods', 'weather'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              className={`seg-btn${view === v ? ' is-on' : ''}`}
              aria-selected={view === v}
              onClick={() => onView(v)}
            >
              {v === 'floods' ? 'Floods' : 'Weather'}
            </button>
          ))}
        </div>
        <div className="head-actions">
          {/* Always reachable, and now load-bearing: the assistant can move the camera, and the map
              writes its position into the URL hash, so a tool call that zooms somewhere becomes the
              view the page reopens on. Without a way back, a reader can be left looking at an empty
              corner of the country wondering where the data went. */}
          <button
            className="icon-btn"
            type="button"
            title="Show all data"
            aria-label="Show all data"
            onClick={onFitAll}
          >
            ⤢
          </button>
          <button
            className="icon-btn"
            type="button"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-label="Switch theme"
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button
            className="icon-btn"
            type="button"
            title="Toggle panel"
            aria-label="Toggle panel"
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? '▾' : '▴'}
          </button>
        </div>
      </header>

      <div className="panel-tabs" role="tablist" aria-label="Panel sections">
        {(['layers', 'assistant'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            onClick={() => setTab(key)}
          >
            {key === 'layers' ? (view === 'weather' ? 'Controls' : 'Layers') : 'Assistant'}
          </button>
        ))}
      </div>

      {/* Both panes stay mounted and are hidden rather than unmounted. Remounting would reset the
          layers scroll position and re-fire Trend's scroll-to-right effect on every tab switch. */}
      {/* A third pane rather than swapped contents: it is a `panel-body` like the others, so the
            [hidden] override and the collapsed-panel rule already cover it, and each view keeps its
            own scroll position across a switch. */}
      <div
          className="panel-body"
          id="panel-weather"
          role="tabpanel"
          aria-labelledby="tab-layers"
          hidden={view !== 'weather' || tab !== 'layers'}
        >
          <Field label="Weather">
            <WeatherControls
              field={field}
              onField={onField}
              rain={rain}
              onRain={onRain}
              weathernextReason={weathernextReason}
            />
          </Field>

          <Field label="Tropical cyclones">
            <Cyclones
              doc={cyclones}
              show={cycloneShow}
              onShow={onCycloneShow}
              validTime={validTime}
              onZoomStorm={onZoomStorm}
            />
          </Field>

          <Field label="Data &amp; updates">{pipelineSummary}</Field>
        </div>

      <div className="panel-body" id="panel-layers" role="tabpanel" aria-labelledby="tab-layers" hidden={view !== 'floods' || tab !== 'layers'}>
        <p className="notice">
          Two things at once. <strong>Nationwide</strong>: UNOSAT's AI detector over Sentinel-1,
          giving people exposed per township for the whole country, days old. <strong>Four
          regions</strong>: hand-traced flood outlines, precise but historical. Radar misses water
          under dense vegetation and inside buildings, population is modelled from WorldPop, and no
          layer here carries depth. Preliminary — not a statutory hazard map.
        </p>

        {totals.places ? (
          <div className="summary-band">
            <div className="summary-cell">
              <span className="summary-value">{totals.people.toLocaleString()}</span>
              <span className="summary-label">people exposed</span>
            </div>
            <div className="summary-cell">
              <span className="summary-value">{Math.round(totals.flooded).toLocaleString()}</span>
              <span className="summary-label">km² flooded</span>
            </div>
            <div className="summary-cell">
              <span className="summary-value">{Math.round(totals.cropland).toLocaleString()}</span>
              <span className="summary-label">km² cropland</span>
            </div>
            <div className="summary-cell">
              <span className="summary-value">{totals.places.toLocaleString()}</span>
              <span className="summary-label">townships</span>
            </div>
            {/* The biggest numbers on the page had nothing on them saying when they were true. */}
            {observed ? <p className="summary-observed">{`Observed ${observed} · UNOSAT FloodAI`}</p> : null}
          </div>
        ) : null}

        <Field label="Legend">
          <Legend index={index} />
        </Field>

        <Field label="Layers">
          <LayerToggles
            index={index}
            kindVisible={kindVisible}
            kindOpacity={kindOpacity}
            onVisible={onKindVisible}
            onOpacity={onKindOpacity}
          />
        </Field>

        <Field label="Locations">
          <LocationList
            index={index}
            datasetVisible={datasetVisible}
            onVisible={onDatasetVisible}
            onZoom={onZoom}
          />
        </Field>

        <Field label="Rainfall on the map">
          <RainControl rain={rain} onRain={onRain} />
        </Field>

        <Field label="Tropical cyclones">
          <Cyclones
            doc={cyclones}
            show={cycloneShow}
            onShow={onCycloneShow}
            validTime={validTime}
            onZoomStorm={onZoomStorm}
          />
        </Field>

        {weather ? (
          <Field label="Forecast">
            <Weather doc={weather} />
          </Field>
        ) : null}

        {history?.series.length ? (
          <Field label="Trend">
            <Trend history={history} />
          </Field>
        ) : null}

        {places.length ? (
          <Field label="Worst affected">
            <TopAffected places={places} onZoom={onZoomTo} />
          </Field>
        ) : null}

        {index.datasets.some((d) => d.stats?.length) ? (
          <Field
            label="Statistics"
            action={
              group ? (
                <button className="mini-btn" type="button" onClick={onOpenAbout}>
                  {`About ${group}`}
                </button>
              ) : undefined
            }
          >
            <Stats
              index={index}
              onZoom={onZoom}
              onExplain={(req) => {
                explainSeq.current += 1
                setExplain({ ...req, id: explainSeq.current })
                // Move the reader to the answer rather than leaving them to find the tab.
                setTab('assistant')
              }}
            />
          </Field>
        ) : null}

        <Field
          label="Data &amp; updates"
          action={
            <button className="mini-btn" type="button" onClick={onOpenPipeline}>
              Details
            </button>
          }
        >
          <div className="pipeline-summary">{pipelineSummary}</div>
        </Field>
      </div>

      <div id="panel-assistant" role="tabpanel" aria-labelledby="tab-assistant" hidden={tab !== 'assistant'} className="panel-pane">
        <Assistant
          ctx={chat}
          onRunPipeline={onRunPipeline}
          runBusy={runBusy}
          picked={picked}
          onClearPicked={onClearPicked}
          explain={explain}
        />
      </div>

      <footer className="panel-foot">{footer}</footer>
    </section>
  )
}
