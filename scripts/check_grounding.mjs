#!/usr/bin/env node
/**
 * Tests for the grounding check.
 *
 * This is the one piece of the assistant that makes a claim *to the reader about the assistant* —
 * "treat that figure with suspicion" — so it has to be right in both directions. A miss lets a made
 * up number through; a false positive is arguably worse, because it teaches the reader to ignore
 * the warning and then the real one goes unread too.
 *
 * Both of its bugs so far were false positives, and both came from the same place: the answer and
 * the sources being parsed differently. Every case below is one that actually happened.
 *
 * No test framework — Node runs the TypeScript directly, and `grounding.ts` has no imports so
 * nothing else is dragged in.
 *
 *   node scripts/check_grounding.mjs
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { ungroundedFigures } = await import(
  resolve(fileURLToPath(new URL('../src/chat/grounding.ts', import.meta.url)))
)

/** A real `national_totals` envelope: figures are raw numbers. */
const TOTALS = '{"data":{"peopleExposed":616059,"floodedAreaKm2":5136.9,"floodedCroplandKm2":4321.9,"townshipsObserved":207}}'

/**
 * A real `pipeline_status` envelope. The alert detail is prose the pipeline formatted for humans,
 * so its figures carry thousands separators — which is exactly what broke the check.
 */
const STATUS =
  '{"data":{"stale":true,"ageHours":144.2,"alerts":[{"severity":"critical","title":"Exposure surge — 616,059 people",' +
  '"detail":"2026-08-08: 616,059 people exposed, 25.3x the median of the previous 12 passes (24,344). ' +
  'Flooded area 5,137 km², observed 259,738 km².","baseline":24344}]}}'

const HISTORY = '{"data":{"rows":[{"date":"2026-08-08","people":616059,"floodedKm2":5137.1,"observedKm2":259738.5}]}}'

const cases = [
  // --- must NOT be flagged -------------------------------------------------------------------
  ['exact figure quoted', '616,059 people were exposed.', [TOTALS], []],
  ['rounded up from 5136.9', 'About 5,137 km² was flooded.', [TOTALS], []],
  ['rounded from 259738.5', '259,738 km² was observed.', [HISTORY], []],
  [
    // The regression. Both figures exist only inside comma-formatted prose in the alert detail.
    'figures that appear only comma-formatted in a tool result',
    'Flooded area 5,137 km², observed 259,738 km².',
    [STATUS],
    [],
  ],
  ['figure carried over from an earlier turn', '616,059 people, as I said.', [TOTALS, STATUS], []],
  ['small numbers are ignored', 'Top 5 of 13 regions, 3 gaps, 25 withheld.', [TOTALS], []],
  ['a service id is not a quantity to invent', 'From AI20260814MMR.', ['{"dataset":"UNOSAT FloodAI AI20260814MMR"}'], []],
  ['a date in the answer', 'Observed 2026-08-08.', ['{"observedAt":"2026-08-08"}'], []],

  // --- must be flagged -----------------------------------------------------------------------
  ['an invented total', 'Roughly 942,000 people were affected.', [TOTALS], ['942,000']],
  ['an invented area', 'Some 9,421 km² was flooded.', [TOTALS], ['9,421']],
  ['a figure from no tool at all', '5,137 km² flooded.', ['{"data":{"stale":true}}'], ['5,137']],

  // --- the grouping rule ---------------------------------------------------------------------
  [
    // `[1,2,3]` must stay three numbers. Joining them would invent 123 and make the check laxer
    // than it appears.
    'a JSON array is not one big number',
    'The value is 123.',
    ['{"bbox":[1,2,3]}'],
    ['123'],
  ],
]

let failed = 0
for (const [name, answer, sources, expected] of cases) {
  const got = ungroundedFigures(answer, sources)
  const ok = JSON.stringify(got) === JSON.stringify(expected)
  if (!ok) {
    failed++
    console.error(`\n  FAILED: ${name}`)
    console.error(`    answer:   ${answer}`)
    console.error(`    expected: ${JSON.stringify(expected)}`)
    console.error(`    got:      ${JSON.stringify(got)}`)
  }
}

if (failed) {
  console.error(`\n  ${failed} of ${cases.length} grounding cases failed.`)
  console.error('  A false positive here tells a reader a correct figure is suspect, which is worse')
  console.error('  than not checking at all — they stop believing the warning.\n')
  process.exit(1)
}

console.log(`  grounding ok — ${cases.length} cases`)
