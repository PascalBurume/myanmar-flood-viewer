/**
 * Reading the update pipeline's state.
 *
 * status.json is the single source of truth. The pipeline records everything it did — every stage,
 * its outcome, duration and detail, plus which machine ran it — so the orchestration tree can be
 * drawn with no external service involved.
 *
 * This once also read the GitHub Actions API for run state. That tied the viewer to one vendor for
 * something the pipeline can simply write down, so it was removed along with the rest of the GitHub
 * integration. A run on a laptop and a run on a server now produce identical evidence.
 */

/** The whole vocabulary — mirrors STATES in scripts/status.py. */
export type SourceState = 'ok' | 'changed' | 'skipped' | 'failed'

export interface StatusSource {
  label: string
  state: SourceState
  checkedAt?: string | null
  sourceUrl?: string
  probe?: string
  detail?: string
  datasets?: Record<string, { sha256?: string; size?: number; features?: Record<string, number> }>
  added?: string[]
  unknownLayers?: string[]
  event?: { id?: string; effective?: string; cleared?: string; peopleTotal?: number }
}

/** One stage the pipeline ran, as recorded by scripts/run_pipeline.py. */
export interface StageRecord {
  key: string
  label: string
  state: SourceState
  detail?: string
  startedAt?: string
  seconds?: number
}

export type Severity = 'critical' | 'warning' | 'info'

export interface Alert {
  kind: string
  severity: Severity
  title: string
  detail: string
  source?: string
  date?: string
  people?: number
}

export interface AlertBlock {
  items: Alert[]
  counts: Record<Severity, number>
  /** Thresholds, not verdicts — applied to `generatedAt` at read time. See `freshness()`. */
  freshness: { runHours: number; dataHours: number }
}

export interface StatusDoc {
  schema: number
  generatedAt: string
  run: {
    id: string | null
    number: string | null
    /** Only set when the runner was GitHub Actions; a link, never the source of truth. */
    url: string | null
    trigger: string
    /** 'github-actions' or 'local:<host>' — which machine produced this. */
    runner?: string
    startedAt?: string | null
    seconds?: number | null
    conclusion: SourceState
    /** The orchestration tree. Present for any run; needs no external API to render. */
    stages?: StageRecord[]
  }
  scanUntil: string | null
  sources: Record<string, StatusSource>
  index: { updated?: string; extraUpdated?: string; datasetIds: string[] }
  alerts?: AlertBlock
  previous?: {
    generatedAt?: string
    run?: { id?: string | null; url?: string | null; conclusion?: string }
    indexUpdated?: string
    datasets?: Record<string, { sha256?: string; features?: Record<string, number> }>
    adamEvent?: string
  }
}

/**
 * Load the published status. Never throws: a 404 means this build predates the status file, which
 * is information to show, not a reason to take the viewer down.
 */
export async function loadStatus(base: string): Promise<StatusDoc | null> {
  try {
    const res = await fetch(`${base}data/status.json`, { cache: 'no-store' })
    if (!res.ok) return null
    const doc = (await res.json()) as StatusDoc
    return doc && doc.schema === 1 ? doc : null
  } catch {
    return null
  }
}

// ---- diffing ----

export interface DatasetChange {
  id: string
  kind: 'added' | 'removed' | 'changed'
  before?: Record<string, number>
  after?: Record<string, number>
}

/**
 * What moved between the previous run and this one, from the pipeline's own record.
 * Compared against whichever source records per-dataset feature counts.
 */
export function diffDatasets(status: StatusDoc): DatasetChange[] {
  const before = status.previous?.datasets ?? {}
  const after = status.sources.unosat?.datasets ?? {}
  const ids = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: DatasetChange[] = []
  for (const id of [...ids].sort()) {
    const b = before[id]
    const a = after[id]
    if (!b && a) out.push({ id, kind: 'added', after: a.features })
    else if (b && !a) out.push({ id, kind: 'removed', before: b.features })
    else if (b && a && JSON.stringify(b.features) !== JSON.stringify(a.features)) {
      out.push({ id, kind: 'changed', before: b.features, after: a.features })
    }
  }
  return out
}

/**
 * How long ago the pipeline last reported in, in hours. The cron runs every 12 h, so anything past
 * ~26 h means two scheduled runs were missed and the schedule itself is suspect.
 */
export function hoursSince(iso: string | undefined | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : (Date.now() - t) / 3_600_000
}

/**
 * Fallback only. The real threshold travels in `status.json` (`alerts.freshness.runHours`), written
 * by `scripts/alerts.py`, so the server's `/api/health` and this page cannot disagree about what
 * counts as stale. This value applies only when the file predates that field.
 */
export const STALE_AFTER_HOURS = 26

// ---- the local server (optional) ----
//
// The page works as plain static files; when it happens to be served by server/index.mjs it gains
// a real trigger. Everything here degrades to "no server" rather than erroring, so the same build
// works in both situations.

export interface RunState {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  lines: string[]
  trigger: string | null
}

/**
 * Is this page being served by our Node server, rather than a plain file server?
 *
 * Any HTTP answer means yes — including **503**, which `/api/health` returns when the pipeline is
 * unwell. Reading `res.ok` here was a real bug: a failed or stale run made the server look absent
 * and took the "Run update now" button away at exactly the moment it was needed. Only a network
 * error, or a static host answering 404 for an endpoint it has never heard of, means no server.
 */
export async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch('api/health', { cache: 'no-store' })
    return res.status !== 404
  } catch {
    return false
  }
}

export async function pollRun(): Promise<RunState | null> {
  try {
    const res = await fetch('api/run', { cache: 'no-store' })
    return res.ok ? ((await res.json()) as RunState) : null
  } catch {
    return null
  }
}

export async function startRun(): Promise<{ ok: true; run: RunState } | { ok: false; error: string }> {
  try {
    const res = await fetch('api/run', { method: 'POST' })
    const body = await res.json()
    // 409 (already running) and 429 (cooldown) are normal answers, not faults — the server is
    // telling us what it is already doing.
    if (!res.ok) return { ok: false, error: String(body.error ?? `server returned ${res.status}`) }
    return { ok: true, run: body as RunState }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Is the pipeline itself still running?
 *
 * Computed here, in the reader, and never read out of the file. A status file cannot record its own
 * staleness — it goes stale by sitting still, long after it was written. Baking a verdict in would
 * produce a page cheerfully reporting "up to date" off a pipeline that died a week ago, which is
 * precisely the blind spot this whole design exists to close. So the file carries the threshold and
 * the clock is consulted here, on every render.
 */
export function freshness(status: StatusDoc | null): {
  stale: boolean
  ageHours: number | null
  maxHours: number
  label: string
} {
  const maxHours = status?.alerts?.freshness?.runHours ?? STALE_AFTER_HOURS
  if (!status?.generatedAt) return { stale: true, ageHours: null, maxHours, label: 'never run' }
  const ageHours = (Date.now() - Date.parse(status.generatedAt)) / 3_600_000
  const label =
    ageHours < 1
      ? `${Math.max(1, Math.round(ageHours * 60))} min ago`
      : ageHours < 48
        ? `${Math.round(ageHours)} h ago`
        : `${Math.round(ageHours / 24)} days ago`
  return { stale: ageHours > maxHours, ageHours, maxHours, label }
}

/** Alerts to show, including the staleness one that only the reader can raise. */
export function liveAlerts(status: StatusDoc | null): Alert[] {
  if (!status) return []
  const items = [...(status.alerts?.items ?? [])]
  const f = freshness(status)
  if (f.stale) {
    items.unshift({
      kind: 'stale',
      severity: 'critical',
      title: 'The pipeline has not run recently',
      detail:
        f.ageHours === null
          ? 'No run has ever completed here, so nothing below has been checked.'
          : `Last run ${f.label} (${Math.round(f.ageHours)} h), past the ${f.maxHours} h ` +
            'threshold. Everything below may be out of date, including the "all quiet" verdict.',
    })
  }
  return items
}

// ---- live run progress ----

export interface RunStep {
  key: string
  /** Short, for the node under the track — "FloodAI exposure". */
  label: string
  /** The stage's own full name, for the detail card — "UNOSAT FloodAI — nationwide exposure". */
  title?: string
  /** 'pending' until the pipeline reaches it; then whatever it reports. */
  state: 'pending' | 'running' | SourceState
  detail?: string
  seconds?: number
}

/**
 * Node captions, keyed by stage.
 *
 * A finished run's `status.json` carries each stage's full label, which is the right thing in a log
 * and far too long under a 74px node — "UNOSAT FloodAI — nationwide exposure" wraps to four lines
 * and the track stops being readable. The short form is only ever a caption; the full label is
 * still shown in the detail card, so nothing is lost.
 */
const SHORT_LABEL: Record<string, string> = {
  gate: 'Scan window',
  unosat: 'UNOSAT extents',
  floodai: 'FloodAI exposure',
  adam: 'WFP ADAM impact',
  history: 'Flood history',
  weather: 'Rain & rivers',
  publish: 'Build & publish',
  commit: 'Commit data',
  status: 'Write status',
}

/**
 * Turn a run's stdout into an ordered list of steps.
 *
 * The pipeline announces its plan before it starts and then marks each stage as it begins and ends
 * (`[[plan]]` / `[[stage]]` in `scripts/run_pipeline.py`). Reading those rather than guessing from
 * prose means the drawn steps come from the process actually doing the work — a stage added to the
 * pipeline appears here with no change to this file, and one that is skipped is still drawn rather
 * than silently missing.
 *
 * Falls back to an empty list when there is no plan line yet, so a page that connects mid-run shows
 * the log rather than a confidently wrong diagram.
 */
export function parseRunProgress(lines: string[]): RunStep[] {
  const plan = lines.filter((l) => l.startsWith('[[plan]] ')).pop()
  if (!plan) return []

  const steps: RunStep[] = plan
    .slice('[[plan]] '.length)
    .split('|')
    .map((part) => {
      const i = part.indexOf(':')
      return { key: part.slice(0, i), label: part.slice(i + 1), state: 'pending' as const }
    })
    .filter((s) => s.key)

  for (const line of lines) {
    if (!line.startsWith('[[stage]] ')) continue
    const [key, state, ...rest] = line.slice('[[stage]] '.length).split(' ')
    const step = steps.find((s) => s.key === key)
    if (!step) continue
    if (state === 'running') {
      step.state = 'running'
      step.title = rest.join(' ').trim() || step.title
      continue
    }
    step.state = state as SourceState
    // The finish marker leads with the duration, then whatever detail the stage recorded.
    const secs = rest[0]?.endsWith('s') ? Number.parseFloat(rest[0]) : undefined
    step.seconds = Number.isFinite(secs) ? secs : undefined
    step.detail = (secs === undefined ? rest : rest.slice(1)).join(' ').trim() || undefined
  }
  return steps
}

/** The plan as recorded in a finished run's status, so the same stepper can draw a past run. */
export function stepsFromStatus(status: StatusDoc | null): RunStep[] {
  return (status?.run.stages ?? []).map((st) => ({
    key: st.key,
    label: SHORT_LABEL[st.key] ?? st.label,
    title: st.label,
    state: st.state,
    detail: st.detail,
    seconds: st.seconds,
  }))
}
