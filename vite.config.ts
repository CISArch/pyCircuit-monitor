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
export default defineConfig({
  plugins: [react(), autoPerfApiPlugin()],
})
