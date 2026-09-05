# myanmar-flood-viewer

A self-contained Myanmar flood viewer: React front end, a zero-dependency Node server, and a
standard-library Python pipeline. It runs, updates and serves itself from one machine.

**Why the early git history is in Japanese.** The repository began life as a Japanese flood viewer
before being rebuilt for Myanmar; commits before `b0b5918` describe that work and nothing in the
current tree depends on it. If the git remote still carries the old repository name, that is a
rename to make on the hosting side — the code never refers to it.

## Data

Two sources answering different questions, and the difference matters more than it looks.

**`scripts/scan_floodai.py` — UNOSAT FloodAI, nationwide and near-current.** UNOSAT run a deep
learning detector over Sentinel-1 and publish it as an ArcGIS service, refreshed as imagery
arrives. The companion `<service>_Stat` FeatureServer carries one point per township with people
exposed, flooded area, flooded cropland and observed area. This is the only source that covers the
whole country and the only one measured in **people**.

- Service names carry a date (`AI20260814MMR`), so the newest is **discovered** from
  `/server/rest/services/FloodAI?f=json` rather than pinned. That is also how a new event is picked
  up without editing code.
- Townships with no observation come back with every measure null. They are **dropped**, not
  written as zero — an unobserved place is not a place with no flooding.
- Totals reconcile exactly with the published dashboard (616,059 people / 5,137 km² / 4,322 km² /
  259,739 km² for the 2026-08-08 window), which is the check that the query is right.
- Circle radius interpolates on `sqrt(people)`, so **area** is proportional to the count. Scaling
  the radius directly would quadruple the ink for double the people.

**Hand-traced UNOSAT extents — four regions, precise, historical.** Everything below. These are the
only layers with a real outline, but they are months to years old and cover four regions.

The four regions are roughly 20% of the people the nationwide layer counts: Sagaing and Ayeyarwady
are consistently the worst affected and have no traced extent here at all.

### The hand-traced extents

Four regions, all satellite-detected flood **extent** — where water was seen on one date, with **no
depth attribute**. Every flood layer is therefore one flat colour: a graded scale would imply a
measurement the data does not contain.

| Location | Event | Imaged | UNOSAT product |
|---|---|---|---|
| Yangon Region | monsoon flooding | 2021-08-25, 2021-08-31 | FL20210831MMR |
| Bago Region | monsoon flooding | 2021-08-25, 2021-08-31 | FL20210831MMR |
| Mandalay Region | Typhoon Yagi | 2024-09-15, 2024-09-24 | FL20240912MMR |
| Nay Pyi Taw Union Territory | Typhoon Yagi | 2024-09-15, 2024-09-24 | FL20240912MMR |

Mixed event dates are deliberate — no single UNOSAT product covers all four areas.

**Yangon holds only 19 flood polygons.** The 2021 analysis extent barely reaches Yangon Region, so
this is a gap in what was analysed, not evidence the region stayed dry. The `inputarea` layer exists
to make that visible: its boundary runs east of Yangon city.

### Layer kinds

`waterextent` (all water, drawn lowest) → `floodextentearly` (earlier pass) → `floodextent` (main
date) → `inputarea` (what was analysed). Array order in `LAYER_KINDS` is stacking order.

Two traps recorded in the data:

- **Sensor and date do not always match between layers.** Yangon and Bago pair cleanly (Sentinel-1,
  2021-08-31). Mandalay and Nay Pyi Taw do not: their water extent is Gaofen-3 from 2024-09-15
  against a Sentinel-1 flood layer from 2024-09-24, because UNOSAT published no Sentinel-1 water
  extent for that event. Not a before/after pair. The sensor and date are in every popup.
- **`Water_Clas` is dropped from the water layer** (`--drop Water_Clas`). UNOSAT sets it to
  `'Flood Water'` on the WaterExtent file exactly as on the FloodExtent file, so passing it through
  would label permanent rivers as flood water.

### Conversion

`scripts/convert_unosat.py`, standard library only. UNOSAT ships each extent as **one** feature
holding tens of thousands of rings (10–90 MB), so simplification is mandatory — the viewer reads
GeoJSON with no tiling. Rings are assigned to a region by **centroid against the real boundary**
(`--region-mode centroid`), not by bounding box, because Yangon and Bago boxes overlap. Analysis
extents use `--region-mode overlap` instead: those polygons are larger than any one region, so
centroid assignment would discard them. `--exclude-name` exists because geoBoundaries ADM1
"Mandalay" still contains Nay Pyi Taw Union Territory, which would otherwise be counted twice.
`Area_ha` is dropped whenever clipping is on, since it describes the whole undivided source.

### Statistics

Every statistic shown is now sourced and dated. *Flood impact (people)* comes from WFP ADAM with an
event id and retrieval date; *People exposed (nationwide)* from UNOSAT FloodAI with its service id
and observation date.

**The supplied *Flood risk share* figures were removed in Aug 2026** (Yangon 53.3%, Bago 30.0%,
Mandalay 13.3%, Nay Pyi Taw 3.3% — recoverable from git). They had been shown alongside the ADAM
impact figures and labelled unverified, on the reasoning that the two measured different things and
dropping either would destroy information. Three findings ended that:

- **No provenance.** They were supplied without a citation, and a search in Aug 2026 found none.
- **A closed tally, not a rate.** Exactly 16/9/4/1 of 30 records, summing to 100% — so they counted
  something across those four regions alone. Nothing about Myanmar as a whole.
- **They invert the measured ranking.** Both datasets here put Bago above Yangon; the shares put
  Yangon first. WFP ADAM has Bago at 99.4% against Yangon's 0.6%; UNOSAT FloodAI (2026-08-08) has
  53.7% against 28.3%. Mandalay and Nay Pyi Taw were close to FloodAI — it was the top two that were
  swapped.

An unsourced figure that also contradicts the measured data is not a second perspective, and a
label saying so is weaker than not printing the number. `Stat.unverified` remains in the schema and
the assistant still carries the "unverified is not sourced" rule, because the next supplied figure
should be labelled rather than quietly trusted.

### Every figure on the panel says where it came from

The project's rule is that a number never appears without its source and date. The panel's three
most numeric blocks were breaking it — the summary band, Worst affected and Statistics all showed
bare figures — which became obvious once the assistant beside them started citing a service id and
observation date on everything it said.

- The summary band and Worst affected carry the observation date, read via `observedRange(places)`
  from the per-feature `Observed` property. It returns a **range** when passes disagree, because one
  UNOSAT product stitches several together and two townships in one file can have been looked at on
  different days.
- Statistics **numbers** its sources and marks each row with the matching superscript. A flat list
  at the bottom left no way to tell which figure came from where — and these rows come from three
  very different places, one of which is the set whose provenance was never established. A reader
  deciding how much to trust `53.3%` has to be able to find that it is the unsourced one.

**`flex: none` on `.summary-band`, for the third time in this file.** It sets `overflow: hidden` to
keep the cell backgrounds inside its rounded corners, which makes its implicit `min-height: auto`
resolve to 0 inside `.panel-body`'s flex column. Adding one line of caption was enough to make the
whole band collapse to its 2px of border and disappear. It had been one added element away from that
the entire time. Any new block in the panel that sets `overflow: hidden` needs `flex: none` with it.

### Panel width is one token, read by both halves

`--panel-w` in `:root` (384px, 440px above 1500px) is the only place the width is written down.
`.panel` uses it, and `fitPadding` in `src/App.tsx` **reads it back out** with `getComputedStyle`
rather than repeating the number.

That indirection is the point. The two used to be separate constants, so widening the panel would
have silently started fitting data underneath it — which is the one thing that padding exists to
prevent, and it would have looked like a map bug rather than a CSS one. The panel grew from 320px
when it stopped being a legend and became a reading surface with an assistant in it; mobile is
untouched, since the bottom sheet is full width either way.

## Card styling

`.notice`, `.alert` and `.wx-caveat` share one shape in `src/style.css`, driven by two custom
properties each card sets for itself — `--tint` (a faint wash of its own severity) and `--rail`
(the accent down the left edge).

- **The rail is a `::before`, not a `border-left`.** A border squares off the rounded corners; a
  pseudo-element can carry a gradient and fade out as it descends.
- **`flex: none` is load-bearing.** The cards use `overflow: hidden` to keep the rail inside the
  radius, and `overflow: hidden` makes a flex item's implicit `min-height: auto` resolve to **0** —
  inside the panel's flex column that squashed a 191px card to 22px and clipped it to one line.
- **Severity tints the whole card, faintly.** Loud enough to read at a glance without parsing the
  text, faint enough that six of them in a column are not noise and the map stays the loudest thing
  on screen.
- **`--warning` and `--warning-ink` are two tokens on purpose.** The bright amber works as a rail or
  a badge fill but measures **3.64:1** as small bold text on the pale panel, under the 4.5:1 AA
  needs; text and the badge fill take the darker ink instead (6.2:1). In dark mode the two collapse
  to one value. Every card colour was measured, both themes, and clears AA.
- The critical count carries a slow, low-contrast pulse: a standing condition, not a notification
  demanding a click. It respects `prefers-reduced-motion`.

## Viewer (React)

The UI is React; the map is not. `src/useMapOverlays.ts` holds the MapLibre instance in a ref and
creates it once — putting it in state would tear it down and rebuild it on every render.

Three things there are load-bearing:

- **`style.load` reads through `stateRef`, not a closure.** The handler is registered once, so a
  plain closure would capture the state as it was at mount and re-add stale layers after every
  basemap or theme switch. Every render refreshes the ref.
- **`initialCamera` is passed to the constructor**, because `fitBounds()` afterwards does not affect
  the opening view. It is computed once from the `focus`-flagged datasets.
- **Sources carry `?v=<index.updated>`.** Layer paths are byte-identical between updates, so without
  the stamp `setData` gets the cached body back and an applied refresh silently changes nothing.

Re-rendering the panel is now idempotent for free, which is what the old imperative builders needed
`replaceChildren()` to achieve.

## Server

`server/index.mjs`, zero dependencies, same reasoning as the stdlib-only Python: nothing to keep
patched. Serves the built site and exposes `GET /api/status`, `GET /api/run`, `POST /api/run`.

- **Runs are serialised and rate-limited** (one at a time, 30s cooldown). Two concurrent pipelines
  would race on `status.json` and on the publish directory swap.
- **No single-page fallback.** Returning `index.html` for a missing file would hand the viewer HTML
  where it asked for JSON, surfacing as `Unexpected token '<'` instead of the 404 its loaders
  already handle.
- **Binds to 127.0.0.1 with no auth**, because `POST /api/run` executes a pipeline. It warns loudly
  on startup if bound wider.
- The client half (`checkServer`/`startRun`/`pollRun` in `src/pipeline.ts`) degrades to "no server"
  rather than erroring, so the same build works as static files or behind the server.

## Data sources

Reference repository: https://github.com/shiwaku/dm-converter/tree/main/viewer
(MapLibre GL JS + Vite + TypeScript; the panel UI and theme switching follow it.)

- Data is read directly as GeoJSON sources — no tiling.
- Basemaps: **Map** (OpenFreeMap Liberty, OpenStreetMap, global, no API key), **Satellite** and
  **Flood 7-2-1** (NASA GIBS), and **Blank**.
- **NASA GIBS imagery is dated**, which is the whole point of including it: you can look at the
  actual picture from the day the flood was detected. Two traps:
  - GIBS is WMTS REST, so the path is `{TileMatrix}/{TileRow}/{TileCol}` — **`{z}/{y}/{x}`, not
    `{z}/{x}/{y}`**. Writing the usual order silently returns the wrong tiles rather than erroring.
  - The style cache is keyed by basemap and theme, so dated imagery must not go through it — a
    different day is a different map. `getBasemapStyle` returns imagery before the cache lookup.
  - `defaultImageryDate()` is *yesterday* UTC: GIBS assembles a day's imagery after the fact, so
    today is usually empty.
  - Bands 7-2-1 is the standard flood combination — water near-black, vegetation green, cloud cyan.
    True colour cannot separate wet ground from shadow.
  - **It is served from VIIRS, not MODIS, though MODIS's band numbers name it.** MODIS images
    2330 km per pass against ~2750 km between consecutive orbits, so below ~30° latitude each day
    leaves a wedge nothing looked at, and Myanmar (10–28°N) sits in it. It arrives as a **black
    diagonal band across the country**: measured over five inland tiles, Terra loses 1.6–25.9% of
    the region depending on the day. Aqua gaps too, one tile column east (57% on the same day).
    The gap cannot be layered over — GIBS bakes no-data in as **opaque black**, serving JPEG
    whatever extension is asked for, and even WMS with `TRANSPARENT=TRUE` returns 44.3% opaque
    black and 0% transparent. Nor can the black be keyed out, because **water is near-black by
    design here**, so keying it would punch holes in the flood water itself. VIIRS images 3060 km
    and overlaps at every latitude: 0.0–0.9% no-data across all six dates this viewer uses.
    `M11-I2-I1` is the same physics (SWIR, NIR, red) at 375 m rather than 250 m — the resolution is
    the price of never losing a wedge of the map.
  - Optical imagery is frequently cloud-covered during monsoon flooding. That is not a bug and it
    is the reason the detection underneath is radar; the README says so to the reader.
- **Cloud-free** is EOX's Sentinel-2 cloudless (CC BY-NC-SA 4.0 — note the NC), a composite that
  keeps the clear pixel from many passes. It answers "I cannot see the ground", not "show me the
  flood": it is a yearly mosaic and carries no date.
- **`tileCloudiness()` must handle both products.** Cloud is white in true colour but **cyan** in
  bands 7-2-1, because the SWIR band is dark over cloud while the NIR and red bands are bright
  (M11/I2/I1 on VIIRS behave as 7/2/1 do on MODIS, which is why the swap preserved the scoring). A
  brightness-and-greyness test alone scored a measured 87%-cloud 7-2-1 tile at **0%** — it reported
  a solid-cloud day as perfectly clear. Both signatures are counted; that is safe because
  true-colour water is dark rather than cyan and 7-2-1 land is green. A tile that is mostly no-data
  returns 1 (unusable), never 0.
  `relabelEnglish()` in `src/basemap.ts` rewrites every name-bearing `text-field` to
  `coalesce(name:en, name_en, name:latin, name)`; features with no translation keep their local
  name, so some Burmese labels remain. The style ships with no attribution, so OSM attribution is
  attached in code.
- The dark theme inverts the basemap's lightness (`recolor` in `src/basemap.ts`).

### Implementation notes

- **What gets displayed is decided by reading `public/data/index.json` at runtime.** Sources and
  layers are assembled as kind (`LAYER_KINDS`) × location; the layer ID is `<location>--<kind>-<part>`.
- **Re-adding overlays after a basemap or theme switch happens in `map.on('style.load', …)`.**
  Testing with `styledata` + `isStyleLoaded()` misses the chance to re-add when a source finishes
  loading after the last event fires, and the layers stay gone.
- Overlays are inserted below the basemap's first symbol layer so place names stay readable.
- Toggle and opacity state is lost on `setStyle`, so it is held in React state and replayed.
- **The initial view is passed via `bounds` on `new Map()`** — `fitBounds()` right after construction
  does not affect the initial camera. Datasets flagged `focus: true` are the only ones it fits.
- Times are shown in **Myanmar time** (`Asia/Yangon`, labelled MMT).

## Weather

### Rainfall on the map — GIBS / GPM IMERG

An **overlay**, not a basemap: rain without the ground under it says very little, so it rides over
whichever base is showing. Added first in `addOverlays` against the same `before` anchor, so every
flood layer added afterwards lands on top of it — a translucent rain field over the detected extents
would wash out the thing the map is about.

- **PNG, not JPEG** (most of a tile is "no rain"), and **matrix set `GoogleMapsCompatible_Level6`** —
  `maxzoom` is 6, not the 9 the reflectance layers use. Asking for level 7 returns nothing.
- **Its own date, separate from `imageryDate`.** IMERG is assembled about two days back and returns
  **404** rather than an empty tile for a day it has not built. `defaultRainDate()` is therefore
  *two* days back, not one, and sharing the imagery control would blank the layer whenever the
  reader stepped to yesterday.
- **`setTiles` on date change.** `addSource` is skipped once the source exists, so without the
  explicit re-point the date control would move while the map kept showing the first day it loaded.
  `rainDate` (a ref) records what is loaded; `setStyle` drops sources, so it is cleared there too.
- The legend is sampled from NASA's `GPM_Precipitation_Rate.xml`, so the key matches the pixels.
  The ramp is **logarithmic** (0.1 → 50 mm/hr). The colour map also holds a *Snow Rate* ramp
  (cyan→purple); a pixel census of a Bay-of-Bengal tile found only rain-ramp greens, so the blue seen
  over water is the dark-theme basemap ocean, not frozen precipitation.

### Forecasts — `scripts/scan_weather.py` → `public/data/weather.json`

**The only forecasts in this viewer.** Everything else is an observation of something that already
happened, and a reader cannot tell them apart unless told — so the caveat is stated in the file
(`note`), at the top of the panel section, and by drawing every forecast bar hollow.

- **River discharge is the default view, not rainfall.** Rain is the input; flow is what overtops a
  bank, and it integrates rain that fell days ago hundreds of kilometres upstream, so a river can be
  rising under a clear sky.
- **The ensemble envelope is drawn** (`river_discharge_min`/`max`). GloFAS's own spread widens from
  about ±1% tomorrow to −11%/+38% at 13 days; one confident line would hide that.
- **The past half of the rainfall chart is not filler.** Flooding is the consequence of rain that has
  already fallen, so "what landed this week" explains the map as it is now; the forecast only says
  whether it is about to get worse.

**Gauge coordinates are channel cells, not towns — do not "correct" them.** GloFAS is gridded at
about 5 km, so one cell off the Ayeyarwady reports a stream. "Magway" at the town's own coordinates
returned **113 m³/s** against **30,338** in the channel nearby: a 270-fold error the response gives
no hint of. Every point was found by probing a grid and keeping the largest flow, and carries
`typicalWhenChosen`; `DRIFT_FACTOR = 20` flags a cell that has wandered rather than publishing a
hundredfold flood.

Fetched **by the pipeline, not the page**, so the served site still contacts nothing but basemap
tiles. The stage is **never fatal** — a flood map is complete without a forecast, so an Open-Meteo
outage records `skipped` rather than turning a good run red.

## The Weather view

A second reading of the same map (`?view=weather`), modelled on Google Weather Lab: a Model radio,
Layers, the cyclone card, an init stepper on the timeline and a key on the map. `scripts/
scan_forecast_field.py` → `public/data/field/`; `src/forecastField.ts` holds the types and the
derivations, `WeatherControls.tsx` and `MapLegend.tsx` the surfaces.

**The URL hash belongs to MapLibre** (`hash: true` writes the camera there on every move), so the
view is a query parameter and the effect that writes it preserves `location.hash`.

Traps recorded:

- **A MapLibre `image` source is one quad in Web Mercator.** Rows spaced evenly in latitude land up
  to a whole cell off across a 19° span — measured: 58 of 156 output rows move by one cell. So the
  PNG is written with Mercator-spaced rows (`mercator_rows()`), four per cell, and the unit test
  pins both the count and the direction.
- **The per-minute limit is the one that bites.** Open-Meteo counts a location as a call and
  refuses past roughly 800 in a minute — the grid is 819 — while the daily ceiling is 10,000. Hence
  `Pacer`, and `api()` retrying once on a 429 because Open-Meteo's rolling window and ours disagree
  at the boundary. The ensemble endpoint costs far more than its location count and gets its own,
  much smaller budget.
- **`models=a,b,c` returns a column per model for the same locations**, so all three deterministic
  models cost one pass over the grid rather than three.
- **Open-Meteo's hourly series starts at 00:00 UTC today** whatever the run's init, so the hours
  before the init belong to the previous run and are dropped.
- **Only ECMWF publishes `last_run_initialisation_time`.** GFS and ICON say "run time not
  published" everywhere — never a guessed one — and their run directories are keyed by fetch time.
- **A forecast frame is a forecast whatever its timestamp.** The badge first read `t >
  observedUntil`, which with a model that publishes no init left every field frame labelled
  *Observed*. `mergeFrames` now marks field frames outright and ORs in the storm boundary.
- **An update that lands while the style is loading used to be dropped.** The `[state]` effect
  returned when `isStyleLoaded()` was false and nothing re-triggered it, so a wind file arriving a
  moment early left its source empty until something else nudged the state. It now defers to the
  next `idle` instead of returning.
- **`syncField`'s cache key must include the wind document.** Without it the async arrival landed on
  an unchanged key and the arrows never appeared — the same class of bug as the one above, found the
  same way.
- **Run directories are immutable**: written once, deleted when they age out. `server/index.mjs`
  serves them `immutable` (the one exception under `/data`) so the timeline's preload warms
  anything; the manifest stays `no-cache`.
- **The palette is one table.** `LEGENDS` in the scanner classifies the pixels and is copied into
  the manifest, which is what `MapLegend` draws. The client must never carry its own stops.
- **Wind direction is where the wind comes from**; the arrow rotates 180°. Surface winds here are
  often a few km/h, so the icon-size floor is large enough to read at all.
- **`points.json` exists so the assistant never reads a pixel**, and carries km/h with m/s for the
  same reason `cyclone_tracks` carries kt with km/h — the grounding check looks for every quoted
  figure in some tool result.
- **A nullable enum is a hard 400** (`check_chat_tools.mjs`), so `set_view_timeline` uses a `'keep'`
  sentinel rather than null — the same shape `layer_reference` uses with `'all'`.
- **The strict-tool budget is now full at 20/20.** The next tool must be non-strict (validating in
  its handler) or replace one. WeatherNext needs none: it is a `model` enum value in both new tools.
- **The Weather pane is a third `panel-body`**, `hidden`-toggled like the other two, so the
  `[hidden]` override and the collapsed-panel rule already cover it and each view keeps its scroll.
- **The legend follows `field.on`, not the view**: a forecast carries its model and run time
  wherever it is drawn.

## Monitoring

Three layers, added together, each answering a question the others cannot.

### The trend — `scripts/history.py` → `public/data/history.json`

`status.json` keeps one run back, which answers "did anything change" but not "is this getting
worse". UNOSAT's dashboard cannot answer that either — one window at a time. But every archived
FloodAI product keeps its observation windows, so a multi-year series is reconstructible: **142
single-pass observations, 2022-03-19 to the current event**, 18 KB.

- **Only rows where `startdate == enddate`.** The service also holds cumulative ranges; mixing a
  one-day observation with a six-day cumulative one produces a chart that climbs for reasons that
  have nothing to do with flooding.
- **Dedup by date keeps the wider `observed`** — the more complete look at that day.
- The stage runs on **every active run**, not only when the newest product changes, because UNOSAT
  revise archived products in place. A run that finds no new product can still find corrected
  figures inside the old ones.

**`AI20230724MMR` is wrong and the guard is a ratio, not a name.** It reports population ~125× too
high (one township at 13.6 M against 575 km²), which put a **107-million-person** spike on the first
chart — twice the population of Myanmar. `MAX_PEOPLE_PER_KM2 = 2000` is an order of magnitude above
the 100–180 the other four archives agree on across 2022, 2023, 2024 and 2026. Over it, the
population is withheld and flagged `peopleSuspect`; the areas, which look sound, are kept. Naming
the bad product would have fixed today and missed the next one. 25 observations withheld; peak now a
plausible 1,717,487 on 2024-07-30.

**The chart's honesty constraints** (`src/components/Trend.tsx`):

- **Bars, not a line.** A line implies the value moved continuously between two points, but nobody
  looked in between.
- **Evenly spaced, so gaps must be drawn.** The record has real holes — nothing at all through 2025.
  A hatched marker goes wherever consecutive passes are >120 days apart, or a four-year jump reads
  as a week. The "vs" figure names its comparison date across such a gap rather than saying
  "previous pass".
- **A pass covers a strip, not the country**, so `observed` travels with every point. A low bar can
  mean a narrow swath, not less water.
- **Hover shows all four measures at once** (`Readout`), not just the plotted one. 200 km² of water
  inside 5,000 km² looked at and the same 200 inside 250,000 are different events, and a bar height
  alone cannot say which. The row matching the selected metric is emphasised so it is clear which
  number the bar is drawn from. It defaults to the latest pass rather than sitting empty, and
  `pointermove` is handled once on the container — 142 bars would otherwise be 142 listeners.
- Withheld points are drawn **hollow at full height** — a gap in the record must not look like a day
  with no flooding.
- The chart overflows and **scrolls to its right edge on mount**; left alone it opens on 2022 and
  looks like it has no current data.

### Alerts — `scripts/alerts.py` → `status.json.alerts`

Derived on every run. **Nothing is pushed anywhere** — recorded and drawn, and a channel later means
reading the same list. `critical` · `warning` · `info`.

- **A surge is judged against the median of the preceding 12 passes**, not a fixed number: a fixed
  threshold is wrong the moment the usual level moves, and the median resists a single large event
  in the window dragging the baseline up and hiding the next one. The current event fires at 25×.
- **A failed check is always critical.** Same rule as everywhere else here: a check that did not
  complete must never render as "nothing new".

### Staleness belongs to the reader, never to the file

A status file cannot know it has gone stale — it goes stale by sitting still, long after it was
written. Baking `stale: false` in would produce a page confidently reporting everything current off
a pipeline that died a week ago, which is the blind spot the whole design exists to close.

So the file carries the **threshold** (`alerts.freshness.runHours`) and both readers apply it to
`generatedAt` at read time: `freshness()` / `liveAlerts()` in `src/pipeline.ts`, and `/api/health`.
One threshold, two consumers, no drift. `STALE_AFTER_HOURS` in `src/pipeline.ts` is now only the
fallback for a file that predates the field.

Past the threshold the chip reads **stale**, not the run's own `ok`. "Up to date" beside a
fortnight-old check is the claim this project exists not to make.

### Pipeline health — `GET /api/health`

Answers **from disk on every request**, never from a cached verdict: a process that decided it was
healthy at startup would go on saying so after the pipeline behind it died. **200** clean, **503**
with a `faults` array otherwise. That 503 is the only signal worth alerting on externally — the site
can be perfectly healthy and completely out of date, and only the run's age says so.

`deploy/` holds systemd units and a cron line. The **timer, not the server, runs the pipeline**:
update and serve are separate jobs, and coupling them would mean a crashed web server silently stops
the data updating too.


## Cyclones

Tropical cyclone tracks, modelled on Google Weather Lab's controls card, from two public keyless
sources: IBTrACS `ACTIVE` (observed) and JTWC warnings (forecast). `scripts/scan_cyclones.py` →
`public/data/cyclones.json`; geometry is built in the browser (`src/cyclones.ts`) so the file holds
numbers only and the assistant reads the same numbers the map draws.

Traps recorded so far:

- **JTWC files the Bay of Bengal under `io`, not `ni`.** IBTrACS calls the same basin `NI`. The RSS
  regex matches `(?:wp|io)\d{4}`; matching `ni` would silently drop every Bay of Bengal storm.
- **IBTrACS's second CSV line is a units row.** Skipped by testing `SEASON.isdigit()`; a
  `DictReader` alone hands it back as a storm with SID `' '`.
- **JTWC wind radii continue on unprefixed lines.** Only the NE quadrant carries `RADIUS OF 034 KT
  WINDS -`; the other three are bare `045 NM SOUTHEAST QUADRANT` lines and must be attached to the
  threshold above them. `test_cyclones.py` pins this.
- **JTWC times carry only a day of month.** `ddhhmm()` resolves against the feed's `pubDate` and
  picks whichever adjacent month lands nearest — a warning issued on the 30th forecasting to the
  2nd crosses a month.
- **ACTIVE drops a storm the moment it dissipates**, hence the 30-day `data/cyclones_cache.json`
  (gitignored). Without it the track of a cyclone that made landfall on Monday would vanish on
  Tuesday.
- **A JTWC warning often precedes IBTrACS by a day.** It becomes a provisional `JTWC:<atcf>` storm
  whose single "observed" point is the warning position, superseded when IBTrACS carries the ATCF id.
- **A cached forecast older than 36 h is dropped**, not carried forward as current.

**No cone without members.** JTWC publishes a single position-accuracy figure, not error growth by
lead, so a cone here would be an invention drawn as data. Wind radii take its visual role; the Cone
and Ensemble toggles stay on the panel, disabled, saying what they need. Phase 2 (WeatherNext 3
members) turns them on with a *measured* spread.

**The timeline** (`src/components/Timeline.tsx`) is the reader's clock: never autoplays, steps at
1.5 s under `prefers-reduced-motion`, and badges Observed/Forecast from `observedUntil`. Its
`validTime` is passed to `useMapOverlays` as a **separate argument**, not inside `OverlayState`, so a
scrub re-points only the cyclone sources (`syncCyclones`) rather than re-running the whole overlay
pass. It must **never** enter the assistant's `<context>` block — it changes on every scrub, which
is a clock by another name and would kill the cached prefix.

**Layer stacking:** wind wedges are added *before* the `LAYER_KINDS` loop (under the floods);
tracks and the marker *after* it (over the exposure circles). `cycloneKey` is cleared in the
`setStyle` effect alongside `rainDate` for the same reason.

**The assistant's `cyclone_tracks` returns kt and km/h both**: the grounding check looks for every
figure the answer quotes in some tool result, and a model that converts 65 kt to 120 km/h in prose
would otherwise be told it invented a number.

**WeatherNext 3 is gated, and the gate shipped first.** `scripts/scan_weathernext.py` records
`skipped: <first missing thing>` — credentials (`WEATHERNEXT_PROJECT`,
`GOOGLE_APPLICATION_CREDENTIALS`), the `.venv-wn3` virtualenv (Python 3.11+; this Mac's Python is
3.9 and Zarr v3's compressed chunks are beyond the standard library), `WEATHERNEXT_ACCEPTED_TERMS=1`,
then the reducer. The terms gate is separate from credentials on purpose: real-time WeatherNext
output is under redistribution-restricting experimental terms (CC BY 4.0 after an hour), and that is
the operator's call on sign-up, not code's. Nothing under `public/data/wn3/` is committed until it
is made. Access needs a Google Account on Google's allow-list (request form, 5–7 business days);
there is no anonymous path — the "public" statistics bucket returns 403.

## The assistant

The panel's second tab answers questions from this viewer's own data. Optional: with no
`ANTHROPIC_API_KEY` on the server the tab explains itself and nothing else changes.

**The tool loop runs in the browser; the server is a key-holding pipe.** Three reasons, and the
third is the one that matters most here:

- The map tools act on React state that only exists in the page. A server-side loop would need a
  callback channel back into the browser — long-poll plus a session store — which is more machinery
  than the whole feature.
- It matches the existing precedent: the server does not parse the pipeline's `[[stage]]` markers
  either. `parseRunProgress` lives in the client. The server stays a dumb pipe.
- **The analysis is TypeScript, and forking it would let the two halves disagree.** `rank_places`
  calls the same `rankPlaces()` the panel renders from; `pipeline_status` calls the same
  `freshness()`/`liveAlerts()` the chip does. A second implementation in `.mjs` would be exactly the
  drift "one threshold, two consumers, no drift" forbids — and the disagreeing consumer would be the
  one quoting numbers at a reader.

**`messages` is the only thing accepted from the client.** Model, system prompt, tools, `max_tokens`,
thinking, effort and `task_budget` are all pinned in `server/index.mjs`; any other top-level key is a
400. Without that allowlist this is not a proxy but an open relay for the operator's API key. There
are deliberately **no CORS headers**, and an origin check refuses cross-origin requests — which also
closed a real CSRF hole on `POST /api/run`, where a cross-site form post needs no preflight and
starts a pipeline.

**SSE, the first streaming response in the codebase.** Polling — the house pattern for `GET /api/run`
— only works there because there is exactly one global run to poll; a chat turn has no such
singleton, so polling would need the per-request buffer and GC that statelessness avoids. Two traps:
the response must not use the `json()` helper (it sets `content-length`), and it sets
`x-accel-buffering: no` because nginx would otherwise buffer the stream into one lump and reproduce
the exact delay streaming was added to remove. `req.on('close')` aborts the upstream call — without
it, closing the tab leaves a request running and billing.

**Grounding is structural, not prompted.** Every tool returns an envelope carrying `dataset`, the
observation date and `caveats`, so the model cannot see a figure without its provenance. `show_chart`
refuses to render without a `source`. And `ungroundedFigures()` in `src/chat/context.ts` checks, in
plain code with no model involved, that every number in the answer appears in some tool result —
it cannot be talked out of its verdict, which is the point.

**Cost.** Sonnet 5, `effort: medium`, nothing Opus-priced anywhere — `grep "claude-" server/index.mjs`
should only ever return `claude-sonnet-5`. Prompt caching is the largest lever: the tools + system +
`<context>` prefix is identical on every turn of a conversation, so it is read at ~0.1x. **A clock in
the `<context>` block would silently disable it** and charge full price every turn, which is why that
block carries only dates read from the data. Watch `cache_read_input_tokens` in the tab's footer;
zero across turns means an invalidator has crept in.

**The grounding check is unit-tested, and both its bugs were false positives.** `ungroundedFigures()`
lives alone in `src/chat/grounding.ts` with **no imports**, so `scripts/check_grounding.mjs` can run
it directly (Node executes the TypeScript). It is the one part of the assistant that makes a claim
*about the assistant* to the reader — "treat that figure with suspicion" — so it has to be right in
both directions, and a false positive is the worse failure: it teaches the reader to ignore the
warning, and then the real one goes unread.

Both bugs came from the same place: **the answer and the sources being parsed differently.** The
second one is the sharper lesson — the answer side stripped thousands separators and the source side
did not, so a figure written `259,738 km²` inside an alert's prose was read as `259` and `738`,
matched nothing, and a correctly quoted number was reported to the reader as invented. Any change
there must keep the two sides on the same regex, and the tests exist to say so.

**Tool definitions are checked before they can build.** Six separate faults reached a live request
during this feature's development, every one of them invisible to the type checker and rejected by
the API rather than by the build: `minimum`/`maximum`, `maxItems`/`maxLength`, a nullable enum, 22
strict tools against a limit of **20**, a schema with no handler, and a strict tool with a property
missing from `required`. So the rules live in `scripts/check_chat_tools.mjs`, which runs first in
`npm run build` — before `tsc`, before vite — and names the tool and the fix.

The one related check that *is* the compiler's job stays there: `TOOL_LABEL` in `Assistant.tsx` is
typed `Record<ToolName, string>`, with `ToolName` derived from the `HANDLERS` object via
`satisfies`, so adding a tool without a reader-facing label is a compile error. It had shipped raw
twice before that type existed, because nothing objected either time.

**Dev mode proxies `/api/chat` and nothing else.** Proxying all of `/api` looks tidier and breaks
`checkServer()`: with the real server stopped Vite answers a proxy `ECONNREFUSED` with **500**, and
`checkServer()` deliberately tests `status !== 404`, so a stopped server would look present and the
"Run update now" button would come back broken.

## The update pipeline

`scripts/run_pipeline.py` is the only entrypoint: gate → UNOSAT (skipped) → ADAM → record status →
optionally publish. A cron, a systemd timer, a hand-run, or `POST /api/run` from the viewer all
invoke the same command and produce byte-identical output. The tree is drawn in README.md.

**The blind spot this design closes.** In an earlier form, commit and deploy were gated on
"something changed", and the scanner recorded its timestamps only on that same path — so a run that
found nothing left no trace anywhere, and "all quiet" was indistinguishable from "broken for a
fortnight". `status.json` is now written on *every* run, including runs that change nothing.

### Self-hosting is a first-class path

`--publish DIR` builds and atomically swaps the site into a directory a local web server serves,
with no git and no external service. `--commit` remains for keeping the generated data in version
control, independent of how the site is served.

Two ordering traps in `stage_publish`, both hit and fixed:

- **`npm run build` copies `public/` into `dist/`**, capturing `status.json` as it was at the *start*
  of the run. Publishing that would serve the previous run's status forever, making "Last checked"
  permanently one run stale. The staged copy is therefore re-stamped via the `finalize` callback
  immediately before the swap.
- **The publish stage must be finished before that stamp**, or the served file records
  `publish: skipped`. A file cannot contain the outcome of its own delivery, but the delivery is the
  rename: if it fails the copy never becomes visible, so anything reading it is by definition reading
  a successful publish.

`BASE_PATH` (read in `vite.config.ts`) sets the base for the build. It defaults to `/`, a domain
root; set `/flood/` to serve under a sub-path.

**The served page contacts nothing but the basemap tiles — with one deliberate exception.** All
pipeline state comes from `status.json` and, when the local server is running, from its own
`/api/*` endpoints. The assistant (below) is the single feature that reaches a third party, and
only when an API key has been configured; unconfigured, the claim above holds unchanged.

### The pipeline records its own history

Run state used to be read live from the GitHub Actions API. That was free and always true, but only
while GitHub was the runner — a hard dependency on one vendor for something the pipeline can simply
write down. It now **records its own stages** (label, state, detail, duration, and which machine)
into `status.json`, and the viewer draws the tree from that. Both halves live in one file:

| | Why |
|---|---|
| Which stages ran, outcome, duration, runner | Works from any runner; no external service to ask |
| What data exists, and what existed before | Only the pipeline can know this; written every run |

**The blind spot this closed.** Commit and deploy were gated on `changed == 'true'`, and the scanner
recorded its timestamps only on that same path — so a run that found nothing left no trace anywhere,
and "all quiet" was indistinguishable from "broken for a fortnight". Build/deploy now runs on every
active run so `status.json` reaches the site regardless. That also fixed a latent bug: a change to
`src/` alone was previously never deployed by CI at all.

### State vocabulary

`ok` · `changed` · `skipped` · `failed` — mirrored in `STATES` (`scripts/status.py`) and
`SourceState` (`src/pipeline.ts`). `run.conclusion` is derived from the source states, never from
the workflow's own success: `continue-on-error` on the ADAM step makes those two diverge, and that
divergence is the whole point — a failed check must still be deployed so the site can show it.
**The UI must never render "up to date" off a check that did not complete.**


### The run as a horizontal stepper

`src/components/Stepper.tsx`, fed by `parseRunProgress()` / `stepsFromStatus()` in `src/pipeline.ts`.

**The pipeline announces itself live.** `status.json` records what a run *did*, after the fact, which
is useless to someone watching a run that takes forty seconds. `run_pipeline.py` therefore emits
`[[plan]]` before anything starts and `[[stage]] <key> <state> …` as each stage begins and ends, all
`flush=True` because the server streams stdout line by line and a buffered boundary would arrive
with the next one, jumping the display two steps at a time.

- **The plan comes from the pipeline, not the viewer.** A hardcoded client-side stage list would
  drift from the code that runs it; announcing it means a new stage appears in the UI with no
  front-end change, and a stage that will be skipped is still drawn rather than silently missing.
- **A live run outranks the recorded status.** While the pipeline works, the only true account of
  where it is comes from the process itself.
- **The connector reports the step to its *left*.** So the filled run of the line is the work
  actually finished, not the work merely reached.
- **Short labels on the nodes, full labels in the detail card** (`SHORT_LABEL` in `pipeline.ts`).
  "UNOSAT FloodAI — nationwide exposure" wraps to four lines under a 74px node.
- The markers are filtered out of the log pane — the stepper already tells that story.

**Two bugs this work exposed, both fixed:**

- **`checkServer()` used `res.ok`.** `/api/health` answers **503** when the pipeline is unwell, so a
  failed or stale run made the server look absent and removed the "Run update now" button at exactly
  the moment it was needed. It now tests `status !== 404` — any HTTP answer means a server is there;
  only a network error or a static host 404 means there is not.
- **A 409 "already in progress" was a dead end.** The page reported that a run was happening and
  then showed nothing about it. Both that path and first load now adopt an in-flight run, so a run
  started by cron, another tab, or a double click is still watchable.

**`dataVersion` refreshes the data, not just the status.** `history.json` and `weather.json` keep the
same path across runs, so without an explicit bump the browser hands back the copy it already has
and a completed update visibly changes nothing — the same trap as `layerUrl()`'s version stamp.

### Applying an update without a reload

`handleApply()` in `src/App.tsx` (it was `applyUpdate()` in the pre-React `src/main.ts`). Four
things had to change first, and each is load-bearing — the first two are now handled structurally by
React and the ref, but the reasoning is why the current shape is the way it is:

- **`index` is `let`, not `const`.** `map.on('style.load', addOverlay)` rebuilds layers from
  `index`, so with a `const` binding an applied update survives until the first theme or basemap
  switch and then silently reverts. Verified by applying an update and then switching both.
- **Sources carry a version stamp** (`layerUrl()` in `src/layers.ts`). Layer paths are byte-identical
  across updates, so without `?v=<index.updated>` the browser and the Pages CDN hand back the old
  body and the refresh reports success while changing nothing.
- **Builders clear their container first.** They append, so re-running them duplicated every row.
- **`buildAbout()` no longer wires listeners** — that moved to `initAboutDialog()`, or every refresh
  would stack another set.

`deriveFromIndex()` recomputes `headings`/`queryLayerIds` and *merges* `datasetVisible` so a reader's
toggles survive. The camera is deliberately never moved.

### Not automated on purpose

UNOSAT is not polled. Its products are 8–282 MB and the region clipping needs hand-tuned tolerances,
boundary files and named exclusions (`Det Khi Na`, `Oke Ta Ra` carved out of geoBoundaries ADM1
Mandalay). Running that unattended would produce a confidently wrong map. `status.json` records it
as `skipped` with the reason, so the tree says so rather than staying silent.

ADAM has no backfill: only the newest event's impact table is readable, every older one returns 403.

## Environment notes

**Assume nothing is installed but Python 3 and Node.** This has been worked on from both WSL and
macOS, and the macOS machine has no GDAL, no tippecanoe and no `unzip`. That is the whole reason
every script here is standard-library only and `convert_unosat.py` parses shapefiles and simplifies
geometry by hand rather than shelling out to `ogr2ogr` — a pipeline that only runs on one laptop is
not a pipeline. Python's `zipfile` stands in for `unzip`.

- Node 20+ and npm for the viewer and the server; the server itself has zero dependencies.
- `vite.config.ts` enables `watch.usePolling`, which matters when the tree sits on a Windows mount
  under WSL: inotify events never arrive there and the dev server otherwise looks frozen. It is
  harmless elsewhere.
- `BASE_PATH` sets the build's base URL. It defaults to `/` (a domain root); set `/flood/` to serve
  under a sub-path.

## Progress log

- [x] convert the four UNOSAT extents with a standard-library-only Python converter
- [x] build the viewer (MapLibre + Vite + TypeScript), then move the UI to React
- [x] add UNOSAT FloodAI: nationwide, per-township exposure, discovered rather than pinned
- [x] add WFP ADAM impact figures alongside the supplied risk shares, each labelled
- [x] remove the unsourced flood risk shares — no provenance, and they inverted the measured ranking
- [x] English basemaps and labels; NASA GIBS dated imagery and EOX cloud-free
- [x] make the pipeline self-hosting: one entrypoint, own server, atomic publish, no CI service
- [x] record the pipeline's own run state in `status.json`, on every run
- [x] add monitoring: the multi-year trend, locally-recorded alerts, and `/api/health`
- [x] add weather: IMERG rainfall on the map, Open-Meteo rain and GloFAS discharge forecasts
- [x] draw the run as a live horizontal stepper fed by the pipeline's own progress markers
- [x] add a grounded assistant in the panel: client-side tool loop, key-holding server proxy
- [x] add tropical cyclone tracks (IBTrACS + JTWC, public) with a timeline scrubber — Weather Lab, phase 1
- [x] add the Weather view: Open-Meteo forecast field (ECMWF / GFS / ICON + 51-member ensemble), model radio, init stepper, map legend
- [ ] WeatherNext 3 gridded field + ensemble cyclone tracks once Google allow-list access arrives (phases 2–3)
- [ ] decide whether to extend or stop the scan when `SCAN_UNTIL` (2026-09-14) is reached
- [ ] add drawing code if a new layer kind arrives (anything outside `LAYER_KINDS`:
      `waterextent` / `floodextentearly` / `floodextent` / `inputarea` / `exposure`)
