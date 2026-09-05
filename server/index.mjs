#!/usr/bin/env node
/**
 * The local server for the flood viewer.
 *
 * Serves the built site and gives the page the one thing a static file cannot: a way to actually
 * run the pipeline. Until now the panel could only print the command and ask you to type it in a
 * terminal, because there was nothing on the other end to accept a request.
 *
 * Zero dependencies, by design. The Python side of this project is standard-library only for the
 * same reason — a tool that has to keep working unattended for months is better with nothing to
 * update than with a framework to keep patched.
 *
 * Binds to 127.0.0.1 by default, and two endpoints are the reason that matters. `POST /api/run`
 * executes a pipeline on this machine. `POST /api/chat` relays to the Anthropic API using the
 * operator's own API key, so anything that can reach it can spend money. Neither has any
 * authentication of its own; the loopback bind is the whole security model.
 *
 *   node server/index.mjs
 *   PORT=8080 HOST=0.0.0.0 PUBLISH_DIR=/var/www/flood node server/index.mjs
 *   ANTHROPIC_API_KEY=sk-... node server/index.mjs     # enables the panel assistant
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))

/**
 * Load `.env` from the project root, if there is one.
 *
 * Eight lines rather than a dotenv dependency, and it exists for one reason: the assistant needs an
 * API key, and "export it in your shell every time" is a recipe for it eventually being pasted
 * somewhere that gets committed. A gitignored file is the safer habit.
 *
 * A real environment variable always wins, so a systemd `EnvironmentFile=` or a one-off
 * `ANTHROPIC_API_KEY=... npm start` still overrides whatever is in the file. Runs before anything
 * below reads `process.env`.
 */
// No .env is the normal case, not an error — the file is optional and the server runs without it.
let dotenv = ''
try {
  dotenv = readFileSync(join(ROOT, '.env'), 'utf8')
} catch {
  /* nothing to load */
}
for (const line of dotenv.split('\n').filter((l) => /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(l))) {
  const i = line.indexOf('=')
  const key = line.slice(0, i).trim()
  // Strip one layer of quotes, which people add out of habit and which would otherwise become part
  // of the value and produce a baffling 401.
  const value = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  if (!(key in process.env)) process.env[key] = value
}

const PORT = Number(process.env.PORT ?? 5180)
const HOST = process.env.HOST ?? '127.0.0.1'
/** Where the built site lives. `npm run build` writes dist/; --publish writes wherever you point it. */
const SITE_DIR = resolve(process.env.SITE_DIR ?? join(ROOT, 'dist'))
/** Status is read from the source tree so it is current even when the site has not been rebuilt. */
const STATUS_FILE = join(ROOT, 'public', 'data', 'status.json')

/** Minimum gap between runs. The pipeline hits third-party APIs; this stops a stuck reload loop
 *  from hammering them, and makes an accidental double-click harmless. */
const COOLDOWN_MS = 30_000

// ---- the panel assistant -------------------------------------------------------------------
//
// This server is a thin, stateless proxy: it holds the API key and pins everything about the
// request except the conversation itself. The tool-calling loop runs in the browser, because the
// tools that move the map are browser state and the analysis they call is the same TypeScript the
// panel uses — a second implementation here would be free to disagree with what the reader sees.
//
// The one rule that keeps this a proxy rather than an open relay: `messages` is the ONLY thing
// accepted from the caller. Everything else is pinned below. Anything reaching this endpoint can
// spend the operator's money, so the allowlist is not a formality.

/**
 * Where to send chat requests.
 *
 * `ANTHROPIC_BASE_URL` is a convention the Anthropic SDKs and CLI already use, and it holds a
 * **base**, not an endpoint — someone with it exported for other tooling would otherwise silently
 * have this server POST to the API root and get a bodyless 404 back. So the path is appended here,
 * and a value that already carries it is left alone.
 *
 * Read from this server's own environment, never from a request: a client-supplied endpoint would
 * be a way to redirect the operator's key somewhere else.
 */
function messagesUrl(base) {
  if (!base) return 'https://api.anthropic.com/v1/messages'
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/v1/messages') ? trimmed : `${trimmed}/v1/messages`
}

const ANTHROPIC_URL = messagesUrl(process.env.ANTHROPIC_BASE_URL)
const ANTHROPIC_VERSION = '2023-06-01'

/** Pinned. The only model this server ever names — cost is why it is a Sonnet. */
const CHAT_MODEL = 'claude-sonnet-5'
/** A ceiling, not a spend: only generated tokens are billed. Sized so adaptive thinking cannot eat
 *  the whole budget and leave a truncated answer, which is billed in full and has to be retried. */
const CHAT_MAX_TOKENS = 16_384
const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CHAT_EFFORT = CHAT_EFFORTS.includes(process.env.CHAT_EFFORT ?? '')
  ? process.env.CHAT_EFFORT
  : 'medium'
/** A twelve-turn conversation with capped tool results runs 60-100 KB of JSON. */
const CHAT_MAX_BODY = 256 * 1024
const CHAT_MAX_MESSAGES = 60
// There is deliberately NO minimum gap between chat requests, unlike POST /api/run's cooldown.
// The tool loop is a chain of requests within one answer, and because every tool reads data the
// browser already has, the next request follows in single-digit milliseconds. A 500ms gate looked
// harmless and broke every question that needed a tool — which is nearly all of them. Concurrency
// is already bounded by `chatBusy`, and spend by the hourly cap; a gap timer adds nothing but a
// way to fail.
const CHAT_MAX_PER_HOUR = 120
/** The guard, not a preference. The client has its own cap; only this one cannot be edited away. */
const CHAT_MAX_TOOL_TURNS = 12
const CHAT_BLOCK_TYPES = new Set(['text', 'tool_use', 'tool_result', 'thinking'])

/** Chat is serialised like runs are, which also caps how fast the key can be spent. */
let chatBusy = false
/** Rolling hour of request timestamps. A runaway loop is the real cost risk here. */
let chatRecent = []

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * The state of the one run this server allows at a time. Concurrent pipeline runs would race on
 * the same files — two processes writing status.json and swapping the site directory — so runs are
 * serialised rather than queued.
 */
let current = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  lines: [],
  trigger: null,
}

/**
 * Read a JSON request body.
 *
 * The first body reader in this project — every other endpoint takes what it needs from the query
 * string. The size cap is checked twice on purpose: once against the declared content-length, which
 * is cheap, and again against what actually arrives, because the header is the caller's claim and
 * not a fact.
 */
async function readJson(req, limit) {
  const type = req.headers['content-type'] ?? ''
  if (!type.startsWith('application/json')) {
    throw Object.assign(new Error('expected content-type: application/json'), { code: 415 })
  }
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) {
    throw Object.assign(new Error(`request body over ${Math.floor(limit / 1024)} KB`), { code: 413 })
  }
  req.setTimeout(10_000)
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    // Stop reading rather than politely draining a body that is already too big.
    if (size > limit) {
      req.destroy()
      throw Object.assign(new Error(`request body over ${Math.floor(limit / 1024)} KB`), { code: 413 })
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { code: 400 })
  }
}

/**
 * Refuse a cross-origin request.
 *
 * There are deliberately no CORS headers anywhere in this file, and there must never be: an
 * `Access-Control-Allow-Origin` on an endpoint that carries an API key is the single most damaging
 * line anyone could add here. This is the other half — a same-origin check for requests that carry
 * an Origin at all. It also closes a real hole on POST /api/run, which a cross-site form could
 * otherwise trigger without a preflight.
 */
function crossOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return new URL(origin).host !== req.headers.host
  } catch {
    return true
  }
}

/**
 * Validate the one thing the client is allowed to send.
 *
 * Returns the messages array or throws. `role: 'system'` is rejected rather than passed through:
 * Sonnet 5 does not accept mid-conversation system messages anyway, but on a model that did they
 * would be an operator-authority channel open to anything that can reach this port.
 */
function validateMessages(body) {
  const keys = Object.keys(body ?? {})
  const extra = keys.filter((k) => k !== 'messages')
  if (extra.length) {
    throw Object.assign(new Error(`only 'messages' is accepted; got ${extra.join(', ')}`), { code: 400 })
  }
  const messages = body?.messages
  if (!Array.isArray(messages) || !messages.length || messages.length > CHAT_MAX_MESSAGES) {
    throw Object.assign(new Error(`messages must be an array of 1-${CHAT_MAX_MESSAGES} entries`), { code: 400 })
  }
  let toolTurns = 0
  for (const m of messages) {
    if (!m || typeof m !== 'object') throw Object.assign(new Error('each message must be an object'), { code: 400 })
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw Object.assign(new Error(`message role must be user or assistant; got ${JSON.stringify(m.role)}`), { code: 400 })
    }
    if (typeof m.content === 'string') continue
    if (!Array.isArray(m.content)) {
      throw Object.assign(new Error('message content must be a string or an array of blocks'), { code: 400 })
    }
    let onlyToolResults = m.content.length > 0
    for (const b of m.content) {
      if (!b || !CHAT_BLOCK_TYPES.has(b.type)) {
        throw Object.assign(new Error(`unsupported content block ${JSON.stringify(b?.type)}`), { code: 400 })
      }
      // A caller could otherwise pin an hour-long cache entry on every block.
      delete b.cache_control
      if (b.type !== 'tool_result') onlyToolResults = false
    }
    // A user turn made only of tool results is the loop talking to itself, not a person.
    if (m.role === 'user') toolTurns = onlyToolResults ? toolTurns + 1 : 0
  }
  if (toolTurns > CHAT_MAX_TOOL_TURNS) {
    throw Object.assign(new Error(`tool loop too long (over ${CHAT_MAX_TOOL_TURNS} turns)`), { code: 400 })
  }
  return messages
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function startRun(args, trigger) {
  current = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    lines: [],
    trigger,
  }

  const publishDir = process.env.PUBLISH_DIR
  const argv = ['scripts/run_pipeline.py', ...args]
  if (publishDir) argv.push('--publish', publishDir)

  const child = spawn('python3', argv, { cwd: ROOT })
  const push = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) current.lines.push(line)
    }
    // A runaway process must not grow this without bound.
    if (current.lines.length > 500) current.lines = current.lines.slice(-500)
  }
  child.stdout.on('data', push)
  child.stderr.on('data', push)
  child.on('close', (code) => {
    current.running = false
    current.exitCode = code
    current.finishedAt = new Date().toISOString()
  })
  child.on('error', (err) => {
    current.running = false
    current.exitCode = -1
    current.finishedAt = new Date().toISOString()
    current.lines.push(`failed to start python3: ${err.message}`)
  })
  return current
}

async function serveStatic(req, res, urlPath) {
  // Resolve inside SITE_DIR and verify, so a path like /../../etc/passwd cannot escape.
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '')
  let file = resolve(join(SITE_DIR, rel))
  if (!file.startsWith(SITE_DIR)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info) {
    // Deliberately no single-page fallback. This app has no client-side routing, and serving
    // index.html for a missing file would hand the viewer HTML where it asked for JSON — surfacing
    // as "Unexpected token '<'" instead of the 404 its loaders already handle cleanly.
    const hint =
      rel === 'index.html' || rel === ''
        ? `Nothing built yet. Run:  npm run build\n(looked in ${SITE_DIR})`
        : `Not found: ${urlPath}`
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(hint)
    return
  }

  const ext = extname(file).toLowerCase()
  // Data changes on every pipeline run; hashed assets never change under the same name. Forecast
  // field runs are the one exception under /data: a run directory is written once and deleted
  // when it ages out, never rewritten, so its frames can be cached forever — the timeline's
  // preload would otherwise warm nothing, and every scrub would refetch. The manifest that lists
  // the runs stays no-cache.
  const immutable =
    file.includes(`${SITE_DIR}/assets/`) ||
    /\/data\/field\/[^/]+\/[^/]+\/[^/]+$/.test(file.slice(SITE_DIR.length))
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cache,
  })
  createReadStream(file).pipe(res)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Health is answered from disk on every request, never from a cached verdict. A process that
  // decided it was healthy at startup would keep saying so while the pipeline behind it died —
  // which is the failure this endpoint exists to catch. Suitable for a systemd `ExecStartPre`
  // probe, an uptime monitor, or `watch curl`.
  if (path === '/api/health') {
    const body = await readFile(STATUS_FILE, 'utf8').catch(() => null)
    let status = null
    try {
      status = body ? JSON.parse(body) : null
    } catch {
      /* a truncated status file is a fault, not a crash — reported as one below */
    }

    const generatedAt = status?.generatedAt ?? null
    const ageHours = generatedAt ? (Date.now() - Date.parse(generatedAt)) / 3_600_000 : null
    const maxAge = status?.alerts?.freshness?.runHours ?? 48
    const critical = status?.alerts?.counts?.critical ?? 0

    // Distinguish "the pipeline is unwell" from "this server is unwell". The server answering at
    // all proves the second; only the file can speak to the first.
    const faults = []
    if (!body) faults.push('no status file: the pipeline has never completed a run here')
    else if (!status) faults.push('status file is not valid JSON')
    else if (ageHours !== null && ageHours > maxAge)
      faults.push(`last run was ${ageHours.toFixed(1)}h ago, over the ${maxAge}h threshold`)
    if (status?.run?.conclusion === 'failed') faults.push('the last run concluded failed')

    return json(res, faults.length ? 503 : 200, {
      ok: faults.length === 0,
      serverUptimeSeconds: Math.round(process.uptime()),
      pipeline: {
        lastRunAt: generatedAt,
        ageHours: ageHours === null ? null : Number(ageHours.toFixed(2)),
        maxAgeHours: maxAge,
        conclusion: status?.run?.conclusion ?? null,
        runner: status?.run?.runner ?? null,
        criticalAlerts: critical,
      },
      running: current.running,
      // Reported, never a fault. The assistant is optional; a viewer with no key is a healthy
      // viewer, and a 503 here would devalue the one signal worth alerting on externally.
      chat: { configured: Boolean(process.env.ANTHROPIC_API_KEY), model: CHAT_MODEL },
      faults,
      siteDir: SITE_DIR,
      publishDir: process.env.PUBLISH_DIR ?? null,
    })
  }

  if (path === '/api/status') {
    const body = await readFile(STATUS_FILE, 'utf8').catch(() => null)
    if (!body) return json(res, 404, { error: 'no status file yet; run the pipeline once' })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(body)
  }

  // The live state of a run, polled by the page while one is in progress.
  if (path === '/api/run' && req.method === 'GET') {
    return json(res, 200, current)
  }

  if (path === '/api/run' && req.method === 'POST') {
    // A cross-site form POST is a simple request: no preflight, and it would start a pipeline.
    if (crossOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })
    if (current.running) {
      // Not an error the user needs to fix — just say what is already happening.
      return json(res, 409, { error: 'a run is already in progress', run: current })
    }
    const since = current.finishedAt ? Date.now() - Date.parse(current.finishedAt) : Infinity
    if (since < COOLDOWN_MS) {
      return json(res, 429, {
        error: `wait ${Math.ceil((COOLDOWN_MS - since) / 1000)}s before running again`,
        run: current,
      })
    }
    const force = url.searchParams.get('force') === '1'
    return json(res, 202, startRun(force ? ['--force'] : [], 'web'))
  }

  // The assistant's capability probe. Reports whether a key is configured — never the key, nor a
  // prefix, a length or a hash of it. This rides its own path rather than a field on /api/health
  // because it is the one path the dev server proxies.
  if (path === '/api/chat' && req.method === 'GET') {
    return json(res, 200, {
      available: true,
      configured: Boolean(process.env.ANTHROPIC_API_KEY),
      model: CHAT_MODEL,
      effort: CHAT_EFFORT,
      maxToolTurns: CHAT_MAX_TOOL_TURNS,
      maxBodyBytes: CHAT_MAX_BODY,
    })
  }

  if (path === '/api/chat' && req.method === 'POST') {
    if (crossOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' })

    const key = process.env.ANTHROPIC_API_KEY
    if (!key) {
      return json(res, 503, {
        error: 'the assistant is not configured on this server (ANTHROPIC_API_KEY is not set)',
      })
    }
    if (chatBusy) return json(res, 409, { error: 'a chat request is already in progress' })

    const now = Date.now()
    chatRecent = chatRecent.filter((t) => now - t < 3_600_000)
    if (chatRecent.length >= CHAT_MAX_PER_HOUR) {
      res.setHeader('retry-after', '600')
      return json(res, 429, {
        error: `hourly cap of ${CHAT_MAX_PER_HOUR} chat requests reached`,
        retryAfterSeconds: 600,
      })
    }

    let messages
    try {
      messages = validateMessages(await readJson(req, CHAT_MAX_BODY))
    } catch (err) {
      return json(res, err.code ?? 400, { error: err.message })
    }

    // Read per request rather than at startup, so editing the prompt needs no restart — the same
    // reason /api/health re-reads the status file every time.
    let system, tools
    try {
      system = await readFile(join(ROOT, 'src', 'chat', 'system.md'), 'utf8')
      tools = JSON.parse(await readFile(join(ROOT, 'src', 'chat', 'tools.json'), 'utf8'))
      if (Array.isArray(tools.tools)) tools = tools.tools
    } catch (err) {
      return json(res, 500, { error: `assistant prompt or tools missing: ${err.message}` })
    }

    chatBusy = true
    chatRecent.push(now)

    const controller = new AbortController()
    // Without this, closing the tab leaves the upstream request running and billing.
    req.on('close', () => controller.abort())
    // Time to first byte only. Replaced by an idle watchdog below, because a whole-request timeout
    // would kill a legitimately long answer in the middle of streaming it.
    let timer = setTimeout(() => controller.abort(), 30_000)

    try {
      const upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': 'task-budgets-2026-03-13',
          'user-agent': 'myanmar-flood-viewer/1.0 (panel assistant)',
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          max_tokens: CHAT_MAX_TOKENS,
          stream: true,
          // display:'summarized' is deliberate — the default omits the text, which reads as a long
          // silent pause in a streaming UI.
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: {
            effort: CHAT_EFFORT,
            // Advisory, unlike max_tokens: the model sees a countdown and finishes gracefully
            // rather than being cut off.
            task_budget: { type: 'tokens', total: 20_000 },
          },
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          tools,
          messages,
        }),
      })

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '')
        let message = detail.slice(0, 500)
        try {
          message = JSON.parse(detail)?.error?.message ?? message
        } catch {
          /* not JSON; the raw text is more use than nothing */
        }
        const retryAfter = upstream.headers.get('retry-after')
        if (retryAfter) res.setHeader('retry-after', retryAfter)
        // Loopback, and the reader is the operator paying the bill — "your key is out of credit"
        // is exactly what they need to see.
        return json(res, upstream.status, { error: message })
      }

      // The first streaming response in this codebase. No content-length, so it cannot use json().
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        // nginx buffers by default, which would deliver the whole stream at once and reproduce the
        // exact problem streaming was added to solve.
        'x-accel-buffering': 'no',
      })
      res.flushHeaders()

      clearTimeout(timer)
      // Idle watchdog: refreshed per chunk, so a long answer survives but a dead connection does not.
      timer = setTimeout(() => controller.abort(), 60_000)

      // Passed through verbatim. This server does not parse Anthropic's event vocabulary, for the
      // same reason it does not parse the pipeline's [[stage]] markers: the client owns semantics.
      for await (const chunk of upstream.body) {
        res.write(chunk)
        timer.refresh()
      }
      return res.end()
    } catch (err) {
      const message = controller.signal.aborted ? 'the assistant timed out' : err.message
      // Once the stream has begun the status is already sent and cannot be changed. The client
      // treats a stream that ends without message_stop as a failure — an answer that stops early
      // must never look finished.
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
        return res.end()
      }
      return json(res, 504, { error: message })
    } finally {
      clearTimeout(timer)
      chatBusy = false
    }
  }

  if (path.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' })

  return serveStatic(req, res, path)
})

server.listen(PORT, HOST, () => {
  console.log(`flood viewer  http://${HOST}:${PORT}`)
  console.log(`  serving     ${SITE_DIR}`)
  console.log(`  status      ${STATUS_FILE}`)
  console.log(`  publish dir ${process.env.PUBLISH_DIR ?? '(not set — POST /api/run will not publish)'}`)
  console.log(
    `  assistant   ${process.env.ANTHROPIC_API_KEY ? `${CHAT_MODEL}, effort ${CHAT_EFFORT}` : '(disabled — ANTHROPIC_API_KEY not set)'}`,
  )
  if (process.env.ANTHROPIC_API_KEY && ANTHROPIC_URL !== 'https://api.anthropic.com/v1/messages') {
    console.log(`  endpoint    ${ANTHROPIC_URL}  (from ANTHROPIC_BASE_URL)`)
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('\n  WARNING: bound beyond localhost, with no authentication on either endpoint that')
    console.log('  matters. POST /api/run executes a pipeline on this machine.')
    if (process.env.ANTHROPIC_API_KEY) {
      console.log('  POST /api/chat spends your Anthropic API key — anything that can reach this port')
      console.log('  can run up a bill against it.')
    }
    console.log('  Put a reverse proxy with auth in front of it.')
  }
})
