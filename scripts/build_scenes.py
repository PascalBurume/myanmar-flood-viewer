#!/usr/bin/env python3
"""Build the 3D view's flood scenes from the traced extents → public/data/scenes/.

    python3 scripts/build_scenes.py              # cached terrain and footprints reused
    python3 scripts/build_scenes.py --refresh    # download them again

Hand-run, like convert_unosat.py, because its inputs are the hand-converted UNOSAT extents: they
change only when someone converts a new product, and this is run after that. The output is
committed. Standard library only, like everything else in scripts/.

What a scene is
---------------
A window of about 14 km on a side where the traced extents hold the most water, with the buildings
that stand in it. Two per region at most, chosen from the four wettest windows by how many
buildings the water reached — the 3D view exists to show a flood in a town, not in an empty field.

For each scene three files are written:

    scenes/index.json              every scene: where, which event, what was observed, the counts
    scenes/<id>/water.png          the flood, per pixel, as a timeline (below)
    scenes/<id>/buildings.json     footprints in the window, each with when water reached it

The timeline, and which parts of it are observed
------------------------------------------------
The only facts are the extents: where a satellite saw water on a date. Bago and Yangon have two
passes (25 and 31 August 2021), Mandalay and Nay Pyi Taw one (24 September 2024). The scene's
timeline runs 0 → S, with observation k at T = k and T = 0 "before" — no flood water mapped.

At every T = k the wet set is **exactly** the observed extent. Between them the water is
*simulated*: newly flooded ground wets deepest-first, receding ground dries shallowest-first. That
ordering is the model, and the view says so. Depth comes from a FwDET-style estimate (Cohen et al.
2018, "Floodwater Depth Estimation Tool"): the water surface at each flooded pixel is the ground
elevation at the nearest edge of the extent, smoothed; depth is that surface minus the ground. It
is used only to *order* the fill, blended with distance from the shore, because SRTM's vertical
error in a flat floodplain is several metres — too coarse to print as a depth, good enough to say
which ground goes under first.

Each pixel carries two bytes on that timeline: when it wets (`on`) and when it dries (`off`), as
T/S × 254, with 255 for "never". `on` and `off` both round *up*, which is what makes the keyframes
exact: a pixel that wets during segment k is dry at T = k−1 and wet at T = k.

Sources
-------
- Extents: UNOSAT via HDX (CC BY-SA), the same files the 2D map draws.
- Terrain: Terrarium tiles (Mapzen / AWS Open Data), SRTM in this region, zoom 12 (~36 m).
- Buildings: Microsoft Global ML Building Footprints (ODbL). Machine-detected from imagery; they
  carry no heights here, so the 3D view draws them at a nominal height and says so.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import math
import re
import shutil
import sys
from collections import deque
from pathlib import Path

from common import INDEX_PATH, ROOT, fetch, utcnow
from png import decode_png_any, encode_png_rgb

OUT_DIR = INDEX_PATH.parent / 'scenes'
CACHE = ROOT / 'data' / 'cache'

TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
FOOTPRINT_LINKS = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv'

REGIONS = ['MM_Bago', 'MM_Mandalay', 'MM_NayPyiTaw', 'MM_Yangon']
# Observation layers, oldest first. The water layer is not one of them: for Mandalay and Nay Pyi
# Taw it is a different satellite nine days earlier, which the dataset notes say is not a
# before/after pair, and for Bago and Yangon it includes the permanent rivers.
OBS_LAYERS = ['floodextentearly', 'floodextent']

SCENE_DEG = 0.13          # window side, degrees (~14 km)
RASTER_Z = 13             # scene raster on the zoom-13 Web Mercator grid (~18 m a pixel here)
DEM_Z = 12                # Terrarium zoom read for the terrain (~36 m, SRTM's own resolution)
BIN_DEG = 0.01            # hotspot search lattice
CANDIDATES = 4            # wettest windows considered per region
PER_REGION = 2            # scenes kept per region
MIN_KM2 = 3.0             # a window with less water than this is not a scene
SMOOTH_R = 4              # water-surface smoothing radius, pixels
SHADE_PX = 24             # distance from the shore at which the shading saturates
MAX_BUILDINGS = 40000

EVENTS = {
    'FL20210831MMR': 'Monsoon floods, August 2021',
    'FL20240912MMR': 'Typhoon Yagi, September 2024',
}


# ---- Web Mercator ----

def world(z: float) -> float:
    return 256 * 2 ** z


def lon_px(lon: float, z: float) -> float:
    return (lon + 180) / 360 * world(z)


def lat_px(lat: float, z: float) -> float:
    s = math.sin(math.radians(lat))
    return (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * world(z)


def px_lon(x: float, z: float) -> float:
    return x / world(z) * 360 - 180


def px_lat(y: float, z: float) -> float:
    return math.degrees(math.atan(math.sinh(math.pi - 2 * math.pi * y / world(z))))


def pixel_metres(lat: float, z: float) -> float:
    return 156543.03392 * math.cos(math.radians(lat)) / 2 ** z


def quadkey(x: int, y: int, z: int) -> str:
    out = ''
    for i in range(z, 0, -1):
        m = 1 << (i - 1)
        out += str((1 if x & m else 0) + (2 if y & m else 0))
    return out


# ---- geometry ----

def polygons(geojson: dict) -> list[list[list[list[float]]]]:
    out = []
    for f in geojson['features']:
        g = f['geometry']
        if g['type'] == 'Polygon':
            out.append(g['coordinates'])
        elif g['type'] == 'MultiPolygon':
            out.extend(g['coordinates'])
    return out


def ring_km2(ring: list[list[float]]) -> float:
    lat0 = sum(p[1] for p in ring) / len(ring)
    kx, ky = 111.32 * math.cos(math.radians(lat0)), 110.57
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(a) / 2


def poly_km2(poly: list[list[list[float]]]) -> float:
    return max(0.0, ring_km2(poly[0]) - sum(ring_km2(h) for h in poly[1:]))


def rasterize(polys: list, x0: int, y0: int, w: int, h: int, z: float) -> bytearray:
    """Even-odd scanline fill of every ring, sampled at pixel centres, on a Mercator pixel grid.

    Even-odd rather than winding: the files are one MultiPolygon per layer whose holes are the
    islands in the water, and even-odd needs no ring orientation to get them right — UNOSAT's rings
    run clockwise, the opposite of the GeoJSON convention.
    """
    rows: list[list[float]] = [[] for _ in range(h)]
    lo_lon, hi_lon = px_lon(x0, z), px_lon(x0 + w, z)
    lo_lat, hi_lat = px_lat(y0 + h, z), px_lat(y0, z)
    for poly in polys:
        for ring in poly:
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            if max(xs) < lo_lon or min(xs) > hi_lon or max(ys) < lo_lat or min(ys) > hi_lat:
                continue
            pts = [(lon_px(p[0], z) - x0, lat_px(p[1], z) - y0) for p in ring]
            for (ax, ay), (bx, by) in zip(pts, pts[1:] + pts[:1]):
                if ay == by:
                    continue
                if ay > by:
                    ax, ay, bx, by = bx, by, ax, ay
                j0 = max(0, math.ceil(ay - 0.5))
                j1 = min(h - 1, math.ceil(by - 0.5) - 1)
                if j1 < j0:
                    continue
                slope = (bx - ax) / (by - ay)
                for j in range(j0, j1 + 1):
                    rows[j].append(ax + (j + 0.5 - ay) * slope)
    mask = bytearray(w * h)
    for j, xs in enumerate(rows):
        if len(xs) < 2:
            continue
        xs.sort()
        base = j * w
        for k in range(0, len(xs) - 1, 2):
            i0 = max(0, math.ceil(xs[k] - 0.5))
            i1 = min(w - 1, math.ceil(xs[k + 1] - 0.5) - 1)
            if i1 >= i0:
                mask[base + i0:base + i1 + 1] = b'\x01' * (i1 - i0 + 1)
    return mask


# ---- the flood model ----

def neighbours(p: int, w: int, h: int):
    x = p % w
    if x > 0:
        yield p - 1
    if x < w - 1:
        yield p + 1
    if p >= w:
        yield p - w
    if p < w * (h - 1):
        yield p + w


def edge_distance(mask: bytearray, w: int, h: int, elev: list[float] | None = None):
    """Distance (4-neighbour steps) from the extent's edge for every pixel in it, and — given the
    ground — the ground elevation at that nearest edge pixel, carried inward.

    An edge pixel is water with dry land beside it *inside the raster*. The raster's own border is
    not a shore: the water carries on past the window.
    """
    n = w * h
    dist = [-1] * n
    wse = [0.0] * n if elev is not None else None
    q: deque[int] = deque()
    for p in range(n):
        if not mask[p]:
            continue
        for m in neighbours(p, w, h):
            if not mask[m]:
                dist[p] = 0
                if wse is not None:
                    wse[p] = elev[p]
                q.append(p)
                break
    if not q:
        # No shore in the window at all: water from edge to edge, or none. Rank by position alone.
        for p in range(n):
            if mask[p]:
                dist[p] = 0
                if wse is not None:
                    wse[p] = elev[p]
        return dist, wse
    while q:
        p = q.popleft()
        d = dist[p] + 1
        for m in neighbours(p, w, h):
            if mask[m] and dist[m] < 0:
                dist[m] = d
                if wse is not None:
                    wse[m] = wse[p]
                q.append(m)
    return dist, wse


def box_mean(values: list[float], mask: bytearray, w: int, h: int, r: int) -> list[float]:
    """Mean of `values` over the masked pixels in a (2r+1)² box, via summed-area tables."""
    sw = w + 1
    s = [0.0] * (sw * (h + 1))
    c = [0] * (sw * (h + 1))
    for y in range(h):
        rs = 0.0
        rc = 0
        for x in range(w):
            p = y * w + x
            if mask[p]:
                rs += values[p]
                rc += 1
            s[(y + 1) * sw + x + 1] = s[y * sw + x + 1] + rs
            c[(y + 1) * sw + x + 1] = c[y * sw + x + 1] + rc
    out = values[:]
    for y in range(h):
        ya, yb = max(0, y - r), min(h, y + r + 1)
        for x in range(w):
            p = y * w + x
            if not mask[p]:
                continue
            xa, xb = max(0, x - r), min(w, x + r + 1)
            cnt = c[yb * sw + xb] - c[ya * sw + xb] - c[yb * sw + xa] + c[ya * sw + xa]
            if cnt:
                out[p] = (s[yb * sw + xb] - s[ya * sw + xb] - s[yb * sw + xa] + s[ya * sw + xa]) / cnt
    return out


def percentile(xs: list[float], q: float) -> float:
    if not xs:
        return 1.0
    ys = sorted(xs)
    return ys[min(len(ys) - 1, int(q * len(ys)))] or 1.0


def order_keys(mask: bytearray, elev: list[float], w: int, h: int) -> list[float]:
    """How early each pixel of an extent goes under: higher first.

    Estimated depth (FwDET: nearest-shore ground as the water surface, smoothed, minus the ground)
    blended with distance from the shore. Depth alone follows SRTM's noise in a flat plain; distance
    alone would ignore the terrain. Both are normalised by their 95th percentile.
    """
    dist, wse = edge_distance(mask, w, h, elev)
    assert wse is not None
    wse = box_mean(wse, mask, w, h, SMOOTH_R)
    depth = [max(0.0, wse[p] - elev[p]) if mask[p] else 0.0 for p in range(w * h)]
    inside = [p for p in range(w * h) if mask[p]]
    dn = percentile([depth[p] for p in inside], 0.95)
    rn = percentile([float(dist[p]) for p in inside], 0.95)
    key = [0.0] * (w * h)
    for p in inside:
        key[p] = 0.6 * min(depth[p] / dn, 1.5) + 0.4 * min(dist[p] / rn, 1.5)
    return key


def timeline(masks: list[bytearray], keys: list[list[float]], n: int) -> tuple[bytearray, bytearray]:
    """`on` and `off` bytes for every pixel. See the module docstring for the rules."""
    s = len(masks)
    on_t = [math.inf] * n
    off_t = [math.inf] * n
    prev = bytearray(n)
    prev_key = [0.0] * n
    for k, (cur, key) in enumerate(zip(masks, keys)):
        new = [p for p in range(n) if cur[p] and not prev[p]]
        new.sort(key=lambda p: -key[p])                       # deepest first
        for i, p in enumerate(new):
            on_t[p] = k + (i + 1) / len(new)
        gone = [p for p in range(n) if prev[p] and not cur[p]]
        gone.sort(key=lambda p: prev_key[p])                  # shallowest dries first
        for i, p in enumerate(gone):
            off_t[p] = k + (i + 1) / len(gone)
        prev, prev_key = cur, key
    q = lambda t: 255 if t == math.inf else min(254, math.ceil(t / s * 254 - 1e-9))  # noqa: E731
    return bytearray(q(t) for t in on_t), bytearray(q(t) for t in off_t)


def wet_at(on: int, off: int, qt: int) -> bool:
    return on <= qt < off


# ---- downloads, cached ----

def cached(path: Path, url: str, refresh: bool, timeout: int = 120) -> bytes:
    if path.exists() and not refresh:
        return path.read_bytes()
    data = fetch(url, timeout=timeout)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def dem_grid(x0: int, y0: int, w: int, h: int, refresh: bool) -> list[float]:
    """Ground elevation, metres, at every scene pixel centre: bilinear from zoom-12 Terrarium."""
    f = 2 ** (RASTER_Z - DEM_Z)
    gx0 = (x0 + 0.5) / f - 0.5
    gy0 = (y0 + 0.5) / f - 0.5
    tx0, ty0 = int(gx0 // 256), int(gy0 // 256)
    tx1, ty1 = int((gx0 + w / f + 1) // 256), int((gy0 + h / f + 1) // 256)
    tw = (tx1 - tx0 + 1) * 256
    mosaic = [0.0] * (tw * (ty1 - ty0 + 1) * 256)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            url = TERRARIUM.format(z=DEM_Z, x=tx, y=ty)
            data = cached(CACHE / 'terrarium' / str(DEM_Z) / str(tx) / f'{ty}.png', url, refresh)
            tw_, th_, ch, rows = decode_png_any(data)
            for j, row in enumerate(rows):
                base = ((ty - ty0) * 256 + j) * tw + (tx - tx0) * 256
                for i in range(256):
                    r, g, b = row[i * ch], row[i * ch + 1], row[i * ch + 2]
                    mosaic[base + i] = r * 256 + g + b / 256 - 32768
    out = [0.0] * (w * h)
    ox, oy = tx0 * 256, ty0 * 256
    for j in range(h):
        gy = (y0 + j + 0.5) / f - 0.5 - oy
        yi = int(gy)
        fy = gy - yi
        for i in range(w):
            gx = (x0 + i + 0.5) / f - 0.5 - ox
            xi = int(gx)
            fx = gx - xi
            a = mosaic[yi * tw + xi]
            b = mosaic[yi * tw + xi + 1]
            c = mosaic[(yi + 1) * tw + xi]
            d = mosaic[(yi + 1) * tw + xi + 1]
            out[j * w + i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return out


def footprint_links(refresh: bool) -> dict[str, str]:
    data = cached(CACHE / 'buildings' / 'dataset-links.csv', FOOTPRINT_LINKS, refresh, timeout=300)
    return {r['QuadKey']: r['Url'] for r in csv.DictReader(io.StringIO(data.decode('utf-8')))
            if r['Location'] == 'Myanmar'}


def footprints(windows: list[dict], refresh: bool) -> None:
    """Every Microsoft footprint whose centroid falls in a window, appended to `window['buildings']`."""
    links = footprint_links(refresh)
    keys: set[str] = set()
    for win in windows:
        w, s, e, n = win['bbox']
        for x in range(int(lon_px(w, 9) // 256), int(lon_px(e, 9) // 256) + 1):
            for y in range(int(lat_px(n, 9) // 256), int(lat_px(s, 9) // 256) + 1):
                keys.add(quadkey(x, y, 9))
    for qk in sorted(keys):
        if qk not in links:
            continue
        print(f'  footprints {qk}')
        raw = cached(CACHE / 'buildings' / f'{qk}.gz', links[qk], refresh, timeout=600)
        with gzip.open(io.BytesIO(raw), 'rt', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                ring = json.loads(line)['geometry']['coordinates'][0]
                cx = sum(p[0] for p in ring[:-1]) / max(1, len(ring) - 1)
                cy = sum(p[1] for p in ring[:-1]) / max(1, len(ring) - 1)
                for win in windows:
                    w, s, e, n = win['bbox']
                    if w <= cx < e and s <= cy < n:
                        win['buildings'].append((cx, cy, ring[:-1]))


# ---- scenes ----

def slug(s: str) -> str:
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def window_at(lon: float, lat: float) -> dict:
    z = RASTER_Z
    x0 = round(lon_px(lon - SCENE_DEG / 2, z))
    x1 = round(lon_px(lon + SCENE_DEG / 2, z))
    y0 = round(lat_px(lat + SCENE_DEG / 2, z))
    y1 = round(lat_px(lat - SCENE_DEG / 2, z))
    return {
        'x0': x0, 'y0': y0, 'w': x1 - x0, 'h': y1 - y0,
        'bbox': [px_lon(x0, z), px_lat(y1, z), px_lon(x1, z), px_lat(y0, z)],
        'center': [lon, lat], 'buildings': [],
    }


def candidates(obs_polys: list[list], bbox: list[float]) -> list[tuple[float, float, float]]:
    """The wettest non-overlapping windows: (lon, lat, km²), best first.

    Area is binned by polygon centroid on a 0.01° lattice and summed over each window with a
    summed-area table — the windows are scored for every lattice point at once. Each observation is
    scored separately and the larger taken, so a window is judged by its worst day.
    """
    w, s, e, n = bbox
    nx = int((e - w) / BIN_DEG) + 3
    ny = int((n - s) / BIN_DEG) + 3
    half = int(round(SCENE_DEG / 2 / BIN_DEG))
    best = [0.0] * (nx * ny)
    for polys in obs_polys:
        grid = [0.0] * (nx * ny)
        for poly in polys:
            ring = poly[0]
            cx = sum(p[0] for p in ring) / len(ring)
            cy = sum(p[1] for p in ring) / len(ring)
            i = int((cx - w) / BIN_DEG) + 1
            j = int((cy - s) / BIN_DEG) + 1
            if 0 <= i < nx and 0 <= j < ny:
                grid[j * nx + i] += poly_km2(poly)
        sat = [0.0] * ((nx + 1) * (ny + 1))
        for j in range(ny):
            run = 0.0
            for i in range(nx):
                run += grid[j * nx + i]
                sat[(j + 1) * (nx + 1) + i + 1] = sat[j * (nx + 1) + i + 1] + run
        for j in range(ny):
            for i in range(nx):
                ia, ib = max(0, i - half), min(nx, i + half + 1)
                ja, jb = max(0, j - half), min(ny, j + half + 1)
                v = (sat[jb * (nx + 1) + ib] - sat[ja * (nx + 1) + ib]
                     - sat[jb * (nx + 1) + ia] + sat[ja * (nx + 1) + ia])
                best[j * nx + i] = max(best[j * nx + i], v)
    order = sorted(range(nx * ny), key=lambda k: -best[k])
    picked: list[tuple[float, float, float]] = []
    for k in order:
        if best[k] < MIN_KM2 or len(picked) >= CANDIDATES:
            break
        lon = w + (k % nx - 1 + 0.5) * BIN_DEG
        lat = s + (k // nx - 1 + 0.5) * BIN_DEG
        if all(abs(lon - a) >= SCENE_DEG or abs(lat - b) >= SCENE_DEG for a, b, _ in picked):
            picked.append((lon, lat, best[k]))
    return picked


def nearest_township(lon: float, lat: float, towns: list[dict]) -> dict | None:
    best, bd = None, math.inf
    for t in towns:
        d = math.hypot((t['lon'] - lon) * math.cos(math.radians(lat)), t['lat'] - lat)
        if d < bd:
            best, bd = t, d
    return best if best and bd < 0.35 else None


COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']


def place_name(lon: float, lat: float, town: dict | None) -> str:
    """'north-east of Thanatpin', or the township itself when the window is on top of it.

    The township point is the one FloodAI reports for it — the only gazetteer this project already
    carries. Two windows in one region often share a nearest township, and the bearing is what
    tells them apart.
    """
    if not town:
        return f'{lat:.2f}°N {lon:.2f}°E'
    dx = (lon - town['lon']) * 111.32 * math.cos(math.radians(lat))
    dy = (lat - town['lat']) * 110.57
    if math.hypot(dx, dy) < 4:
        return town['township']
    bearing = (math.degrees(math.atan2(dx, dy)) + 360) % 360
    return f"{COMPASS[round(bearing / 45) % 8]} of {town['township']}"


def encode_buildings(win: dict, on: bytearray, off: bytearray) -> dict:
    """Footprints as integer micro-degrees: the first vertex from the window's corner, the rest as
    steps from the one before. Each carries `on`/`off` read at its centroid pixel."""
    w, s = win['bbox'][0], win['bbox'][1]
    out = []
    for cx, cy, ring in win['buildings']:
        i = int(lon_px(cx, RASTER_Z) - win['x0'])
        j = int(lat_px(cy, RASTER_Z) - win['y0'])
        if not (0 <= i < win['w'] and 0 <= j < win['h']):
            continue
        p = j * win['w'] + i
        coords: list[int] = []
        px_, py_ = round((ring[0][0] - w) * 1e6), round((ring[0][1] - s) * 1e6)
        coords += [px_, py_]
        for x, y in ring[1:]:
            nx_, ny_ = round((x - w) * 1e6), round((y - s) * 1e6)
            coords += [nx_ - px_, ny_ - py_]
            px_, py_ = nx_, ny_
        out.append([on[p], off[p], coords])
    return {'origin': [round(w, 6), round(s, 6)], 'unit': 1e-6, 'b': out}


def houses_focus(enc: dict, masks_q: list[int]) -> list[float] | None:
    """Where the most buildings stood in the water, for the 3D view's "houses" camera.

    Buildings reached on any observed date are binned on a ~400 m lattice; the busiest cell and its
    neighbours give the point, as the mean of their centroids. None when the water reached none.
    """
    ox, oy = enc['origin']
    cells: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for on, off, c in enc['b']:
        if not any(wet_at(on, off, q) for q in masks_q):
            continue
        # The first vertex stands in for the centroid: footprints are tens of metres across.
        x, y = ox + c[0] * 1e-6, oy + c[1] * 1e-6
        cells.setdefault((int(x / 0.004), int(y / 0.004)), []).append((x, y))
    if not cells:
        return None
    best = max(cells, key=lambda k: sum(len(cells.get((k[0] + i, k[1] + j), [])) for i in (-1, 0, 1) for j in (-1, 0, 1)))
    pts = [p for i in (-1, 0, 1) for j in (-1, 0, 1) for p in cells.get((best[0] + i, best[1] + j), [])]
    return [round(sum(p[0] for p in pts) / len(pts), 5), round(sum(p[1] for p in pts) / len(pts), 5)]


def build(refresh: bool) -> int:
    index = json.loads(INDEX_PATH.read_text(encoding='utf-8'))
    base = INDEX_PATH.parent
    towns = []
    fa = next((d for d in index['datasets'] if 'exposure' in d['layers']), None)
    if fa:
        for f in json.loads((base.parent / fa['layers']['exposure']['path']).read_text(encoding='utf-8'))['features']:
            lon, lat = f['geometry']['coordinates']
            towns.append({'lon': lon, 'lat': lat, 'township': f['properties'].get('Township'),
                          'region': f['properties'].get('Region')})

    regions = []
    for ds in index['datasets']:
        if ds['id'] not in REGIONS:
            continue
        obs = []
        for layer in OBS_LAYERS:
            info = ds['layers'].get(layer)
            if not info:
                continue
            doc = json.loads((base.parent / info['path']).read_text(encoding='utf-8'))
            props = doc['features'][0]['properties']
            obs.append({'layer': layer, 'date': props.get('Sensor_Dat'), 'sensor': props.get('Sensor_ID'),
                        'polys': polygons(doc)})
        product = (re.search(r'UNOSAT (FL\d{8}[A-Z]{3})', ds.get('note', '')) or [None, None])[1]
        cands = candidates([o['polys'] for o in obs], ds['bbox'])
        print(f'{ds["id"]}: {len(obs)} observation(s), {len(cands)} candidate window(s)')
        regions.append({'ds': ds, 'obs': obs, 'product': product,
                        'windows': [dict(window_at(lon, lat), km2=km2) for lon, lat, km2 in cands]})

    footprints([win for r in regions for win in r['windows']], refresh)

    scenes = []
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    for r in regions:
        ds, obs = r['ds'], r['obs']
        # Score each candidate by the buildings its water reached on any date, then by area.
        for win in r['windows']:
            win['masks'] = [rasterize(o['polys'], win['x0'], win['y0'], win['w'], win['h'], RASTER_Z) for o in obs]
            hits = 0
            for cx, cy, _ in win['buildings']:
                i = int(lon_px(cx, RASTER_Z) - win['x0'])
                j = int(lat_px(cy, RASTER_Z) - win['y0'])
                if 0 <= i < win['w'] and 0 <= j < win['h'] and any(m[j * win['w'] + i] for m in win['masks']):
                    hits += 1
            win['hits'] = hits
        kept = sorted(r['windows'], key=lambda v: (-v['hits'], -v['km2']))[:PER_REGION]
        for win in kept:
            w, h = win['w'], win['h']
            n = w * h
            lon, lat = win['center']
            town = nearest_township(lon, lat, towns)
            name = place_name(lon, lat, town)
            sid = slug(f'{ds["id"].replace("MM_", "")}-{name}')
            # Two windows in one region can share a nearest township; the id must not.
            while any(sc['id'] == sid for sc in scenes):
                sid = f'{sid}-2' if not sid[-1].isdigit() else f'{sid[:-1]}{int(sid[-1]) + 1}'
            print(f'  scene {sid}: {w}×{h} px, {len(win["buildings"])} buildings, {win["hits"]} reached by water')
            elev = dem_grid(win['x0'], win['y0'], w, h, refresh)
            keys = [order_keys(m, elev, w, h) for m in win['masks']]
            on, off = timeline(win['masks'], keys, n)
            union = bytearray(1 if any(m[p] for m in win['masks']) else 0 for p in range(n))
            shore, _ = edge_distance(union, w, h)
            shade = bytearray(0 if shore[p] < 0 else round(min(shore[p], SHADE_PX) / SHADE_PX * 255) for p in range(n))

            d = OUT_DIR / sid
            d.mkdir(parents=True, exist_ok=True)
            rows = []
            for j in range(h):
                row = bytearray(w * 3)
                row[0::3] = on[j * w:(j + 1) * w]
                row[1::3] = off[j * w:(j + 1) * w]
                row[2::3] = shade[j * w:(j + 1) * w]
                rows.append(row)
            (d / 'water.png').write_bytes(encode_png_rgb(w, h, rows))
            blds = win['buildings'][:MAX_BUILDINGS]
            enc = encode_buildings({**win, 'buildings': blds}, on, off)
            (d / 'buildings.json').write_text(json.dumps(enc, separators=(',', ':')) + '\n', encoding='utf-8')

            pix_km2 = pixel_metres(lat, RASTER_Z) ** 2 / 1e6
            s_obs = len(obs)
            observations = []
            for k, (o, m) in enumerate(zip(obs, win['masks'])):
                qt = round((k + 1) / s_obs * 254)
                observations.append({
                    't': k + 1, 'date': o['date'], 'sensor': o['sensor'], 'layer': o['layer'],
                    'waterKm2': round(sum(m) * pix_km2, 1),
                    'buildingsInWater': sum(1 for b in enc['b'] if wet_at(b[0], b[1], qt)),
                })
            scenes.append({
                'id': sid,
                'name': name,
                'region': ds['name'].split(',')[0],
                'dataset': ds['id'],
                'event': EVENTS.get(r['product'] or '', r['product'] or ''),
                'product': r['product'],
                'center': [round(lon, 5), round(lat, 5)],
                'bbox': [round(v, 6) for v in win['bbox']],
                'size': [w, h],
                'pixelMetres': round(pixel_metres(lat, RASTER_Z), 1),
                # Exact, so the view's live readout lands on these observations' own figures.
                'pixelKm2': pix_km2,
                'steps': s_obs,
                'observations': observations,
                'buildings': {'count': len(enc['b']), 'truncated': len(win['buildings']) > MAX_BUILDINGS},
                'focus': houses_focus(enc, [round((k + 1) / s_obs * 254) for k in range(s_obs)]),
                'water': f'scenes/{sid}/water.png',
                'buildingsFile': f'scenes/{sid}/buildings.json',
                'township': town,
            })

    scenes.sort(key=lambda sc: -max(o['buildingsInWater'] for o in sc['observations']))
    doc = {
        'generatedAt': utcnow(),
        'note': ('Where water was is observed: at each dated step the water is exactly the extent '
                 'UNOSAT traced from that satellite pass. Between steps it is simulated — newly '
                 'flooded ground fills deepest-first by an estimate from SRTM terrain, receding '
                 'ground dries shallowest-first. No depth is claimed: the estimate only orders the '
                 'fill. Buildings are machine-detected footprints; one inside the water was '
                 'exposed, not necessarily damaged.'),
        'sources': {
            'extents': 'UNOSAT via HDX (CC BY-SA)',
            'terrain': 'Terrarium tiles, Mapzen / AWS Open Data — SRTM (zoom 12)',
            'buildings': 'Microsoft Global ML Building Footprints (ODbL)',
        },
        'rasterZoom': RASTER_Z,
        'scenes': scenes,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / 'index.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    size = sum(f.stat().st_size for f in OUT_DIR.rglob('*') if f.is_file()) / 1e6
    print(f'\nwrote {len(scenes)} scenes ({size:.1f} MB)')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--refresh', action='store_true', help='download terrain and footprints again')
    args = ap.parse_args()
    return build(args.refresh)


if __name__ == '__main__':
    sys.exit(main())
