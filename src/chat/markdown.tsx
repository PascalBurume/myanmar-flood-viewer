import { Fragment, type ReactNode } from 'react'

/**
 * A deliberately small Markdown subset, rendered as React elements.
 *
 * The model writes Markdown whether or not it is asked to, so without this an answer arrives as
 * literal `**616,059**` and `- Sagaing`. Only four constructs are worth supporting here — bold,
 * italic, inline code, and lists — and building them as elements rather than HTML means there is no
 * `dangerouslySetInnerHTML` anywhere and nothing to sanitise.
 *
 * Forty lines instead of `marked` plus `dompurify`, which is the same reasoning that keeps the
 * server at zero dependencies: two packages to keep patched is a poor trade for four constructs.
 */

/** `**bold**`, `*italic*`, `` `code` `` — everything else is left as written. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  // One pass, alternation ordered so `**` is matched before `*`.
  const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-${i++}`
    if (token.startsWith('**')) out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    else if (token.startsWith('`')) out.push(<code key={key}>{token.slice(1, -1)}</code>)
    else out.push(<em key={key}>{token.slice(1, -1)}</em>)
    last = match.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const BULLET = /^\s*[-*]\s+/
const NUMBER = /^\s*\d+[.)]\s+/

export function renderMarkdown(text: string): ReactNode {
  const blocks = text.trim().split(/\n{2,}/).filter(Boolean)

  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split('\n').filter((l) => l.trim())

        if (lines.length && lines.every((l) => BULLET.test(l))) {
          return (
            <ul key={b}>
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(BULLET, ''), `${b}-${i}`)}</li>
              ))}
            </ul>
          )
        }

        if (lines.length && lines.every((l) => NUMBER.test(l))) {
          return (
            <ol key={b}>
              {lines.map((l, i) => (
                <li key={i}>{inline(l.replace(NUMBER, ''), `${b}-${i}`)}</li>
              ))}
            </ol>
          )
        }

        // A single newline inside a paragraph is a soft wrap, not a new paragraph.
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <Fragment key={i}>
                {i > 0 ? ' ' : null}
                {inline(l, `${b}-${i}`)}
              </Fragment>
            ))}
          </p>
        )
      })}
    </>
  )
}
