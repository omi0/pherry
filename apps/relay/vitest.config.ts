import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test stands up a real control plane over an in-process PGlite database
    // (the committed migrations run per test, ~300–800ms) plus, for the bridge
    // suite, a listening TCP relay. Give the gate generous headroom so it stays
    // deterministic on busy machines / CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
