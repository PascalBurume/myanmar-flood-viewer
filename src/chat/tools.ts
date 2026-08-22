/**
 * The tools the assistant can call, and the envelope every one of them returns.
 *
 * All of them run here in the browser, not on the server. Two reasons, and both are load-bearing:
 * the tools that move the map act on React state that only exists here, and the tools that compute
 * figures call the very same functions the panel renders from. A second implementation on the
 * server would be free to drift, and then the assistant and the panel could quietly disagree about
 * "worst affected" with no way for a reader to tell which to believe.
 */

import {
  findPlaces,
  nationalTotals,
  rankPlaces,
  type Measure,
  type Place,
} from '../components/TopAffected'
import {
  historyGaps,
  trendFacts,
  windowSeries,
  type History,
  type Metric,
  type Observation,
} from '../components/Trend'
import { riverFacts, sortedRain, sortedRivers, type WeatherDoc } from '../components/Weather'
import { freshness, liveAlerts, parseRunProgress, pollRun, stepsFromStatus, type StatusDoc } from '../pipeline'
import { LAYER_KINDS, datasetName, type DataIndex, type KindKey } from '../layers'
import type { Basemap } from '../basemap'
import type { RainState } from '../components/Panel'

/** Everything a tool can do to the map. Supplied by App, which owns the state they mutate. */
export interface ChatActions {
  setKindVisible: (kind: KindKey, visible: boolean) => void
  setKindOpacity: (kind: KindKey, opacity: number) => void
  setDatasetVisible: (id: string, visible: boolean) => void
  zoomTo: (lon: number, lat: number) => void
  zoomToDataset: (id: string) => void
  fitAll: () => void
  setBasemap: (b: Basemap) => void
  setImageryDate: (d: string) => void
  setRain: (r: RainState) => void
}

/**
 * Asking the map what it is drawing.
 *
 * The only route to the flood polygons: 12,731 of them, ~5 MB, with no aggregate computable without
 * a spatial join. MapLibre already indexes them, so the map is asked rather than the files parsed.
 */
export interface ChatMapQuery {
  viewport: () => { west: number; south: number; east: number; north: number; zoom: number; center: { lon: number; lat: number } } | null
  coverage: (lon: number, lat: number) => string[]
  at: (lon: number, lat: number) => { onScreen: boolean; features: { layer: string; properties: Record<string, unknown> }[] } | null
  inView: () => { layer: string; properties: Record<string, unknown> }[]
}

/** What the map currently shows, so a tool can report state rather than guess at it. */
export interface ChatMapState {
  basemap: Basemap
  imageryDate: string
  rain: RainState
  kindVisible: Record<string, boolean>
  kindOpacity: Record<string, number>
}

export interface ChatContext {
  index: DataIndex
  places: Place[]
  status: StatusDoc | null
  history: History | null
  weather: WeatherDoc | null
  map: ChatMapState & { query: ChatMapQuery }
  actions: ChatActions
}

/** `MM_Mandalay--floodextent-fill` -> its dataset and kind. */
function splitLayerId(id: string): { datasetId: string; kind: string } {
  const [datasetId, rest] = id.split('--')
  return { datasetId, kind: (rest ?? '').replace(/-(fill|line|outline)$/, '') }
}

/**
 * Group rendered features into one row per dataset+kind, carrying the distinct sensor/date pairs.
 *
 * Counts are deliberately not reported. The converter split each UNOSAT multipolygon into thousands
 * of rings, and MapLibre returns a feature per tile it was clipped into, so any number here would
 * describe the conversion and the tiling rather than the flood.
 */
function summariseFeatures(
  feats: { layer: string; properties: Record<string, unknown> }[],
  index: DataIndex,
) {
  const byKey = new Map<string, { datasetId: string; datasetName: string; kind: string; kindLabel: string; observations: Set<string> }>()
  for (const f of feats) {
    const { datasetId, kind } = splitLayerId(f.layer)
    const key = `${datasetId}/${kind}`
    if (!byKey.has(key)) {
      const ds = index.datasets.find((d) => d.id === datasetId)
      byKey.set(key, {
        datasetId,
        datasetName: ds ? datasetName(ds) : datasetId,
        kind,
        kindLabel: LAYER_KINDS.find((k) => k.key === kind)?.label ?? kind,
        observations: new Set(),
      })
    }
    const p = f.properties
    const sensor = (p.Sensor_ID ?? p.SensorID ?? '') as string
    const date = (p.Sensor_Dat ?? p.SensorDate ?? '') as string
    const status = (p.Water_Stat ?? '') as string
    if (sensor || date) byKey.get(key)!.observations.add([sensor, date, status].filter(Boolean).join(' · '))
  }
  return [...byKey.values()].map((v) => ({ ...v, observations: [...v.observations] }))
}

/**
 * Every tool answers with this shape, never a bare number.
 *
 * Provenance is structural here rather than something the system prompt asks for politely. The
 * model cannot see a figure without also seeing which dataset it came from, when it was observed,
 * and what is wrong with it — so a citation is the path of least resistance rather than a rule to
 * remember.
 */
export interface Envelope {
  data: unknown
  dataset: string
  observedAt?: string | null
  generatedAt?: string | null
  caveats: string[]
}

/** The caveats that have to travel with any exposure figure. */
const EXPOSURE_CAVEATS = [
  'Only townships where flood water was actually detected appear in this dataset. A township that is absent was not measured as dry — most likely it was not observed.',
  'Population is modelled from WorldPop, not counted.',
  'Radar misses water under dense vegetation and inside buildings, so these are lower bounds.',
  'No layer in this viewer carries water depth.',
]

const HISTORY_CAVEATS = [
  'Each row is one satellite pass covering a strip, not the whole country — always read a flooded area against the observed area on the same row.',
  'Observations with people: null had their population withheld as implausible. They are not zeros and must never be summed or charted as zero.',
  'The record has real holes, including nothing at all through 2025. A gap is not a dry spell.',
]

function observedDate(places: Place[]): string | null {
  const dates = [...new Set(places.map((p) => p.observed).filter(Boolean))].sort()
  if (!dates.length) return null
  return dates.length === 1 ? dates[0] : `${dates[0]} to ${dates.at(-1)}`
}

function exposureService(ctx: ChatContext): string {
  const id = ctx.status?.sources?.floodai?.event?.id
  return id ? `UNOSAT FloodAI ${id}` : 'UNOSAT FloodAI'
}

const round1 = (n: number) => Number(n.toFixed(1))

/** A tool may return a follow-up for the UI to render — a chart, or a confirm card. */
export interface ToolOutcome {
  envelope: Envelope
  chart?: ChartSpec
  confirm?: { reason: string }
}

export interface ChartSpec {
  chart: 'bars' | 'series'
  title: string
  unit: string
  source: string
  caveat?: string | null
  rows: { label: string; sub?: string | null; value: number | null; withheld?: boolean; lon?: number | null; lat?: number | null; highlight?: boolean }[]
  /**
   * Drawn from a tool's own result rather than requested by the model.
   *
   * This is the preferred path. `show_chart` requires the model to decide to call it *and* to
   * retype every figure into the spec — a transcription step where a chart can quietly end up
   * disagreeing with the sentence above it. A chart built from the tool result cannot: it is the
   * same numbers, not a copy of them. An explicit show_chart in the same turn wins, since the model
   * asked for something specific.
   */
  auto?: boolean
}

/** Enough rows to show the shape of a ranking; more than this just shrinks the bars. */
const AUTO_CHART_ROWS = 8

type Handler = (input: Record<string, unknown>, ctx: ChatContext) => ToolOutcome | Promise<ToolOutcome>

const env = (e: Envelope): ToolOutcome => ({ envelope: e })
const withChart = (chart: ChartSpec, e: Envelope): ToolOutcome => ({ envelope: e, chart })

const HANDLERS = {
  // ---- data -----------------------------------------------------------------------------------

  list_datasets(_input, ctx) {
    return env({
      data: {
        updated: ctx.index.updated,
        note: ctx.index.note ?? null,
        datasets: ctx.index.datasets.map((d) => ({
          id: d.id,
          name: datasetName(d),
          // Verbatim. These notes are the most careful prose in the project and say exactly what
          // each dataset is not; paraphrasing them is how a caveat gets lost.
          note: d.note ?? null,
          bbox: d.bbox,
          layers: Object.fromEntries(Object.entries(d.layers).map(([k, v]) => [k, v.features])),
          stats: (d.stats ?? []).map((s) => ({
            label: s.label,
            value: s.value,
            unit: s.unit ?? null,
            source: s.source ?? null,
            unverified: s.unverified ?? false,
            count: s.count ?? null,
            denominator: s.denominator ?? null,
          })),
        })),
      },
      dataset: 'this viewer’s dataset index',
      generatedAt: ctx.index.updated,
      caveats: [
        'A statistic marked unverified has no established provenance and must be labelled as such whenever it is quoted.',
      ],
    })
  },

  national_totals(_input, ctx) {
    const t = nationalTotals(ctx.places)
    return env({
      data: {
        peopleExposed: t.people,
        floodedAreaKm2: round1(t.flooded),
        floodedCroplandKm2: round1(t.cropland),
        townshipsObserved: t.places,
      },
      dataset: exposureService(ctx),
      observedAt: observedDate(ctx.places),
      caveats: EXPOSURE_CAVEATS,
    })
  },

  rank_places(input, ctx) {
    const measure = (['people', 'flooded', 'cropland'] as const).includes(input.measure as Measure)
      ? (input.measure as Measure)
      : 'people'
    const groupBy = input.groupBy === 'township' ? 'township' : 'region'
    const limit = Math.min(Math.max(Number(input.limit) || 15, 1), 50)
    const rows = rankPlaces(ctx.places, { measure, groupBy, limit })
    const label: Record<Measure, string> = {
      people: 'People exposed',
      flooded: 'Flooded area',
      cropland: 'Flooded cropland',
    }
    const chart: ChartSpec = {
      auto: true,
      chart: 'bars',
      title: `${label[measure]} by ${groupBy}`,
      unit: measure === 'people' ? 'people' : 'km2',
      source: `${exposureService(ctx)}, observed ${observedDate(ctx.places) ?? 'unknown'}`,
      caveat: 'Only places where water was detected appear. One that is absent was not measured as dry.',
      rows: rows.slice(0, AUTO_CHART_ROWS).map((r) => ({
        label: r.name,
        sub: r.sub,
        value: measure === 'people' ? Math.round(r.value) : round1(r.value),
        withheld: false,
        lon: r.lon,
        lat: r.lat,
      })),
    }
    return withChart(chart, {
      data: {
        measure,
        groupBy,
        rows: rows.map((r) => ({
          name: r.name,
          detail: r.sub,
          value: measure === 'people' ? Math.round(r.value) : round1(r.value),
          unit: measure === 'people' ? 'people' : 'km²',
          lon: Number(r.lon.toFixed(5)),
          lat: Number(r.lat.toFixed(5)),
        })),
        returned: rows.length,
        ofTownships: ctx.places.length,
      },
      dataset: exposureService(ctx),
      observedAt: observedDate(ctx.places),
      caveats: [
        ...EXPOSURE_CAVEATS,
        groupBy === 'region'
          ? 'Region coordinates are weighted by impact, so they point at where the water is rather than the geometric centre.'
          : 'Ranked by township; a region with many moderately affected townships can outweigh anything on this list.',
      ],
    })
  },

  lookup_place(input, ctx) {
    const query = String(input.query ?? '')
    const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 20)
    const hits = findPlaces(ctx.places, query, limit)
    return env({
      data: {
        query,
        matches: hits.map((p) => ({
          township: p.township,
          district: p.district,
          region: p.region,
          peopleExposed: p.people,
          floodedAreaKm2: round1(p.flooded),
          floodedCroplandKm2: round1(p.cropland),
          observed: p.observed,
          lon: p.lon,
          lat: p.lat,
        })),
        found: hits.length,
        // Spelled out because this is the single most likely place to mislead a reader.
        ...(hits.length
          ? {}
          : {
              noMatchMeans:
                `"${query}" is not among the ${ctx.places.length} townships where flood water was detected in this observation. That is not evidence it is dry — it was most likely not observed, or the name is spelled differently here.`,
            }),
      },
      dataset: exposureService(ctx),
      observedAt: observedDate(ctx.places),
      caveats: EXPOSURE_CAVEATS,
    })
  },

  flood_history(input, ctx) {
    if (!ctx.history) throw new Error('the historical record has not loaded')
    const metric = (['people', 'flooded', 'cropland', 'observed'] as const).includes(
      input.metric as 'people',
    )
      ? (input.metric as 'people' | 'flooded' | 'cropland' | 'observed')
      : 'people'
    const from = typeof input.from === 'string' ? input.from : null
    const to = typeof input.to === 'string' ? input.to : null
    const limit = Math.min(Math.max(Number(input.limit) || 24, 1), 60)

    let rows = ctx.history.series.filter((r) => (!from || r.date >= from) && (!to || r.date <= to))
    if (input.order === 'value') {
      rows = [...rows].sort((a, b) => (Number(b[metric] ?? -1)) - (Number(a[metric] ?? -1)))
    }
    const picked = input.order === 'value' ? rows.slice(0, limit) : rows.slice(-limit)

    // A time series draws itself too, and this is where it matters most: a withheld figure has to
    // appear as a hollow bar, never as a zero, and that is not something to leave to the model
    // retyping values into a chart spec.
    const metricLabel: Record<string, string> = {
      people: 'People exposed',
      flooded: 'Flooded area',
      cropland: 'Flooded cropland',
      observed: 'Observed area',
    }
    const ordered = [...picked].sort((a, b) => a.date.localeCompare(b.date))
    const chart: ChartSpec = {
      auto: true,
      chart: 'series',
      title: `${metricLabel[metric]} per pass`,
      unit: metric === 'people' ? 'people' : 'km2',
      source: `UNOSAT FloodAI archive, ${ordered[0]?.date ?? '?'} to ${ordered.at(-1)?.date ?? '?'}`,
      caveat:
        'Bars are one per pass, evenly spaced — not a time axis. A hollow bar is an observation whose figure was withheld, not a day without flooding.',
      rows: ordered.map((r) => ({
        label: r.date,
        sub: null,
        value: metric === 'people' ? r.people : (r[metric] as number),
        withheld: metric === 'people' && r.people === null,
        lon: null,
        lat: null,
      })),
    }

    return withChart(chart, {
      data: {
        note: ctx.history.note,
        totalObservations: ctx.history.series.length,
        withheldInWholeRecord: ctx.history.suspect ?? 0,
        returned: picked.length,
        withheldInThisSlice: picked.filter((r) => r.people === null).length,
        gaps: historyGaps(rows),
        // people stays null where it was withheld. Never coalesced to 0.
        rows: picked.map((r: Observation) => ({
          date: r.date,
          service: r.service,
          people: r.people,
          peopleWithheld: r.peopleSuspect ?? false,
          floodedKm2: round1(r.flooded),
          croplandKm2: round1(r.cropland),
          observedKm2: round1(r.observed),
        })),
      },
      dataset: 'UNOSAT FloodAI archive (history.json)',
      generatedAt: ctx.history.generatedAt,
      caveats: HISTORY_CAVEATS,
    })
  },

  history_stats(input, ctx) {
    if (!ctx.history) throw new Error('the historical record has not loaded')
    const metric: Metric = input.metric === 'flooded' ? 'flooded' : 'people'
    const windowDays = [0, 365, 1095].includes(Number(input.windowDays)) ? Number(input.windowDays) : 0
    const series = windowSeries(ctx.history.series, windowDays)
    const f = trendFacts(series, metric)
    const at = (o: Observation | null) =>
      o ? { date: o.date, service: o.service, people: o.people, floodedKm2: round1(o.flooded), observedKm2: round1(o.observed) } : null
    return env({
      data: {
        metric,
        windowDays,
        latest: at(f.latest),
        previous: at(f.previous),
        changeRatio: f.changeRatio === null ? null : Number(f.changeRatio.toFixed(3)),
        peak: at(f.peak),
        passes: f.passes,
        withheld: f.withheld,
        daysSincePreviousPass: f.gapBeforePrevious,
      },
      dataset: 'UNOSAT FloodAI archive (history.json)',
      generatedAt: ctx.history.generatedAt,
      caveats: [
        ...HISTORY_CAVEATS,
        f.gapBeforePrevious && f.gapBeforePrevious > 120
          ? `The comparison spans ${f.gapBeforePrevious} days. Name the date you are comparing against rather than saying "the previous pass".`
          : 'The comparison is against the immediately preceding pass.',
      ],
    })
  },

  weather_forecast(input, ctx) {
    if (!ctx.weather) throw new Error('the forecast has not loaded')
    const place = typeof input.place === 'string' ? input.place.toLowerCase() : null
    const match = <T extends { name: string }>(xs: T[]) =>
      place ? xs.filter((x) => x.name.toLowerCase().includes(place)) : xs

    const data =
      input.kind === 'rain'
        ? {
            kind: 'rain',
            points: match(sortedRain(ctx.weather)).map((p) => ({
              name: p.name,
              today: p.today,
              past7mm: round1(p.past7),
              next7mm: round1(p.next7),
              days: p.days.map((d) => ({ date: d.date, mm: round1(d.mm), probability: d.prob, isForecast: d.date >= p.today })),
            })),
          }
        : {
            kind: 'rivers',
            gauges: match(sortedRivers(ctx.weather)).map((p) => {
              const f = riverFacts(p)
              return {
                name: f.name,
                nowM3s: Math.round(f.now),
                peakAheadM3s: Math.round(f.peakAhead),
                peakDate: f.peakDate,
                max30M3s: Math.round(f.max30),
                changeRatio: Number(f.changeRatio.toFixed(3)),
                cellSuspect: f.cellSuspect,
                offsetFromTown: f.offsetFromTown,
                days: f.days.map((d) => ({ date: d.date, q: Math.round(d.q), lo: Math.round(d.lo), hi: Math.round(d.hi), isForecast: d.isForecast })),
              }
            }),
          }

    return env({
      data: { ...data, note: ctx.weather.note },
      dataset: ctx.weather.attribution,
      generatedAt: ctx.weather.generatedAt,
      caveats: [
        'THIS IS THE ONLY FORECAST IN THIS VIEWER. Every day flagged isForecast is model output, not an observation. Say so.',
        'Gauge coordinates are river-channel cells about 5 km across, not the towns they are named after. offsetFromTown records that; it is deliberate and must not be described as an error.',
        'The lo/hi pair is the ensemble spread, which widens from about ±1% tomorrow to −11%/+38% at two weeks. Quote it rather than a single confident number.',
      ],
    })
  },

  pipeline_status(_input, ctx) {
    const f = freshness(ctx.status)
    return env({
      data: {
        // The verdict, from the same function the chip renders from. Repeat it; never work
        // freshness out for yourself from a timestamp.
        stale: f.stale,
        lastCheckedLabel: f.label,
        ageHours: f.ageHours === null ? null : round1(f.ageHours),
        staleAfterHours: f.maxHours,
        conclusion: ctx.status?.run?.conclusion ?? null,
        runner: ctx.status?.run?.runner ?? null,
        sources: Object.fromEntries(
          Object.entries(ctx.status?.sources ?? {}).map(([k, v]) => [k, { state: v.state, detail: v.detail ?? null }]),
        ),
        stages: stepsFromStatus(ctx.status).map((s) => ({ key: s.key, state: s.state, detail: s.detail ?? null })),
        alerts: liveAlerts(ctx.status).map((a) => ({
          severity: a.severity,
          title: a.title,
          detail: a.detail,
          date: a.date ?? null,
          baseline: a.baseline ?? null,
        })),
      },
      dataset: 'this viewer’s own pipeline record (status.json)',
      generatedAt: ctx.status?.generatedAt ?? null,
      caveats: [
        'Staleness is judged against the wall clock at read time, never baked into the file.',
        'A source reporting "skipped" was not checked. That is not the same as "unchanged".',
      ],
    })
  },

  layer_reference(input, ctx) {
    // 'all' rather than null: the API rejects an enum that mixes strings with null, and an
    // explicit word is less ambiguous for the model than an absent value anyway.
    const wanted = typeof input.kind === 'string' && input.kind !== 'all' ? input.kind : null
    const kinds = LAYER_KINDS.filter((k) => !wanted || k.key === wanted)
    return env({
      data: {
        layers: kinds.map((k) => ({
          key: k.key,
          label: k.label,
          // Verbatim, so the assistant's explanation and the panel's are the same words.
          description: k.desc,
          visible: ctx.map.kindVisible[k.key] ?? false,
          opacity: ctx.map.kindOpacity[k.key] ?? null,
          clickable: k.query,
        })),
        basemap: ctx.map.basemap,
        imageryDate: ctx.map.imageryDate,
        rain: ctx.map.rain,
      },
      dataset: 'this viewer’s layer definitions',
      caveats: ['No flood layer in this viewer carries depth. Every one is a flat colour for that reason.'],
    })
  },

  /**
   * One place set against the worst-hit, in a single ranking.
   *
   * `rank_places` alone answers "who is worst" and quietly drops everyone else — ask it to compare
   * Mandalay with the worst regions and it returns the top five, which Mandalay misses by one
   * place. The reader then sees a chart with their own region absent from it, which answers a
   * question nobody asked.
   *
   * So the subject is always in the result, with its true rank, however far down it sits.
   */
  compare_places(input, ctx) {
    const measure = (['people', 'flooded', 'cropland'] as const).includes(input.measure as Measure)
      ? (input.measure as Measure)
      : 'people'
    const groupBy = input.groupBy === 'township' ? 'township' : 'region'
    const topN = Math.min(Math.max(Number(input.topN) || 5, 1), 15)
    const wanted = String(input.subject ?? '').trim()
    if (!wanted) throw new Error('give the place to compare as `subject`')

    const all = rankPlaces(ctx.places, { measure, groupBy, limit: 10_000 })
    const norm = (x: string) => x.trim().toLowerCase()
    let at = all.findIndex((r) => norm(r.name) === norm(wanted))
    if (at < 0) at = all.findIndex((r) => norm(r.name).includes(norm(wanted)))

    // A township name asked about at region level: resolve it to its region and say so, rather than
    // failing over a mismatch the reader had no way to know about.
    let resolvedVia: string | null = null
    if (at < 0 && groupBy === 'region') {
      const t = findPlaces(ctx.places, wanted, 1)[0]
      if (t) {
        at = all.findIndex((r) => norm(r.name) === norm(t.region))
        if (at >= 0) resolvedVia = `"${wanted}" is a township in ${t.region}; compared at region level.`
      }
    }
    if (at < 0) {
      throw new Error(
        `"${wanted}" is not among the ${groupBy === 'region' ? 'regions' : 'townships'} where water was detected, so it cannot be ranked. That is not evidence it is dry.`,
      )
    }

    const subject = all[at]
    const top = all.slice(0, topN)
    const inTop = at < topN
    const rows = inTop ? top : [...top, subject]
    const fmtVal = (v: number) => (measure === 'people' ? Math.round(v) : round1(v))

    const chart: ChartSpec = {
      auto: true,
      chart: 'bars',
      title: `${subject.name} vs the worst-hit ${groupBy === 'region' ? 'regions' : 'townships'}`,
      unit: measure === 'people' ? 'people' : 'km2',
      source: `${exposureService(ctx)}, observed ${observedDate(ctx.places) ?? 'unknown'}`,
      caveat: inTop
        ? `${subject.name} is among the worst ${topN}.`
        : `${subject.name} ranks ${at + 1} of ${all.length} and is shown alongside the top ${topN} for scale.`,
      rows: rows.map((r) => ({
        label: r.name,
        sub: r === subject ? `ranked ${at + 1} of ${all.length}` : r.sub,
        value: fmtVal(r.value),
        withheld: false,
        lon: r.lon,
        lat: r.lat,
        highlight: r === subject,
      })),
    }

    return withChart(chart, {
      data: {
        measure,
        groupBy,
        subject: {
          name: subject.name,
          value: fmtVal(subject.value),
          rank: at + 1,
          outOf: all.length,
          detail: subject.sub,
          resolvedVia,
        },
        worst: top.map((r, i) => ({ rank: i + 1, name: r.name, value: fmtVal(r.value), detail: r.sub })),
        // The comparison stated outright, so it cannot be got wrong in the retelling.
        timesSmallerThanWorst:
          subject.value > 0 ? Number((all[0].value / subject.value).toFixed(1)) : null,
        shareOfNationalTotal: Number(
          ((subject.value / all.reduce((a, r) => a + r.value, 0)) * 100).toFixed(1),
        ),
        unit: measure === 'people' ? 'people' : 'km²',
      },
      dataset: exposureService(ctx),
      observedAt: observedDate(ctx.places),
      caveats: [
        ...EXPOSURE_CAVEATS,
        `Ranked across ${all.length} ${groupBy === 'region' ? 'regions' : 'townships'} where water was detected. Anywhere not observed is absent from the ranking entirely, so a rank is a position among the measured, not among all of Myanmar.`,
        ...(resolvedVia ? [resolvedVia] : []),
      ],
    })
  },

  // ---- seeing the map -------------------------------------------------------------------------

  inspect_map(_input, ctx) {
    const view = ctx.map.query.viewport()
    if (!view) throw new Error('the map has not finished loading')

    // Townships come from the data filtered by the viewport, NOT from the renderer — exact, with no
    // "was it drawn" caveat attached. Only the polygons have to be asked of the map.
    const inBox = ctx.places.filter(
      (p) => p.lon >= view.west && p.lon <= view.east && p.lat >= view.south && p.lat <= view.north,
    )
    const ranked = [...inBox].sort((a, b) => b.people - a.people)
    const hidden = LAYER_KINDS.filter((k) => k.query && !ctx.map.kindVisible[k.key]).map((k) => k.label)

    return env({
      data: {
        viewport: view,
        townshipsInView: {
          count: inBox.length,
          peopleExposed: inBox.reduce((a, p) => a + p.people, 0),
          floodedKm2: round1(inBox.reduce((a, p) => a + p.flooded, 0)),
          worst: ranked.slice(0, 8).map((p) => ({
            township: p.township,
            region: p.region,
            people: p.people,
            floodedKm2: round1(p.flooded),
            observed: p.observed,
          })),
        },
        tracedExtentsDrawnHere: summariseFeatures(ctx.map.query.inView(), ctx.index),
        layersCurrentlyHidden: hidden,
        basemap: ctx.map.basemap,
      },
      dataset: 'what the map is drawing right now',
      observedAt: observedDate(inBox),
      caveats: [
        'The township figures are exact — filtered from the data by the map bounds.',
        'The traced extents are read from what is DRAWN. A hidden layer, anything off-screen, and small polygons simplified away at low zoom all return nothing, so their presence means something and their absence means very little.',
        hidden.length
          ? `These layers are switched off, so they could not appear: ${hidden.join(', ')}. Say so before concluding anything is absent.`
          : 'All queryable layers are switched on.',
        'No count of polygons is given, and none should be inferred: the conversion split each extent into thousands of rings and the map returns one feature per tile, so a number would describe the file format rather than the flood.',
      ],
    })
  },

  query_location(input, ctx) {
    let lon = Number(input.lon)
    let lat = Number(input.lat)
    let resolved: string | null = null

    if (typeof input.placeName === 'string' && input.placeName.trim()) {
      const hit = findPlaces(ctx.places, input.placeName, 1)[0]
      if (!hit) throw new Error(`"${input.placeName}" is not among the townships with detected water, so there are no coordinates for it. That is not evidence it is dry.`)
      lon = hit.lon
      lat = hit.lat
      resolved = `${hit.township}, ${hit.region}`
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new Error('give either placeName, or both lon and lat')
    }

    const hit = ctx.map.query.at(lon, lat)
    if (!hit) throw new Error('the map has not finished loading')

    const covering = ctx.map.query.coverage(lon, lat)
    const hidden = LAYER_KINDS.filter((k) => k.query && !ctx.map.kindVisible[k.key]).map((k) => k.label)
    // The nearest township with detected water, as a second, renderer-independent answer.
    const nearest = [...ctx.places]
      .map((p) => ({ p, d: Math.hypot(p.lon - lon, p.lat - lat) }))
      .sort((a, b) => a.d - b.d)[0]

    return env({
      data: {
        location: { lon: Number(lon.toFixed(5)), lat: Number(lat.toFixed(5)), resolvedFrom: resolved },
        onScreen: hit.onScreen,
        drawnHere: summariseFeatures(hit.features, ctx.index),
        tracedDatasetsCoveringThisPoint: covering,
        nearestTownshipWithDetectedWater: nearest
          ? {
              township: nearest.p.township,
              region: nearest.p.region,
              approxDegreesAway: Number(nearest.d.toFixed(3)),
              people: nearest.p.people,
              observed: nearest.p.observed,
            }
          : null,
        layersCurrentlyHidden: hidden,
      },
      dataset: 'the map’s own rendered features',
      caveats: [
        !hit.onScreen
          ? 'This point is OFF SCREEN, so nothing could be read from the map there. Move the map to it first, then ask again. Do not report this as "no flooding".'
          : 'Read from what is drawn at this point.',
        covering.length
          ? `Hand-traced extents exist here (${covering.join(', ')}) — and they are historical: check the imaging date in the result rather than assuming it describes today.`
          : 'NO hand-traced extent covers this point at all. Only four regions were ever traced, so nothing was looked at here — which is not the same as nothing being there.',
        hidden.length ? `Switched off and therefore unfindable: ${hidden.join(', ')}.` : 'All queryable layers are on.',
        'A hit is evidence; a miss is not. Absence here means the map drew nothing at this point, never that the ground was dry.',
      ],
    })
  },

  // ---- map control ----------------------------------------------------------------------------

  set_layer_visibility(input, ctx) {
    const kind = String(input.kind) as KindKey
    if (!LAYER_KINDS.some((k) => k.key === kind)) throw new Error(`no such layer: ${kind}`)
    const visible = Boolean(input.visible)
    ctx.actions.setKindVisible(kind, visible)
    return env({ data: { ok: true, kind, visible }, dataset: 'map state', caveats: [] })
  },

  set_layer_opacity(input, ctx) {
    const kind = String(input.kind) as KindKey
    if (!LAYER_KINDS.some((k) => k.key === kind)) throw new Error(`no such layer: ${kind}`)
    const opacity = Math.min(Math.max(Number(input.opacity), 0), 1)
    ctx.actions.setKindOpacity(kind, opacity)
    return env({ data: { ok: true, kind, opacity }, dataset: 'map state', caveats: [] })
  },

  set_dataset_visibility(input, ctx) {
    const id = String(input.datasetId)
    if (!ctx.index.datasets.some((d) => d.id === id)) throw new Error(`no such dataset: ${id}`)
    ctx.actions.setDatasetVisible(id, Boolean(input.visible))
    return env({ data: { ok: true, datasetId: id, visible: Boolean(input.visible) }, dataset: 'map state', caveats: [] })
  },

  zoom_to_place(input, ctx) {
    const name = String(input.placeName ?? '')
    const hit = findPlaces(ctx.places, name, 1)[0]
    if (!hit) {
      throw new Error(
        `"${name}" is not among the townships where water was detected, so there is nowhere to zoom to. That is not evidence it is dry.`,
      )
    }
    ctx.actions.zoomTo(hit.lon, hit.lat)
    return env({
      data: { ok: true, movedTo: { township: hit.township, region: hit.region, lon: hit.lon, lat: hit.lat } },
      dataset: exposureService(ctx),
      observedAt: hit.observed,
      caveats: [],
    })
  },

  zoom_to_dataset(input, ctx) {
    const id = String(input.datasetId)
    const ds = ctx.index.datasets.find((d) => d.id === id)
    if (!ds) throw new Error(`no such dataset: ${id}`)
    ctx.actions.zoomToDataset(id)
    return env({ data: { ok: true, datasetId: id, name: datasetName(ds) }, dataset: 'map state', caveats: [] })
  },

  fit_all(_input, ctx) {
    ctx.actions.fitAll()
    return env({ data: { ok: true }, dataset: 'map state', caveats: [] })
  },

  set_basemap(input, ctx) {
    const map: Record<string, Basemap> = {
      osm: 'osm',
      satellite: 'nasa',
      flood721: 'nasa721',
      cloudfree: 'clear',
      blank: 'blank',
    }
    const basemap = map[String(input.basemap)]
    if (!basemap) throw new Error(`no such basemap: ${String(input.basemap)}`)
    ctx.actions.setBasemap(basemap)

    let dateSet: string | null = null
    if (typeof input.imageryDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.imageryDate)) {
      // GIBS assembles a day's imagery after the fact, so a future date returns nothing at all.
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      dateSet = input.imageryDate > yesterday ? yesterday : input.imageryDate
      ctx.actions.setImageryDate(dateSet)
    }
    return env({
      data: { ok: true, basemap: String(input.basemap), imageryDate: dateSet },
      dataset: 'map state',
      caveats: basemap === 'nasa721' || basemap === 'nasa'
        ? ['Optical imagery is frequently solid cloud during monsoon flooding. That is expected, and it is why the detection underneath is radar.']
        : [],
    })
  },

  set_rain_overlay(input, ctx) {
    const on = Boolean(input.on)
    // IMERG returns 404, not an empty tile, for a day it has not assembled yet — about two days back.
    const twoDaysBack = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
    let date = ctx.map.rain.date
    if (typeof input.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      date = input.date > twoDaysBack ? twoDaysBack : input.date
    }
    const opacity = Number.isFinite(Number(input.opacity))
      ? Math.min(Math.max(Number(input.opacity), 0.1), 1)
      : ctx.map.rain.opacity
    ctx.actions.setRain({ on, date, opacity })
    return env({
      data: { ok: true, on, date, opacity },
      dataset: 'NASA GIBS / GPM IMERG',
      observedAt: date,
      caveats: ['This is measured rainfall that already fell, not a forecast.'],
    })
  },

  // ---- chart ----------------------------------------------------------------------------------

  show_chart(input) {
    const rows = Array.isArray(input.rows) ? (input.rows as ChartSpec['rows']) : []
    if (!rows.length) throw new Error('a chart needs at least one row')
    if (!input.source) throw new Error('a chart must name its dataset and observation date in `source`')
    const spec: ChartSpec = {
      chart: input.chart === 'series' ? 'series' : 'bars',
      title: String(input.title ?? ''),
      unit: String(input.unit ?? 'count'),
      source: String(input.source),
      caveat: typeof input.caveat === 'string' ? input.caveat : null,
      rows: rows.slice(0, 40),
    }
    return {
      envelope: {
        data: { ok: true, drawn: spec.rows.length },
        dataset: spec.source,
        caveats: ['The chart is drawn for the reader. State the headline number in prose as well.'],
      },
      chart: spec,
    }
  },

  // ---- pipeline -------------------------------------------------------------------------------

  request_pipeline_run(input, ctx) {
    const reason = String(input.reason ?? 'to fetch the latest data')
    const f = freshness(ctx.status)
    // Runs nothing. A pending tool_result blocks the whole conversation, so a tool cannot wait for
    // a human — it hands the decision over and the turn ends. The reader's click is the only thing
    // that ever starts a pipeline.
    return {
      envelope: {
        data: {
          status: 'awaiting_confirmation',
          askedTheReader: true,
          reason,
          currentFreshness: { stale: f.stale, label: f.label },
          note: 'Nothing has been started. Tell the reader a button is below and that it is their decision.',
        },
        dataset: 'this viewer’s own pipeline record',
        caveats: ['A run takes about 40 seconds and makes live calls to third-party services.'],
      },
      confirm: { reason },
    }
  },

  async check_run_state() {
    const run = await pollRun()
    if (!run) throw new Error('no local server is available to ask')
    const steps = parseRunProgress(run.lines)
    return env({
      data: {
        running: run.running,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exitCode: run.exitCode,
        stages: steps.map((s) => ({ key: s.key, state: s.state, detail: s.detail ?? null })),
      },
      dataset: 'the local pipeline runner',
      caveats: [],
    })
  },
} satisfies Record<string, Handler>

/**
 * The name of every tool that exists.
 *
 * Derived from the handlers rather than written out, so it cannot fall behind them. Anything keyed
 * by tool name — the transcript's friendly labels, above all — can be typed `Record<ToolName, …>`
 * and will then fail to compile the moment a tool is added without one. A raw `compare_places`
 * appearing in the UI is a small bug, but it is the kind that ships because nothing objects.
 */
export type ToolName = keyof typeof HANDLERS

export const TOOL_NAMES = Object.keys(HANDLERS)

export interface ToolResult {
  text: string
  isError: boolean
  chart?: ChartSpec
  confirm?: { reason: string }
}

/** Run one tool call. Never throws — a failed tool is a result the model has to be told about. */
export async function runTool(name: string, input: unknown, ctx: ChatContext): Promise<ToolResult> {
  // The name comes off the wire, so it is a plain string until proven otherwise — hence the lookup
  // through a widened view rather than an index into the literal type.
  const handler = (HANDLERS as Record<string, Handler | undefined>)[name]
  if (!handler) return { text: JSON.stringify({ error: `no such tool: ${name}` }), isError: true }
  try {
    const out = await handler((input ?? {}) as Record<string, unknown>, ctx)
    // Compact, not indented: on a payload this size the whitespace alone is real money.
    return { text: JSON.stringify(out.envelope), isError: false, chart: out.chart, confirm: out.confirm }
  } catch (err) {
    return { text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), isError: true }
  }
}
