import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test builds a fresh in-process PGlite database and runs the real
    // migrations (~300–800ms). Under vitest's parallel workers the route suites
    // instantiate many of these at once, so a heavily-contended test can exceed
    // the 5s default even though it completes quickly in isolation. Give it
    // generous headroom so the gate is deterministic on busy machines/CI.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
