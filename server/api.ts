// Shared auto_perf API middleware — used by the vite dev/preview server
// (vite.config.ts) and the production server (docker/serve.mjs). Node-only
// built-ins, zero npm dependencies. All task paths are validated to stay
// under the configured log root.
//
// Endpoints under /api/autoperf/:
//   GET tasks                      task list + result.json summary (cached 3s)
//   GET task?name=<dir>            full result.json + execution.log tail + files
//   GET log?task=<dir>&path=<rel>  raw text of a .log/.txt/.json/.csv file
//   GET health                     proxy of the auto_perf bot /api/health
//   GET queue                      pending/running rows from the state DB (optional)
//   GET file|head|count            .mlir access for the IR graph view
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, open as openFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface AutoPerfApiOptions {
  /** task log root (task-* dirs); default env AUTO_PERF_LOG_DIR or /tmp/auto_perf_logs */
  logRoot?: string
  /** auto_perf bot base URL for the health proxy; default env AUTO_PERF_API_BASE */
  apiBase?: string
  /** optional sqlite state DB for queue details; default env AUTO_PERF_STATE_DB */
  stateDb?: string
}

type Next = () => void
type Middleware = (req: any, res: any, next: Next) => void

function geomean(xs: number[]): number | null {
  if (!xs.length) return null
  let s = 0
  for (const x of xs) s += Math.log(x)
  return Math.exp(s / xs.length)
}

function tsFromTaskName(name: string): string | null {
  const m = /^task-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\d+Z-/.exec(name)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`
}

async function findMlirFiles(dir: string, base: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) await findMlirFiles(join(dir, e.name), rel, out, depth + 1)
    else if (e.name.endsWith('.mlir')) out.push(rel)
  }
}

function summarizeResult(result: any): Record<string, unknown> {
  const rows: any[] = Array.isArray(result?.rows) ? result.rows : []
  const cps: number[] = []
  const pv: number[] = []
  let matchN = 0
  for (const r of rows) {
    if (typeof r?.cycles_per_s === 'number' && r.cycles_per_s > 0) cps.push(r.cycles_per_s)
    if (typeof r?.pycircuit_to_verilator_ratio === 'number' && r.pycircuit_to_verilator_ratio > 0) {
      pv.push(r.pycircuit_to_verilator_ratio)
    }
    if (r?.common_metrics_match) matchN++
  }
  return {
    status: result?.status ?? null,
    stage: result?.stage ?? null,
    error: result?.error || null,
    branch: result?.branch ?? null,
    sha: result?.sha ?? null,
    author: result?.author ?? null,
    commitUrl: result?.commit_url ?? null,
    gmCps: geomean(cps),
    gmPV: geomean(pv),
    matchN,
    rowN: rows.length,
    totalSeconds: typeof result?.total_seconds === 'number' ? result.total_seconds : null,
    compileSeconds: typeof result?.compile_seconds === 'number' ? result.compile_seconds : null,
    matrixSeconds: typeof result?.matrix_seconds === 'number' ? result.matrix_seconds : null,
    areaTop: result?.area_top ?? null,
  }
}

/** Read the last ~64KB of a file and return its final `maxLines` lines. */
async function tailLines(path: string, maxBytes = 65536, maxLines = 200): Promise<string> {
  try {
    const fh = await openFile(path, 'r')
    try {
      const st = await fh.stat()
      const len = Math.min(maxBytes, st.size)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, st.size - len)
      const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n')
      while (lines.length > maxLines) lines.shift()
      return lines.join('\n')
    } finally {
      await fh.close()
    }
  } catch {
    return ''
  }
}

export function autoPerfApi(opts: AutoPerfApiOptions = {}): Middleware {
  const logRoot = resolve(opts.logRoot ?? process.env.AUTO_PERF_LOG_DIR ?? '/tmp/auto_perf_logs')
  const apiBase = (
    opts.apiBase ?? process.env.AUTO_PERF_API_BASE ?? 'http://127.0.0.1:8790'
  ).replace(/\/$/, '')
  const stateDbRaw =
    opts.stateDb ?? process.env.AUTO_PERF_STATE_DB ?? '~/.local/state/auto-perf/state.sqlite3'
  const stateDb = stateDbRaw.startsWith('~')
    ? join(homedir(), stateDbRaw.slice(1))
    : stateDbRaw

  const json = (res: any, code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(body))
  }

  /** Resolve a (task, rel path) pair under the log root; null on escape. */
  const safePath = (task: string, file: string): string | null => {
    const base = resolve(logRoot, task)
    const full = resolve(base, file)
    if (!full.startsWith(logRoot + sep)) return null
    if (full !== base && !full.startsWith(base + sep)) return null
    return full
  }

  // ---- caches -------------------------------------------------------------
  const TASKS_TTL_MS = 3000
  let tasksCache: { at: number; body: any } | null = null
  let tasksInflight: Promise<any> | null = null

  async function computeTasks(): Promise<any> {
    const tasks: any[] = []
    let entries: string[] = []
    try {
      entries = await readdir(logRoot)
    } catch {
      /* root missing */
    }
    for (const name of entries.filter((e) => e.startsWith('task-')).sort().reverse()) {
      const dir = join(logRoot, name)
      const st = await stat(dir).catch(() => null)
      if (!st?.isDirectory()) continue
      const files: string[] = []
      await findMlirFiles(dir, '', files)
      const task: any = {
        name,
        mtime: st.mtimeMs,
        ts: tsFromTaskName(name),
        files,
      }
      const resultFile = join(dir, 'result.json')
      const rstat = await stat(resultFile).catch(() => null)
      if (rstat?.isFile()) {
        try {
          const parsed = JSON.parse(await readFile(resultFile, 'utf-8'))
          Object.assign(task, { hasResult: true }, summarizeResult(parsed))
        } catch {
          task.hasResult = false
        }
      }
      if (!task.hasResult) {
        // no result.json yet: expose log freshness so the UI can show a
        // live-updating running task
        const lg = await stat(join(dir, 'execution.log')).catch(() => null)
        task.hasResult = false
        task.logSize = lg?.size ?? 0
        task.logMtime = lg?.mtimeMs ?? null
      }
      tasks.push(task)
    }
    return { root: logRoot, tasks }
  }

  function getTasks(): Promise<any> {
    const now = Date.now()
    if (tasksCache && now - tasksCache.at < TASKS_TTL_MS) return Promise.resolve(tasksCache.body)
    if (tasksInflight) return tasksInflight
    tasksInflight = computeTasks()
      .then((body) => {
        tasksCache = { at: Date.now(), body }
        return body
      })
      .finally(() => {
        tasksInflight = null
      })
    return tasksInflight
  }

  const HEALTH_TTL_MS = 3000
  let healthCache: { at: number; body: any } | null = null

  async function computeHealth(): Promise<any> {
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 2500)
      try {
        const r = await fetch(`${apiBase}/api/health`, { signal: ac.signal })
        if (!r.ok) return { ok: false, error: 'bot HTTP ' + r.status }
        const d = (await r.json()) as any
        return { ok: true, counts: d.counts ?? {} }
      } finally {
        clearTimeout(timer)
      }
    } catch (e: any) {
      return { ok: false, error: String(e?.cause?.code ?? e?.message ?? e) }
    }
  }

  function getHealth(): Promise<any> {
    const now = Date.now()
    if (healthCache && now - healthCache.at < HEALTH_TTL_MS) return Promise.resolve(healthCache.body)
    const p = computeHealth().then((body) => {
      healthCache = { at: Date.now(), body }
      return body
    })
    return p
  }

  // The bot's state DB is a WAL database on a read-only mount: opening it
  // in place succeeds but the first prepare() fails (SQLite wants to create
  // -shm). Copy db + sidecars to a writable temp dir (≈15ms for 23MB) and
  // read the copy.
  async function withStateDb<T>(fn: (db: any) => T): Promise<T> {
    const { DatabaseSync } = await import('node:sqlite')
    const { mkdir, copyFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = join(tmpdir(), 'pycircuit-monitor-state')
    await mkdir(dir, { recursive: true })
    const copy = join(dir, 'state.sqlite3')
    await copyFile(stateDb, copy)
    for (const suffix of ['-wal', '-shm']) {
      try {
        await copyFile(stateDb + suffix, copy + suffix)
      } catch {
        await rm(copy + suffix, { force: true })
      }
    }
    const db = new DatabaseSync(copy, { timeout: 2000 } as any)
    try {
      return fn(db)
    } finally {
      db.close()
    }
  }

  async function readQueueRows(): Promise<any> {
    return withStateDb((db) =>
      db
        .prepare(
          `SELECT delivery_id, branch, sha, status, created_at, started_at
           FROM tasks WHERE status IN ('pending','running') ORDER BY id`,
        )
        .all(),
    )
  }

  async function computeQueue(): Promise<any> {
    const file = await stat(stateDb).catch(() => null)
    if (!file?.isFile()) return { available: false, stateDb }
    try {
      return { available: true, rows: await readQueueRows() }
    } catch (e: any) {
      // transient inconsistency between db and -wal copies: retry once
      try {
        await new Promise((r) => setTimeout(r, 120))
        return { available: true, rows: await readQueueRows() }
      } catch (e2: any) {
        return { available: false, stateDb, error: String(e2?.message ?? e2) }
      }
    }
  }

  // ---- /best: the Feishu bot's 最佳 view ----------------------------------
  // For every remote branch at its current head SHA, take the newest finished
  // task at that exact SHA and average its rows (arithmetic mean, same as
  // feishu._average_metrics), sorted by P/V ratio desc; untested branches last.
  const BEST_TTL_MS = 10000
  let bestCache: { at: number; body: any } | null = null
  let bestInflight: Promise<any> | null = null

  async function computeBest(): Promise<any> {
    const file = await stat(stateDb).catch(() => null)
    if (!file?.isFile()) return { available: false, stateDb }
    return withStateDb((db) => {
      const refs = db.prepare('SELECT branch, sha FROM remote_refs ORDER BY branch').all() as any[]
      const pick = db.prepare(
        `SELECT id, status, finished_at, started_at, result_json FROM tasks
         WHERE branch = ? AND sha = ? AND status IN ('pass','partial','fail','timeout')
         ORDER BY id DESC LIMIT 1`,
      )
      const mean = (rows: any[], key: string, skip?: string): number | null => {
        const vals: number[] = []
        for (const r of rows) {
          if (skip && r?.[skip]) continue
          const v = r?.[key]
          if (typeof v === 'number' && isFinite(v)) vals.push(v)
        }
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
      }
      const entries = refs.map((ref: any) => {
        const rec = pick.get(ref.branch, ref.sha) as any
        if (!rec) return { branch: ref.branch, sha: ref.sha, tested: false }
        let result: any = null
        try { result = JSON.parse(rec.result_json) } catch { /* ignore */ }
        const tr = Array.isArray(result?.rows) ? result.rows : []
        const anyDiff = tr.some((r: any) => r && r.common_metrics_match === false)
        return {
          branch: ref.branch,
          sha: ref.sha,
          tested: true,
          status: rec.status,
          finishedAt: rec.finished_at,
          startedAt: rec.started_at,
          pycircuit: mean(tr, 'cycles_per_s', 'error'),
          verilator: mean(tr, 'verilator_cycles_per_s', 'verilator_error'),
          ratio: mean(tr, 'pycircuit_to_verilator_ratio'),
          matchN: tr.filter((r: any) => r?.common_metrics_match === true).length,
          rowN: tr.length,
          mismatch: anyDiff,
          totalSeconds: typeof result?.total_seconds === 'number' ? result.total_seconds : null,
          taskDir: String(result?.local_log_dir ?? '').split('/').pop() || null,
        }
      })
      const rank = (e: any) =>
        e.tested ? (e.ratio == null ? Number.MAX_SAFE_INTEGER - 1 : -e.ratio) : Number.MAX_SAFE_INTEGER
      entries.sort((a: any, b: any) => rank(a) - rank(b) || String(a.branch).localeCompare(String(b.branch)))
      return {
        available: true,
        generatedAt: new Date().toISOString(),
        total: entries.length,
        tested: entries.filter((e: any) => e.tested).length,
        entries,
      }
    })
  }

  function getBest(): Promise<any> {
    const now = Date.now()
    if (bestCache && now - bestCache.at < BEST_TTL_MS) return Promise.resolve(bestCache.body)
    if (bestInflight) return bestInflight
    bestInflight = computeBest()
      .then((body) => { bestCache = { at: Date.now(), body }; return body })
      .finally(() => { bestInflight = null })
    return bestInflight
  }

  const QUEUE_TTL_MS = 3000
  let queueCache: { at: number; body: any } | null = null
  let queueInflight: Promise<any> | null = null

  function getQueue(): Promise<any> {
    const now = Date.now()
    if (queueCache && now - queueCache.at < QUEUE_TTL_MS) return Promise.resolve(queueCache.body)
    if (queueInflight) return queueInflight
    queueInflight = computeQueue()
      .then((body) => { queueCache = { at: Date.now(), body }; return body })
      .finally(() => { queueInflight = null })
    return queueInflight
  }

  return function autoPerfHandler(req: any, res: any, next: Next): void {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/autoperf/')) return next()

    if (url.pathname === '/api/autoperf/tasks') {
      void getTasks().then((body) => json(res, 200, body))
      return
    }

    if (url.pathname === '/api/autoperf/health') {
      void getHealth().then((body) => json(res, 200, body))
      return
    }

    if (url.pathname === '/api/autoperf/queue') {
      void getQueue().then((body) => json(res, 200, body))
      return
    }

    if (url.pathname === '/api/autoperf/best') {
      void getBest()
        .then((body) => json(res, 200, body))
        .catch((e) => json(res, 200, { available: false, error: String(e?.message ?? e) }))
      return
    }

    if (url.pathname === '/api/autoperf/task') {
      const name = url.searchParams.get('name') ?? ''
      const dir = safePath(name, '')
      if (!dir) return json(res, 403, { error: 'path escapes log root' })
      void (async () => {
        const st = await stat(dir).catch(() => null)
        if (!st?.isDirectory()) return json(res, 404, { error: 'unknown task' })
        const files: string[] = []
        await findMlirFiles(dir, '', files)
        let entries: string[] = []
        try {
          entries = (await readdir(dir)).filter((e) => e !== 'pass_ir')
        } catch {
          /* ignore */
        }
        let result: any = null
        try {
          result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf-8'))
        } catch {
          /* not finished yet */
        }
        const lg = await stat(join(dir, 'execution.log')).catch(() => null)
        const logTail = await tailLines(join(dir, 'execution.log'))
        json(res, 200, {
          name,
          ts: tsFromTaskName(name),
          result,
          summary: result ? summarizeResult(result) : null,
          logTail,
          logSize: lg?.size ?? 0,
          logMtime: lg?.mtimeMs ?? null,
          files,
          entries,
        })
      })()
      return
    }

    if (url.pathname === '/api/autoperf/log') {
      const task = url.searchParams.get('task') ?? ''
      const file = url.searchParams.get('path') ?? ''
      const full = safePath(task, file)
      if (!full) return json(res, 403, { error: 'path escapes log root' })
      if (!/\.(log|txt|json|jsonl|csv)$/.test(full)) {
        return json(res, 400, { error: 'only .log/.txt/.json/.jsonl/.csv files' })
      }
      const CAP = 8 * 1024 * 1024
      const pageRaw = url.searchParams.get('page')
      const pageSize = Math.min(Math.max(Number(url.searchParams.get('lines')) || 100, 20), 500)
      void (async () => {
        try {
          const st = await stat(full)
          if (!st.isFile()) return json(res, 404, { error: 'not a file' })
          const fh = await openFile(full, 'r')
          try {
            const len = Math.min(CAP, st.size)
            const buf = Buffer.alloc(len)
            const { bytesRead } = await fh.read(buf, 0, len, st.size - len)
            const text = buf.subarray(0, bytesRead).toString('utf-8')
            const truncated = st.size > CAP
            if (pageRaw !== null) {
              // paginated mode: page is 1-based, or "last" for the newest page;
              // pages are counted over the (up to 8MB) tail window
              const all = text.length ? text.split('\n') : []
              if (all.length > 1 && all[all.length - 1] === '') all.pop()
              const totalPages = Math.max(1, Math.ceil(all.length / pageSize))
              const page =
                pageRaw === 'last' ? totalPages : Math.min(Math.max(Number(pageRaw) || 1, 1), totalPages)
              const start = (page - 1) * pageSize
              return json(res, 200, {
                path: file,
                size: st.size,
                truncated,
                totalLines: all.length,
                totalPages,
                page,
                pageSize,
                startLine: start + 1,
                lines: all.slice(start, start + pageSize),
              })
            }
            // legacy full-text mode
            return json(res, 200, { path: file, size: st.size, truncated, text })
          } finally {
            await fh.close()
          }
        } catch (e) {
          json(res, 404, { error: String(e) })
        }
      })()
      return
    }

    if (url.pathname === '/api/autoperf/count') {
      // pre-fetch estimate: SSA-def count + largest single function, streamed
      // server-side so the client can skip oversized dumps without downloading
      const task = url.searchParams.get('task') ?? ''
      const file = url.searchParams.get('path') ?? ''
      const full = safePath(task, file)
      if (!full) return json(res, 403, { error: 'path escapes log root' })
      if (!full.endsWith('.mlir')) return json(res, 400, { error: 'only .mlir files' })
      void (async () => {
        try {
          const st = await stat(full)
          let ops = 0, cur = 0, maxOps = 0, maxFunc: string | null = null, curFunc: string | null = null, rem = '', combDepth = 0
          const braces = (line: string) => (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
          const onLine = (line: string) => {
            if (combDepth > 0) { combDepth += braces(line); return } // comb region: whole comb = 1 node (rendered collapsed)
            const f = /func\.func\s+@([\w.$-]+)/.exec(line)
            if (f) {
              if (curFunc && cur > maxOps) { maxOps = cur; maxFunc = curFunc }
              curFunc = f[1]; cur = 0
            } else if (/^\s*%[\w.$-]+(:\d+)?\s*=\s*pyc\.comb\b/.test(line)) {
              cur++; ops++; combDepth = braces(line)
            } else if (/^\s*%[\w.$-]+(:\d+)?\s*=/.test(line) && !/^\s*%[\w.$-]+(:\d+)?\s*=\s*pyc\.(wire|alias)\b/.test(line)) { cur++; ops++ }
          }
          for await (const chunk of createReadStream(full, 'utf8')) {
            const lines = (rem + chunk).split('\n')
            rem = lines.pop() ?? ''
            for (const line of lines) onLine(line)
          }
          if (rem) onLine(rem)
          if (curFunc && cur > maxOps) { maxOps = cur; maxFunc = curFunc }
          json(res, 200, { bytes: st.size, ops, maxOps, maxFunc })
        } catch (e) {
          json(res, 404, { error: String(e) })
        }
      })()
      return
    }

    if (url.pathname === '/api/autoperf/file' || url.pathname === '/api/autoperf/head') {
      const task = url.searchParams.get('task') ?? ''
      const file = url.searchParams.get('path') ?? ''
      const full = safePath(task, file)
      if (!full) return json(res, 403, { error: 'path escapes log root' })
      if (!full.endsWith('.mlir')) return json(res, 400, { error: 'only .mlir files' })
      if (url.pathname === '/api/autoperf/head') {
        // read only the first N bytes (module-name detection needs just the head)
        const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 1200, 1), 4096)
        openFile(full, 'r').then(async (fh) => {
          try {
            const buf = Buffer.alloc(n)
            const { bytesRead } = await fh.read(buf, 0, n, 0)
            json(res, 200, { path: file, text: buf.subarray(0, bytesRead).toString('utf-8') })
          } finally { await fh.close() }
        }).catch((e) => json(res, 404, { error: String(e) }))
        return
      }
      // Stream the {"path":...,"text":"..."} body instead of readFile+JSON.stringify:
      // a 60MB pass-IR dump buffered as a JS string plus its JSON copy peaks far
      // above the 128M container cap and OOM-kills the server.
      stat(full)
        .then(() => {
          const dec = new TextDecoder()
          const escRe = /["\\\x00-\x1f]/g
          const esc = (s: string) => s.replace(escRe, (c) => JSON.stringify(c).slice(1, -1))
          const encoder = new Transform({
            transform(chunk: any, _enc: any, cb: (err: any, v?: any) => void) {
              cb(null, esc(dec.decode(chunk, { stream: true })))
            },
            flush(cb: (err: any, v?: any) => void) {
              cb(null, esc(dec.decode()) + '"}')
            },
          })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.write('{"path":' + JSON.stringify(file) + ',"text":"')
          pipeline(createReadStream(full), encoder as any, res).catch(() => {
            res.destroy() // headers already sent; truncate so the client fails fast
          })
        })
        .catch((e) => json(res, 404, { error: String(e) }))
      return
    }

    json(res, 404, { error: 'not found' })
  }
}
