import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Declared locally rather than pulling in @types/node. This config is the only place the project
// touches a Node global, and one line beats a dependency.
declare const process: { env: Record<string, string | undefined> }

// Where the site will be served from. Vite bakes this into every asset URL, so it has to match how
// the web server exposes the site or nothing loads.
//   unset             a domain root — the default, and what a self-hosted site normally is
//   BASE_PATH=/flood/ served under a sub-path
const BASE_PATH = process.env.BASE_PATH

export default defineConfig(() => ({
  plugins: [react()],
  base: BASE_PATH ?? '/',
  server: {
    port: 5175,
    strictPort: true,
    // When WSL watches files on the Windows side (/mnt/c), inotify events never arrive, so the
    // dev server keeps serving stale output after an edit. Fall back to polling.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  // main.ts loads the basemap style with a top-level await, which needs ES2022
  build: {
    target: 'es2022',
  },
  define: {
    __BUILD_TIME__: JSON.stringify(
      new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    ),
  },
}))
