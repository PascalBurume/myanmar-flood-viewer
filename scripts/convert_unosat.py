#!/usr/bin/env python3
"""Convert UNOSAT flood-extent shapefiles to simplified GeoJSON for the viewer.

Usage:
    python3 scripts/convert_unosat.py <shp-or-zip> <out.geojson> [--tolerance 0.0002] [--min-area 5e-7]

Why this exists instead of ogr2ogr
----------------------------------
Pure standard library, so the UNOSAT shapefiles convert on a machine with no GDAL installed, and so
the simplification below is explicit and reviewable rather than hidden behind a flag.

Why simplification is not optional
----------------------------------
UNOSAT publishes each flood extent as a *single* feature whose geometry is a MultiPolygon of tens of
thousands of Sentinel-1 derived rings — 10-18 MB of raw coordinates per layer. The viewer reads
GeoJSON straight from a source with no tiling, so serving the raw geometry would stall the browser.
Rings are simplified
(Douglas-Peucker, in degrees) and speckle below --min-area is dropped.

This is lossy on purpose. It is fit for an overview map of where flooding was detected, NOT for
measuring areas — read Area_ha off the properties for that, since it is computed from the full
geometry before simplification.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import zipfile
from pathlib import Path

# Shapefile shape types this script handles. UNOSAT flood layers are all polygons.
POLYGON, POLYGON_Z, POLYGON_M = 5, 15, 25

# Attributes worth carrying into the viewer. The dbf also holds staff IDs and internal notes that
# have no place on a public map, so this is an allowlist rather than a passthrough.
KEEP_FIELDS = (
    'Water_Clas',
    'Water_Stat',
    'Sensor_ID',
    'Sensor_Dat',
    'SensorDate',
    'Confidence',
    'Area_ha',
    'EventCode',
)


# ---- dbf ----


def read_dbf(path: Path) -> list[dict]:
    """Read a dBASE III table. Only the field types UNOSAT actually emits are decoded."""
    data = path.read_bytes()
    count, header_len, record_len = struct.unpack('<IHH', data[4:12])
    fields: list[tuple[str, str, int]] = []
    pos = 32
    while pos < header_len - 1 and data[pos : pos + 1] != b'\r':
        raw = data[pos : pos + 32]
        name = raw[0:11].split(b'\x00')[0].decode('latin-1').strip()
        fields.append((name, chr(raw[11]), raw[16]))
        pos += 32

    rows = []
    base = header_len
    for i in range(count):
        rec = data[base + i * record_len : base + (i + 1) * record_len]
        if not rec or rec[0:1] == b'*':  # deleted record
            continue
        row: dict = {}
        off = 1
        for name, ftype, flen in fields:
            valb = rec[off : off + flen]
            off += flen
            if name not in KEEP_FIELDS:
                continue
            val = valb.decode('latin-1').strip()
            if val == '':
                continue
            if ftype in 'FN':
                try:
                    val = float(val)
                    if val.is_integer():
                        val = int(val)
                except ValueError:
                    pass
            elif ftype == 'D' and len(val) == 8:
                val = f'{val[0:4]}-{val[4:6]}-{val[6:8]}'
            row[name] = val
        rows.append(row)
    return rows


# ---- shp ----


def read_shp_polygons(path: Path) -> list[list[list[tuple[float, float]]]]:
    """Read polygon records. Returns, per record, a list of rings (each a list of (x, y))."""
    data = path.read_bytes()
    shape_type = struct.unpack('<i', data[32:36])[0]
    if shape_type not in (POLYGON, POLYGON_Z, POLYGON_M):
        raise SystemExit(f'{path.name}: shape type {shape_type} is not a polygon type')

    out = []
    pos = 100
    end = len(data)
    while pos + 8 <= end:
        _num, content_len = struct.unpack('>ii', data[pos : pos + 8])
        body = pos + 8
        pos = body + content_len * 2
        rec_type = struct.unpack('<i', data[body : body + 4])[0]
        if rec_type == 0:  # null shape
            continue
        n_parts, n_points = struct.unpack('<ii', data[body + 36 : body + 44])
        parts_off = body + 44
        parts = list(struct.unpack(f'<{n_parts}i', data[parts_off : parts_off + n_parts * 4]))
        pts_off = parts_off + n_parts * 4
        coords = struct.unpack(f'<{n_points * 2}d', data[pts_off : pts_off + n_points * 16])

        rings = []
        bounds = parts + [n_points]
        for a, b in zip(bounds, bounds[1:]):
            ring = [(coords[j * 2], coords[j * 2 + 1]) for j in range(a, b)]
            if len(ring) >= 4:
                rings.append(ring)
        out.append(rings)
    return out


# ---- geometry ----


def signed_area(ring: list[tuple[float, float]]) -> float:
    """Shoelace area. Shapefiles wind outer rings clockwise, which comes out negative here."""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        total += x1 * y2 - x2 * y1
    return total / 2.0


def simplify(ring: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas-Peucker on a closed ring, iterative so a huge ring cannot blow the stack."""
    if len(ring) < 5 or tol <= 0:
        return ring
    pts = ring[:-1] if ring[0] == ring[-1] else ring[:]
    if len(pts) < 4:
        return ring
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol * tol
    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue
        x1, y1 = pts[first]
        x2, y2 = pts[last]
        dx, dy = x2 - x1, y2 - y1
        denom = dx * dx + dy * dy
        worst, worst_i = -1.0, -1
        for i in range(first + 1, last):
            px, py = pts[i]
            if denom == 0:
                d2 = (px - x1) ** 2 + (py - y1) ** 2
            else:
                t = ((px - x1) * dx + (py - y1) * dy) / denom
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                d2 = (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2
            if d2 > worst:
                worst, worst_i = d2, i
        if worst > tol2:
            keep[worst_i] = True
            stack.append((first, worst_i))
            stack.append((worst_i, last))
    kept = [p for p, k in zip(pts, keep) if k]
    if len(kept) < 3:
        return []
    return kept + [kept[0]]


def overlaps(ring: list[tuple[float, float]], box: list[float]) -> bool:
    """Cheap bbox-vs-bbox test. Rings are small relative to the clip box, so this is enough."""
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(xs) >= box[0] and min(xs) <= box[2] and max(ys) >= box[1] and min(ys) <= box[3]


def point_in_ring(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


class Region:
    """An administrative area used to select which flood rings belong to a location.

    A bounding box is a poor proxy for a region — Yangon and Bago sit close enough that their boxes
    overlap, which would file the same flood polygon under both. This tests the ring's centroid
    against the actual boundary instead.
    """

    def __init__(self, rings: list[list[tuple[float, float]]]):
        self.rings = rings
        xs = [p[0] for r in rings for p in r]
        ys = [p[1] for r in rings for p in r]
        self.box = [min(xs), min(ys), max(xs), max(ys)]

    @staticmethod
    def from_geojson(path: Path, names: list[str]) -> 'Region':
        gj = json.loads(path.read_text(encoding='utf-8'))
        wanted = {n.lower() for n in names}
        rings: list[list[tuple[float, float]]] = []
        found: set[str] = set()
        for feat in gj.get('features', []):
            props = feat.get('properties', {})
            label = str(props.get('shapeName') or props.get('name') or '')
            if label.lower() not in wanted:
                continue
            found.add(label.lower())
            geom = feat.get('geometry', {})
            polys = (
                geom['coordinates']
                if geom.get('type') == 'MultiPolygon'
                else [geom.get('coordinates', [])]
            )
            for poly in polys:
                if poly:
                    rings.append([(c[0], c[1]) for c in poly[0]])
        missing = wanted - found
        if missing:
            raise SystemExit(f'{path.name}: no feature named {sorted(missing)}')
        return Region(rings)

    def contains(self, x: float, y: float) -> bool:
        if not (self.box[0] <= x <= self.box[2] and self.box[1] <= y <= self.box[3]):
            return False
        inside = False
        for ring in self.rings:
            crossings = False
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 > y) != (y2 > y):
                    xin = (x2 - x1) * (y - y1) / (y2 - y1) + x1
                    if x < xin:
                        crossings = not crossings
            if crossings:
                inside = not inside
        return inside

    def holds(self, ring: list[tuple[float, float]], mode: str = 'centroid') -> bool:
        """Decide whether a ring belongs to this region.

        'centroid' assigns each ring to exactly one region — right for flood extent, where thousands
        of small rings must not be double-counted across neighbouring regions.

        'overlap' keeps any ring touching the region — right for an analysis extent, which is a
        handful of polygons far larger than one region. Their centroids usually fall outside the
        region entirely, so centroid mode would discard the very outline that shows what was
        analysed. Overlap deliberately lets one polygon appear under several regions, because the
        analysed area genuinely does span them.
        """
        if mode == 'overlap':
            if not overlaps(ring, self.box):
                return False
            # A vertex inside the region, or a region vertex inside the ring, covers both the
            # "region clips the polygon" and "polygon swallows the region" cases.
            if any(self.contains(x, y) for x, y in ring):
                return True
            return any(point_in_ring(px, py, ring) for r in self.rings for px, py in r)
        n = len(ring)
        cx = sum(p[0] for p in ring) / n
        cy = sum(p[1] for p in ring) / n
        return self.contains(cx, cy)


def rings_to_multipolygon(
    rings: list[list[tuple[float, float]]],
    tol: float,
    min_area: float,
    precision: int,
    clip: list[float] | None = None,
    region: 'Region | None' = None,
    exclude: 'Region | None' = None,
    region_mode: str = 'centroid',
) -> list:
    """Group rings into polygons (outer + holes) and simplify. Shapefile winding decides which."""
    polygons: list[list] = []
    pending_holes: list[list] = []
    for ring in rings:
        area = signed_area(ring)
        if abs(area) < min_area:
            continue  # speckle: single-pixel radar noise, not useful at map scale
        if clip and not overlaps(ring, clip):
            continue
        if region and not region.holds(ring, region_mode):
            continue
        if exclude and exclude.holds(ring):
            continue
        simple = simplify(ring, tol)
        if not simple:
            continue
        rounded = [[round(x, precision), round(y, precision)] for x, y in simple]
        if area < 0:  # clockwise -> outer ring
            polygons.append([rounded])
        elif polygons:  # counter-clockwise -> hole in the polygon opened most recently
            polygons[-1].append(rounded)
        else:
            pending_holes.append(rounded)
    # A hole before any outer ring means the winding assumption did not hold; keep it as its own
    # polygon rather than silently dropping real flooded area.
    polygons.extend([h] for h in pending_holes)
    return polygons


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('source', help='.shp file, or a .zip containing one')
    ap.add_argument('out', help='output .geojson')
    ap.add_argument('--layer', help='when the source is a zip, match this substring in the name')
    ap.add_argument(
        '--tolerance',
        type=float,
        default=0.0002,
        help='Douglas-Peucker tolerance in degrees (default 0.0002, roughly 20 m)',
    )
    ap.add_argument(
        '--min-area',
        type=float,
        default=5e-7,
        help='drop rings smaller than this in square degrees (default 5e-7, roughly 6 ha)',
    )
    ap.add_argument('--precision', type=int, default=5, help='coordinate decimal places')
    ap.add_argument('--extra', action='append', default=[], help='extra property, as key=value')
    ap.add_argument(
        '--drop',
        action='append',
        default=[],
        help=(
            'attribute to omit from the output. Needed for WaterExtent, where UNOSAT sets '
            "Water_Clas='Flood Water' on the total-water layer exactly as on the flood layer — "
            'carrying it through would label permanent rivers as flood water.'
        ),
    )
    ap.add_argument(
        '--bbox',
        help='keep only rings overlapping minx,miny,maxx,maxy — a cheap pre-filter',
    )
    ap.add_argument('--region-file', help='GeoJSON of administrative boundaries to clip against')
    ap.add_argument(
        '--region-mode',
        choices=('centroid', 'overlap'),
        default='centroid',
        help='centroid: one region per ring (flood extent). overlap: keep anything touching the '
        'region (analysis extent, whose polygons are larger than the region itself).',
    )
    ap.add_argument('--exclude-file', help='GeoJSON holding an area to carve out of --region-name')
    ap.add_argument(
        '--exclude-name',
        action='append',
        default=[],
        help=(
            'shapeName to subtract from the selection. Needed because a region polygon may still '
            'contain a territory that was later carved out of it — geoBoundaries ADM1 Mandalay '
            'still covers Nay Pyi Taw, which would otherwise be counted under both.'
        ),
    )
    ap.add_argument(
        '--region-name',
        action='append',
        default=[],
        help='shapeName to select from --region-file; repeat to combine several',
    )
    args = ap.parse_args()

    region = None
    if args.region_file:
        if not args.region_name:
            print('error: --region-file needs at least one --region-name', file=sys.stderr)
            return 2
        region = Region.from_geojson(Path(args.region_file), args.region_name)

    exclude = None
    if args.exclude_name:
        exclude_path = Path(args.exclude_file or args.region_file or '')
        if not exclude_path.name:
            print('error: --exclude-name needs --exclude-file or --region-file', file=sys.stderr)
            return 2
        exclude = Region.from_geojson(exclude_path, args.exclude_name)

    clip = None
    if args.bbox:
        parts = [float(v) for v in args.bbox.split(',')]
        if len(parts) != 4:
            print('error: --bbox needs exactly minx,miny,maxx,maxy', file=sys.stderr)
            return 2
        clip = parts

    src = Path(args.source)
    workdir = None
    if src.suffix.lower() == '.zip':
        workdir = src.parent / (src.stem + '__extracted')
        with zipfile.ZipFile(src) as zf:
            zf.extractall(workdir)
        candidates = sorted(workdir.rglob('*.shp'))
        if args.layer:
            candidates = [c for c in candidates if args.layer.lower() in c.name.lower()]
        if not candidates:
            print(f'error: no matching .shp inside {src.name}', file=sys.stderr)
            return 2
        if len(candidates) > 1:
            print('error: several shapefiles match; narrow it with --layer:', file=sys.stderr)
            for c in candidates:
                print('   ', c.name, file=sys.stderr)
            return 2
        shp = candidates[0]
    else:
        shp = src

    records = read_shp_polygons(shp)
    dbf_path = shp.with_suffix('.dbf')
    attrs = read_dbf(dbf_path) if dbf_path.exists() else [{} for _ in records]

    extra = {}
    for item in args.extra:
        key, _, value = item.partition('=')
        extra[key] = value

    features = []
    raw_rings = kept_rings = 0
    clipping = bool(clip or region)
    for rings, props in zip(records, attrs + [{}] * (len(records) - len(attrs))):
        # Area_ha describes the whole undivided multipolygon in the source product. Once rings are
        # clipped to one region it no longer describes this feature, and leaving it in would show a
        # nationwide figure on a single region's popup. Drop it rather than publish a wrong number.
        if clipping:
            props = {k: v for k, v in props.items() if k != 'Area_ha'}
        if args.drop:
            props = {k: v for k, v in props.items() if k not in args.drop}
        raw_rings += len(rings)
        multi = rings_to_multipolygon(
            rings, args.tolerance, args.min_area, args.precision, clip, region, exclude,
            args.region_mode,
        )
        kept_rings += sum(len(p) for p in multi)
        if not multi:
            continue
        features.append(
            {
                'type': 'Feature',
                'properties': {**props, **extra},
                'geometry': {'type': 'MultiPolygon', 'coordinates': multi},
            }
        )

    xs = [x for f in features for poly in f['geometry']['coordinates'] for ring in poly for x, _ in ring]
    ys = [y for f in features for poly in f['geometry']['coordinates'] for ring in poly for _, y in ring]
    fc: dict = {'type': 'FeatureCollection', 'features': features}
    if xs:
        fc['bbox'] = [min(xs), min(ys), max(xs), max(ys)]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')

    size_mb = out.stat().st_size / 1e6
    print(f'{shp.name}')
    print(f'  features {len(features)}, rings {raw_rings} -> {kept_rings}')
    print(f'  wrote {out} ({size_mb:.2f} MB)')
    if workdir:
        print(f'  (extracted to {workdir}; safe to delete)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
