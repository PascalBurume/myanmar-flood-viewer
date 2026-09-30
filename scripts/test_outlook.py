#!/usr/bin/env python3
"""Unit tests for the Flood Outlook's arithmetic.

    python3 scripts/test_outlook.py

Nothing here touches the network. What is pinned is what a reader of the map is trusting without
being able to check: that a band edge falls on the side the panel says it does, that "unknown" can
never turn into "minimal", that a wettest day spanning a step boundary is found, and that the river
thresholds come out of a textbook Gumbel fit.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import outlook as ol  # noqa: E402
import river_climatology as rc  # noqa: E402
import scan_forecast_field as sf  # noqa: E402


class BandTests(unittest.TestCase):
    def test_edges_are_inclusive(self):
        self.assertEqual(ol.band(60, ol.LIKELIHOOD_BANDS), 'high')
        self.assertEqual(ol.band(59.9, ol.LIKELIHOOD_BANDS), 'medium')
        self.assertEqual(ol.band(20, ol.LIKELIHOOD_BANDS), 'low')
        self.assertEqual(ol.band(0, ol.LIKELIHOOD_BANDS), 'very low')
        self.assertEqual(ol.band(10000, ol.IMPACT_BANDS), 'severe')
        self.assertEqual(ol.band(9999, ol.IMPACT_BANDS), 'significant')
        self.assertEqual(ol.band(0, ol.IMPACT_BANDS), 'minimal')

    def test_rain_threshold_is_inclusive_and_ignores_missing_members(self):
        r = ol.rain_likelihood([64.5, 64.4, None, 115.6, 0.0])
        self.assertEqual((r['members'], r['veryHeavy'], r['of']), (2, 1, 4))
        self.assertEqual(r['pct'], 50.0)

    def test_no_members_is_zero_not_an_error(self):
        self.assertEqual(ol.rain_likelihood([None, None])['pct'], 0.0)


class MatrixTests(unittest.TestCase):
    def test_matrix_is_complete_and_monotonic(self):
        for lk in ol.LIKELIHOODS:
            row = [ol.LEVELS.index(v) for v in ol.MATRIX[lk]]
            self.assertEqual(len(row), len(ol.IMPACTS))
            self.assertEqual(row, sorted(row), f'{lk} row must not fall as impact rises')
        for i in range(len(ol.IMPACTS)):
            col = [ol.LEVELS.index(ol.MATRIX[lk][i]) for lk in ol.LIKELIHOODS]
            self.assertEqual(col, sorted(col), 'a column must not fall as likelihood rises')

    def test_very_low_likelihood_never_colours_a_township(self):
        # Otherwise every badly flooded township would carry a colour on every quiet day.
        self.assertEqual(set(ol.MATRIX['very low']), {'very low'})

    def test_unknown_impact_is_never_minimal(self):
        self.assertIsNone(ol.level_for('high', None))
        self.assertEqual(ol.level_for('high', 'severe'), 'high')


class ImpactTests(unittest.TestCase):
    rows = [
        {'service': 'A', 'date': '2024-07-30', 'people': 12000, 'flooded': 40.0},
        {'service': 'B', 'date': '2023-07-19', 'people': 900000, 'flooded': 5.0},
        {'service': 'A', 'date': '2024-08-02', 'people': 0, 'flooded': 0.2},
    ]

    def test_withheld_observation_is_skipped(self):
        imp = ol.impact_from_rows(self.rows, {('B', '2023-07-19')})
        self.assertEqual((imp['people'], imp['date'], imp['band']), (12000, '2024-07-30', 'severe'))
        self.assertEqual((imp['passes'], imp['withheld']), (3, 1))

    def test_everything_withheld_is_unknown(self):
        self.assertIsNone(ol.impact_from_rows(self.rows[1:2], {('B', '2023-07-19')}))

    def test_a_pass_that_saw_nobody_is_a_record_of_zero(self):
        imp = ol.impact_from_rows(self.rows[2:], set())
        self.assertEqual((imp['people'], imp['band']), (0, 'minimal'))


class RiverTests(unittest.TestCase):
    gauge = {'name': 'G', 'lat': 17.45, 'lon': 95.56, 'returnFlow': {'2': 40000, '5': 48000},
             'ensemble': {'members': 51, 'over2': 20, 'over5': 3}}

    def test_within_radius(self):
        r = ol.river_likelihood(17.45, 95.70, [self.gauge])  # ~15 km east
        self.assertIsNotNone(r)
        self.assertEqual((r['members'], r['of']), (20, 51))
        self.assertLess(r['km'], ol.RIVER_KM)

    def test_outside_radius(self):
        self.assertIsNone(ol.river_likelihood(17.45, 96.0, [self.gauge]))  # ~47 km

    def test_haversine(self):
        self.assertAlmostEqual(ol.haversine_km(0, 0, 0, 1), 111.19, places=1)


class CellTests(unittest.TestCase):
    grid = {'lats': [28.5, 27.5, 26.5], 'lons': [92.0, 93.0, 94.0, 95.0], 'step': 1.0}

    def test_nearest_and_clamped(self):
        self.assertEqual(ol.cell_index(27.4, 93.2, self.grid), 1 * 4 + 1)
        self.assertEqual(ol.cell_index(10.0, 110.0, self.grid), 2 * 4 + 3)


class AccumulationTests(unittest.TestCase):
    def test_wettest_day_across_a_step_boundary(self):
        vals = [0.0] * 48
        for i in range(10, 34):  # 24 wet hours straddling the 3-h boundaries
            vals[i] = 3.0
        vals[45] = 5.0  # a lone shower later, not enough to move the wettest day
        self.assertEqual(sf.wettest_span(vals, list(range(48))), 72.0)

    def test_missing_hour_skips_the_window_not_the_day(self):
        vals = [1.0] * 30
        vals[0] = None
        self.assertEqual(sf.wettest_span(vals, list(range(30))), 24.0)
        self.assertIsNone(sf.window_total(vals, list(range(30))))

    def test_short_window_has_no_day(self):
        self.assertIsNone(sf.wettest_span([1.0] * 10, list(range(10))))

    def test_window_counts_hours_ending_after_the_start(self):
        times = [f'2026-09-29T{h:02d}:00' for h in range(24)] + [f'2026-09-30T{h:02d}:00' for h in range(24)]
        idx = sf.window_indices(times, '2026-09-29T06:00:00Z', hours=24)
        self.assertEqual(times[idx[0]], '2026-09-29T07:00')
        self.assertEqual(times[idx[-1]], '2026-09-30T06:00')
        self.assertEqual(len(idx), 24)

    def test_window_starts_at_the_read_not_the_init(self):
        self.assertEqual(sf.window_start('2026-09-29T00:00:00Z', '2026-09-29T15:22:06+00:00'), '2026-09-29T15:00:00Z')
        self.assertEqual(sf.window_start('2026-09-29T06:00:00Z', '2026-09-29T05:10:00+00:00'), '2026-09-29T06:00:00Z')


class GumbelTests(unittest.TestCase):
    def test_method_of_moments(self):
        sample = [100, 120, 90, 150, 110, 130, 95, 140]
        fit = rc.gumbel(sample)
        n = len(sample)
        mean = sum(sample) / n
        sd = math.sqrt(sum((x - mean) ** 2 for x in sample) / (n - 1))
        alpha = sd * math.sqrt(6) / math.pi
        self.assertAlmostEqual(fit['scale'], alpha)
        # The 2-year flow sits 0.3665 scale units above the mode, just below the mean.
        self.assertAlmostEqual(fit['levels']['2'], mean - rc.EULER * alpha + 0.36651 * alpha, places=3)
        self.assertLess(fit['levels']['2'], mean)
        self.assertLess(fit['levels']['2'], fit['levels']['5'])
        self.assertLess(fit['levels']['5'], fit['levels']['20'])

    def test_needs_two_years(self):
        with self.assertRaises(ValueError):
            rc.gumbel([100])


if __name__ == '__main__':
    unittest.main(verbosity=1)
