/** Vitest setup: unmount the React tree after each test so nothing (timers, effects) lingers. */
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
