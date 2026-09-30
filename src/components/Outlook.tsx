import { useEffect, useMemo, useRef, useState } from 'react'

import {
  LEVEL_COLOR,
  LEVEL_INK,
  cap,
  impactLine,
  likelihoodLine,
  type Impact,
  type Level,
  type OutlookDoc,
  type OutlookTownship,
} from '../outlook'
import { formatMMT } from '../time'

/**
 * The Outlook view's pane, in the blocks the Panel lays out.
 *
 * Every figure carries a superscript that points at a numbered source at the bottom, which is the
 * panel's standing rule. The Outlook needs it more than any other block: one row mixes a forecast
 * (¹ or ³) with an observation (⁴), and the reader has to be able to tell which is which.
 */

const SUP = { ens: '¹', amounts: '²', rivers: '³', history: '⁴' } as const

function Chip({ level }: { level: Level | null }) {
  if (!level) return <span className="ol-chip is-unknown">No level</span>
  return (
    <span className="ol-chip" style={{ background: LEVEL_COLOR[level], color: LEVEL_INK[level] }}>
      {cap(level)}
    </span>
  )
}

/** When, and what kind of claim this is, before any number. */
export function OutlookHeader({ doc }: { doc: OutlookDoc | null }) {
  if (!doc) {
    return (
      <p className="notice">
        No outlook yet. The pipeline builds one after the forecast field and the river forecast have
        been read; run an update to create it.
      </p>
    )
  }
  const { counts } = doc
  const levels: Level[] = ['high', 'medium', 'low', 'very low']
  return (
    <>
      <p className="notice ol-notice">
        <strong>A forecast-derived triage, not a warning.</strong> Each township is placed by how
        many of 51 forecast scenarios bring heavy rain or a high river{SUP.ens}
        {SUP.rivers} (likelihood), against the most people radar has seen under water there
        since 2022{SUP.history} (impact). For warnings, refer to Myanmar's Department of
        Meteorology and Hydrology.
      </p>
      <p className="ol-window">{`${formatMMT(doc.window.from, { short: true })} → ${formatMMT(doc.window.to, { short: true })}`}</p>
      <div className="summary-band ol-counts">
        {levels.map((lv) => (
          <div className="summary-cell" key={lv}>
            <span className="summary-value">
              <span className="ol-dot" style={{ background: LEVEL_COLOR[lv] }} aria-hidden="true" />
              {counts[lv]}
            </span>
            <span className="summary-label">{cap(lv)}</span>
          </div>
        ))}
      </div>
      {counts.unknown ? (
        <p className="stat-source">{`${counts.unknown} township${counts.unknown === 1 ? '' : 's'} with no usable population record carry no level.`}</p>
      ) : null}
    </>
  )
}

export type MatrixCell = { lk: Level; im: Impact } | null

/**
 * Likelihood × impact. Each cell is tinted with the level it maps to and holds how many townships
 * fall in it. Clicking one filters the list. The matrix is drawn from the file's own `method`, so
 * the rule on screen is the rule that placed the townships.
 */
export function OutlookMatrix({ doc, cell, onCell }: { doc: OutlookDoc | null; cell: MatrixCell; onCell: (c: MatrixCell) => void }) {
  if (!doc) return null
  const { likelihoods, impacts, matrix, likelihoodBands, impactBands } = doc.method
  const rows = [...likelihoods].reverse()
  // Each band by its lower bound, the bottom one by its upper: "≥ 1k" is unambiguous where a range
  // written out ("1k–9.999k") is not, and the columns already read in order.
  const lkLabel = (lk: Level) => {
    const i = likelihoodBands.findIndex(([, n]) => n === lk)
    return i === likelihoodBands.length - 1 ? `< ${likelihoodBands[i - 1][0]}%` : `≥ ${likelihoodBands[i][0]}%`
  }
  const k = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n))
  const imLabel = (im: Impact) => {
    const i = impactBands.findIndex(([, n]) => n === im)
    return i === impactBands.length - 1 ? `< ${k(impactBands[i - 1][0])}` : `≥ ${k(impactBands[i][0])}`
  }
  return (
    <div className="ol-matrix" role="grid" aria-label="Likelihood by impact">
      <div className="ol-axis ol-axis-y">Likelihood · share of scenarios</div>
      <div className="ol-grid" style={{ gridTemplateColumns: `auto repeat(${impacts.length}, 1fr)` }}>
        <span />
        {impacts.map((im) => (
          <span className="ol-col-head" key={im}>
            {cap(im)}
            <small>{imLabel(im)}</small>
          </span>
        ))}
        {rows.map((lk) => (
          <div className="ol-row" role="row" key={lk} style={{ display: 'contents' }}>
            <span className="ol-row-head">
              {cap(lk)}
              <small>{lkLabel(lk)}</small>
            </span>
            {impacts.map((im, j) => {
              const lv = matrix[lk][j]
              const n = doc.grid[lk]?.[j] ?? 0
              const on = cell?.lk === lk && cell?.im === im
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={im}
                  className={`ol-cell${on ? ' is-on' : ''}${n ? '' : ' is-empty'}`}
                  style={{ ['--cell' as string]: LEVEL_COLOR[lv] }}
                  aria-pressed={on}
                  title={`${cap(lk)} likelihood, ${im} impact → ${lv}: ${n} township${n === 1 ? '' : 's'}`}
                  onClick={() => onCell(on ? null : { lk, im })}
                >
                  {n || '·'}
                </button>
              )
            })}
          </div>
        ))}
      </div>
      <div className="ol-axis ol-axis-x">Impact · most people seen under water on one pass</div>
    </div>
  )
}

const PAGE = 25

/** The ranked townships, each with the two figures that placed it. */
export function OutlookList({
  doc,
  cell,
  selected,
  onSelect,
}: {
  doc: OutlookDoc | null
  cell: MatrixCell
  selected: number | null
  onSelect: (i: number | null) => void
}) {
  const [all, setAll] = useState(false)
  const rowRefs = useRef(new Map<number, HTMLDivElement>())
  const rows = useMemo(() => {
    if (!doc) return []
    const indexed = doc.townships.map((t, i) => ({ t, i }))
    if (cell) return indexed.filter(({ t }) => t.likelihood.band === cell.lk && t.impact?.band === cell.im)
    return indexed.filter(({ t }) => t.level && t.level !== 'very low')
  }, [doc, cell])

  // A township picked on the map is brought into view in the list, so the two stay one reading.
  const shown = all ? rows : rows.slice(0, PAGE)
  const selectedHidden = selected !== null && !shown.some((r) => r.i === selected)
  useEffect(() => {
    if (selected === null) return
    if (selectedHidden && rows.some((r) => r.i === selected)) setAll(true)
    rowRefs.current.get(selected)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selected, selectedHidden, rows])

  if (!doc) return null
  const picked = selected !== null ? doc.townships[selected] : null
  return (
    <div className="ol-list">
      {picked && !rows.some((r) => r.i === selected) ? (
        <TownshipRow t={picked} i={selected!} rank={null} doc={doc} selected onSelect={onSelect} rowRefs={rowRefs} />
      ) : null}
      {rows.length === 0 ? (
        <p className="stat-source">
          {cell ? 'No township falls in that cell.' : 'Every township is very low for this window: no scenario-backed signal of heavy rain or a high river.'}
        </p>
      ) : null}
      {shown.map(({ t, i }, k) => (
        <TownshipRow key={i} t={t} i={i} rank={k + 1} doc={doc} selected={i === selected} onSelect={onSelect} rowRefs={rowRefs} />
      ))}
      {rows.length > PAGE ? (
        <button type="button" className="mini-btn ol-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  )
}

function TownshipRow({
  t,
  i,
  rank,
  doc,
  selected,
  onSelect,
  rowRefs,
}: {
  t: OutlookTownship
  i: number
  rank: number | null
  doc: OutlookDoc
  selected: boolean
  onSelect: (i: number | null) => void
  rowRefs: React.MutableRefObject<Map<number, HTMLDivElement>>
}) {
  const lk = t.likelihood
  const days = doc.window.hours / 24
  return (
    <div
      className={`stat-row stat-clickable ol-row-item${selected ? ' is-selected' : ''}`}
      ref={(el) => {
        if (el) rowRefs.current.set(i, el)
        else rowRefs.current.delete(i)
      }}
      tabIndex={0}
      title={`Show ${t.name} on the map`}
      aria-current={selected || undefined}
      onClick={() => onSelect(selected ? null : i)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(selected ? null : i)
        }
      }}
    >
      <div className="stat-head">
        <span className="stat-name">
          {rank !== null ? <span className="rank">{rank}</span> : null}
          {t.name}
          <span className="rank-sub">{t.region}</span>
        </span>
        <Chip level={t.level} />
      </div>
      <p className="ol-why">
        {likelihoodLine(t, doc)}
        {lk.driver === 'rain' && lk.rain.veryHeavy ? ` (${lk.rain.veryHeavy} a ≥ ${doc.method.veryHeavyMm} mm day)` : ''}
        {lk.driver === 'river' ? SUP.rivers : SUP.ens}
      </p>
      <p className="ol-why">
        {impactLine(t)}
        {t.impact ? SUP.history : ''}
      </p>
      {selected && t.rain && t.rain.total !== null ? (
        <p className="ol-why is-soft">
          {`ECMWF at this cell: ${t.rain.total} mm over ${days} days, wettest day ${t.rain.wettest24} mm`}
          {SUP.amounts}
          {lk.driver === 'rain' && lk.river ? ` · river: ${lk.river.members} of ${lk.river.of} over the 2-year flow at ${lk.river.gauge}` : ''}
          {lk.driver === 'river' ? ` · rain: ${lk.rain.members} of ${lk.rain.of} scenarios bring a heavy day` : ''}
        </p>
      ) : null}
    </div>
  )
}

/** The eight gauges against their own 2-year flow. */
export function OutlookRivers({ doc }: { doc: OutlookDoc | null }) {
  if (!doc) return null
  if (!doc.gauges.length) {
    return <p className="stat-source">River thresholds have not been built yet (scripts/river_climatology.py), so only rain sets the likelihood.</p>
  }
  const gauges = [...doc.gauges].sort((a, b) => (b.ensemble?.over2 ?? 0) - (a.ensemble?.over2 ?? 0))
  return (
    <div className="ol-rivers">
      {gauges.map((g) => {
        const e = g.ensemble
        const share = e && e.members ? e.over2 / e.members : 0
        return (
          <div className="stat-row" key={g.name}>
            <div className="stat-head">
              <span className="stat-name">{g.name}</span>
              <span className="stat-value">{e ? `${e.over2} / ${e.members}` : 'n/a'}</span>
            </div>
            <div className="stat-track">
              <div className="stat-fill" style={{ width: `${share * 100}%`, background: LEVEL_COLOR[share >= 0.6 ? 'high' : share >= 0.4 ? 'medium' : share >= 0.2 ? 'low' : 'very low'] }} />
            </div>
            <p className="ol-why is-soft">
              {`2-year flow ${g.returnFlow['2'].toLocaleString('en-US')} m³/s`}
              {g.peakAhead ? ` · forecast peak ${g.peakAhead.toLocaleString('en-US')} on ${g.peakDate}` : ''}
              {SUP.rivers}
            </p>
          </div>
        )
      })}
      <p className="stat-source">Scenarios (of 51 GloFAS members) reaching the 2-year flow on any day of the window.</p>
    </div>
  )
}

/** Where each numbered figure came from, and what the method cannot see. */
export function OutlookSources({ doc }: { doc: OutlookDoc | null }) {
  if (!doc) return null
  const s = doc.sources
  const when = (iso: string | null | undefined) => (iso ? formatMMT(iso, { short: true }) : 'run time not published')
  return (
    <div className="ol-sources">
      <ol className="ol-source-list">
        <li>
          <span className="ol-sup">{SUP.ens}</span>
          {`${s.ensemble.label}, run ${when(s.ensemble.init)}. A scenario counts when its wettest 24 h in the window reaches ${doc.method.heavyMm} mm at the township's ${s.ensemble.cellDeg}° cell. ${doc.method.thresholdSource}`}
        </li>
        {s.amounts ? (
          <li>
            <span className="ol-sup">{SUP.amounts}</span>
            {`${s.amounts.label}, run ${when(s.amounts.init)}, at the township's ${s.amounts.cellDeg}° cell.`}
          </li>
        ) : null}
        {s.rivers ? (
          <li>
            <span className="ol-sup">{SUP.rivers}</span>
            {`${s.rivers.label}. Applies within ${doc.method.riverKm} km of one of ${s.rivers.gauges} gauge cells. Read ${when(s.rivers.generatedAt)}.`}
          </li>
        ) : null}
        <li>
          <span className="ol-sup">{SUP.history}</span>
          {`${s.history.label}: ${s.history.services.length} products, ${s.history.from} to ${s.history.to}. ${s.history.withheldObservations} observations with implausible population figures are withheld, as in the trend chart.`}
        </li>
      </ol>
      <p className="stat-source">{doc.method.matrixSource}</p>
      <ul className="ol-caveats">
        {doc.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p className="stat-source">{`Built ${formatMMT(doc.generatedAt, { short: true })}.`}</p>
    </div>
  )
}

/** The whole pane's state that crosses blocks: which matrix cell filters the list. */
export function useMatrixCell() {
  return useState<MatrixCell>(null)
}
