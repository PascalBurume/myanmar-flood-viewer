import { useCallback, useEffect, useRef, useState } from 'react'

import { chatInfo, ChatError, type ChatUsage, type ServerInfo } from '../../chat/client'
import { runConversation, type ToolRun } from '../../chat/loop'
import { runTool, type ChartSpec, type ChatContext, type ToolName } from '../../chat/tools'
import type { ExplainRequest } from '../Panel'
import { renderMarkdown } from '../../chat/markdown'
import { ChatChart } from './ChatChart'

/** What the reader sees, as distinct from the wire history the model sees. */
interface Turn {
  role: 'you' | 'assistant'
  text: string
  tools?: ToolRun[]
  charts?: ChartSpec[]
  confirm?: { reason: string } | null
  ungrounded?: string[]
  error?: string
  /** The question that produced this turn, kept so a failed one can be retried. */
  asked?: string
}

/**
 * What the reader sees on a chip instead of the tool's internal name.
 *
 * Typed against `ToolName`, so adding a tool without adding its label is a compile error rather
 * than a raw `compare_places` appearing in someone's transcript. That shipped twice before this
 * type existed, because nothing objected either time.
 */
const TOOL_LABEL: Record<ToolName, string> = {
  list_datasets: 'dataset index',
  national_totals: 'nationwide totals',
  rank_places: 'worst-affected ranking',
  compare_places: 'compared with the worst',
  lookup_place: 'place lookup',
  flood_history: 'historical record',
  history_stats: 'trend summary',
  weather_forecast: 'rain & river forecast',
  pipeline_status: 'pipeline status',
  layer_reference: 'layer reference',
  inspect_map: 'read the map',
  query_location: 'checked that spot',
  set_layer_visibility: 'layer toggled',
  set_layer_opacity: 'layer opacity',
  set_dataset_visibility: 'dataset toggled',
  zoom_to_place: 'moved the map',
  zoom_to_dataset: 'moved the map',
  fit_all: 'zoomed out',
  set_basemap: 'basemap changed',
  set_rain_overlay: 'rainfall overlay',
  show_chart: 'drew a chart',
  request_pipeline_run: 'asked about updating',
  check_run_state: 'run state',
}

const SUGGESTIONS = [
  'How many people are exposed, and which regions are worst?',
  'Is this getting worse than previous years?',
  'Show me the Ayeyarwady river forecast',
  'Is this data up to date?',
]

/**
 * The assistant tab.
 *
 * Answers only from the data this viewer already holds. The grounding is enforced by the tool
 * envelopes and by a deterministic figure check, rather than by asking the model nicely — see
 * `chat/tools.ts` and `chat/context.ts`.
 */
export function Assistant({
  ctx,
  onRunPipeline,
  runBusy,
  picked,
  onClearPicked,
  explain,
}: {
  ctx: ChatContext
  onRunPipeline: () => void
  runBusy: boolean
  /** Where the reader last clicked on the map, so a question can be about "here". */
  picked: { lon: number; lat: number; label: string } | null
  onClearPicked: () => void
  /** A statistic the reader clicked in the panel, to be explained on arrival. */
  explain: ExplainRequest | null
}) {
  const [info, setInfo] = useState<ServerInfo | null | undefined>(undefined)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState('')
  const [activeTools, setActiveTools] = useState<ToolRun[]>([])
  const [usage, setUsage] = useState<ChatUsage | null>(null)
  /** The wire-shaped conversation. Kept in a ref: the model's copy is not render state. */
  const history = useRef<unknown[]>([])
  /** Every tool output this conversation has produced, for the grounding check. */
  const outputs = useRef<string[]>([])
  const abort = useRef<AbortController | null>(null)
  const log = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void chatInfo().then(setInfo)
  }, [])

  // Drop any request still running when this unmounts — on a reload or an HMR swap it would
  // otherwise keep streaming into a component that no longer exists, and keep billing for it.
  useEffect(() => () => abort.current?.abort(), [])


  // Follow the answer as it streams, the way a terminal would.
  useEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, streaming, activeTools])

  const ask = useCallback(
    /**
     * `displayAs` is what the reader sees in their own bubble, when that differs from what the model
     * is sent. A question assembled on their behalf — from a clicked statistic, say — carries
     * scaffolding the model needs and they should never have to read.
     */
    async (question: string, displayAs?: string) => {
      if (!question.trim() || busy) return
      setDraft('')
      setTurns((t) => [...t, { role: 'you', text: displayAs ?? question }])
      setBusy(true)
      setStreaming('')
      setActiveTools([])
      const controller = new AbortController()
      abort.current = controller
      // When a spot has been picked, look it up here and hand the model the answer with the
      // question, rather than hoping it calls query_location.
      //
      // Three rounds of prompting failed to make it prefer the point over the whole view — it kept
      // answering about the visible scene. Structure settles it: the reader asked about a place, so
      // what the map says at that place arrives with the question. Costs one local call and no
      // extra round trip.
      let withPlace = question
      let pickedOutput: string | null = null
      let probeRun: ToolRun | null = null
      if (picked) {
        const probe = await runTool('query_location', { lon: picked.lon, lat: picked.lat }, ctx)
        pickedOutput = probe.text
        // Shown as a chip like any other lookup. It happened on the reader's behalf, so it should
        // be as visible as one the model asked for — the transcript shows what was consulted.
        setActiveTools([{ id: 'picked', name: 'query_location', input: picked, ok: !probe.isError }])
        probeRun = { id: 'picked', name: 'query_location', input: picked, ok: !probe.isError }
        withPlace =
          `The reader is pointing at lon ${picked.lon}, lat ${picked.lat} (${picked.label}) and is asking about THAT SPOT, ` +
          `not the whole visible area. What the map reports there:\n\n${probe.text}\n\nTheir question: ${question}`
      }
      try {
        const result = await runConversation(history.current, withPlace, ctx, {
          signal: controller.signal,
          // The probe's figures are real tool output, so they must count as grounded.
          priorOutputs: pickedOutput ? [...outputs.current, pickedOutput] : outputs.current,
          onEvent: (e) => {
            if (e.type === 'text') setStreaming((s) => s + e.delta)
          },
          onTool: (run) => setActiveTools((t) => [...t, run]),
        })
        history.current = result.messages
        outputs.current = [...outputs.current, ...result.outputs]
        setUsage(result.usage)
        setTurns((t) => [
          ...t,
          {
            role: 'assistant',
            text: result.text,
            tools: probeRun ? [probeRun, ...result.tools] : result.tools,
            charts: result.charts,
            confirm: result.confirm,
            ungrounded: result.ungrounded,
          },
        ])
      } catch (err) {
        const message =
          err instanceof ChatError
            ? err.message
            : controller.signal.aborted
              ? 'stopped'
              : err instanceof Error
                ? err.message
                : String(err)
        // A 503 means the server itself cannot answer — no key, or it was restarted without one.
        // The capability probe only runs at mount, so without this the tab would go on offering a
        // composer that cannot work. Re-probe and let the panel fall through to the setup note,
        // which says what to actually do.
        const unconfigured = err instanceof ChatError && err.status === 503
        if (unconfigured) void chatInfo().then(setInfo)
        // Shown as a failed turn, never as an answer. A cut-off reply that looks finished is
        // exactly the thing this project exists not to do. `asked` is withheld when retrying
        // cannot possibly help — offering "try again" at something that always fails is worse
        // than offering nothing.
        setTurns((t) => [
          ...t,
          { role: 'assistant', text: '', error: message, asked: unconfigured ? undefined : question },
        ])
        // `asked` holds the full question, not the label, so Try again resends what the model needs.
      } finally {
        setStreaming('')
        setActiveTools([])
        setBusy(false)
        abort.current = null
      }
    },
    // `picked` belongs here: without it the callback closes over the value from the render that
    // created it — null, before the reader had clicked anything — and the point lookup never runs.
    [busy, ctx, picked],
  )

  /**
   * A statistic clicked in the panel becomes a question, once.
   *
   * Keyed by the request's own counter rather than its contents, so clicking the same figure twice
   * asks twice — and so this cannot re-fire when `ask` changes identity, which it does on every map
   * move because the tool context is one of its dependencies.
   */
  const lastExplained = useRef<number>(0)
  useEffect(() => {
    if (!explain || explain.id === lastExplained.current) return
    lastExplained.current = explain.id
    const facts = [
      `dataset: ${explain.dataset}`,
      `figure: ${explain.label} = ${explain.value.toLocaleString()}${explain.unit}`,
      `source: ${explain.source ?? 'none recorded'}`,
    ].join('\n')
    void ask(
      `The reader clicked this figure in the panel and wants it explained:\n\n${facts}\n\n` +
        `Their question: What does this number actually mean, where does it come from, and what should I be careful about when reading it?`,
      `Explain: ${explain.label} — ${explain.value.toLocaleString()}${explain.unit}`,
    )
  }, [explain, ask])

  if (info === undefined) return <p className="chat-note">Checking for a server…</p>

  if (info === null) {
    return (
      <p className="chat-note">
        The assistant needs the local server. This page is being served as static files, so there is
        nothing to send a question to. Run <code>npm start</code> and reload.
      </p>
    )
  }

  if (!info.configured) {
    return (
      <div className="chat">
        <p className="chat-note">
          The assistant is not configured on this server. Put <code>ANTHROPIC_API_KEY</code> in a{' '}
          <code>.env</code> file at the project root, or set it in the environment the server runs
          in, then restart it. Everything else in this viewer works without it.
        </p>
        {/* The conversation is kept rather than discarded. Losing what was already answered because
            the server was restarted underneath would be a second, avoidable annoyance. */}
        {turns.length ? (
          <div className="chat-log">
            {turns.map((turn, i) => (
              <div key={i} className={`chat-msg is-${turn.role}`}>
                {turn.error ? <p className="chat-error">{turn.error}</p> : renderMarkdown(turn.text)}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  const reset = () => {
    history.current = []
    outputs.current = []
    setTurns([])
    setUsage(null)
  }

  const chips = (tools: ToolRun[]) => (
    <div className="chat-tools">
      {tools.map((t, j) => (
        <span key={j} className={`chat-chip${t.ok ? '' : ' is-error'}`}>
          {/* `t.name` arrives from the model, so it is not guaranteed to be one we know. */}
          {TOOL_LABEL[t.name as ToolName] ?? t.name}
        </span>
      ))}
    </div>
  )

  return (
    <div className="chat">
      <div className="chat-log" ref={log}>
        <p className="chat-intro">
          Ask about the flood data on this map. Answers come only from the datasets this viewer
          holds, and every figure is cited with the date it was observed. Questions are sent to
          Anthropic's API to be answered.
        </p>

        {turns.map((turn, i) => (
          <div key={i} className={`chat-msg is-${turn.role}`}>
            {turn.tools?.length ? chips(turn.tools) : null}

            {turn.error ? (
              <p className="chat-error">
                {turn.error}
                {turn.asked ? (
                  <button type="button" className="chat-retry" onClick={() => void ask(turn.asked!)}>
                    Try again
                  </button>
                ) : null}
              </p>
            ) : (
              renderMarkdown(turn.text)
            )}

            {turn.charts?.map((spec, j) => (
              <ChatChart key={j} spec={spec} onZoom={ctx.actions.zoomTo} />
            ))}

            {/* A figure that appears in no tool result. Surfaced rather than trusted — this is a
                deterministic check, so it is the one claim here that cannot be talked around. */}
            {turn.ungrounded?.length ? (
              <p className="chat-error">
                {turn.ungrounded.length === 1 ? 'This figure does' : 'These figures do'} not appear in
                any data the assistant looked up: {turn.ungrounded.join(', ')}. Treat{' '}
                {turn.ungrounded.length === 1 ? 'it' : 'them'} with suspicion.
              </p>
            ) : null}

            {turn.confirm ? (
              <div className="chat-confirm">
                <p>{turn.confirm.reason}</p>
                <button
                  type="button"
                  className="mini-btn"
                  disabled={runBusy}
                  onClick={() => {
                    onRunPipeline()
                    void ask('I started a pipeline run just now.')
                  }}
                >
                  {runBusy ? 'Running…' : 'Run update now'}
                </button>
                <span className="chat-confirm-note">Takes about 40 seconds and calls live services.</span>
              </div>
            ) : null}
          </div>
        ))}

        {busy ? (
          <div className="chat-msg is-assistant">
            {activeTools.length ? chips(activeTools) : null}
            {streaming ? renderMarkdown(streaming) : <p className="chat-thinking">Working…</p>}
          </div>
        ) : null}

        {!turns.length && !busy ? (
          <div className="chat-suggest">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="mini-btn" onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {picked ? (
        <div className="chat-picked">
          <span>📍 {picked.label}</span>
          <code>
            {picked.lat}, {picked.lon}
          </code>
          <button type="button" onClick={onClearPicked} aria-label="Stop asking about this spot">
            ×
          </button>
        </div>
      ) : null}

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(draft)
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Escape abandons a running answer.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void ask(draft)
            } else if (e.key === 'Escape' && busy) {
              abort.current?.abort()
            }
          }}
          placeholder="Ask about the flood data…"
          rows={2}
          aria-label="Ask the assistant"
        />
        <button type="submit" className="mini-btn" disabled={busy || !draft.trim()}>
          {busy ? '…' : 'Ask'}
        </button>
      </form>

      {/* Announced once, on completion — not per token, which would make a screen reader unusable. */}
      <p className="chat-foot" aria-live="polite">
        {turns.length ? (
          <button type="button" className="chat-reset" onClick={reset} disabled={busy}>
            New conversation
          </button>
        ) : null}
        {info.model} · effort {info.effort}
        {usage ? (
          <>
            {' · '}
            {(usage.input + usage.cacheRead).toLocaleString()} in / {usage.output.toLocaleString()} out
            {/* Zero cache reads across turns means a silent invalidator and full price every time. */}
            {usage.cacheRead ? ` · ${usage.cacheRead.toLocaleString()} cached` : ' · uncached'}
          </>
        ) : null}
      </p>
    </div>
  )
}
