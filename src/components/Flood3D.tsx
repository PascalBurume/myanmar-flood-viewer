import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import maplibregl from 'maplibre-gl'
import { get3dStyle, type Base3d } from '../basemap'
import type { Theme } from '../theme'
import { layerUrl, type DataIndex } from '../layers'
import {
  formatDay,
  loadScene,
  observationAt,
  stepByte,
  WaterPainter,
  type Scene,
  type SceneData,
  type SceneIndex,
} from '../scenes'
import type { Place } from './TopAffected'

const BASE_URL = import.meta.env.BASE_URL

/** What the reader has chosen to see; owned by the App so the panel and the map share it. */
export interface Look3d {
  base: Base3d
  /** Vertical exaggeration of the terrain. Myanmar's floodplains are flat enough to vanish at 1×. */
  exaggeration: number
  buildings: boolean
  /** Buildings the water has reached, in a warning colour. */
  highlight: boolean
  /** Water density, 0–1. */
  water: number
  orbit: boolean
}

export const DEFAULT_LOOK: Look3d = { base: 'satellite', exaggeration: 1.8, buildings: true, highlight: true, water: 0.9, orbit: false }

/** The country from the south, tilted: the delta's columns in front, Sagaing's behind, the Shan
 *  hills rising to the east. */
const OVERVIEW = { center: [95.9, 19.1] as [number, number], zoom: 6.05, pitch: 58, bearing: -16 }
/** How long one step of a scene's timeline takes to play. */
const SEGMENT_MS = 8000
/** Rest on each observed date while playing, so the reader sees what was actually there. */
const HOLD_MS = 1400
/** Close enough over the flooded houses for the footprints to read as buildings. */
const HOUSES = { zoom: 15.3, pitch: 64 }
const GLIDE_MS = 4200
/** A column's height per person exposed. Linear, so twice the height is twice the people. */
const COLUMN_M_PER_PERSON = 1.6
const HEX_KM = 5
const FLOODED = '#ff6a3d'
const BUILDING = { light: '#f3eee6', dark: '#c9c2b8' }

const ID = {
  water: 'scene-water',
  buildings: 'scene-buildings',
  frame: 'scene-frame',
  pins: 'scene-pins',
  pinLabels: 'scene-pin-labels',
  columns: 'exposure-columns',
} as const

const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

function hexagon(lon: number, lat: number, km: number): number[][] {
  const dx = km / (111.32 * Math.cos((lat * Math.PI) / 180))
  const dy = km / 110.57
  const ring = []
  for (let k = 0; k <= 6; k++) {
    const a = (Math.PI / 3) * (k % 6) + Math.PI / 6
    ring.push([lon + dx * Math.cos(a), lat + dy * Math.sin(a)])
  }
  return ring
}

/** One hexagonal column per township, as tall as the people UNOSAT's FloodAI counts exposed. */
function columns(places: Place[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: places
      .filter((p) => p.people > 0)
      .map((p, i) => ({
        type: 'Feature',
        id: i,
        geometry: { type: 'Polygon', coordinates: [hexagon(p.lon, p.lat, HEX_KM)] },
        properties: { people: p.people, township: p.township, region: p.region, observed: p.observed, flooded: p.flooded },
      })),
  }
}

function pins(index: SceneIndex | null): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: (index?.scenes ?? []).map((s) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: s.center },
      properties: { id: s.id, name: s.name, region: s.region },
    })),
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The 3D view: a separate map, because a tilted terrain map with a sky is a different instrument
 * from the flat one, and keeping it apart leaves the 2D map's layer logic untouched. It is mounted
 * only while the view is open; leaving the view releases its WebGL context.
 *
 * Two scales. Zoomed out, the whole country: SRTM terrain with every township FloodAI counted as a
 * column as tall as the people exposed, and the hand-traced extents draped where they exist. Pick a
 * scene and it flies in to a ~14 km window where water was traced, draws the buildings standing
 * there, and plays the flood: at each satellite date the water is exactly what was seen; between
 * dates the fill is simulated from the terrain, and the view says so throughout.
 */
export function Flood3D({
  theme,
  index,
  places,
  scenes,
  sceneId,
  onScene,
  look,
  onLook,
}: {
  theme: Theme
  index: DataIndex
  places: Place[]
  scenes: SceneIndex | null
  sceneId: string | null
  onScene: (id: string | null) => void
  look: Look3d
  onLook: (patch: Partial<Look3d>) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const popup = useRef<maplibregl.Popup | null>(null)
  const [styleReady, setStyleReady] = useState(0)
  /**
   * Whether the current style has fired `style.load`, so sources and layers can be added.
   * `isStyleLoaded()` is not that question: it also waits for every tile, and with terrain loading
   * during a camera flight it stays false for seconds — the scene's layers were never added and the
   * country's stayed on screen.
   */
  const styleOk = useRef(false)
  const [data, setData] = useState<SceneData | null>(null)
  const [loading, setLoading] = useState(false)
  const painter = useRef<WaterPainter | null>(null)
  /** What each building's feature-state last said, so only the ones that change are touched. */
  const wetState = useRef<Uint8Array | null>(null)
  const tRef = useRef(0)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const playingRef = useRef(false)
  playingRef.current = playing
  const [stats, setStats] = useState({ water: 0, reached: 0 })
  /** Whether the reader has taken the camera since choosing the scene. The view only moves the
   *  camera on its own until they have. */
  const touched = useRef(false)

  // Handlers registered once read the present through refs.
  const lookRef = useRef(look)
  lookRef.current = look
  const dataRef = useRef(data)
  dataRef.current = data
  const themeRef = useRef(theme)
  themeRef.current = theme
  const scenesRef = useRef(scenes)
  scenesRef.current = scenes
  const onSceneRef = useRef(onScene)
  onSceneRef.current = onScene
  const onLookRef = useRef(onLook)
  onLookRef.current = onLook
  const placesRef = useRef(places)
  placesRef.current = places
  const indexRef = useRef(index)
  indexRef.current = index

  const scene = useMemo(() => scenes?.scenes.find((s) => s.id === sceneId) ?? null, [scenes, sceneId])

  /** Paint the water and the buildings for moment `tn`. Returns the readouts for the bar. */
  const draw = useCallback((tn: number, animating: boolean) => {
    const map = mapRef.current
    const d = dataRef.current
    const p = painter.current
    if (!map || !d || !p || !styleOk.current) return null
    const wet = p.paint(tn, lookRef.current.water, animating)
    const q = stepByte(tn, d.scene.steps)
    const ws = wetState.current
    let reached = 0
    const hasSource = Boolean(map.getSource(ID.buildings))
    for (let i = 0; i < d.bOn.length; i++) {
      const w = d.bOn[i] <= q && q < d.bOff[i] ? 1 : 0
      reached += w
      if (ws && w !== ws[i]) {
        ws[i] = w
        if (hasSource) map.setFeatureState({ source: ID.buildings, id: i }, { wet: w === 1 })
      }
    }
    // A paused canvas source never re-uploads; let one frame through, then stop again.
    const cs = map.getSource(ID.water) as maplibregl.CanvasSource | undefined
    if (cs && !playingRef.current) {
      cs.play()
      map.once('render', () => {
        if (!playingRef.current) cs.pause()
      })
    }
    map.triggerRepaint()
    return { water: wet * (d.scene.pixelKm2 ?? d.scene.pixelMetres ** 2 / 1e6), reached }
  }, [])

  const removeScene = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    for (const id of [ID.buildings, ID.water, ID.frame]) {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }
  }, [])

  /** Add everything this view draws on top of the style. Idempotent; called on every style load. */
  const addLayers = useCallback(() => {
    const map = mapRef.current
    if (!map || !styleOk.current) return
    const d = dataRef.current
    const overview = !d
    const style = map.getStyle()
    // The basemap's own OpenStreetMap buildings are sparse here and would double the footprints.
    for (const l of style.layers) {
      if ((l as { 'source-layer'?: string })['source-layer'] === 'building') map.setLayoutProperty(l.id, 'visibility', 'none')
    }
    const before = style.layers.find((l) => l.type === 'symbol')?.id

    // The country: traced extents draped on the terrain, FloodAI townships as columns, scene pins.
    const idx = indexRef.current
    for (const ds of idx.datasets) {
      const info = ds.layers.floodextent
      if (!info) continue
      const id = `extent-${ds.id}`
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: layerUrl(BASE_URL, info, idx.updated) })
      if (!map.getLayer(id)) {
        map.addLayer({ id, type: 'fill', source: id, paint: { 'fill-color': '#2a86e6', 'fill-opacity': 0.85 } }, before)
      }
      map.setLayoutProperty(id, 'visibility', overview ? 'visible' : 'none')
    }
    if (!map.getSource(ID.columns)) map.addSource(ID.columns, { type: 'geojson', data: columns(placesRef.current) })
    if (!map.getLayer(ID.columns)) {
      map.addLayer(
        {
          id: ID.columns,
          type: 'fill-extrusion',
          source: ID.columns,
          paint: {
            'fill-extrusion-height': ['*', ['get', 'people'], COLUMN_M_PER_PERSON],
            'fill-extrusion-base': 0,
            'fill-extrusion-color': [
              'interpolate', ['linear'], ['get', 'people'],
              0, '#fde0c5', 2000, '#f8a36a', 10000, '#e8703a', 30000, '#b23a12',
            ],
            'fill-extrusion-opacity': 0.9,
          },
        },
        before,
      )
    }
    map.setLayoutProperty(ID.columns, 'visibility', overview ? 'visible' : 'none')
    if (!map.getSource(ID.pins)) map.addSource(ID.pins, { type: 'geojson', data: pins(scenesRef.current) })
    if (!map.getLayer(ID.pins)) {
      map.addLayer({
        id: ID.pins,
        type: 'circle',
        source: ID.pins,
        paint: {
          'circle-radius': 7,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#1d6fd6',
          'circle-stroke-width': 3,
          'circle-pitch-alignment': 'viewport',
        },
      })
      map.addLayer({
        id: ID.pinLabels,
        type: 'symbol',
        source: ID.pins,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-max-width': 10,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#0d2a4d', 'text-halo-width': 1.6 },
      })
    }
    for (const id of [ID.pins, ID.pinLabels]) map.setLayoutProperty(id, 'visibility', overview ? 'visible' : 'none')

    // The scene: water on a canvas draped over the terrain, and the buildings standing in it.
    const p = painter.current
    if (!d || !p) return
    const [w, s, e, n] = d.scene.bbox
    if (!map.getSource(ID.water)) {
      map.addSource(ID.water, {
        type: 'canvas',
        canvas: p.canvas,
        coordinates: [[w, n], [e, n], [e, s], [w, s]],
        animate: false,
      })
    }
    if (!map.getLayer(ID.water)) {
      map.addLayer(
        { id: ID.water, type: 'raster', source: ID.water, paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' } },
        before,
      )
    }
    if (!map.getSource(ID.frame)) {
      map.addSource(ID.frame, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[w, n], [e, n], [e, s], [w, s], [w, n]] } },
      })
    }
    if (!map.getLayer(ID.frame)) {
      map.addLayer(
        { id: ID.frame, type: 'line', source: ID.frame, paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.55, 'line-dasharray': [3, 3] } },
        before,
      )
    }
    if (!map.getSource(ID.buildings)) map.addSource(ID.buildings, { type: 'geojson', data: d.buildings })
    if (!map.getLayer(ID.buildings)) {
      map.addLayer(
        {
          id: ID.buildings,
          type: 'fill-extrusion',
          source: ID.buildings,
          minzoom: 11,
          paint: {
            'fill-extrusion-height': ['get', 'h'],
            'fill-extrusion-base': 0,
            'fill-extrusion-color': BUILDING[themeRef.current],
            'fill-extrusion-opacity': 0.96,
            'fill-extrusion-vertical-gradient': true,
          },
        },
        before,
      )
    }
    styleBuildings()
    // Feature-state does not survive a style reload, so everything is pushed again.
    wetState.current = new Uint8Array(d.bOn.length)
    const r = draw(tRef.current, playingRef.current)
    if (r) setStats(r)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw])

  /** Buildings on or off, and the reached ones highlighted or not. */
  const styleBuildings = useCallback(() => {
    const map = mapRef.current
    if (!map?.getLayer(ID.buildings)) return
    const l = lookRef.current
    map.setLayoutProperty(ID.buildings, 'visibility', l.buildings ? 'visible' : 'none')
    map.setPaintProperty(
      ID.buildings,
      'fill-extrusion-color',
      l.highlight
        ? ['case', ['boolean', ['feature-state', 'wet'], false], FLOODED, BUILDING[themeRef.current]]
        : BUILDING[themeRef.current],
    )
  }, [])

  // ---- create the map, once ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const style = await get3dStyle(lookRef.current.base, themeRef.current, lookRef.current.exaggeration)
      if (cancelled || !container.current) return
      const map = new maplibregl.Map({
        container: container.current,
        style,
        center: OVERVIEW.center,
        zoom: OVERVIEW.zoom,
        pitch: OVERVIEW.pitch,
        bearing: OVERVIEW.bearing,
        maxPitch: 78,
        minZoom: 4.5,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      })
      mapRef.current = map
      if (import.meta.env.DEV) (window as unknown as { __map3d?: maplibregl.Map }).__map3d = map
      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left')
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
      popup.current = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '300px' })
      map.on('style.load', () => {
        styleOk.current = true
        addLayers()
        setStyleReady((n) => n + 1)
      })

      for (const ev of ['mousedown', 'touchstart', 'wheel'] as const) map.on(ev, () => (touched.current = true))

      const clickable = [ID.pins, ID.columns, ID.buildings]
      map.on('mousemove', (e) => {
        const ids = clickable.filter((id) => map.getLayer(id))
        const hit = ids.length && map.queryRenderedFeatures(e.point, { layers: ids }).length
        map.getCanvas().style.cursor = hit ? 'pointer' : ''
      })
      map.on('click', (e) => {
        const ids = clickable.filter((id) => map.getLayer(id))
        const f = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids })[0] : undefined
        if (!f) return
        if (f.layer.id === ID.pins) {
          onSceneRef.current(String(f.properties?.id))
          return
        }
        let html = ''
        if (f.layer.id === ID.columns) {
          const pr = f.properties as { township: string; region: string; people: number; observed: string; flooded: number }
          html = `<div class="pop-head">${esc(pr.township)} · ${esc(pr.region)}</div><div class="pop-body pt">
            <p class="pt-now"><span>People exposed</span><strong>${Number(pr.people).toLocaleString()}</strong></p>
            <p class="pt-now"><span>Flooded area</span><strong>${pr.flooded} km²</strong></p>
            <p class="pt-note">UNOSAT FloodAI, observed ${esc(pr.observed)}. Column height is proportional to the people count.</p></div>`
        } else {
          const d = dataRef.current
          const i = Number(f.id)
          if (!d || !Number.isFinite(i)) return
          const lines = d.scene.observations
            .map((o) => {
              const q = stepByte(o.t, d.scene.steps)
              const inIt = d.bOn[i] <= q && q < d.bOff[i]
              return `<p class="pt-now"><span>${esc(formatDay(o.date))}</span><strong>${inIt ? 'in the water' : 'dry'}</strong></p>`
            })
            .join('')
          html = `<div class="pop-head">Building</div><div class="pop-body pt">${lines}
            <p class="pt-note">Footprint: Microsoft Global ML Building Footprints (ODbL), machine-detected. Water: the extent UNOSAT traced from each Sentinel-1 pass. In the water means exposed, not necessarily damaged. Height is drawn, not measured.</p></div>`
        }
        popup.current?.setLngLat(e.lngLat).setHTML(html).addTo(map)
      })
    })()
    return () => {
      cancelled = true
      popup.current?.remove()
      mapRef.current?.remove()
      mapRef.current = null
    }
    // Created once; base, theme and terrain changes are handled below without rebuilding it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- base or theme: a new style, with every overlay re-added on style.load ----
  const firstStyle = useRef(true)
  useEffect(() => {
    if (firstStyle.current) {
      firstStyle.current = false
      return
    }
    let cancelled = false
    void get3dStyle(look.base, theme, lookRef.current.exaggeration).then((style) => {
      if (cancelled || !mapRef.current) return
      styleOk.current = false
      mapRef.current.setStyle(style)
    })
    return () => {
      cancelled = true
    }
  }, [look.base, theme])

  useEffect(() => {
    const map = mapRef.current
    if (map && styleOk.current) map.setTerrain({ source: 'dem-terrain', exaggeration: look.exaggeration })
  }, [look.exaggeration, styleReady])

  useEffect(() => {
    styleBuildings()
  }, [look.buildings, look.highlight, theme, styleReady, styleBuildings])

  // Water density: a repaint at the same moment.
  useEffect(() => {
    if (!playingRef.current) {
      const r = draw(tRef.current, false)
      if (r) setStats(r)
    }
  }, [look.water, draw])

  // The townships arrive after the map is built (they are fetched, not bundled): refresh the columns.
  useEffect(() => {
    ;(mapRef.current?.getSource(ID.columns) as maplibregl.GeoJSONSource | undefined)?.setData(columns(places))
  }, [places, styleReady])

  // Scenes arrive after the map: refresh the pins.
  useEffect(() => {
    ;(mapRef.current?.getSource(ID.pins) as maplibregl.GeoJSONSource | undefined)?.setData(pins(scenes))
  }, [scenes, styleReady])

  // ---- choosing a scene, or going back to the country ----
  useEffect(() => {
    const map = mapRef.current
    setPlaying(false)
    popup.current?.remove()
    if (!scene) {
      painter.current = null
      // Cleared here as well as in state: addLayers below reads the ref, and state only reaches
      // it on the next render — it would still see the scene and hide the country again.
      dataRef.current = null
      setData(null)
      removeScene()
      if (map) {
        addLayers()
        map.flyTo({ ...OVERVIEW, duration: 2600 })
      }
      return
    }
    let cancelled = false
    setLoading(true)
    touched.current = false
    // Fly while the scene loads; the two take about as long as each other.
    map?.flyTo({ center: scene.center, zoom: 12.35, pitch: 63, bearing: -28, duration: 3400 })
    void loadScene(BASE_URL, scene).then((d) => {
      if (cancelled) return
      setLoading(false)
      if (!d) return
      removeScene()
      painter.current = new WaterPainter(d)
      wetState.current = new Uint8Array(d.bOn.length)
      dataRef.current = d
      setData(d)
      // Facts first when motion is unwelcome: open on the last observation, still.
      const reduced = prefersReduced()
      tRef.current = reduced ? d.scene.steps : 0
      setT(tRef.current)
      if (styleOk.current) addLayers()
      const r = draw(tRef.current, false)
      if (r) setStats(r)
      if (reduced) return
      const go = () => {
        if (!cancelled && dataRef.current === d) setPlaying(true)
      }
      if (mapRef.current?.isMoving()) mapRef.current.once('moveend', go)
      else go()
    })
    return () => {
      cancelled = true
    }
  }, [scene, addLayers, removeScene, draw])

  // ---- playback ----
  useEffect(() => {
    const d = data
    const map = mapRef.current
    if (!playing || !d || !map) return
    const steps = d.scene.steps
    if (tRef.current >= steps - 1e-6) tRef.current = 0
    const cs = map.getSource(ID.water) as maplibregl.CanvasSource | undefined
    cs?.play()
    let raf = 0
    let last = performance.now()
    let lastUi = 0
    let holdUntil = 0
    // The camera goes down to the houses once, on the date the water reached the most of them —
    // for Bago that is the first pass, so the reader then watches the water drain around them.
    const peak = d.scene.observations.reduce((a, b) => (b.buildingsInWater > a.buildingsInWater ? b : a)).t
    let glided = false
    const glide = (): boolean => {
      if (glided) return false
      glided = true
      const f = d.scene.focus
      if (!f || touched.current || prefersReduced()) return false
      map.flyTo({ center: f, zoom: HOUSES.zoom, pitch: HOUSES.pitch, bearing: map.getBearing() - 25, duration: GLIDE_MS })
      return true
    }
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      if (now < holdUntil) {
        raf = requestAnimationFrame(tick)
        return
      }
      const prev = tRef.current
      let tn = prev + dt / SEGMENT_MS
      // Crossing an observed date: land on it exactly and rest there.
      const k = Math.floor(prev + 1e-9) + 1
      if (tn >= k && k < steps) {
        tn = k
        holdUntil = now + (k === peak && glide() ? GLIDE_MS + HOLD_MS : HOLD_MS)
      }
      if (tn >= steps) tn = steps
      tRef.current = tn
      const atKey = Math.abs(tn - Math.round(tn)) < 1e-9
      const r = draw(tn, !atKey)
      if (now - lastUi > 100 || atKey) {
        lastUi = now
        setT(tn)
        if (r) setStats(r)
      }
      if (tn >= steps) {
        setPlaying(false)
        if (peak === steps) glide()
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      cs?.pause()
      // The frame left on screen is a still: no moving-front glow.
      const r = draw(tRef.current, false)
      if (r) setStats(r)
      setT(tRef.current)
    }
  }, [playing, data, draw])

  // ---- slow orbit, stopped by the reader's own hand ----
  useEffect(() => {
    const map = mapRef.current
    if (!look.orbit || !map || prefersReduced()) return
    let raf = 0
    let last = performance.now()
    const spin = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      if (!map.isEasing()) map.setBearing(map.getBearing() + dt * 0.004)
      raf = requestAnimationFrame(spin)
    }
    raf = requestAnimationFrame(spin)
    const stop = () => onLookRef.current({ orbit: false })
    map.on('mousedown', stop)
    map.on('touchstart', stop)
    map.on('wheel', stop)
    return () => {
      cancelAnimationFrame(raf)
      map.off('mousedown', stop)
      map.off('touchstart', stop)
      map.off('wheel', stop)
    }
  }, [look.orbit])

  const scrub = (v: number) => {
    setPlaying(false)
    // Snap onto an observed date when close to it, so the observed frame is easy to land on.
    const snapped = Math.abs(v - Math.round(v)) < 0.03 ? Math.round(v) : v
    tRef.current = snapped
    setT(snapped)
    const r = draw(snapped, false)
    if (r) setStats(r)
  }

  const obs = scene ? observationAt(scene, t) : null
  const steps = scene?.steps ?? 1

  return (
    <div className="three-d">
      <div ref={container} className="three-d-map" />

      {scene ? (
        <div className="scene-card">
          <button type="button" className="mini-btn scene-back" onClick={() => onScene(null)}>
            ← Country
          </button>
          <div className="scene-card-text">
            <p className="scene-card-name">{scene.name}</p>
            <p className="scene-card-sub">
              {scene.region} · {scene.event}
            </p>
          </div>
          {scene.focus ? (
            <button
              type="button"
              className="mini-btn scene-houses"
              onClick={() => {
                const map = mapRef.current
                touched.current = true
                map?.flyTo({ center: scene.focus!, zoom: HOUSES.zoom, pitch: HOUSES.pitch, bearing: (map.getBearing() ?? 0) - 25, duration: 3000 })
              }}
            >
              Houses in the water
            </button>
          ) : null}
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              touched.current = true
              mapRef.current?.flyTo({ center: scene.center, zoom: 12.35, pitch: 63, bearing: -28, duration: 2400 })
            }}
          >
            Whole scene
          </button>
        </div>
      ) : null}

      {loading ? <div className="three-d-loading">Loading the scene…</div> : null}

      {scene && data ? (
        <SimBar
          scene={scene}
          t={t}
          playing={playing}
          onPlaying={(on) => {
            if (on && tRef.current >= steps - 1e-6) scrub(0)
            setPlaying(on)
          }}
          onScrub={scrub}
          observedDate={obs?.date ?? null}
          water={stats.water}
          reached={stats.reached}
        />
      ) : null}

      <Legend3D scene={scene} scenes={scenes} />
    </div>
  )
}

/** The scene's own clock: before, each observed date, and the simulated fill between them. */
function SimBar({
  scene,
  t,
  playing,
  onPlaying,
  onScrub,
  observedDate,
  water,
  reached,
}: {
  scene: Scene
  t: number
  playing: boolean
  onPlaying: (on: boolean) => void
  onScrub: (t: number) => void
  observedDate: string | null
  water: number
  reached: number
}) {
  const steps = scene.steps
  const label = observedDate
    ? `Observed ${formatDay(observedDate)}`
    : t <= 1e-6
      ? 'Before — no flood water mapped'
      : 'Simulated between observations'
  return (
    <div className="sim-bar" role="group" aria-label="Flood simulation">
      <button
        type="button"
        className="icon-btn timeline-play"
        aria-pressed={playing}
        aria-label={playing ? 'Pause the flood' : 'Play the flood'}
        onClick={() => onPlaying(!playing)}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
            <rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M4.5 2.8v10.4a.8.8 0 0 0 1.2.7l8.4-5.2a.8.8 0 0 0 0-1.4L5.7 2.1a.8.8 0 0 0-1.2.7z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div className="sim-body">
        <div className="sim-head">
          <span className={`sim-state${observedDate ? ' is-observed' : t > 1e-6 ? ' is-simulated' : ''}`}>{label}</span>
          <span className="sim-readout">
            <strong>{water.toFixed(1)}</strong> km² water · <strong>{reached.toLocaleString()}</strong> buildings in it
          </span>
        </div>
        <div className="sim-track" style={{ '--pos': t / steps } as CSSProperties}>
          <input
            type="range"
            min={0}
            max={steps}
            step={0.001}
            value={t}
            aria-label="Moment of the flood shown"
            aria-valuetext={label}
            onChange={(e) => onScrub(Number(e.target.value))}
          />
          <div className="sim-ticks" aria-hidden="true">
            <span style={{ '--at': 0 } as CSSProperties}>Before</span>
            {scene.observations.map((o) => (
              <span key={o.t} style={{ '--at': o.t / steps } as CSSProperties} className="is-obs">
                {formatDay(o.date)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Legend3D({ scene, scenes }: { scene: Scene | null; scenes: SceneIndex | null }) {
  if (!scene) {
    return (
      <div className="legend-3d">
        <p className="legend-3d-head">Myanmar in 3D</p>
        <div className="legend-3d-row">
          <span className="swatch-col" />
          <span>People exposed per township — height is the count (UNOSAT FloodAI)</span>
        </div>
        <div className="legend-3d-row">
          <span className="swatch" style={{ background: '#2a86e6' }} />
          <span>Hand-traced flood extents (UNOSAT)</span>
        </div>
        <div className="legend-3d-row">
          <span className="swatch-pin" />
          <span>{scenes?.scenes.length ? 'Flood scenes — pick one to fly in' : 'No flood scenes built yet'}</span>
        </div>
        <p className="legend-3d-note">Terrain exaggerated for legibility. Mapzen / AWS terrain (SRTM).</p>
      </div>
    )
  }
  return (
    <div className="legend-3d">
      <p className="legend-3d-head">{scene.name}</p>
      <div className="legend-3d-row">
        <span className="swatch swatch-water" />
        <span>Water — observed on each date, simulated between</span>
      </div>
      <div className="legend-3d-row">
        <span className="swatch" style={{ background: FLOODED }} />
        <span>Building standing in the water</span>
      </div>
      <div className="legend-3d-row">
        <span className="swatch" style={{ background: BUILDING.light, border: '1px solid var(--line-2)' }} />
        <span>Building (heights drawn, not measured)</span>
      </div>
      <p className="legend-3d-note">
        {scenes?.sources.extents} · {scenes?.sources.buildings} · {scenes?.sources.terrain}
      </p>
    </div>
  )
}
