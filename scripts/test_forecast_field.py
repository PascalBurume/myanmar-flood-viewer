#!/usr/bin/env python3
"""Unit tests for the forecast-field scanner's arithmetic and the PNG writer.

    python3 scripts/test_forecast_field.py

Nothing here touches the network. The parts worth pinning are the ones a reader cannot check by
eye: that the Mercator row placement puts each block where it claims to be, that a 3-hour total is
the right three hours, and that a PNG round-trips through the palette it was written with.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import png  # noqa: E402
import scan_forecast_field as sf  # noqa: E402


class PngTests(unittest.TestCase):
    def test_round_trip_with_transparent_zero(self):
        pal = [(0, 0, 0), (10, 20, 30), (200, 210, 220)]
        rows = [bytes([0, 1, 2]), bytes([2, 1, 0])]
        data = png.encode_png(3, 2, rows, pal)
        w, h, back, pal2, transparent = png.decode_png(data)
        self.assertEqual((w, h), (3, 2))
        self.assertEqual(back, rows)
        self.assertEqual(pal2, pal)
        self.assertEqual(transparent, 0)

    def test_write_png_creates_parents(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'a' / 'b' / 'x.png'
            png.write_png(p, 1, 1, [b'\x01'], [(0, 0, 0), (255, 255, 255)])
            self.assertTrue(p.exists())
            self.assertEqual(p.read_bytes()[:8], b'\x89PNG\r\n\x1a\n')

    def test_classify_is_lower_bound_inclusive(self):
        stops = [0.5, 2, 5]
        self.assertEqual(png.classify(None, stops), 0)
        self.assertEqual(png.classify(0.4, stops), 0)
        self.assertEqual(png.classify(0.5, stops), 1)
        self.assertEqual(png.classify(1.9, stops), 1)
        self.assertEqual(png.classify(2, stops), 2)
        self.assertEqual(png.classify(500, stops), 3)


class GridTests(unittest.TestCase):
    def test_grid_shape(self):
        lats, lons, rows, cols = sf.grid_points()
        self.assertEqual((rows, cols), (39, 21))
        self.assertEqual((lats[0], lats[-1]), (28.5, 9.5))
        self.assertEqual((lons[0], lons[-1]), (92.0, 102.0))
        self.assertEqual(sf.bbox(), [91.75, 9.25, 102.25, 28.75])

    def test_mercator_rows_edges_and_middle(self):
        m = sf.mercator_rows()
        self.assertEqual(len(m), 39 * sf.MERC_ROWS_PER_CELL)
        self.assertEqual(m[0], 0)        # top of the image is the northern cell
        self.assertEqual(m[-1], 38)      # bottom is the southern cell
        self.assertTrue(all(b >= a for a, b in zip(m, m[1:])))  # monotone
        # Every sample row is used at least once — nothing is dropped by the warp.
        self.assertEqual(sorted(set(m)), list(range(39)))
        # The warp is the point: against evenly spaced rows it shifts a good share of the image by
        # a whole cell, and never by more than one over this 19° span. Measured, then pinned.
        north, south = 28.75, 9.25
        linear = [int((north - (north - (j + 0.5) / len(m) * (north - south))) // 0.5) for j in range(len(m))]
        moved = [j for j in range(len(m)) if m[j] != linear[j]]
        self.assertEqual(len(moved), 58)
        self.assertEqual(max(abs(m[j] - linear[j]) for j in range(len(m))), 1)
        # Mercator stretches the north, so a Mercator row shows ground at or north of the linear
        # one — i.e. never a higher row index.
        self.assertTrue(all(m[j] <= linear[j] for j in range(len(m))))

    def test_cell_of_nearest_centre(self):
        self.assertEqual(sf.cell_of(28.5, 92.0), (0, 0))
        self.assertEqual(sf.cell_of(9.5, 102.0), (38, 20))
        self.assertEqual(sf.cell_of(16.87, 96.20), (int(round((28.5 - 17.0) / 0.5)), int(round((96.0 - 92.0) / 0.5))))


class AggregationTests(unittest.TestCase):
    def test_sum3h_is_three_hours_ending_at_k(self):
        vals = [float(i) for i in range(10)]
        self.assertEqual(sf.sum3h(vals, 3), 1 + 2 + 3)
        self.assertEqual(sf.sum3h(vals, 6), 4 + 5 + 6)
        self.assertIsNone(sf.sum3h([None, 1, 2, 3], 2))
        self.assertIsNone(sf.sum3h([1, 2], 1))

    def test_step_indices_and_init_cut(self):
        times = [f'2026-09-05T{h:02d}:00' for h in range(24)] + [f'2026-09-06T{h:02d}:00' for h in range(24)]
        steps = sf.step_indices(times)
        self.assertEqual(steps[0], (3, 3, '2026-09-05T03:00:00Z'))
        self.assertEqual(steps[-1][2], '2026-09-06T21:00:00Z')
        # No published init: cut at the fetch time floored to the 3-hour step.
        self.assertEqual(sf.valid_from(None, '2026-09-05T13:40:00+00:00'), '2026-09-05T12:00:00Z')

    def test_usable_steps_start_after_the_init(self):
        times = [f'2026-09-05T{h:02d}:00' for h in range(24)] + [f'2026-09-06T{h:02d}:00' for h in range(24)]
        kept = sf.usable_steps(times, '2026-09-05T06:00:00Z')
        # The step stamped 06Z totals 03–06Z: the previous run's rain. The run's own first step
        # ends three hours after its init, and its lead is counted from the init.
        self.assertEqual(kept[0], (9, 3, '2026-09-05T09:00:00Z'))
        self.assertEqual(kept[1][1:], (6, '2026-09-05T12:00:00Z'))
        # An 18Z run read the next morning: the first step on offer is 03Z, a nine-hour lead —
        # not the three it used to be labelled with.
        late = sf.usable_steps(times, '2026-09-04T18:00:00Z')
        self.assertEqual(late[0], (3, 9, '2026-09-05T03:00:00Z'))

    def test_normalise_steps_repairs_runs_on_disk(self):
        run = {'init': '2026-09-24T06:00:00Z', 'fetchedAt': '2026-09-24T16:40:58+00:00', 'steps': [
            {'h': 3, 'valid': '2026-09-24T06:00:00Z', 'precip': 'a'},
            {'h': 6, 'valid': '2026-09-24T09:00:00Z', 'precip': 'b'},
            {'h': 9, 'valid': '2026-09-24T12:00:00Z', 'precip': 'c'},
        ]}
        out = sf.normalise_steps(run)
        self.assertEqual([(s['h'], s['precip']) for s in out], [(3, 'b'), (6, 'c')])
        self.assertEqual(sf.normalise_steps({**run, 'steps': out}), out)  # idempotent
        # No init: the fetch time floored to the step stands in for it.
        gfs = {'init': None, 'fetchedAt': '2026-09-24T16:40:58+00:00', 'steps': [
            {'h': 3, 'valid': '2026-09-24T15:00:00Z'}, {'h': 6, 'valid': '2026-09-24T18:00:00Z'}]}
        self.assertEqual([s['h'] for s in sf.normalise_steps(gfs)], [3])

    def test_frame_stats_peak_and_wet_share(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'f.png'
            png.write_png(p, 4, 2, [bytes([0, 0, 1, 3]), bytes([0, 0, 0, 2])], [(0, 0, 0)] * 4)
            self.assertEqual(sf.frame_stats(p), [3, 0.375])
            png.write_png(p, 2, 1, [bytes([0, 0])], [(0, 0, 0)] * 2)
            self.assertEqual(sf.frame_stats(p), [0, 0])

    def test_raster_rows_match_mercator_mapping(self):
        lats, lons, rows, cols = sf.grid_points()
        vals = [[float(r) for _ in range(cols)] for r in range(rows)]   # value == row number
        stops = [float(s) for s in range(1, 40)]                          # index == value
        out = sf.raster(vals, stops)
        self.assertEqual(len(out), rows * sf.MERC_ROWS_PER_CELL)
        self.assertEqual(out[0][0], 0)
        self.assertEqual(out[-1][0], 38)


if __name__ == '__main__':
    unittest.main(verbosity=1)
