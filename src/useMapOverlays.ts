import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'

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
) {
  const mapRef = useRef<maplibregl.Map | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const clickRef = useRef(onClick)
  clickRef.current = onClick
  /** The rain date currently loaded into the source, so a change can be detected and re-pointed. */
  const rainDate = useRef('')

  /** Re-add every source and layer, then replay visibility and opacity. */
  const addOverlays = useRef(() => {
    const map = mapRef.current
    if (!map) return
    const { index, kindVisible, kindOpacity, datasetVisible } = stateRef.current

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
        const o = kindOpacity[kind.key] ?? 0.7
        for (const spec of kind.specs(ds.id)) {
          if (!map.getLayer(spec.id)) continue
          map.setLayoutProperty(spec.id, 'visibility', on)
          if (!kind.opacity) continue
          // Fill and outline use different paint properties; clamp the outline so a boundary does
          // not disappear entirely at low opacity.
          if (spec.type === 'fill') map.setPaintProperty(spec.id, 'fill-opacity', o)
          else if (spec.type === 'line') map.setPaintProperty(spec.id, 'line-opacity', Math.max(o, 0.4))
          else if (spec.type === 'circle') {
            map.setPaintProperty(spec.id, 'circle-opacity', o * 0.8)
            map.setPaintProperty(spec.id, 'circle-stroke-opacity', o)
          }
        }
      }
    }
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
        const ids = queryableLayerIds(stateRef.current.index).filter((id) => map.getLayer(id))
        const features = map.queryRenderedFeatures(e.point, { layers: ids })
        clickRef.current(features, e.lngLat)
      })
      map.on('mousemove', (e) => {
        const ids = queryableLayerIds(stateRef.current.index).filter((id) => map.getLayer(id))
        const hit = ids.length > 0 && map.queryRenderedFeatures(e.point, { layers: ids }).length > 0
        map.getCanvas().style.cursor = hit ? 'pointer' : ''
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
        mapRef.current.setStyle(style)
      }
    })
  }, [basemap, theme, imageryDate])

  // ---- visibility, opacity and data changes ----
  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    addOverlays.current()
  }, [state])

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
