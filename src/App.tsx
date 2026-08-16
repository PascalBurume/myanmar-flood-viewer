import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type maplibregl from 'maplibre-gl'

import {
  BASEMAP_LABELS,
  IMAGERY_BASEMAPS,
  defaultImageryDate,
  gibsTileUrl,
  tileCloudiness,
  type Basemap,
  defaultRainDate,
} from './basemap'
import { AboutDialog, PipelineDialog } from './components/Dialogs'
import { Panel } from './components/Panel'
import { useExposure } from './components/TopAffected'
import { useHistory } from './components/Trend'
import { Alerts } from './components/Alerts'
import { useWeather } from './components/Weather'
import {
  LAYER_KINDS,
  loadIndex,
  popupHtml,
  type DataIndex,
  type Dataset,
  type KindKey,
} from './layers'
import {
  checkServer,
  loadStatus,
  pollRun,
  startRun,
  type RunState,
  freshness,
  type StatusDoc,
} from './pipeline'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import { popupHeadings, useMapOverlays } from './useMapOverlays'

const BASE_URL = import.meta.env.BASE_URL

/** Times are shown in Myanmar time: the data is about Myanmar, so that is what its readers use. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Yangon',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d)
  return `${s} MMT`
}

/** Step an ISO date by whole days, in UTC so it cannot drift across a local midnight. */
function shiftDay(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  const today = defaultImageryDate()
  const next = d.toISOString().slice(0, 10)
  return next > today ? today : next
}

const STATE_WORD: Record<string, string> = {
  ok: 'up to date',
  changed: 'new data',
  skipped: 'not scanned',
  failed: 'check failed',
}

export function App({ initialIndex }: { initialIndex: DataIndex }) {
  const [index, setIndex] = useState(initialIndex)
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [basemap, setBasemap] = useState<Basemap>('osm')
  // Rainfall is an overlay, not a basemap: rain without the ground under it says very little, so it
  // rides on top of whichever base is showing rather than replacing it.
  const [rain, setRain] = useState({ on: false, date: defaultRainDate(), opacity: 0.65 })
  /**
   * Which day of NASA imagery to show. Defaults to the day the flood data was observed, so
   * switching to Satellite lands on the picture that matches the polygons rather than on today.
   */
  const [imageryDate, setImageryDate] = useState<string>(() => {
    const observed = initialIndex.datasets
      .flatMap((d) => (d.note ?? '').match(/observed (\d{4}-\d{2}-\d{2})/) ?? [])
      .filter((m) => /^\d{4}-/.test(m))[0]
    return observed ?? defaultImageryDate()
  })
  const showImageryDate = IMAGERY_BASEMAPS.includes(basemap)
  const [clearSearch, setClearSearch] = useState('')
  const [status, setStatus] = useState<StatusDoc | null>(null)
  // Bumped when a run finishes. history.json and weather.json keep the same path across runs, so
  // without an explicit nudge the browser would hand back the copy it already has and a completed
  // update would visibly change nothing.
  const [dataVersion, setDataVersion] = useState(0)
  const [run, setRun] = useState<RunState | null>(null)
  const [serverAvailable, setServerAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [pipelineOpen, setPipelineOpen] = useState(false)

  const [kindVisible, setKindVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(LAYER_KINDS.map((k) => [k.key, true])),
  )
  const [kindOpacity, setKindOpacity] = useState<Record<string, number>>(() =>
    Object.fromEntries(LAYER_KINDS.map((k) => [k.key, 0.7])),
  )
  const [datasetVisible, setDatasetVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(initialIndex.datasets.map((d) => [d.id, true])),
  )

  const mapContainer = useRef<HTMLDivElement>(null)
  const popupRef = useRef<maplibregl.Popup | null>(null)

  useEffect(() => applyThemeAttr(theme), [theme])

  // Leave room on the left so the panel does not cover the data it describes.
  const fitPadding = useMemo(() => {
    const narrow = window.matchMedia('(max-width: 640px)').matches
    return narrow
      ? { top: 40, right: 40, bottom: 40, left: 40 }
      : { top: 40, right: 40, bottom: 40, left: 360 }
  }, [])

  /**
   * The opening view. Datasets flagged `focus` win when any exist, so the map opens somewhere
   * useful rather than on the union of everything. Computed once — `fitBounds` after construction
   * does not affect the initial camera, so it has to be passed to the constructor.
   */
  const initialCamera = useMemo(() => {
    const focused = initialIndex.datasets.filter((d) => d.focus)
    const source = focused.length ? focused : initialIndex.datasets
    const boxes = source.map((d) => d.bbox).filter((b): b is [number, number, number, number] => !!b)
    if (!boxes.length) return { center: [96.2, 19.5] as [number, number], zoom: 6 }
    const bounds: [number, number, number, number] = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ]
    return { bounds, fitBoundsOptions: { padding: fitPadding } }
  }, [initialIndex, fitPadding])

  const headings = useMemo(() => popupHeadings(index), [index])
  const places = useExposure(index, BASE_URL)
  const history = useHistory(BASE_URL, dataVersion)
  const weather = useWeather(BASE_URL, dataVersion)


  const onMapClick = useCallback(
    (features: maplibregl.MapGeoJSONFeature[], lngLat: maplibregl.LngLat) => {
      const popup = popupRef.current
      if (!popup) return
      if (!features.length) {
        popup.remove()
        return
      }
      popup.setLngLat(lngLat).setHTML(popupHtml(features, headings)).addTo(mapRef.current!)
    },
    [headings],
  )

  const overlayState = useMemo(
    () => ({ index, kindVisible, kindOpacity, datasetVisible, rain }),
    [index, kindVisible, kindOpacity, datasetVisible, rain],
  )

  const { mapRef, addOverlays, applyIndex } = useMapOverlays(
    mapContainer,
    overlayState,
    theme,
    basemap,
    imageryDate,
    initialCamera as unknown as maplibregl.MapOptions,
    onMapClick,
  )

const zoomTo = useCallback(
    (lon: number, lat: number) => {
      // Zoom in enough to see townships, but never past where the circles stop being meaningful.
      mapRef.current?.easeTo({ center: [lon, lat], zoom: Math.max(mapRef.current.getZoom(), 8.5) })
    },
    [mapRef],
  )

  /**
   * Step back through recent days and jump to the least cloudy one over the current view.
   *
   * Cloud cannot be taken out of an image, but a clearer day usually exists nearby — during monsoon
   * a gap of a day or two is common. This samples one tile per day at the current centre and ranks
   * them, which is cheap (about 14 tiles of a few KB) and needs no extra service.
   */
  const findClearestDay = useCallback(async () => {
    const map = mapRef.current
    if (!map || !IMAGERY_BASEMAPS.includes(basemap)) return
    setClearSearch('Checking recent days…')

    // One tile covering the current centre. Zoom 6 keeps it to a single wide tile per day.
    const z = 6
    const c = map.getCenter()
    const x = Math.floor(((c.lng + 180) / 360) * 2 ** z)
    const latRad = (c.lat * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * 2 ** z)

    const days: string[] = []
    for (let i = 0; i < 14; i++) {
      const d = new Date(`${defaultImageryDate()}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - i)
      days.push(d.toISOString().slice(0, 10))
    }

    const scored = await Promise.all(
      days.map(async (date) => ({ date, cloud: await tileCloudiness(gibsTileUrl(basemap, date, z, x, y)) })),
    )
    const usable = scored.filter((s) => s.cloud < 1)
    if (!usable.length) {
      setClearSearch('Could not read imagery for any recent day.')
      return
    }
    const best = usable.reduce((a, b) => (b.cloud < a.cloud ? b : a))
    setImageryDate(best.date)
    const pct = Math.round(best.cloud * 100)
    setClearSearch(
      pct > 60
        ? `Clearest of the last 14 days is ${best.date}, still about ${pct}% cloud — monsoon. Try Cloud-free.`
        : `Jumped to ${best.date}, roughly ${pct}% cloud.`,
    )
  }, [basemap, mapRef])

  useEffect(() => {
    void import('maplibre-gl').then(({ default: ml }) => {
      popupRef.current = new ml.Popup({ closeButton: true, closeOnClick: true, maxWidth: '320px' })
    })
  }, [])

  // ---- pipeline status ----

  const refreshStatus = useCallback(async () => {
    setStatus(await loadStatus(BASE_URL))
  }, [])

  useEffect(() => {
    void refreshStatus()
    void checkServer().then(async (ok) => {
      setServerAvailable(ok)
      // Adopt a run already under way — a cron or another tab may have started one, and the page
      // should show it rather than only ever tracking runs it started itself.
      if (!ok) return
      const current = await pollRun()
      if (current?.running) setRun(current)
    })
  }, [refreshStatus])

  // While a run is in progress, poll it. Stops as soon as it finishes, so an idle page is silent.
  useEffect(() => {
    if (!run?.running) return
    const id = window.setInterval(async () => {
      const next = await pollRun()
      if (next) setRun(next)
      if (next && !next.running) {
        window.clearInterval(id)
        // The run rewrites status.json, history.json and weather.json — pick all of them up
        // without making the reader click anything.
        await refreshStatus()
        setDataVersion((v) => v + 1)
      }
    }, 1200)
    return () => window.clearInterval(id)
  }, [run?.running, refreshStatus])

  const handleRun = useCallback(async () => {
    setMessage('')
    const res = await startRun()
    if (res.ok) {
      setRun(res.run)
      return
    }
    setMessage(res.error)
    // "A run is already in progress" is a refusal to start a *second* one, not a refusal to show
    // the first. Attaching to the run that exists is what the reader wanted either way; reporting
    // that something is happening and then showing nothing about it is the worst of both.
    const current = await pollRun()
    if (current?.running) setRun(current)
  }, [])

  const handleZoom = useCallback(
    (ds: Dataset) => {
      if (ds.bbox) mapRef.current?.fitBounds(ds.bbox, { padding: fitPadding })
    },
    [fitPadding, mapRef],
  )

  const handleFitAll = useCallback(() => {
    const boxes = index.datasets.map((d) => d.bbox).filter((b): b is [number, number, number, number] => !!b)
    if (!boxes.length) return
    mapRef.current?.fitBounds(
      [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ],
      { padding: fitPadding },
    )
    setAboutOpen(false)
  }, [index, fitPadding, mapRef])

  /** Swap in newly published data without a reload, keeping the view and the toggles. */
  const handleApply = useCallback(async () => {
    setBusy(true)
    setMessage('')
    try {
      const next = await loadIndex(BASE_URL)
      const sameVersion = next.updated === index.updated
      const sameIds =
        next.datasets.length === index.datasets.length &&
        next.datasets.every((d) => index.datasets.some((o) => o.id === d.id))
      if (sameVersion && sameIds) {
        setMessage('Already showing the newest data.')
        return
      }
      await applyIndex.current(next)
      setDatasetVisible((prev) => {
        // Keep the reader's toggles; default anything genuinely new to visible.
        const merged: Record<string, boolean> = {}
        for (const ds of next.datasets) merged[ds.id] = prev[ds.id] ?? true
        return merged
      })
      setIndex(next)
      // New datasets need sources and layers creating; addOverlays no-ops on everything present.
      addOverlays.current()
      setMessage('Applied.')
    } catch (e) {
      setMessage(`Could not apply: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [index, applyIndex, addOverlays])

  const fresh = freshness(status)
  const pipelineSummary = (
    <>
      <p className="pipeline-line">{`Data as of ${formatTime(index.updated)}`}</p>
      {status ? (
        <p className="pipeline-line">
          {`Last checked ${formatTime(status.generatedAt)} · ${fresh.label} `}
          {/* A stale run's verdict is about a check made days ago, so it cannot be reported as the
              current state. "up to date" beside a fortnight-old check is exactly the claim this
              project exists not to make. */}
          <span
            className={`about-chip pipeline-chip pipeline-${fresh.stale ? 'failed' : status.run.conclusion}`}
          >
            {fresh.stale ? 'stale' : (STATE_WORD[status.run.conclusion] ?? status.run.conclusion)}
          </span>
        </p>
      ) : (
        <p className="pipeline-warn">No published status yet — the pipeline has not run.</p>
      )}
      {/* Staleness is raised by Alerts, from the same threshold the server's /api/health uses,
          rather than from a second constant that could drift away from it. */}
      <Alerts status={status} />
    </>
  )

  return (
    <>
      <div id="map" ref={mapContainer} />

      <Panel
        index={index}
        theme={theme}
        kindVisible={kindVisible}
        kindOpacity={kindOpacity}
        datasetVisible={datasetVisible}
        onKindVisible={(k: KindKey, v) => setKindVisible((s) => ({ ...s, [k]: v }))}
        onKindOpacity={(k: KindKey, v) => setKindOpacity((s) => ({ ...s, [k]: v }))}
        onDatasetVisible={(id, v) => setDatasetVisible((s) => ({ ...s, [id]: v }))}
        onZoom={handleZoom}
        onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
        onOpenAbout={() => setAboutOpen(true)}
        onOpenPipeline={() => setPipelineOpen(true)}
        places={places}
        onZoomTo={zoomTo}
        history={history}
        weather={weather}
        rain={rain}
        onRain={setRain}
        pipelineSummary={pipelineSummary}
        footer={
          <>
            <p className="disclaimer">
              This site is built and published by an individual. It is not an official site of
              UNOSAT, WFP or any humanitarian agency.
            </p>
            Data:{' '}
            <a href="https://data.humdata.org/organization/unosat" target="_blank" rel="noopener">
              UNOSAT flood extents via HDX
            </a>{' '}
            (CC BY-SA) /{' '}
            <a href="https://api.adam.geospatial.wfp.org" target="_blank" rel="noopener">
              WFP ADAM
            </a>{' '}
            impact figures /{' '}
            <a href="https://www.geoboundaries.org/" target="_blank" rel="noopener">
              geoBoundaries
            </a>{' '}
            (ODbL)
            <br />
            Basemap:{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">
              © OpenStreetMap contributors
            </a>{' '}
            /{' '}
            <a href="https://openfreemap.org/" target="_blank" rel="noopener">
              OpenFreeMap
            </a>
            <br />
            <span className="build-ver">{`Data fetched: ${formatTime(index.updated)}`}</span>
            <span className="build-ver">{`build ${__BUILD_TIME__}`}</span>
          </>
        }
      />

      {showImageryDate ? (
        <div className="imagery-date" role="group" aria-label="Imagery date">
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous day"
            onClick={() => setImageryDate((d) => shiftDay(d, -1))}
          >
            ‹
          </button>
          <input
            type="date"
            value={imageryDate}
            max={defaultImageryDate()}
            onChange={(e) => e.target.value && setImageryDate(e.target.value)}
            aria-label="Imagery date"
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Next day"
            disabled={imageryDate >= defaultImageryDate()}
            onClick={() => setImageryDate((d) => shiftDay(d, 1))}
          >
            ›
          </button>
          <button
            type="button"
            className="mini-btn clear-day"
            title="Search the last 14 days for the least cloudy image over this view"
            onClick={() => void findClearestDay()}
          >
            Clearest day
          </button>
        </div>
      ) : null}
      {showImageryDate && clearSearch ? <div className="imagery-note">{clearSearch}</div> : null}

      <div id="basemap" className="basemap-switch" role="tablist" aria-label="Basemap">
        {(Object.keys(BASEMAP_LABELS) as Basemap[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-selected={key === basemap}
            onClick={() => setBasemap(key)}
          >
            {BASEMAP_LABELS[key]}
          </button>
        ))}
      </div>

      <AboutDialog
        open={aboutOpen}
        index={index}
        onClose={() => setAboutOpen(false)}
        onFitAll={handleFitAll}
      />
      <PipelineDialog
        open={pipelineOpen}
        status={status}
        run={run}
        serverAvailable={serverAvailable}
        busy={busy}
        message={message}
        onClose={() => setPipelineOpen(false)}
        onCheck={() => void refreshStatus()}
        onRun={() => void handleRun()}
        onApply={() => void handleApply()}
        formatTime={formatTime}
      />
    </>
  )
}
