import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const shared = resolve('src/shared')
const main = resolve('src/main')

export default defineConfig({
  main: {
    // better-sqlite3 is a native addon: it must stay external and be required
    // from node_modules at runtime, never bundled.
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@main': main } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      // A sandboxed renderer can only load a CommonJS preload, and this package
      // is ESM ("type": "module"), so pin the format explicitly.
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: { '@shared': shared, '@renderer': resolve('src/renderer/src') }
    },
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html') } } },
    plugins: [react()]
  }
})
