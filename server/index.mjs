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
 * Binds to 127.0.0.1 by default. `POST /api/run` executes a pipeline on this machine, so it is not
 * something to expose to a network without putting authentication in front of it.
 *
 *   node server/index.mjs
 *   PORT=8080 HOST=0.0.0.0 PUBLISH_DIR=/var/www/flood node server/index.mjs
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const PORT = Number(process.env.PORT ?? 5180)
const HOST = process.env.HOST ?? '127.0.0.1'
/** Where the built site lives. `npm run build` writes dist/; --publish writes wherever you point it. */
const SITE_DIR = resolve(process.env.SITE_DIR ?? join(ROOT, 'dist'))
/** Status is read from the source tree so it is current even when the site has not been rebuilt. */
const STATUS_FILE = join(ROOT, 'public', 'data', 'status.json')

/** Minimum gap between runs. The pipeline hits third-party APIs; this stops a stuck reload loop
 *  from hammering them, and makes an accidental double-click harmless. */
const COOLDOWN_MS = 30_000

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
  // Data changes on every pipeline run; hashed assets never change under the same name.
  const cache = file.includes(`${SITE_DIR}/assets/`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
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
      running: current.state === 'running',
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

  if (path.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' })

  return serveStatic(req, res, path)
})

server.listen(PORT, HOST, () => {
  console.log(`flood viewer  http://${HOST}:${PORT}`)
  console.log(`  serving     ${SITE_DIR}`)
  console.log(`  status      ${STATUS_FILE}`)
  console.log(`  publish dir ${process.env.PUBLISH_DIR ?? '(not set — POST /api/run will not publish)'}`)
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('\n  WARNING: bound beyond localhost. POST /api/run executes a pipeline on this')
    console.log('  machine and has no authentication. Put a reverse proxy with auth in front of it.')
  }
})
