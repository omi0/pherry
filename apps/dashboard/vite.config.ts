/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The dashboard is a static SPA: `vite build` must succeed with no env vars set
// (runtime config is read defensively from import.meta.env). Tests run in jsdom
// against a fake API + fake auth — never a network, never Clerk.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
})
