import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'

import { toFeatureCollections, type CycloneDoc, type CycloneShow } from './cyclones'
import {
  activeRun,
  WIND_CLASSES,
  arrowId,
  arrowImage,
  findModel,
  frameUrl,
  modelForLayer,
  nearestStep,
  windFeatures,
  type FieldState,
} from './forecastField'

import {
  RAIN_ATTRIBUTION,
  RAIN_MAX_ZOOM,
  getBasemapStyle,
  rainTileUrl,
  type Basemap,
} from './basemap'
import {
  LAYER_KINDS,
  datasetName,
  layerId,
  layerUrl,
  sourceId,
  sourceSpec,
  type DataIndex,
  type KindKey,
} from './layers'
import type { Theme } from './theme'

// Data paths are relative to wherever the site is mounted, which Vite bakes in at build time.
const BASE_URL = import.meta.env.BASE_URL

export interface OverlayState {
  index: DataIndex
  kindVisible: Record<string, boolean>
  kindOpacity: Record<string, number>
  datasetVisible: Record<string, boolean>
  /** Measured rainfall, drawn over the basemap. Dated, like the imagery. */
  rain: { on: boolean; date: string; opacity: number }
  /** Tropical cyclone tracks and what is drawn of them. */
  cyclones: { doc: CycloneDoc | null; show: CycloneShow }
  /** The gridded forecast field, drawn under everything the flood map is about. */
  field: FieldState
  /**
   * Quieten the flood layers. The Weather view is a reading of the sky, and the exposure circles —
   * the loudest thing on the Floods map by design — sat on top of the rain field and hid it. They
   * stay drawn, faint, so the two can still be read against each other.
   */
  dimFloods: boolean
}

/** How far the flood layers are quietened in the Weather view. */
const FLOOD_DIM = 0.3

// ---- the forecast field ----
//
// One `image` source rather than raster tiles: the frames are a few hundred bytes each and the
// whole point is that scrubbing swaps them instantly, which `updateImage` does without a network
// round trip per tile. `raster-resampling: 'nearest'` keeps the blocks square — they are the
// sampling grid, and smoothing them would draw detail the model does not have.

const FIELD = { img: 'field-img', layer: 'field', wind: 'field-wind' } as const

/** A frame that has not loaded yet, so the source always has something valid in it. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

export function fieldQueryableIds(): string[] {
  return [FIELD.wind]
}

export function fieldPopupHeadings(): Map<string, string> {
  return new Map([[FIELD.wind, 'Forecast field / Wind at 10 m']])
}

// ---- cyclone layers ----
//
// Ids follow the `<dataset>--<kind>-<part>` scheme with `cyclones` as the dataset, so the click
// handler's `splitLayerId` and the popup headings treat them like any other layer.

const CY = {
  wind: 'cyclones--wind',
  observed: 'cyclones--observed',
  forecast: 'cyclones--forecast',
  now: 'cyclones--now',
} as const

const WIND_COLOR: maplibregl.ExpressionSpecification = [
  'match', ['get', 'kt'], 34, '#f2b705', 50, '#f07d1a', 64, '#d13b2e', '#f2b705',
]

/** Layer specs, in stacking order within their group. `source` is the CY key they draw from. */
const CYCLONE_LAYERS: Array<{ show: keyof CycloneShow; spec: maplibregl.LayerSpecification }> = [
  // Under the floods: translucent wedges, so a detected extent is never washed out by wind.
  {
    show: 'wind',
    spec: {
      id: `${CY.wind}-fill`, type: 'fill', source: CY.wind,
      paint: { 'fill-color': WIND_COLOR, 'fill-opacity': ['match', ['get', 'kt'], 34, 0.18, 50, 0.24, 64, 0.32, 0.18] },
    },
  },
  {
    show: 'wind',
    spec: {
      id: `${CY.wind}-outline`, type: 'line', source: CY.wind,
      paint: { 'line-color': WIND_COLOR, 'line-width': 1, 'line-opacity': 0.6 },
    },
  },
]

/** Over the floods: the tracks themselves. A pale category colour needs a dark casing to be seen. */
const CYCLONE_TRACK_LAYERS: Array<{ show: keyof CycloneShow; spec: maplibregl.LayerSpecification }> = [
  {
    show: 'observed',
    spec: {
      id: `${CY.observed}-casing`, type: 'line', source: `${CY.observed}-line`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1b1b1b', 'line-width': 4.5, 'line-opacity': 0.55 },
    },
  },
  {
    show: 'observed',
    spec: {
      id: `${CY.observed}-line`, type: 'line', source: `${CY.observed}-line`,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 },
    },
  },
  {
    show: 'observed',
    spec: {
      id: `${CY.observed}-points`, type: 'circle', source: `${CY.observed}-points`,
      paint: { 'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#1b1b1b', 'circle-stroke-width': 1 },
    },
  },
  // Forecast: dashed line, hollow points. The same rule as the hollow forecast bars in the panel.
  {
    show: 'forecast',
    spec: {
      id: `${CY.forecast}-casing`, type: 'line', source: `${CY.forecast}-line`,
      paint: { 'line-color': '#ffffff', 'line-width': 4, 'line-opacity': 0.7 },
    },
  },
  {
    show: 'forecast',
    spec: {
      id: `${CY.forecast}-line`, type: 'line', source: `${CY.forecast}-line`,
      paint: { 'line-color': '#2b2b2b', 'line-width': 2, 'line-dasharray': [2, 2] },
    },
  },
  {
    show: 'forecast',
    spec: {
      id: `${CY.forecast}-ring`, type: 'circle', source: `${CY.forecast}-points`,
      paint: { 'circle-radius': 6.5, 'circle-opacity': 0, 'circle-stroke-color': '#1b1b1b', 'circle-stroke-width': 1 },
    },
  },
  {
    show: 'forecast',
    spec: {
      id: `${CY.forecast}-points`, type: 'circle', source: `${CY.forecast}-points`,
      paint: { 'circle-radius': 5, 'circle-opacity': 0, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5 },
    },
  },
  // The moment on the timeline: filled when observed, hollow once it is a forecast.
  {
    show: 'observed',
    spec: {
      id: `${CY.now}-marker`, type: 'circle', source: CY.now,
      paint: {
        'circle-radius': 9,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['case', ['get', 'isForecast'], 0, 0.95],
        'circle-stroke-color': '#111111',
        'circle-stroke-width': 2.5,
      },
    },
  },
]

/** Layers a click may land on. Points and wedges, not the lines. */
export function cycloneQueryableIds(): string[] {
  return [`${CY.now}-marker`, `${CY.forecast}-points`, `${CY.observed}-points`, `${CY.wind}-fill`]
}

/** Popup headings for the cyclone layers, merged with the dataset ones by the App. */
export function cyclonePopupHeadings(): Map<string, string> {
  return new Map([
    [`${CY.now}-marker`, 'Tropical cyclones / Position at the time shown'],
    [`${CY.observed}-points`, 'Tropical cyclones / Observed track'],
    [`${CY.forecast}-points`, 'Tropical cyclones / Forecast track (JTWC)'],
    [`${CY.wind}-fill`, 'Tropical cyclones / Wind radii'],
  ])
}

/**
 * MapLibre inside React.
 *
 * The map is created once and lives in a ref, never in state: it is a mutable imperative object
 * whose lifecycle has nothing to do with rendering, and putting it in state would tear it down and
 * rebuild it on every change.
 *
 * The subtlety is `style.load`. Switching basemap or theme replaces the entire style, which drops
 * every source and layer the app added, so they have to be re-added afterwards. That handler is
 * registered once, so it would close over the state as it was at mount — a stale snapshot. It
 * therefore reads through a ref that every render keeps current, which is the whole reason
 * `stateRef` exists.
 */
export function useMapOverlays(
  container: React.RefObject<HTMLDivElement | null>,
  state: OverlayState,
  theme: Theme,
  basemap: Basemap,
  imageryDate: string,
  initialCamera: maplibregl.MapOptions | null,
  onClick: (features: maplibregl.MapGeoJSONFeature[], lngLat: maplibregl.LngLat) => void,
  /**
   * The moment the timeline is showing. A separate argument, not part of `state`, so a scrub
   * re-points only the cyclone sources rather than re-running the whole overlay pass.
   */
  validTime: string | null = null,
) {
  const mapRef = useRef<maplibregl.Map | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  const timeRef = useRef(validTime)
  timeRef.current = validTime
  /** The arrow icons are drawn per theme and re-added on every style load, which is what a theme
   *  switch is — so the handler needs the theme as it is now, not as it was at mount. */
  const themeRef = useRef(theme)
  themeRef.current = theme
  /** The rain date currently loaded into the source, so a change can be detected and re-pointed. */
  const rainDate = useRef('')
  /** What the cyclone sources currently hold, so a scrub or a refreshed file can be detected. */
  const cycloneKey = useRef('')
  /** The same for the field: model, run, layer and moment, so a scrub re-points only what moved. */
  const fieldKey = useRef('')
  /** Frames can land out of order over a slow link; only the newest may win. */
  const fieldSeq = useRef(0)

  /** Re-point the field's image and wind sources at the frame for the current moment. */
  const syncField = useRef(() => {
    const map = mapRef.current
    if (!map || !map.getSource(FIELD.img)) return
    const field = stateRef.current.field
    const run = activeRun(field.manifest, field)
    const model = findModel(field.manifest, modelForLayer(field.model, field.layer))
    const step = nearestStep(run, timeRef.current, field.manifest?.stepHours ?? 3)
    // The wind document loads after the layer is selected, and it must be part of the key: without
    // it the arrivals land on an unchanged key, this returns early and the arrows never appear.
    const key = `${field.manifest?.generatedAt ?? ''}|${field.model}|${run?.key ?? ''}|${field.layer}|${step?.valid ?? ''}|${field.wind?.steps.length ?? 0}`
    if (key === fieldKey.current) return
    fieldKey.current = key

    if (field.layer === 'wind') {
      ;(map.getSource(FIELD.wind) as maplibregl.GeoJSONSource | undefined)?.setData(
        windFeatures(field.wind, timeRef.current),
      )
      map.setLayoutProperty(FIELD.layer, 'visibility', 'none')
      map.setLayoutProperty(FIELD.wind, 'visibility', field.on ? 'visible' : 'none')
      return
    }
    map.setLayoutProperty(FIELD.wind, 'visibility', 'none')
    const url = step ? frameUrl(BASE_URL, step, field.layer) : null
    // The probability layers come from the ensemble, whose grid — and so whose image quad — is a
    // different size from the deterministic one, so the coordinates move with the layer.
    const b = model?.bbox
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] | undefined = b
      ? [[b[0], b[3]], [b[2], b[3]], [b[2], b[1]], [b[0], b[1]]]
      : undefined
    const seq = ++fieldSeq.current
    const src = map.getSource(FIELD.img) as maplibregl.ImageSource | undefined
    if (!src) return
    map.setPaintProperty(FIELD.layer, 'raster-opacity', field.opacity)
    if (!url) {
      src.updateImage({ url: BLANK, coordinates })
      map.setLayoutProperty(FIELD.layer, 'visibility', 'none')
      return
    }
    // Decode first, swap after. `updateImage` fetches and uploads on its own schedule, so two
    // quick steps could land in either order — the guard this replaced compared a counter with
    // itself a line after incrementing it, and never fired. Decoding here makes the swap a cache
    // hit, lets the previous frame stay on screen until the next is ready (no blank flash during
    // playback), and gives the counter something real to guard.
    const img = new Image()
    img.src = url
    const swap = () => {
      if (seq !== fieldSeq.current || mapRef.current !== map || !map.getSource(FIELD.img)) return
      src.updateImage({ url, coordinates })
      map.setLayoutProperty(FIELD.layer, 'visibility', stateRef.current.field.on ? 'visible' : 'none')
    }
    img.decode().then(swap, swap)
  })

  /** Re-point the cyclone sources at the collections for the current file and moment. */
  const syncCyclones = useRef(() => {
    const map = mapRef.current
    if (!map || !map.getSource(CY.now)) return
    const { doc } = stateRef.current.cyclones
    const key = `${doc?.generatedAt ?? ''}|${doc?.storms.length ?? 0}|${timeRef.current ?? ''}`
    if (key === cycloneKey.current) return
    const c = toFeatureCollections(doc, timeRef.current)
    const put = (id: string, data: GeoJSON.FeatureCollection) =>
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data)
    put(CY.wind, c.wind)
    put(`${CY.observed}-line`, c.observedLine)
    put(`${CY.observed}-points`, c.observedPoints)
    put(`${CY.forecast}-line`, c.forecastLine)
    put(`${CY.forecast}-points`, c.forecastPoints)
    put(CY.now, c.now)
    cycloneKey.current = key
  })

  /** Re-add every source and layer, then replay visibility and opacity. */
  const addOverlays = useRef(() => {
    const map = mapRef.current
    if (!map) return
    const { index, kindVisible, kindOpacity, datasetVisible, dimFloods } = stateRef.current

    // Insert below the basemap's first symbol layer so place names stay readable through the fill.
    const before = map.getStyle().layers.find((l) => l.type === 'symbol')?.id

    // Rain goes in first, so every flood layer added afterwards against the same anchor lands on
    // top of it. A translucent rainfall field over the detected extents would wash out the thing
    // the map is actually about.
    const { rain } = stateRef.current
    if (!map.getSource('rain')) {
      map.addSource('rain', {
        type: 'raster',
        tiles: [rainTileUrl(rain.date)],
        tileSize: 256,
        maxzoom: RAIN_MAX_ZOOM,
        attribution: RAIN_ATTRIBUTION,
      })
      rainDate.current = rain.date
    } else if (rainDate.current !== rain.date) {
      // A different day is different data, so the tiles have to be re-pointed on the source that
      // already exists — `addSource` above is skipped once it does, and without this the date
      // control would move while the map kept showing the first day it loaded.
      ;(map.getSource('rain') as maplibregl.RasterTileSource).setTiles([rainTileUrl(rain.date)])
      rainDate.current = rain.date
    }
    if (!map.getLayer('rain')) {
      map.addLayer(
        { id: 'rain', type: 'raster', source: 'rain', paint: { 'raster-opacity': rain.opacity } },
        before,
      )
    }
    map.setLayoutProperty('rain', 'visibility', rain.on ? 'visible' : 'none')
    map.setPaintProperty('rain', 'raster-opacity', rain.opacity)

    // The forecast field goes in immediately after the rain, and so under every flood layer added
    // after it against the same anchor: a translucent rain forecast over a detected extent would
    // wash out the thing the map is actually about.
    const fieldModel = findModel(stateRef.current.field.manifest, modelForLayer(stateRef.current.field.model, stateRef.current.field.layer))
    const fb = fieldModel?.bbox ?? [92, 9.5, 102, 28.5]
    if (!map.getSource(FIELD.img)) {
      map.addSource(FIELD.img, {
        type: 'image',
        url: BLANK,
        coordinates: [[fb[0], fb[3]], [fb[2], fb[3]], [fb[2], fb[1]], [fb[0], fb[1]]],
      })
    }
    if (!map.getLayer(FIELD.layer)) {
      map.addLayer(
        {
          id: FIELD.layer,
          type: 'raster',
          source: FIELD.img,
          paint: {
            'raster-opacity': stateRef.current.field.opacity,
            // The blocks are the sampling grid; smoothing them would imply detail the model does
            // not have. No cross-fade either, or a scrub flashes between frames.
            'raster-resampling': 'nearest',
            'raster-fade-duration': 0,
          },
        },
        before,
      )
    }

    // Cyclone sources are created empty and filled by syncCyclones, which is also what a scrub
    // calls — one path for "the file changed" and "the moment changed".
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }
    for (const id of [CY.wind, `${CY.observed}-line`, `${CY.observed}-points`, `${CY.forecast}-line`, `${CY.forecast}-points`, CY.now]) {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty })
    }
    // Wind wedges go in here, under every flood layer added after them.
    for (const { spec } of CYCLONE_LAYERS) {
      if (!map.getLayer(spec.id)) map.addLayer(spec, before)
    }

    // Kinds outside, locations inside, so the stacking order survives new locations appearing.
    for (const kind of LAYER_KINDS) {
      for (const ds of index.datasets) {
        const info = ds.layers[kind.key]
        if (!info) continue
        const src = sourceId(ds.id, kind.key)
        if (!map.getSource(src)) map.addSource(src, sourceSpec(BASE_URL, info, index.updated))
        for (const spec of kind.specs(ds.id)) {
          if (!map.getLayer(spec.id)) map.addLayer(spec, before)
        }
      }
      for (const ds of index.datasets) {
        if (!ds.layers[kind.key]) continue
        const on = kindVisible[kind.key] && datasetVisible[ds.id] ? 'visible' : 'none'
        const o = (kindOpacity[kind.key] ?? 0.7) * (dimFloods ? FLOOD_DIM : 1)
        for (const spec of kind.specs(ds.id)) {
          if (!map.getLayer(spec.id)) continue
          map.setLayoutProperty(spec.id, 'visibility', on)
          if (!kind.opacity) continue
          // Fill and outline use different paint properties; clamp the outline so a boundary does
          // not disappear entirely at low opacity.
          if (spec.type === 'fill') map.setPaintProperty(spec.id, 'fill-opacity', o)
          else if (spec.type === 'line') map.setPaintProperty(spec.id, 'line-opacity', Math.max(o, dimFloods ? 0.15 : 0.4))
          else if (spec.type === 'circle') {
            map.setPaintProperty(spec.id, 'circle-opacity', o * 0.8)
            map.setPaintProperty(spec.id, 'circle-stroke-opacity', o)
          }
        }
      }
    }

    // Wind arrows sit above the floods but below the storm tracks. `setStyle` drops registered
    // images along with the sources, so the icon is re-added here rather than once at startup.
    WIND_CLASSES.forEach((_, cls) => {
      if (map.hasImage(arrowId(cls))) return
      const img = arrowImage(cls, themeRef.current)
      if (img) map.addImage(arrowId(cls), img, { pixelRatio: 2 })
    })
    if (!map.getSource(FIELD.wind)) {
      map.addSource(FIELD.wind, { type: 'geojson', data: empty })
    }
    if (!map.getLayer(FIELD.wind)) {
      map.addLayer(
        {
          id: FIELD.wind,
          type: 'symbol',
          source: FIELD.wind,
          layout: {
            'icon-image': ['concat', 'wind-arrow-', ['to-string', ['get', 'cls']]],
            'icon-rotate': ['get', 'rot'],
            'icon-rotation-alignment': 'map',
            // Every arrow is drawn. With collision on, the place labels won the space and whole
            // districts came out arrowless — which reads as calm, the opposite of a measurement.
            // The layer sits under the symbol layers, so a label still draws over an arrow, and
            // ignoring placement means an arrow never pushes a label off the map either.
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // Monsoon surface winds over Myanmar are often only a few km/h, so the floor has to
            // be large enough to read at all; colour carries the rest of the scale. Shrunk when
            // zoomed out, where a 1° grid is only twenty-odd pixels apart.
            'icon-size': [
              'interpolate', ['linear'], ['zoom'],
              4, ['interpolate', ['linear'], ['get', 'kmh'], 0, 0.36, 20, 0.5, 60, 0.72],
              6, ['interpolate', ['linear'], ['get', 'kmh'], 0, 0.55, 20, 0.78, 60, 1.1],
            ],
          },
        },
        before,
      )
    }

    // Tracks go in last, over the exposure circles, and the marker over everything.
    for (const { spec } of CYCLONE_TRACK_LAYERS) {
      if (!map.getLayer(spec.id)) map.addLayer(spec, before)
    }
    const { show, doc } = stateRef.current.cyclones
    for (const { show: key, spec } of [...CYCLONE_LAYERS, ...CYCLONE_TRACK_LAYERS]) {
      map.setLayoutProperty(spec.id, 'visibility', doc && show[key] ? 'visible' : 'none')
    }
    syncCyclones.current()
    syncField.current()
  })

  // ---- create the map, once ----
  useEffect(() => {
    if (!container.current || mapRef.current || !initialCamera) return
    let cancelled = false

    void (async () => {
      const style = await getBasemapStyle(basemap, theme, imageryDate)
      if (cancelled || !container.current) return
      const map = new maplibregl.Map({
        ...initialCamera,
        container: container.current,
        style,
        minZoom: 4,
        maxZoom: 19,
        hash: true,
        attributionControl: false,
      })
      mapRef.current = map
      // Dev only: a handle for poking the style from the console or a browser tool. Never in a
      // production build — nothing there should reach into the map from outside React.
      if (import.meta.env.DEV) (window as unknown as { __map?: maplibregl.Map }).__map = map

      map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
      map.addControl(
        new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: false },
          fitBoundsOptions: { maxZoom: 17 },
          trackUserLocation: true,
          showUserLocation: true,
        }),
        'top-right',
      )
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left')
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')

      // Fires on first load and after every setStyle, once addLayer is possible. Testing with
      // 'styledata' + isStyleLoaded() misses the chance to re-add when a source finishes loading
      // after the last event, and the overlays stay gone.
      map.on('style.load', () => addOverlays.current())

      map.on('click', (e) => {
        const ids = [...cycloneQueryableIds(), ...fieldQueryableIds(), ...queryableLayerIds(stateRef.current.index)].filter((id) => map.getLayer(id))
        const features = map.queryRenderedFeatures(e.point, { layers: ids })
        clickRef.current(features, e.lngLat)
      })
      let hovered: { source: string; id: string | number } | null = null
      const unhover = () => {
        if (hovered && map.getSource(hovered.source)) map.setFeatureState(hovered, { hover: false })
        hovered = null
      }
      map.on('mouseout', unhover)
      map.on('mousemove', (e) => {
        const ids = [...cycloneQueryableIds(), ...fieldQueryableIds(), ...queryableLayerIds(stateRef.current.index)].filter((id) => map.getLayer(id))
        const hits = ids.length ? map.queryRenderedFeatures(e.point, { layers: ids }) : []
        const hit = hits.length > 0
        // Hover ring on the exposure circle on top, the one a click would describe first. Not on
        // the Weather view, where the circles are faint background and a click asks the forecast.
        const circle = stateRef.current.dimFloods ? undefined : hits.find((f) => f.layer.type === 'circle' && f.layer.id.includes('--exposure-'))
        const next = circle && circle.id !== undefined ? { source: circle.source, id: circle.id } : null
        if (next?.source !== hovered?.source || next?.id !== hovered?.id) {
          unhover()
          if (next) {
            map.setFeatureState(next, { hover: true })
            hovered = next
          }
        }
        // A crosshair over the forecast: anywhere on it can be clicked for the point forecast.
        const { field, dimFloods } = stateRef.current
        const probe = dimFloods && field.on && field.layer !== 'wind'
        map.getCanvas().style.cursor = hit ? 'pointer' : probe ? 'crosshair' : ''
      })
    })()

    return () => {
      cancelled = true
    }
    // Deliberately empty: the map is created once. Theme and basemap changes are handled by the
    // setStyle effect below, not by rebuilding the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCamera !== null])

  // ---- basemap / theme changes replace the style ----
  const styleSeq = useRef(0)
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const seq = ++styleSeq.current
    void getBasemapStyle(basemap, theme, imageryDate).then((style) => {
      // If another switch started while this style was loading, only the newest one should land.
      // setStyle drops every source, so the recorded rain date has to be cleared too — otherwise
      // the re-added source is created with the right tiles but the ref still matches and a
      // subsequent date change is compared against a source that no longer exists.
      if (seq === styleSeq.current && mapRef.current) {
        rainDate.current = ''
        cycloneKey.current = ''
        fieldKey.current = ''
        mapRef.current.setStyle(style)
      }
    })
  }, [basemap, theme, imageryDate])

  // ---- visibility, opacity and data changes ----
  //
  // A file that arrives while the style is still loading used to be dropped here — the guard
  // returned and nothing re-triggered, because `style.load` had already fired. It showed up as the
  // wind arrows never appearing after a reload: the document landed a moment too early and its
  // source stayed empty until something else happened to nudge the state. Deferring to the next
  // idle rather than returning keeps the guard's purpose (never call addLayer on a half-built
  // style) without losing the update.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (map.isStyleLoaded()) {
      addOverlays.current()
      return
    }
    const onIdle = () => addOverlays.current()
    map.once('idle', onIdle)
    return () => {
      map.off('idle', onIdle)
    }
  }, [state])

  // ---- the timeline moved: only the moving sources need re-pointing ----
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (map.isStyleLoaded()) {
      syncCyclones.current()
      syncField.current()
      return
    }
    const onIdle = () => {
      syncCyclones.current()
      syncField.current()
    }
    map.once('idle', onIdle)
    return () => {
      map.off('idle', onIdle)
    }
  }, [validTime])

  /** Re-point every existing source at a new version-stamped URL, then add anything new. */
  const applyIndex = useRef(async (next: DataIndex) => {
    const map = mapRef.current
    if (!map) return
    for (const ds of next.datasets) {
      for (const kind of LAYER_KINDS) {
        const info = ds.layers[kind.key]
        if (!info) continue
        const src = map.getSource(sourceId(ds.id, kind.key))
        if (src && 'setData' in src) {
          // The stamp is load-bearing: layer paths are byte-identical between updates, so without
          // it the browser and any CDN hand back the previous body and the refresh silently no-ops.
          await (src as maplibregl.GeoJSONSource).setData(layerUrl(BASE_URL, info, next.updated), true)
        }
      }
    }
  })

  return { mapRef, addOverlays, applyIndex }
}

export function queryableLayerIds(index: DataIndex): string[] {
  const ids: string[] = []
  for (const kind of LAYER_KINDS) {
    if (!kind.query) continue
    for (const ds of index.datasets) {
      if (ds.layers[kind.key]) ids.push(layerId(ds.id, kind.key as KindKey, 'fill'))
    }
  }
  return ids
}

export function popupHeadings(index: DataIndex): Map<string, string> {
  const headings = new Map<string, string>()
  for (const kind of LAYER_KINDS) {
    for (const ds of index.datasets) {
      if (!ds.layers[kind.key]) continue
      for (const spec of kind.specs(ds.id)) {
        headings.set(spec.id, `${datasetName(ds)} / ${kind.label}`)
      }
    }
  }
  return headings
}
