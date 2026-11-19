// Minimal zero-dependency production server for pyCircuit-monitor.
// Serves the built SPA from dist/ and delegates every /api/autoperf/* route
// to the shared middleware in server/api.ts (same code path as the vite
// dev/preview server). Static-file serving stays local to this file.
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { autoPerfApi } from '../server/api.ts'

const PORT = Number(process.env.PORT || 4173)
const DIST = resolve(process.env.DIST_DIR || 'dist')
const LOG_ROOT = resolve(process.env.AUTO_PERF_LOG_DIR || '/data/auto_perf_logs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

const api = autoPerfApi({ logRoot: LOG_ROOT })

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname)
  if (rel.endsWith('/')) rel += 'index.html'
  const full = resolve(DIST, '.' + (rel.startsWith('/') ? rel : '/' + rel))
  if (!full.startsWith(DIST + sep)) { res.writeHead(403); return res.end('forbidden') }
  if (!existsSync(full) || !statSyncIsFile(full)) {
    // SPA fallback
    const index = join(DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return createReadStream(index).pipe(res)
  }
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(full)
  res.writeHead(200, {
    'Content-Type': MIME[extname(full)] || 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(full).pipe(res)
}

function statSyncIsFile(p) { try { return statSync(p).isFile() } catch { return false } }

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/api/')) {
    return api(req, res, () => {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  }
  serveStatic(req, res, url.pathname)
}).listen(PORT, () => console.log(`pycircuit-monitor serving ${DIST} + logs ${LOG_ROOT} on :${PORT}`))