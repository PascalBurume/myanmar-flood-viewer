#!/usr/bin/env python3
"""Unit tests for scan_cyclones.py's parsers — the parts that read other people's formats.

    python3 scripts/test_cyclones.py

Both sources are fixed-format text with traps the parsers must survive: IBTrACS's second line is a
units row, JTWC's wind radii continue on unprefixed lines, and JTWC's times carry only a day of the
month. The fixtures below are cut from real products (JTWC WTPN32 for 23W, September 2026).
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import scan_cyclones as sc  # noqa: E402

IBTRACS = """\
SID,SEASON,NUMBER,BASIN,SUBBASIN,NAME,ISO_TIME,NATURE,LAT,LON,WMO_WIND,WMO_PRES,WMO_AGENCY,TRACK_TYPE,DIST2LAND,LANDFALL,IFLAG,USA_AGENCY,USA_ATCF_ID,USA_LAT,USA_LON,USA_RECORD,USA_STATUS,USA_WIND,USA_PRES,USA_SSHS,USA_R34_NE,USA_R34_SE,USA_R34_SW,USA_R34_NW,USA_R50_NE,USA_R50_SE,USA_R50_SW,USA_R50_NW,USA_R64_NE,USA_R64_SE,USA_R64_SW,USA_R64_NW
 ,Year, , , , , , ,degrees_north,degrees_east,kts,mb, , ,km,km, , , ,degrees_north,degrees_east, , ,kts,mb,1,nmile,nmile,nmile,nmile,nmile,nmile,nmile,nmile,nmile,nmile,nmile,nmile
2026245N12090,2026,50,NI,BB,UNNAMED,2026-09-03 00:00:00,TS,12.0,90.0, , , ,PROVISIONAL,500,500,O_,jtwc_io,IO032026,12.0,90.0, ,TS,35,1000,0,60,60,40,40, , , , , , , ,
2026245N12090,2026,50,NI,BB,UNNAMED,2026-09-03 06:00:00,TS,12.6,89.6, , , ,PROVISIONAL,450,450,P_,jtwc_io,IO032026,12.6,89.6, ,TS,45,996,0,70,70,50,50,20,20,0,0, , , ,
2026222N15223,2026,45,EP,MM,LALA,2026-08-10 00:00:00,DS,14.5,-137.3, , , ,PROVISIONAL,1942,1942,O_,nhc,CP012026,14.5,-137.3, ,DB,20,1007,-3, , , , , , , , , , , ,
2026244N23132,2026,49,WP,MM,KROVANH,2026-09-03 00:00:00,TS,26.1,130.2, , , ,PROVISIONAL,300,300,O_,jtwc_wp,WP222026,26.1,130.2, ,TS,39,996,0, , , , , , , , , , , ,
"""

# A JTWC warning for a Bay of Bengal storm, in the exact layout JTWC uses (spacing included).
JTWC = """\
WTIO31 PGTW 031500
MSGID/GENADMIN/JOINT TYPHOON WRNCEN PEARL HARBOR HI//
SUBJ/TROPICAL CYCLONE 03B (THREE) WARNING NR 004//
RMKS/
1. TROPICAL CYCLONE 03B (THREE) WARNING NR 004
   01 ACTIVE TROPICAL CYCLONE IN NORTHINDIAN OCEAN
   MAX SUSTAINED WINDS BASED ON ONE-MINUTE AVERAGE
   WIND RADII VALID OVER OPEN WATER ONLY
    ---
   WARNING POSITION:
   031200Z --- NEAR 12.8N 89.4E
     MOVEMENT PAST SIX HOURS - 320 DEGREES AT 07 KTS
     POSITION ACCURATE TO WITHIN 040 NM
     POSITION BASED ON CENTER LOCATED BY SATELLITE
   PRESENT WIND DISTRIBUTION:
   MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 034 KT WINDS - 070 NM NORTHEAST QUADRANT
                            070 NM SOUTHEAST QUADRANT
                            050 NM SOUTHWEST QUADRANT
                            050 NM NORTHWEST QUADRANT
   REPEAT POSIT: 12.8N 89.4E
    ---
   FORECASTS:
   12 HRS, VALID AT:
   040000Z --- 13.9N 88.9E
   MAX SUSTAINED WINDS - 055 KT, GUSTS 070 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 034 KT WINDS - 080 NM NORTHEAST QUADRANT
                            080 NM SOUTHEAST QUADRANT
                            060 NM SOUTHWEST QUADRANT
                            060 NM NORTHWEST QUADRANT
   RADIUS OF 050 KT WINDS - 030 NM NORTHEAST QUADRANT
                            030 NM SOUTHEAST QUADRANT
                            020 NM SOUTHWEST QUADRANT
                            020 NM NORTHWEST QUADRANT
   VECTOR TO 24 HR POSIT: 020 DEG/ 08 KTS
    ---
   24 HRS, VALID AT:
   041200Z --- 15.4N 89.5E
   MAX SUSTAINED WINDS - 065 KT, GUSTS 080 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   RADIUS OF 034 KT WINDS - 090 NM NORTHEAST QUADRANT
                            090 NM SOUTHEAST QUADRANT
                            070 NM SOUTHWEST QUADRANT
                            070 NM NORTHWEST QUADRANT
   RADIUS OF 064 KT WINDS - 015 NM NORTHEAST QUADRANT
                            015 NM SOUTHEAST QUADRANT
                            010 NM SOUTHWEST QUADRANT
                            010 NM NORTHWEST QUADRANT
   VECTOR TO 36 HR POSIT: 030 DEG/ 09 KTS
    ---
   EXTENDED OUTLOOK:
   48 HRS, VALID AT:
   051200Z --- 18.9N 92.6E
   MAX SUSTAINED WINDS - 050 KT, GUSTS 065 KT
   WIND RADII VALID OVER OPEN WATER ONLY
   DISSIPATING AS A SIGNIFICANT TROPICAL CYCLONE OVER LAND
    ---
REMARKS:
031500Z POSITION NEAR 13.1N 89.3E.
MINIMUM CENTRAL PRESSURE AT 031200Z IS 990 MB.
NNNN
"""

REF = datetime(2026, 9, 3, 17, 30, tzinfo=timezone.utc)


class IbtracsTests(unittest.TestCase):
    def test_units_row_skipped_and_basins_filtered(self):
        storms = sc.parse_ibtracs(IBTRACS)
        # LALA (EP) is out of basin. KROVANH (WP) survives the basin filter here — the box is judged
        # later, once forecasts are attached — and is dropped by touches_box below.
        self.assertEqual(sorted(storms), ['2026244N23132', '2026245N12090'])
        self.assertFalse(sc.touches_box(storms['2026244N23132']))
        self.assertTrue(sc.touches_box(storms['2026245N12090']))
        st = storms['2026245N12090']
        self.assertEqual(st['basin'], 'NI')
        self.assertEqual(st['atcf'], 'IO032026')
        self.assertEqual(len(st['observed']), 2)

    def test_radii_and_measures(self):
        st = sc.parse_ibtracs(IBTRACS)['2026245N12090']
        first, last = st['observed']
        self.assertEqual(first['t'], '2026-09-03T00:00:00Z')
        self.assertEqual(first['windKt'], 35)
        self.assertEqual(first['presHpa'], 1000)
        self.assertEqual(first['sshs'], 0)
        self.assertEqual(first['r34'], [60, 60, 40, 40])
        self.assertIsNone(first['r50'])
        self.assertEqual(last['r50'], [20, 20, 0, 0])
        self.assertIsNone(last['r64'])


class JtwcTests(unittest.TestCase):
    def setUp(self):
        self.fc = sc.parse_warning(JTWC, REF, 'io0326', 'https://example/io0326web.txt')

    def test_header(self):
        self.assertEqual(self.fc['atcf'], 'IO032026')
        self.assertEqual(self.fc['number'], '03B')
        self.assertEqual(self.fc['name'], 'THREE')
        self.assertEqual(self.fc['issued'], '2026-09-03T15:00:00Z')

    def test_warning_position(self):
        w = self.fc['warning']
        self.assertEqual((w['t'], w['lat'], w['lon']), ('2026-09-03T12:00:00Z', 12.8, 89.4))
        self.assertEqual(w['windKt'], 45)
        self.assertEqual(w['accuracyNm'], 40)
        self.assertEqual(w['presHpa'], 990)
        # The three continuation lines carry no "RADIUS OF" prefix and must still be read.
        self.assertEqual(w['r34'], [70, 70, 50, 50])

    def test_forecast_points(self):
        taus = [p['tauH'] for p in self.fc['points']]
        self.assertEqual(taus, [12, 24, 48])
        p24 = self.fc['points'][1]
        self.assertEqual((p24['t'], p24['lat'], p24['lon']), ('2026-09-04T12:00:00Z', 15.4, 89.5))
        self.assertEqual(p24['windKt'], 65)
        self.assertEqual(p24['r34'], [90, 90, 70, 70])
        self.assertIsNone(p24['r50'])
        self.assertEqual(p24['r64'], [15, 15, 10, 10])
        self.assertTrue(self.fc['points'][2].get('dissipating'))

    def test_month_rollover(self):
        # A feed read on 1 October about a warning position on the 30th resolves to September,
        # and a forecast for the 2nd, read on 30 September, resolves to October.
        oct1 = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)
        self.assertEqual(sc.ddhhmm('301200', oct1).isoformat(), '2026-09-30T12:00:00+00:00')
        sep30 = datetime(2026, 9, 30, 21, 0, tzinfo=timezone.utc)
        self.assertEqual(sc.ddhhmm('021200', sep30).isoformat(), '2026-10-02T12:00:00+00:00')

    def test_products_from_rss(self):
        rss = b"""<?xml version="1.0"?><rss><channel><pubDate>Thu, 03 Sep 2026 17:30:00 +0000</pubDate>
        <item><description><![CDATA[<a href='https://www.metoc.navy.mil/jtwc/products/io0326web.txt'>x</a>
        <a href='https://www.metoc.navy.mil/jtwc/products/io0326prog.txt'>y</a>
        <a href='https://www.metoc.navy.mil/jtwc/products/wp2326web.txt'>z</a>
        <a href='https://www.metoc.navy.mil/jtwc/products/sh0126web.txt'>southern</a>]]></description></item>
        </channel></rss>"""
        ids, ref = sc.jtwc_products(rss)
        self.assertEqual(ids, ['io0326', 'wp2326'])
        self.assertEqual(ref, REF)


class MergeTests(unittest.TestCase):
    def test_forecast_attaches_by_atcf_id(self):
        storms = sc.parse_ibtracs(IBTRACS)
        fc = sc.parse_warning(JTWC, REF, 'io0326', 'u')
        sc.attach_forecasts(storms, [fc], REF)
        st = storms['2026245N12090']
        self.assertIsNotNone(st['forecast'])
        self.assertEqual(st['forecast']['agency'], 'JTWC')
        self.assertEqual(len(st['forecast']['points']), 3)
        # The warning position does not get added as an observation when IBTrACS has the storm.
        self.assertEqual(len(st['observed']), 2)

    def test_new_warning_without_ibtracs_makes_a_provisional_storm(self):
        storms: dict = {}
        fc = sc.parse_warning(JTWC, REF, 'io0326', 'u')
        sc.attach_forecasts(storms, [fc], REF)
        self.assertEqual(list(storms), ['JTWC:IO032026'])
        st = storms['JTWC:IO032026']
        self.assertEqual(st['basin'], 'NI')
        self.assertEqual(st['observed'][0]['trackType'], 'JTWC warning position')

    def test_cache_retains_and_ibtracs_supersedes(self):
        old = {'sid': 'OLD', 'atcf': 'IO022026', 'name': 'OLD', 'basin': 'NI',
               'observed': [{'t': '2026-08-20T00:00:00Z', 'lat': 10, 'lon': 85}]}
        ancient = {'sid': 'ANCIENT', 'atcf': None, 'name': 'X', 'basin': 'NI',
                   'observed': [{'t': '2026-06-01T00:00:00Z', 'lat': 10, 'lon': 85}]}
        provisional = {'sid': 'JTWC:IO032026', 'atcf': 'IO032026', 'name': 'THREE', 'basin': 'NI',
                       'observed': []}
        cache = {'storms': {'OLD': old, 'ANCIENT': ancient, 'JTWC:IO032026': provisional}}
        merged = sc.merge(cache, sc.parse_ibtracs(IBTRACS), REF)
        self.assertIn('OLD', merged)              # within 30 days: kept
        self.assertNotIn('ANCIENT', merged)       # older: dropped
        self.assertNotIn('JTWC:IO032026', merged)  # IBTrACS now carries IO032026
        self.assertIn('2026245N12090', merged)

    def test_forecast_into_box_keeps_a_storm_observed_outside_it(self):
        # Observed only at 12N 78E (west of the box); JTWC forecasts it to 13N 82E.
        st = {'sid': 'X', 'atcf': 'IO042026', 'name': 'X', 'basin': 'NI',
              'observed': [{'t': '2026-09-03T00:00:00Z', 'lat': 12.0, 'lon': 78.0}],
              'forecast': {'warning': {'t': '2026-09-03T12:00:00Z', 'lat': 12.2, 'lon': 78.5},
                           'points': [{'tauH': 24, 't': '2026-09-04T12:00:00Z', 'lat': 13.0, 'lon': 82.0}]}}
        self.assertTrue(sc.touches_box(st))
        st['forecast']['points'][0]['lon'] = 79.0
        self.assertFalse(sc.touches_box(st))

    def test_stale_forecast_is_dropped(self):
        storms = sc.parse_ibtracs(IBTRACS)
        fc = sc.parse_warning(JTWC, REF, 'io0326', 'u')
        sc.attach_forecasts(storms, [fc], REF)
        later = datetime(2026, 9, 6, 0, 0, tzinfo=timezone.utc)
        out = sc.finish(storms, later)
        self.assertIsNone(out[0]['forecast'])
        self.assertEqual(out[0]['peakWindKt'], 45)


if __name__ == '__main__':
    unittest.main(verbosity=1)
