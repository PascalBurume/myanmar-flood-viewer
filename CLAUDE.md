# myanmar-flood-viewer

A self-contained Myanmar flood viewer: React front end, a zero-dependency Node server, and a
standard-library Python pipeline. It runs, updates and serves itself from one machine.

**History worth knowing.** This began as `chiba-flood-viewer`, for the 13 August 2026 Chiba floods
in Japan. The Japanese data, its NIED scanner, the depth-class machinery and the Japan-only GSI
basemaps were removed when the scope moved to Myanmar; the GitHub Actions workflow, the Actions API
client and the gh-pages deploy were removed when it moved to self-hosting. Git history has all of
it. The git remote may still carry the old name — that is a rename to make on the hosting side, and
nothing in the code depends on it.

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

Each region carries two figures, and they disagree. *Flood risk share* was supplied to the project, is marked
**unverified** in the UI, and is exactly 16/9/4/1 of 30 records — a tally, not a modelled
probability. Its provenance is still unestablished. *Flood impact (people)* comes from WFP ADAM with an
event id and retrieval date. Across five ADAM events Bago is ~85% of affected people and Yangon
~5% — close to the inverse of the supplied shares. `scan_adam.py` deliberately does **not**
overwrite the supplied figures; both are shown, each labelled.

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
  - Bands 7-2-1 (MODIS) is the standard flood combination — water near-black, vegetation green,
    cloud cyan. True colour cannot separate wet ground from shadow.
  - Optical imagery is frequently cloud-covered during monsoon flooding. That is not a bug and it
    is the reason the detection underneath is radar; the README says so to the reader.
- **Cloud-free** is EOX's Sentinel-2 cloudless (CC BY-NC-SA 4.0 — note the NC), a composite that
  keeps the clear pixel from many passes. It answers "I cannot see the ground", not "show me the
  flood": it is a yearly mosaic and carries no date.
- **`tileCloudiness()` must handle both products.** Cloud is white in true colour but **cyan** in
  bands 7-2-1, because band 7 is dark over cloud while 2 and 1 are bright. A
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

**The served page contacts nothing but the basemap tiles.** All pipeline state comes from
`status.json` and, when the local server is running, from its own `/api/*` endpoints.

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

- Runs on WSL at `/mnt/c/Users/yshiw/Documents/GIS/chiba-flood-viewer`.
  **This is not true everywhere** — it has also been worked on from macOS, where GDAL, tippecanoe
  and `unzip` are all absent. `scripts/convert_unosat.py` is standard-library-only for that reason;
  `scripts/fetch_data.py` still needs ogr2ogr and gets it from gdal-bin in CI.
- On WSL: `ogr2ogr` (GDAL), `node` (v20), `npm` and `tippecanoe` are all available.
  Note: the older environment note saying "neither GDAL nor pip is available" no longer applies.
- There is no `unzip` command → Python's `zipfile` module is used instead.
- Because it lives on /mnt/c, Vite has `watch.usePolling` enabled (inotify events do not arrive).

## Progress log

- [x] git init (`main` branch)
- [x] check the NIED page, download and extract the data
- [x] convert to GeoJSON (ogr2ogr)
- [x] build the MapLibre + Vite + TS viewer (layer toggles, legend, opacity, popup,
      basemap/theme switching)
- [x] verify rendering in headless Chromium (pale/photo/dark, popup)
- [x] deploy to GitHub Pages (https://shiwaku.github.io/chiba-flood-viewer/)
      `npm run deploy` publishes to the `gh-pages` branch. `base` in `vite.config.ts` is
      `/chiba-flood-viewer/`. Fix that too if the repository is renamed.
- [x] twice-daily automatic scan, fetch, convert and redeploy (`scripts/fetch_data.py` +
      `.github/workflows/update-data.yml`). New locations appear with no change to the viewer.
- [x] translate the UI, comments and docs to English (source data stays Japanese; see "UI language")
- [x] add the English (OpenStreetMap) basemap so labels are not Japanese-only, and so the map works
      outside Japan
- [x] add four Myanmar locations (UNOSAT flood extent) with flood risk share statistics
- [x] add monitoring: the multi-year trend, locally-recorded alerts, and a health endpoint
- [ ] replace the *citation pending* source on the flood risk share figures
- [ ] decide whether to extend or stop the scan when `SCAN_UNTIL` (2026-09-14) is reached
- [ ] add drawing code if a new layer kind arrives (anything other than
      `floodarea` / `inputarea` / `inputpoint`)
