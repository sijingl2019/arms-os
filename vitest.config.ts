import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@main': r('./src/main'),
      // The brain's maths lives in the renderer but is plain TypeScript, so it
      // is unit-tested here alongside the main-process modules.
      '@renderer': r('./src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
