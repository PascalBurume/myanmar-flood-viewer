#!/usr/bin/env python3
"""Unit tests for the 3D scenes' arithmetic.

    python3 scripts/test_scenes.py

Nothing here touches the network. The property worth pinning above all is the one the view's
honesty rests on: at every observed date the simulated water is *exactly* the observed extent, and
only the moments between observations are modelled.
"""

from __future__ import annotations

import struct
import sys
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_scenes as bs  # noqa: E402
import png  # noqa: E402


def square(x0: float, y0: float, x1: float, y1: float) -> list[list[float]]:
    return [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]


class TileTests(unittest.TestCase):
    def test_quadkey(self):
        self.assertEqual(bs.quadkey(0, 0, 1), '0')
        self.assertEqual(bs.quadkey(1, 1, 1), '3')
        self.assertEqual(bs.quadkey(3, 5, 3), '213')

    def test_quadkey_for_bago_matches_the_footprint_index(self):
        # The tile that holds Bago's hotspot, as Microsoft's dataset-links.csv names it.
        x = int(bs.lon_px(96.6, 9) // 256)
        y = int(bs.lat_px(17.2, 9) // 256)
        self.assertEqual(bs.quadkey(x, y, 9), '132201223')

    def test_mercator_round_trip(self):
        for lon, lat in [(96.2, 16.8), (92.0, 28.5), (101.9, 9.6)]:
            self.assertAlmostEqual(bs.px_lon(bs.lon_px(lon, 13), 13), lon, places=9)
            self.assertAlmostEqual(bs.px_lat(bs.lat_px(lat, 13), 13), lat, places=9)


class RasterTests(unittest.TestCase):
    def grid(self):
        # A 20×20 window on the zoom-13 grid somewhere in Bago.
        x0 = int(bs.lon_px(96.5, 13))
        y0 = int(bs.lat_px(17.3, 13))
        return x0, y0, 20, 20

    def lonlat(self, x0, y0, i, j):
        return bs.px_lon(x0 + i, 13), bs.px_lat(y0 + j, 13)

    def test_square_fills_its_pixels(self):
        x0, y0, w, h = self.grid()
        a = self.lonlat(x0, y0, 5, 15)
        b = self.lonlat(x0, y0, 10, 5)
        m = bs.rasterize([[square(a[0], a[1], b[0], b[1])]], x0, y0, w, h, 13)
        self.assertEqual(sum(m), 5 * 10)
        self.assertEqual(m[7 * w + 7], 1)
        self.assertEqual(m[2 * w + 2], 0)

    def test_hole_is_left_dry_whatever_the_winding(self):
        x0, y0, w, h = self.grid()
        outer = square(*self.lonlat(x0, y0, 2, 18), *self.lonlat(x0, y0, 18, 2))
        hole = square(*self.lonlat(x0, y0, 8, 12), *self.lonlat(x0, y0, 12, 8))
        for ring in (outer, outer[::-1]):
            m = bs.rasterize([[ring, hole]], x0, y0, w, h, 13)
            self.assertEqual(sum(m), 16 * 16 - 4 * 4)
            self.assertEqual(m[10 * w + 10], 0)

    def test_rings_outside_the_window_are_ignored(self):
        x0, y0, w, h = self.grid()
        far = square(80.0, 10.0, 80.1, 10.1)
        self.assertEqual(sum(bs.rasterize([[far]], x0, y0, w, h, 13)), 0)


class ModelTests(unittest.TestCase):
    def test_edge_distance_ignores_the_raster_border(self):
        w = h = 7
        mask = bytearray(w * h)
        for j in range(1, 6):
            for i in range(1, 6):
                mask[j * w + i] = 1
        dist, _ = bs.edge_distance(mask, w, h)
        self.assertEqual(dist[3 * w + 3], 2)
        self.assertEqual(dist[1 * w + 1], 0)
        # Water to the raster's edge: that edge is not a shore, so distance runs from the real one.
        full = bytearray(b'\x01' * (w * h))
        for i in range(w):
            full[i] = 0  # dry top row only
        dist, _ = bs.edge_distance(full, w, h)
        self.assertEqual(dist[1 * w + 3], 0)
        self.assertEqual(dist[6 * w + 3], 5)

    def test_wse_carries_the_shore_elevation_inward(self):
        w, h = 5, 1
        mask = bytearray([0, 1, 1, 1, 0])
        elev = [10.0, 4.0, 1.0, 6.0, 10.0]
        dist, wse = bs.edge_distance(mask, w, h, elev)
        self.assertEqual(dist[1:4], [0, 1, 0])
        self.assertIn(wse[2], (4.0, 6.0))

    def test_keyframes_are_exactly_the_observations(self):
        n = 12
        early = bytearray([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0])
        late = bytearray([0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0])
        keys = [[float(i % 5) for i in range(n)], [float((i * 7) % 5) for i in range(n)]]
        on, off = bs.timeline([early, late], keys, n)
        for k, mask in ((0, bytearray(n)), (1, early), (2, late)):
            q = round(k / 2 * 254)
            self.assertEqual([1 if bs.wet_at(on[p], off[p], q) else 0 for p in range(n)], list(mask), f'T={k}')
        # Never-wet pixels say so.
        self.assertEqual((on[11], off[11]), (255, 255))
        # Deepest first: of the pixels arriving with the first pass, the larger key wets earlier.
        self.assertLess(on[4], on[0])

    def test_single_observation_timeline(self):
        mask = bytearray([0, 1, 1, 0])
        on, off = bs.timeline([mask], [[0.0, 2.0, 1.0, 0.0]], 4)
        self.assertEqual([bs.wet_at(on[p], off[p], 254) for p in range(4)], [False, True, True, False])
        self.assertEqual([bs.wet_at(on[p], off[p], 0) for p in range(4)], [False] * 4)
        self.assertLess(on[1], on[2])


class NamingTests(unittest.TestCase):
    def test_place_name_bearing(self):
        town = {'lon': 96.0, 'lat': 17.0, 'township': 'Thanatpin'}
        self.assertEqual(bs.place_name(96.0, 17.0, town), 'Thanatpin')
        self.assertEqual(bs.place_name(96.1, 16.9, town), 'south-east of Thanatpin')
        self.assertEqual(bs.place_name(96.0, 17.2, town), 'north of Thanatpin')
        self.assertIn('°N', bs.place_name(96.0, 17.0, None))


def encode_with_filter(width: int, height: int, rows: list[bytes], ftype: int, bpp: int = 3) -> bytes:
    """A PNG whose scanlines use one given filter — the decoder must undo each of them."""
    out = bytearray()
    prev = bytes(len(rows[0]))
    for row in rows:
        line = bytearray()
        for i, v in enumerate(row):
            a = row[i - bpp] if i >= bpp else 0
            b = prev[i]
            c = prev[i - bpp] if i >= bpp else 0
            p = [0, a, b, (a + b) >> 1, png._paeth(a, b, c)][ftype]
            line.append((v - p) & 0xFF)
        out += bytes([ftype]) + line
        prev = row
    return b''.join([
        b'\x89PNG\r\n\x1a\n',
        png._chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)),
        png._chunk(b'IDAT', zlib.compress(bytes(out))),
        png._chunk(b'IEND', b''),
    ])


class PngTests(unittest.TestCase):
    rows = [bytes([10, 20, 30, 250, 5, 7]), bytes([0, 255, 128, 3, 9, 200]), bytes([77, 1, 2, 3, 4, 5])]

    def test_rgb_round_trip(self):
        w, h, c, back = png.decode_png_any(png.encode_png_rgb(2, 3, self.rows))
        self.assertEqual((w, h, c), (2, 3, 3))
        self.assertEqual([bytes(r) for r in back], self.rows)

    def test_every_filter_is_undone(self):
        for f in range(5):
            w, h, c, back = png.decode_png_any(encode_with_filter(2, 3, self.rows, f))
            self.assertEqual([bytes(r) for r in back], self.rows, f'filter {f}')


if __name__ == '__main__':
    unittest.main(verbosity=1)
