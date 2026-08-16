import type { LayerSpecification, SourceSpecification } from 'maplibre-gl'

export const ATTRIBUTION =
  'Flood extents: <a href="https://data.humdata.org/organization/unosat" target="_blank" rel="noopener">UNOSAT via HDX</a> (CC BY-SA)'

// ---- Dataset list (public/data/index.json) ----

export interface DatasetLayerInfo {
  path: string
  features: number
}

/** A published figure about a location, shown in the panel and the popup. */
export interface Stat {
  label: string
  value: number
  unit?: string
  /** Where the number came from. Shown in the panel so a figure is never presented unsourced. */
  source?: string
  /**
   * Set when the provenance of a figure is not established. It is then marked in the UI rather
   * than footnoted, because a number sitting next to sourced ones reads as equally sourced unless
   * something says otherwise — and on a flood map that is a real way to mislead.
   */
  unverified?: boolean
}

export interface Dataset {
  id: string
  name: string
  sourceFile: string
  layers: Record<string, DatasetLayerInfo>
  bbox: [number, number, number, number] | null
  /** Optional per-location figures, shown as a ranked bar list in the panel. */
  stats?: Stat[]
  /** Optional free-text note, e.g. the event and date a layer was captured. */
  note?: string
  /**
   * Optional label tying several datasets together, e.g. "Myanmar". When present it produces an
   * "About <group>" button opening a summary of that group. Kept in the index rather than in code
   * so a future group needs no viewer change.
   */
  group?: string
  /**
   * Optional. When any dataset sets this, the initial view fits only the flagged ones.
   * Flagging is data, not code, so which area the viewer opens on stays a property of the index
   * rather than something hardcoded here.
   */
  focus?: boolean
}

export interface DataIndex {
  updated: string
  source: string
  datasets: Dataset[]
}

/**
 * Load the dataset list. What gets drawn is decided at runtime from this list rather than fixed at
 * build time, so a new location shows up on the map without a code change.
 *
 * This used to merge a second, hand-authored index on top, because the old scanner rewrote
 * index.json on every run. That scanner is gone, so there is only one file again.
 */
export async function loadIndex(base: string): Promise<DataIndex> {
  const res = await fetch(`${base}data/index.json`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Could not load the dataset index (HTTP ${res.status})`)
  return (await res.json()) as DataIndex
}

/**
 * Display-name overrides, keyed by dataset id. The index already carries English names, so this is
 * only needed when a source's own wording should not be shown as-is.
 */
export const DATASET_NAMES: Record<string, string> = {}

export const datasetName = (ds: Dataset): string => DATASET_NAMES[ds.id] ?? ds.name

// ---- Layer kinds ----

export type KindKey = 'waterextent' | 'floodextentearly' | 'floodextent' | 'inputarea' | 'exposure'

/**
 * Colour for satellite-detected flood extent. Deliberately a single flat colour, not the depth
 * ramp: UNOSAT publishes where water was observed, with no depth attached, and a graded scale would
 * imply a measurement that does not exist in the data.
 */
export const EXTENT_COLOR = '#1f7a8c'

/**
 * Colour for total surface water. Deliberately duller and greyer than EXTENT_COLOR so the flood
 * layer stacked above it stays the thing the eye goes to — this layer is context, not the finding.
 */
export const WATER_COLOR = '#8fa8bd'

/**
 * Colour for the earlier satellite pass. A different hue rather than a lighter teal, because the
 * two dates are separate observations to compare, not steps on one scale — and where this colour
 * shows through the later layer, it means water that had drained away by then.
 */
export const EARLY_COLOR = '#8c6bb1'

/**
 * Colour for population exposure. Warm, because it is the only layer about people rather than
 * water — the eye should not read it as another shade of flood.
 */
export const EXPOSURE_COLOR = '#e8703a'

export interface LayerKind {
  key: KindKey
  label: string
  desc: string
  /** Whether to show an opacity slider (only the flooded area, which has a fill) */
  opacity: boolean
  /** Whether a click opens a popup */
  query: boolean
  specs: (datasetId: string) => LayerSpecification[]
}

/** Layer ID. Unique across datasets. */
export const layerId = (datasetId: string, kind: KindKey, part: string): string =>
  `${datasetId}--${kind}-${part}`

export const sourceId = (datasetId: string, kind: KindKey): string => `${datasetId}--${kind}`

// Array order is stacking order (earlier is lower). Flood fill at the bottom, reference point on top.
export const LAYER_KINDS: LayerKind[] = [
  {
    // Listed before floodextent so it draws underneath: this is the baseline, flood water sits on it.
    key: 'waterextent',
    label: 'All surface water',
    desc: 'Every water surface UNOSAT detected, permanent rivers and lakes included. Roughly speaking, what this shows minus the flood layer is the water that is normally there — useful for telling new flooding apart from a river doing what it always does. Check the imaging date in the popup: for some regions it comes from a different satellite and date than the flood layer, so the two are not a strict before/after pair.',
    opacity: true,
    query: true,
    specs: (ds) => [
      {
        id: layerId(ds, 'waterextent', 'fill'),
        type: 'fill',
        source: sourceId(ds, 'waterextent'),
        paint: { 'fill-color': WATER_COLOR, 'fill-opacity': 0.7 },
      } as LayerSpecification,
      {
        id: layerId(ds, 'waterextent', 'outline'),
        type: 'line',
        source: sourceId(ds, 'waterextent'),
        paint: {
          'line-color': WATER_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 15, 0.6],
          'line-opacity': 0.8,
        },
      } as LayerSpecification,
    ],
  },
  {
    // Drawn under `floodextent` so the later pass wins where they overlap. What is left showing in
    // this colour is water present on the earlier date and gone by the later one.
    key: 'floodextentearly',
    label: 'Flood water (earlier pass)',
    desc: 'The same detection from an earlier satellite pass, for regions where UNOSAT published more than one date. Where this colour shows through, water was there earlier and had drained by the later date; where only the main flood colour shows, it arrived later. Each popup carries its own imaging date.',
    opacity: true,
    query: true,
    specs: (ds) => [
      {
        id: layerId(ds, 'floodextentearly', 'fill'),
        type: 'fill',
        source: sourceId(ds, 'floodextentearly'),
        paint: { 'fill-color': EARLY_COLOR, 'fill-opacity': 0.7 },
      } as LayerSpecification,
      {
        id: layerId(ds, 'floodextentearly', 'outline'),
        type: 'line',
        source: sourceId(ds, 'floodextentearly'),
        paint: {
          'line-color': EARLY_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 15, 0.6],
          'line-opacity': 0.8,
        },
      } as LayerSpecification,
    ],
  },
  {
    key: 'floodextent',
    label: 'Detected flood water',
    desc: 'Flood water detected in Sentinel-1 radar imagery by UNOSAT. This is observed extent on one date, not depth, and radar misses water under dense vegetation or inside buildings. Geometry is simplified for display — read the area off the popup rather than measuring it.',
    opacity: true,
    query: true,
    specs: (ds) => [
      {
        id: layerId(ds, 'floodextent', 'fill'),
        type: 'fill',
        source: sourceId(ds, 'floodextent'),
        paint: { 'fill-color': EXTENT_COLOR, 'fill-opacity': 0.7 },
      } as LayerSpecification,
      {
        id: layerId(ds, 'floodextent', 'outline'),
        type: 'line',
        source: sourceId(ds, 'floodextent'),
        paint: {
          'line-color': EXTENT_COLOR,
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.2, 15, 0.8],
          'line-opacity': 0.9,
        },
      } as LayerSpecification,
    ],
  },
  {
    key: 'inputarea',
    label: 'Estimation extent',
    desc: 'The area the analysis actually covered. Nothing outside this outline was assessed, so blank ground beyond it does not mean there was no flooding — it means nobody looked.',
    opacity: false,
    query: false,
    specs: (ds) => [
      {
        id: layerId(ds, 'inputarea', 'line'),
        type: 'line',
        source: sourceId(ds, 'inputarea'),
        paint: {
          'line-color': '#e5533d',
          'line-width': 2,
          'line-dasharray': [3, 2],
        },
      } as LayerSpecification,
    ],
  },
  {
    // Last in the array, so it draws above every water layer: these are the people, and they should
    // never be hidden underneath the thing that happened to them.
    key: 'exposure',
    label: 'People exposed (nationwide)',
    desc: "UNOSAT's AI detector run over Sentinel-1 for the whole country, then crossed with WorldPop. One circle per township, sized by the number of people under detected water. This is the only layer that covers all of Myanmar and the only one measured in people — the flood layers above it are hand-traced extents for four regions. Radar underestimates water under vegetation and in built-up areas, and WorldPop can overestimate urban populations.",
    opacity: true,
    query: true,
    specs: (ds) => [
      {
        id: layerId(ds, 'exposure', 'fill'),
        type: 'circle',
        source: sourceId(ds, 'exposure'),
        paint: {
          // Area-proportional rather than radius-proportional: doubling the radius quadruples the
          // ink, which would read as four times the people.
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['sqrt', ['max', ['get', 'People exposed'], 1]],
            1, 2,
            50, 8,
            160, 18,
            400, 34,
          ],
          'circle-color': EXPOSURE_COLOR,
          'circle-opacity': 0.55,
          'circle-stroke-color': EXPOSURE_COLOR,
          'circle-stroke-width': 1,
          'circle-stroke-opacity': 0.9,
        },
      } as LayerSpecification,
    ],
  },
]

/**
 * URL for a layer's GeoJSON, optionally version-stamped.
 *
 * The stamp matters more than it looks. Paths like `data/MM_Bago/floodextent.geojson` are
 * byte-identical strings from one update to the next, so refreshing a source with the same URL gets
 * the previous body straight back out of the browser cache or the Pages CDN — the refresh would
 * report success and change nothing on screen. Passing the index's `updated` timestamp makes the
 * URL change exactly when the data does.
 */
export function layerUrl(base: string, info: DatasetLayerInfo, version?: string): string {
  const url = `${base}${info.path}`
  return version ? `${url}?v=${encodeURIComponent(version)}` : url
}

export function sourceSpec(
  base: string,
  info: DatasetLayerInfo,
  version?: string,
): SourceSpecification {
  return { type: 'geojson', data: layerUrl(base, info, version), attribution: ATTRIBUTION }
}

/** At most this many overlapping features are listed for one click. */
export const POPUP_MAX_ITEMS = 8

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * Display labels for attribute names. The names come from UNOSAT's shapefiles, where the dbf format
 * truncates them to 10 characters, so they are translated at display time rather than in the data.
 * Unknown attribute names are shown as they are.
 */
const PROP_LABELS: Record<string, string> = {
  // UNOSAT flood-extent fields, abbreviated to 10 characters by the shapefile dbf format.
  Water_Clas: 'Water class',
  Water_Stat: 'Water status',
  Sensor_ID: 'Sensor',
  Sensor_Dat: 'Imaged on',
  SensorDate: 'Imaged on',
  Confidence: 'Confidence',
  Area_ha: 'Area (ha)',
  EventCode: 'UNOSAT event',
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export function popupHtml(
  features: { layer: { id: string }; properties: Record<string, unknown> | null }[],
  /** Layer ID → heading ("location / layer"), so it is clear which location a feature belongs to. */
  headings: Map<string, string>,
): string {
  const items = features.slice(0, POPUP_MAX_ITEMS).map((f) => {
    const props = f.properties ?? {}
    const rows = Object.entries(props)
      .map(
        ([k, v]) =>
          `<tr><th>${escapeHtml(PROP_LABELS[k] ?? k)}</th><td>${escapeHtml(formatValue(v))}</td></tr>`,
      )
      .join('')
    const head = headings.get(f.layer.id) ?? f.layer.id
    return `<div class="pop-item"><p class="pop-item-head">${escapeHtml(head)}</p><table class="pop-tbl">${rows || '<tr><td>No attributes</td></tr>'}</table></div>`
  })
  const more =
    features.length > POPUP_MAX_ITEMS
      ? `<p class="pop-item-head">${features.length - POPUP_MAX_ITEMS} more</p>`
      : ''
  return `<div class="pop-head">Feature info</div><div class="pop-body">${items.join('')}${more}</div>`
}
