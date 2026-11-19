import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { autoPerfApi } from './server/api.ts'

// auto_perf log/task API (task summaries, result details, live health, IR
// file access). Shared with the production server in docker/serve.mjs.
function autoPerfApiPlugin(): Plugin {
  const middleware = autoPerfApi()
  return {
    name: 'auto-perf-api',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

// https://vite.dev/config/
// Build stamp in UTC+8 (docker builds run in UTC) shown in the top nav so
// stale tabs are easy to spot.
const buildStamp = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 16)

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildStamp),
  },
  plugins: [react(), autoPerfApiPlugin()],
})
