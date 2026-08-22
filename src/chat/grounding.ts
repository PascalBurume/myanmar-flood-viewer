/**
 * Checking that the numbers in an answer came from somewhere.
 *
 * Plain code, no model, no tokens. Every figure in the reply has to appear in something the
 * assistant actually looked up. It cannot be argued out of its verdict, which is the point — this
 * project would rather show a reader "that figure is not in the data" than let a confident wrong
 * number through.
 *
 * Kept in its own file with **no imports**, so it can be unit-tested by `scripts/check_grounding.mjs`
 * without dragging in React or MapLibre. It has produced two false positives already, and a false
 * positive is worse than no check at all: it teaches the reader to ignore the warning, and then the
 * real one goes unread too.
 */

/**
 * One number, in either of the forms this data uses.
 *
 * The alternation order matters: the grouped form is tried first so `259,738` is taken whole rather
 * than as `259` then `738`.
 *
 * Grouping is matched strictly — a comma only counts as a thousands separator when followed by
 * exactly three digits. That keeps a JSON array like `[1,2,3]` as three separate numbers instead of
 * inventing `123`, which would quietly make the check more permissive than it looks.
 */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g

/** Digits only, with trailing `.0`s dropped so `5137.0` and `5137` are the same figure. */
const normalise = (raw: string) => raw.replace(/,/g, '').replace(/\.0+$/, '')

/**
 * Figures in `answer` that appear nowhere in `sources`.
 *
 * **Both sides are parsed by the same regex, deliberately.** They were not, once: the answer side
 * stripped thousands separators and the source side did not, so a figure written `259,738 km²`
 * inside a tool result was read as `259` and `738` and matched nothing — and a correctly quoted
 * number was reported to the reader as suspect. Any change here must keep the two sides identical.
 *
 * Deliberately narrow: values under 100 are ignored, because years, list positions and small counts
 * produce constant noise and are rarely the figure that misleads.
 */
export function ungroundedFigures(answer: string, sources: string[]): string[] {
  const known = new Set((sources.join(' ').match(NUMBER) ?? []).map(normalise))

  const out = new Set<string>()
  for (const raw of answer.match(NUMBER) ?? []) {
    const plain = normalise(raw)
    const n = Number(plain)
    if (!Number.isFinite(n) || Math.abs(n) < 100) continue
    if (known.has(plain)) continue

    // A rounded quotation of a real figure is honest reporting, not invention: 5,137 for 5136.9.
    const rounded = [...known].some((k) => {
      const kn = Number(k)
      if (!Number.isFinite(kn) || kn === 0) return false
      return Math.abs(kn - n) / Math.abs(kn) < 0.005
    })
    if (!rounded) out.add(raw)
  }
  return [...out]
}
