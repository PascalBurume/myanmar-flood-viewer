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
import { Timeline } from './components/Timeline'
import { MapLegend } from './components/MapLegend'
import {
  activeRun,
  fieldFrames,
  fieldStrip,
  findModel,
  frameNearest,
  frameUrl,
  legendFor,
  mergeFrames,
  modelForLayer,
  nearestStep,
  runsFor,
  useForecastField,
  useWindDoc,
  type FieldState,
} from './forecastField'
import {
  DEFAULT_SHOW,
  cycloneFrames,
  observedUntil,
  stormBounds,
  useCyclones,
  type CycloneLayerKey,
  type CycloneShow,
  type Storm,
} from './cyclones'
import { formatMMT as formatTime } from './time'
import { seriesAt, seriesPopupHtml } from './fieldSample'
import { Flood3D, DEFAULT_LOOK, type Look3d } from './components/Flood3D'
import { useSceneIndex } from './scenes'
import { viewFromUrl, type ViewKey } from './view'
import { frameSource } from './fieldRender'
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
  stepsFromStatus,
  type StatusDoc,
} from './pipeline'
import { applyThemeAttr, initialTheme, type Theme } from './theme'
import {
  cyclonePopupHeadings,
  cycloneQueryableIds,
  fieldPopupHeadings,
  fieldQueryableIds,
  popupHeadings,
  queryableLayerIds,
  useMapOverlays,
} from './useMapOverlays'

const BASE_URL = import.meta.env.BASE_URL

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
  const [cycloneShow, setCycloneShow] = useState<CycloneShow>(DEFAULT_SHOW)
  /**
   * Which reading of the map is on show. MapLibre owns the URL hash (it writes the camera there on
   * every move), so the view goes in the query string, which it never touches.
   */
  const [view, setView] = useState<ViewKey>(viewFromUrl)
  const [fieldOn, setFieldOn] = useState(() => viewFromUrl() === 'weather')
  /** The 3D view: which scene (null is the whole country) and how it is drawn. */
  const [sceneId, setSceneId] = useState<string | null>(null)
  const [look3d, setLook3d] = useState<Look3d>(DEFAULT_LOOK)
  const onLook3d = useCallback((patch: Partial<Look3d>) => setLook3d((l) => ({ ...l, ...patch })), [])
  const [fieldModel, setFieldModel] = useState<FieldState['model']>('ecmwf')
  const [fieldLayer, setFieldLayer] = useState<FieldState['layer']>('precip')
  const [fieldRun, setFieldRun] = useState<string | null>(null)
  const [fieldOpacity, setFieldOpacity] = useState(0.75)
  const [fieldStyle, setFieldStyle] = useState<FieldState['style']>('smooth')
  /**
   * The timeline. `validTime` is the moment the map shows; null means "the newest observation",
   * which is what the map opens on and what a reader who never touches the scrubber sees.
   */
  const [validTime, setValidTime] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
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
  /** Where the reader last clicked. Lets a question be about "this spot" without them reading
   *  coordinates off the screen and typing them in. */
  const [pickedPoint, setPickedPoint] = useState<{ lon: number; lat: number; label: string } | null>(null)

  useEffect(() => applyThemeAttr(theme), [theme])

  // The view is deep-linkable. `replaceState` rather than `pushState`: switching view is not a
  // navigation a reader expects the back button to undo, and the hash MapLibre keeps writing there
  // has to survive untouched.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (view !== 'floods') url.searchParams.set('view', view)
    else url.searchParams.delete('view')
    window.history.replaceState(null, '', `${url.pathname}${url.search}${window.location.hash}`)
  }, [view])

  // Leave room on the left so the panel does not cover the data it describes.
  //
  // The width is read from the panel's own `--panel-w` token rather than repeated here. It used to
  // be a second copy of the number, which meant widening the panel silently started fitting data
  // underneath it — the exact failure this padding exists to prevent.
  const fitPadding = useMemo(() => {
    if (window.matchMedia('(max-width: 640px)').matches) {
      return { top: 40, right: 40, bottom: 40, left: 40 }
    }
    const w = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue('--panel-w'),
      10,
    )
    return { top: 40, right: 40, bottom: 40, left: (Number.isFinite(w) ? w : 320) + 40 }
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

  const headings = useMemo(
    () => new Map([...popupHeadings(index), ...cyclonePopupHeadings(), ...fieldPopupHeadings()]),
    [index],
  )
  const places = useExposure(index, BASE_URL)
  const history = useHistory(BASE_URL, dataVersion)
  const weather = useWeather(BASE_URL, dataVersion)
  const cyclones = useCyclones(BASE_URL, dataVersion)
  const fieldManifest = useForecastField(BASE_URL, dataVersion)
  const sceneIndex = useSceneIndex(BASE_URL, view === '3d')
  const cyclonesState = useMemo(() => ({ doc: cyclones, show: cycloneShow }), [cyclones, cycloneShow])
  const observedTo = useMemo(() => observedUntil(cyclones), [cyclones])
  const fieldBase = useMemo(
    () => ({ manifest: fieldManifest, on: fieldOn, model: fieldModel, run: fieldRun, layer: fieldLayer, opacity: fieldOpacity, style: fieldStyle, wind: null }),
    [fieldManifest, fieldOn, fieldModel, fieldRun, fieldLayer, fieldOpacity, fieldStyle],
  )
  const fieldRunDoc = useMemo(() => activeRun(fieldManifest, fieldBase), [fieldManifest, fieldBase])
  const windDoc = useWindDoc(BASE_URL, fieldRunDoc, fieldOn && fieldLayer === 'wind')
  const field = useMemo<FieldState>(() => ({ ...fieldBase, wind: windDoc }), [fieldBase, windDoc])
  const onField = useCallback((patch: Partial<FieldState>) => {
    if (patch.on !== undefined) setFieldOn(patch.on)
    if (patch.model !== undefined) setFieldModel(patch.model)
    if (patch.layer !== undefined) setFieldLayer(patch.layer)
    if (patch.run !== undefined) setFieldRun(patch.run)
    if (patch.opacity !== undefined) setFieldOpacity(patch.opacity)
    if (patch.style !== undefined) setFieldStyle(patch.style)
  }, [])

  /**
   * One timeline over both systems. Storm positions are observations up to the newest fix; every
   * field frame is model output whatever its time, so `mergeFrames` marks those outright rather
   * than comparing them against a boundary a model without a published run time cannot supply.
   */
  const frames = useMemo(
    () => mergeFrames(cycloneFrames(cyclones), fieldOn ? fieldFrames(fieldRunDoc) : [], observedTo),
    [cyclones, fieldOn, fieldRunDoc, observedTo],
  )
  /**
   * The timeline belongs to the Weather view, and to the field wherever it is drawn. On the Floods
   * view with the field off it used to appear anyway, carrying nothing but the fixes of a storm
   * that may be a thousand kilometres off-screen.
   */
  const timelineOn = view !== '3d' && (view === 'weather' || fieldOn)
  /**
   * The moment on show. `validTime` is null until the reader moves the scrubber, and the opening
   * moment used to be resolved twice: the timeline showed its first frame (a storm fix, badged
   * Observed) while the map drew the field's first step, hours later — two different moments on
   * screen at once. Now there is one answer, the frame nearest the present, and both read it.
   */
  const openingTime = useMemo(() => frameNearest(frames, Date.now()), [frames])
  const shownTime = timelineOn ? (validTime ?? openingTime) : null
  const shownStep = useMemo(
    () => (fieldOn ? nearestStep(fieldRunDoc, shownTime, fieldManifest?.stepHours ?? 3) : null),
    [fieldOn, fieldRunDoc, shownTime, fieldManifest],
  )
  const strip = useMemo(
    () => (fieldOn ? fieldStrip(frames, fieldRunDoc, fieldLayer, legendFor(fieldManifest, fieldLayer), fieldManifest?.stepHours ?? 3) : []),
    [fieldOn, frames, fieldRunDoc, fieldLayer, fieldManifest],
  )
  const runList = useMemo(() => runsFor(fieldManifest, fieldModel, fieldLayer), [fieldManifest, fieldModel, fieldLayer])
  const runIndex = Math.max(runList.findIndex((r) => r.key === (fieldRunDoc?.key ?? '')), 0)
  /** Step to an older or newer run of the same model, keeping the reader near the same moment. */
  const stepRun = useCallback(
    (dir: -1 | 1) => {
      const next = runList[runIndex + dir]
      if (!next) return
      setFieldRun(next.key)
      const step = nearestStep(next, shownTime ?? observedTo, fieldManifest?.stepHours ?? 3)
      if (step) setValidTime(step.valid)
    },
    [runList, runIndex, shownTime, observedTo, fieldManifest],
  )
  /** Why WeatherNext is not among the models, in the pipeline's own words. */
  const weathernextReason = useMemo(
    () => stepsFromStatus(status).find((x) => x.key === 'weathernext')?.detail ?? null,
    [status],
  )


  /** Prepare the frame the timeline is about to step to — drawn, if smooth — before it is needed. */
  const framePreload = useMemo(() => {
    if (!fieldOn || fieldLayer === 'wind') return undefined
    const model = findModel(fieldManifest, modelForLayer(fieldModel, fieldLayer))
    const legend = legendFor(fieldManifest, fieldLayer)
    return (t: string) => {
      const step = nearestStep(fieldRunDoc, t, fieldManifest?.stepHours ?? 3)
      const url = step ? frameUrl(BASE_URL, step, fieldLayer) : null
      if (url) void frameSource(url, fieldStyle, model, legend)
    }
  }, [fieldOn, fieldLayer, fieldManifest, fieldModel, fieldRunDoc, fieldStyle])

  /** Point-forecast reads are async; only the newest click may fill the popup. */
  const pointQuery = useRef(0)
  const onMapClick = useCallback(
    (features: maplibregl.MapGeoJSONFeature[], lngLat: maplibregl.LngLat) => {
      // Record the spot whether or not anything was under it: "nothing is drawn here" is a
      // perfectly good question to ask about, and often the more interesting one.
      const near = places
        .map((p) => ({ p, d: Math.hypot(p.lon - lngLat.lng, p.lat - lngLat.lat) }))
        .sort((a, b) => a.d - b.d)[0]
      setPickedPoint({
        lon: Number(lngLat.lng.toFixed(5)),
        lat: Number(lngLat.lat.toFixed(5)),
        label: near && near.d < 0.6 ? `near ${near.p.township || near.p.region}` : 'this spot',
      })

      const popup = popupRef.current
      if (!popup) return
      const pointSeq = ++pointQuery.current

      // On the Weather view the flood layers are drawn faint and are not what a click is about:
      // a storm or a wind arrow under the pointer still answers, anything else asks the forecast.
      const own = view === 'weather' ? features.filter((f) => f.layer.id.startsWith('cyclones--') || f.layer.id.startsWith('field-')) : features
      const legend = legendFor(fieldManifest, fieldLayer)
      const model = findModel(fieldManifest, modelForLayer(fieldModel, fieldLayer))
      if (!own.length && fieldOn && legend && model && fieldRunDoc) {
        const { lng, lat } = lngLat
        popup
          .setLngLat(lngLat)
          .setHTML('<div class="pop-head">Forecast here</div><div class="pop-body pt"><p class="pt-where">Reading the run…</p></div>')
          .addTo(mapRef.current!)
        void seriesAt(BASE_URL, model, fieldRunDoc, fieldLayer, legend, lng, lat, shownStep?.valid ?? null).then((series) => {
          // A later click owns the popup now.
          if (pointSeq !== pointQuery.current) return
          if (!series) {
            popup.setHTML('<div class="pop-head">Forecast here</div><div class="pop-body pt"><p class="pt-where">Outside the forecast grid, which covers 92–102°E and 9.5–28.5°N.</p></div>')
            return
          }
          popup.setHTML(
            seriesPopupHtml({
              series,
              legend,
              layer: fieldLayer,
              modelLabel: model.label,
              run: fieldRunDoc,
              lon: lng,
              lat,
              cellDeg: Math.round(((model.bbox[2] - model.bbox[0]) / model.size[0]) * 100) / 100,
            }),
          )
        })
        return
      }
      if (!own.length) {
        popup.remove()
        return
      }
      popup.setLngLat(lngLat).setHTML(popupHtml(own, headings)).addTo(mapRef.current!)
    },
    [headings, places, view, fieldManifest, fieldLayer, fieldModel, fieldOn, fieldRunDoc, shownStep],
  )

  const overlayState = useMemo(
    () => ({ index, kindVisible, kindOpacity, datasetVisible, rain, cyclones: cyclonesState, field, dimFloods: view === 'weather' }),
    [index, kindVisible, kindOpacity, datasetVisible, rain, cyclonesState, field, view],
  )

  const { mapRef, addOverlays, applyIndex } = useMapOverlays(
    mapContainer,
    overlayState,
    theme,
    basemap,
    imageryDate,
    initialCamera as unknown as maplibregl.MapOptions,
    onMapClick,
    shownTime,
  )

  const zoomToStorm = useCallback(
    (storm: Storm) => {
      const b = stormBounds(storm)
      if (b) mapRef.current?.fitBounds(b, { padding: fitPadding, maxZoom: 7 })
    },
    [fitPadding, mapRef],
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
      popupRef.current = new ml.Popup({ closeButton: true, closeOnClick: true, maxWidth: '340px' })
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

  /** The camera move alone. Split out because the assistant's fit_all tool must move the map
   *  without also closing a dialog the reader had open. */
  const fitAllCamera = useCallback(() => {
    // "All the data" depends on the reading: the forecast grid covers the country and its
    // approaches, the flood datasets only where water was found.
    if (view === 'weather' && fieldManifest) {
      const g = fieldManifest.grid
      mapRef.current?.fitBounds([g.west, g.south, g.east, g.north], { padding: fitPadding, duration: 800 })
      return
    }
    const boxes = index.datasets.map((d) => d.bbox).filter((b): b is [number, number, number, number] => !!b)
    if (!boxes.length) return
    mapRef.current?.fitBounds(
      [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ],
      { padding: fitPadding, duration: 800 },
    )
  }, [index, fitPadding, mapRef, view, fieldManifest])

  /**
   * Switching reading. Choosing Weather used to leave the forecast switched off and the camera
   * zoomed on a flood district, so the view opened on the same map with a different panel — it
   * looked broken. It now turns the field on and frames the region the forecast covers; leaving
   * it keeps the field as the reader set it, since a forecast can be read over the floods too.
   */
  const selectView = useCallback(
    (v: ViewKey, frame = true) => {
      setView(v)
      if (v !== 'weather') return
      setFieldOn(true)
      setValidTime(null)
      const g = fieldManifest?.grid
      if (frame && g) mapRef.current?.fitBounds([g.west, g.south, g.east, g.north], { padding: fitPadding, duration: 900 })
    },
    [fieldManifest, fitPadding, mapRef],
  )

  /**
   * A link straight to `?view=weather` opened on the flood datasets' camera, since that is what the
   * constructor is given and the forecast manifest arrives later. Frame the forecast once it does —
   * unless the URL carried a camera of its own, which is the reader's and wins.
   */
  const [hadCamera] = useState(() => /^#\d/.test(window.location.hash))
  const framedWeather = useRef(false)
  useEffect(() => {
    const g = fieldManifest?.grid
    if (framedWeather.current || hadCamera || view !== 'weather' || !g) return
    // The map is built after its style is fetched, so it can be later than the manifest. Wait
    // for it briefly rather than miss the one chance to frame.
    let tries = 0
    const attempt = () => {
      const map = mapRef.current
      if (!map) return ++tries < 50
      framedWeather.current = true
      map.fitBounds([g.west, g.south, g.east, g.north], { padding: fitPadding, duration: 0 })
      return false
    }
    if (!attempt()) return
    const id = window.setInterval(() => {
      if (!attempt()) window.clearInterval(id)
    }, 200)
    return () => window.clearInterval(id)
  }, [fieldManifest, hadCamera, view, fitPadding, mapRef])

  const handleFitAll = useCallback(() => {
    fitAllCamera()
    setAboutOpen(false)
  }, [fitAllCamera])

  /**
   * Letting the assistant *see* the map, not just move it.
   *
   * The flood extents are 12,731 polygons across ~5 MB — far too much to put in a prompt, and there
   * is no aggregate the model could compute from them without a spatial join. But MapLibre is
   * already a spatial index over exactly this data, and the popup code already asks it what is under
   * a point. These helpers expose that same question to the tools.
   *
   * The thing to keep hold of: `queryRenderedFeatures` answers "what is currently DRAWN", not "what
   * exists". A hidden layer returns nothing, the viewport clips everything outside it, and at low
   * zoom small polygons are simplified away. So a hit means something and a miss means very little —
   * the same asymmetry as the exposure data, and the tools have to say so.
   */
  const mapQuery = useMemo(
    () => ({
      viewport() {
        const map = mapRef.current
        if (!map) return null
        const b = map.getBounds()
        const c = map.getCenter()
        return {
          west: Number(b.getWest().toFixed(4)),
          south: Number(b.getSouth().toFixed(4)),
          east: Number(b.getEast().toFixed(4)),
          north: Number(b.getNorth().toFixed(4)),
          zoom: Number(map.getZoom().toFixed(2)),
          center: { lon: Number(c.lng.toFixed(4)), lat: Number(c.lat.toFixed(4)) },
        }
      },

      /** Which datasets have any traced extent covering a point, by bounding box. Coarse on purpose:
       *  it answers "is there traced data near here at all", never "was this analysed and found dry". */
      coverage(lon: number, lat: number) {
        return index.datasets
          .filter((d) => d.bbox && lon >= d.bbox[0] && lon <= d.bbox[2] && lat >= d.bbox[1] && lat <= d.bbox[3])
          .map((d) => d.id)
      },

      /** What is drawn at a location. Off-screen returns `onScreen: false` rather than a false miss. */
      at(lon: number, lat: number) {
        const map = mapRef.current
        if (!map) return null
        const b = map.getBounds()
        if (lon < b.getWest() || lon > b.getEast() || lat < b.getSouth() || lat > b.getNorth()) {
          return { onScreen: false, features: [] as { layer: string; properties: Record<string, unknown> }[] }
        }
        const pt = map.project([lon, lat])
        // A few pixels of slack: a thin polygon edge is otherwise almost impossible to hit.
        const box: [[number, number], [number, number]] = [
          [pt.x - 5, pt.y - 5],
          [pt.x + 5, pt.y + 5],
        ]
        const ids = [...cycloneQueryableIds(), ...fieldQueryableIds(), ...queryableLayerIds(index)].filter((id) => map.getLayer(id))
        const hits = map.queryRenderedFeatures(box, { layers: ids })
        return {
          onScreen: true,
          features: hits.map((f) => ({ layer: f.layer.id, properties: (f.properties ?? {}) as Record<string, unknown> })),
        }
      },

      /** What kinds of feature are drawn anywhere in the current view. */
      inView() {
        const map = mapRef.current
        if (!map) return []
        const ids = [...cycloneQueryableIds(), ...fieldQueryableIds(), ...queryableLayerIds(index)].filter((id) => map.getLayer(id))
        if (!ids.length) return []
        const hits = map.queryRenderedFeatures({ layers: ids })
        return hits.map((f) => ({ layer: f.layer.id, properties: (f.properties ?? {}) as Record<string, unknown> }))
      },
    }),
    [index, mapRef],
  )

  // What the assistant's tools can reach. Memoised so a keystroke in the composer does not rebuild
  // it, and deliberately made of the very same values the panel renders from — a figure the
  // assistant quotes and a figure the reader sees come from one source.
  const chatContext = useMemo(
    () => ({
      index,
      places,
      status,
      history,
      weather,
      cyclones,
      fieldManifest,
      map: { basemap, imageryDate, rain, kindVisible, kindOpacity, cycloneShow, view, field, frames, query: mapQuery },
      actions: {
        setCycloneLayer: (k: CycloneLayerKey, v: boolean) => setCycloneShow((s) => ({ ...s, [k]: v })),
        setView: (v: 'floods' | 'weather') => selectView(v, false),
        setValidTime,
        setPlaying,
        setField: onField,
        setKindVisible: (k: KindKey, v: boolean) => setKindVisible((s) => ({ ...s, [k]: v })),
        setKindOpacity: (k: KindKey, v: number) => setKindOpacity((s) => ({ ...s, [k]: v })),
        setDatasetVisible: (id: string, v: boolean) => setDatasetVisible((s) => ({ ...s, [id]: v })),
        zoomTo,
        zoomToDataset: (id: string) => {
          const ds = index.datasets.find((d) => d.id === id)
          if (ds) handleZoom(ds)
        },
        fitAll: fitAllCamera,
        setBasemap,
        setImageryDate,
        setRain,
      },
    }),
    [
      index, places, status, history, weather, cyclones, fieldManifest,
      basemap, imageryDate, rain, kindVisible, kindOpacity, cycloneShow, view, field, frames, onField,
      zoomTo, handleZoom, fitAllCamera, mapQuery, selectView,
    ],
  )

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

      {/* A second map, mounted only while the 3D view is open, over the flat one. Unmounting it
          releases its WebGL context; the 2D map underneath keeps its state untouched. */}
      {view === '3d' ? (
        <Flood3D
          theme={theme}
          index={index}
          places={places}
          scenes={sceneIndex}
          sceneId={sceneId}
          onScene={setSceneId}
          look={look3d}
          onLook={onLook3d}
        />
      ) : null}

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
        view={view}
        onView={selectView}
        threeD={{ scenes: sceneIndex, sceneId, onScene: setSceneId, look: look3d, onLook: onLook3d }}
        field={field}
        onField={onField}
        weathernextReason={weathernextReason}
        cyclones={cyclones}
        cycloneShow={cycloneShow}
        onCycloneShow={(k, v) => setCycloneShow((s) => ({ ...s, [k]: v }))}
        validTime={shownTime}
        onZoomStorm={zoomToStorm}
        chat={chatContext}
        onRunPipeline={handleRun}
        runBusy={busy}
        onFitAll={fitAllCamera}
        picked={pickedPoint}
        onClearPicked={() => setPickedPoint(null)}
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

      {showImageryDate && view !== '3d' ? (
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
      {showImageryDate && clearSearch && view !== '3d' ? <div className="imagery-note">{clearSearch}</div> : null}

      <Timeline
        frames={timelineOn ? frames : []}
        value={shownTime}
        onChange={setValidTime}
        strip={strip}
        leadHours={fieldOn && fieldRunDoc?.init ? (shownStep?.h ?? null) : null}
        playing={playing}
        onPlaying={setPlaying}
        observedUntil={observedTo}
        initTime={fieldOn ? (fieldRunDoc?.init ?? null) : null}
        initIndex={runIndex}
        initCount={runList.length}
        onInitStep={fieldOn && runList.length > 1 ? stepRun : undefined}
        preload={framePreload}
      />

      {view !== '3d' ? <MapLegend field={field} step={shownStep} view={view} onField={onField} /> : null}

      <div id="basemap" className="basemap-switch" role="tablist" aria-label="Basemap" hidden={view === '3d'}>
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
