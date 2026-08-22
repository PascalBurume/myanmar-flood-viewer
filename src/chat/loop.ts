/**
 * The agentic loop: ask, run whatever tools come back, ask again, until the model has an answer.
 *
 * It runs in the browser. The server holds the key and pins everything else about the request, but
 * the conversation itself lives here — see `tools.ts` for why the tools cannot live on the server.
 */

import { streamTurn, ChatError, type ChatEvent, type ChatUsage, type ContentBlock } from './client'
import { contextBlock } from './context'
import { ungroundedFigures } from './grounding'
import { runTool, type ChartSpec, type ChatContext } from './tools'

/** Matches the server's own guard. That one is the real limit; this is a courtesy. */
const MAX_TOOL_TURNS = 12

export interface ToolRun {
  id: string
  name: string
  input: unknown
  ok: boolean
}

export interface LoopEvents {
  onEvent?: (e: ChatEvent) => void
  /** A tool finished. Drives the chips in the transcript, so the reader sees what was consulted. */
  onTool?: (run: ToolRun) => void
}

export interface LoopResult {
  /** The full wire history, ready to send back on the next question. */
  messages: unknown[]
  /** What the assistant actually said, for display. */
  text: string
  tools: ToolRun[]
  charts: ChartSpec[]
  confirm: { reason: string } | null
  usage: ChatUsage
  /** Figures in the answer that appear in no tool result. Empty is the normal case. */
  ungrounded: string[]
  /** This turn's raw tool outputs, so the caller can accumulate them across the conversation. */
  outputs: string[]
}

const textOf = (content: ContentBlock[]) =>
  content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

/**
 * Send one question and drive the conversation to an answer.
 *
 * `history` is the wire-shaped conversation so far; the returned `messages` replaces it. On the
 * first turn the orientation block is prepended — once, so it stays a stable cached prefix for the
 * life of the conversation.
 */
export async function runConversation(
  history: unknown[],
  question: string,
  ctx: ChatContext,
  {
    onEvent,
    onTool,
    signal,
    // Tool outputs from earlier turns. The grounding check spans the whole conversation, not just
    // this turn: a reader who asks a follow-up and gets a figure restated from two turns ago is
    // being answered correctly, and flagging that as ungrounded would train them to ignore the
    // warning — which would cost more than the check is worth.
    priorOutputs = [],
  }: LoopEvents & { signal?: AbortSignal; priorOutputs?: string[] } = {},
): Promise<LoopResult> {
  // Also fed to the grounding check below: the orientation block carries real figures — dataset
  // notes, statistics, service ids — and a model quoting one of them is being accurate, not
  // inventing. Leaving it out made correct answers look suspect, which is worse than not checking.
  const context = contextBlock(ctx)
  const opening = history.length
    ? []
    : [{ role: 'user', content: `${context}\n\nAcknowledge nothing; wait for my question.` },
       { role: 'assistant', content: 'Ready.' }]

  const messages: unknown[] = [...history, ...opening, { role: 'user', content: question }]
  const tools: ToolRun[] = []
  const charts: ChartSpec[] = []
  const outputs: string[] = []
  let confirm: { reason: string } | null = null
  const usage: ChatUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

  for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
    const result = await streamTurn(messages, { signal, onEvent })
    messages.push({ role: 'assistant', content: result.content })

    usage.input += result.usage.input
    usage.output += result.usage.output
    usage.cacheRead += result.usage.cacheRead
    usage.cacheWrite += result.usage.cacheWrite

    const calls = result.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    )
    if (!calls.length) {
      const text = textOf(result.content)
      return {
        messages,
        text,
        tools,
        // If the model asked for a specific chart, that is what it wants shown; the ones the tools
        // drew for themselves would only duplicate it.
        charts: charts.some((c) => !c.auto) ? charts.filter((c) => !c.auto) : charts,
        confirm,
        usage,
        ungrounded: ungroundedFigures(text, [...priorOutputs, ...outputs, context]),
        outputs,
      }
    }

    // Every result goes back in ONE user message. Splitting them across several teaches the model
    // that parallel calls do not work, and it stops making them.
    const blocks = []
    for (const call of calls) {
      const out = await runTool(call.name, call.input, ctx)
      const run: ToolRun = { id: call.id, name: call.name, input: call.input, ok: !out.isError }
      tools.push(run)
      outputs.push(out.text)
      if (out.chart) charts.push(out.chart)
      if (out.confirm) confirm = out.confirm
      onTool?.(run)
      blocks.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: out.text,
        ...(out.isError ? { is_error: true } : {}),
      })
    }
    messages.push({ role: 'user', content: blocks })
  }

  throw new ChatError(`gave up after ${MAX_TOOL_TURNS} rounds of tool calls without reaching an answer`)
}
