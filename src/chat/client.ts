/**
 * Talking to the assistant endpoint.
 *
 * This is the only file in the project that understands Anthropic's streaming event vocabulary —
 * deliberately, and for the same reason `parseRunProgress` is the only place that understands the
 * pipeline's `[[stage]]` markers. The server passes the stream through untouched; the meaning is
 * assembled here.
 */

export interface ChatUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** A block of the assistant's reply, in the shape the API expects it back. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  /** A tool call has been announced. Its input is still streaming; this is for the progress chip. */
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'usage'; usage: ChatUsage }

export interface TurnResult {
  content: ContentBlock[]
  stopReason: string | null
  usage: ChatUsage
}

export interface ServerInfo {
  configured: boolean
  model: string
  effort: string
  maxToolTurns: number
}

/**
 * Is there a server, and is the assistant configured on it?
 *
 * Distinguishes the two, because they fail differently: no server at all is the static-hosting
 * case, while a server without a key is a deployment that has not finished. A reader sees a
 * different sentence for each.
 */
export async function chatInfo(): Promise<ServerInfo | null> {
  try {
    const res = await fetch('api/chat', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as ServerInfo
  } catch {
    return null
  }
}

/**
 * Raised for anything that stops a turn producing a usable answer.
 *
 * Carries the HTTP status when there was one, because not every failure deserves the same offer:
 * a timeout is worth retrying, a server with no API key configured is not, and telling someone to
 * "try again" at something that cannot succeed is worse than saying nothing.
 */
export class ChatError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/**
 * Run one turn and stream it back.
 *
 * `onEvent` fires as tokens arrive; the resolved value is the finished assistant message, ready to
 * append to the conversation.
 */
export async function streamTurn(
  messages: unknown[],
  { signal, onEvent }: { signal?: AbortSignal; onEvent?: (e: ChatEvent) => void } = {},
): Promise<TurnResult> {
  const res = await fetch('api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
    signal,
  })

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    let message: string | null = null
    try {
      message = (JSON.parse(body) as { error?: string }).error ?? null
    } catch {
      /* not JSON — handled below, where the absence is itself the useful signal */
    }

    if (!message) {
      // Every error this server produces is JSON. So a 5xx with an empty or non-JSON body did not
      // come from it — the connection died before it could answer, and the dev proxy turned that
      // into a bare 500. In practice that means the server restarted or stopped mid-request, which
      // a retry fixes; "the assistant failed (HTTP 500)" left the reader with nowhere to go.
      message =
        res.status >= 500
          ? `lost the connection to the local server (HTTP ${res.status}). It may have restarted mid-request — try again.`
          : `the assistant failed (HTTP ${res.status})`
    }
    throw new ChatError(message, res.status)
  }

  const blocks: ContentBlock[] = []
  /** Tool inputs arrive as JSON split across deltas, so they are accumulated as text and parsed at
   *  the end. Never string-matched — escaping in these payloads is not something to pattern-match. */
  const partialJson = new Map<number, string>()
  const usage: ChatUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let stopReason: string | null = null
  let sawStop = false
  let streamError: string | null = null

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line. A frame split across chunks stays in the buffer.
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      const type = event.type as string

      if (type === 'error') {
        streamError = ((event.error as { message?: string })?.message ?? 'the assistant failed')
        continue
      }

      if (type === 'message_start') {
        const u = (event.message as { usage?: Record<string, number> })?.usage
        if (u) {
          usage.input = u.input_tokens ?? 0
          usage.cacheRead = u.cache_read_input_tokens ?? 0
          usage.cacheWrite = u.cache_creation_input_tokens ?? 0
        }
        continue
      }

      if (type === 'content_block_start') {
        const index = event.index as number
        const block = event.content_block as Record<string, unknown>
        if (block.type === 'text') blocks[index] = { type: 'text', text: '' }
        else if (block.type === 'thinking') blocks[index] = { type: 'thinking', thinking: '' }
        else if (block.type === 'tool_use') {
          blocks[index] = { type: 'tool_use', id: block.id as string, name: block.name as string, input: {} }
          partialJson.set(index, '')
          onEvent?.({ type: 'tool_start', id: block.id as string, name: block.name as string })
        }
        continue
      }

      if (type === 'content_block_delta') {
        const index = event.index as number
        const delta = event.delta as Record<string, unknown>
        const block = blocks[index]
        if (delta.type === 'text_delta' && block?.type === 'text') {
          block.text += delta.text as string
          onEvent?.({ type: 'text', delta: delta.text as string })
        } else if (delta.type === 'thinking_delta' && block?.type === 'thinking') {
          block.thinking += delta.thinking as string
          onEvent?.({ type: 'thinking', delta: delta.thinking as string })
        } else if (delta.type === 'input_json_delta') {
          partialJson.set(index, (partialJson.get(index) ?? '') + (delta.partial_json as string))
        } else if (delta.type === 'signature_delta' && block?.type === 'thinking') {
          block.signature = delta.signature as string
        }
        continue
      }

      if (type === 'content_block_stop') {
        const index = event.index as number
        const block = blocks[index]
        if (block?.type === 'tool_use') {
          const raw = partialJson.get(index) ?? ''
          try {
            block.input = raw ? JSON.parse(raw) : {}
          } catch {
            throw new ChatError(`the assistant sent a malformed call to ${block.name}`)
          }
        }
        continue
      }

      if (type === 'message_delta') {
        const d = event.delta as { stop_reason?: string }
        if (d?.stop_reason) stopReason = d.stop_reason
        const u = event.usage as { output_tokens?: number } | undefined
        if (u?.output_tokens) usage.output = u.output_tokens
        continue
      }

      if (type === 'message_stop') {
        sawStop = true
        onEvent?.({ type: 'usage', usage })
      }
    }
  }

  if (streamError) throw new ChatError(streamError)
  // A stream that ended without message_stop was cut off. Returning what arrived would render a
  // truncated answer as a finished one, which is the failure this project exists to prevent.
  if (!sawStop) throw new ChatError('the answer was cut off before it finished')
  if (stopReason === 'max_tokens') {
    throw new ChatError('the answer ran past its length limit and stopped early')
  }
  if (stopReason === 'refusal') throw new ChatError('the assistant declined to answer that')

  return { content: blocks.filter(Boolean), stopReason, usage }
}
