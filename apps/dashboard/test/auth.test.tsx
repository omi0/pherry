import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigErrorCard, DevTokenProvider, chooseAuthSeam, useAuth } from '../src/auth'

const STORAGE_KEY = 'pherry.dev-token'

/** A child that only renders once the seam has an identity — the gate's inside. */
function Probe(): ReactNode {
  const { identity, mode, signOut } = useAuth()
  return (
    <div>
      <span>mode:{mode}</span>
      <span>id:{identity?.label}</span>
      <button type="button" onClick={signOut}>
        out
      </button>
      <span>SECRET-CONTENT</span>
    </div>
  )
}

describe('DevTokenProvider (auth seam)', () => {
  afterEach(() => {
    sessionStorage.clear()
  })

  it('gates content behind a pasted token and round-trips through sessionStorage', async () => {
    const user = userEvent.setup()
    render(
      <DevTokenProvider>
        <Probe />
      </DevTokenProvider>,
    )

    // Signed out: the card is shown, the gated content is not.
    expect(screen.queryByText('SECRET-CONTENT')).toBeNull()
    expect(screen.getByText(/Dev sign-in/)).toBeDefined()

    await user.type(screen.getByPlaceholderText('paste a human token'), 'ct_pasted_token')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    // Signed in: the content and the dev-token identity appear.
    expect(screen.getByText('SECRET-CONTENT')).toBeDefined()
    expect(screen.getByText('mode:dev-token')).toBeDefined()
    expect(screen.getByText('id:Dev session')).toBeDefined()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('ct_pasted_token')
  })

  it('restores a stored token on mount', () => {
    sessionStorage.setItem(STORAGE_KEY, 'ct_prior')
    render(
      <DevTokenProvider>
        <Probe />
      </DevTokenProvider>,
    )
    expect(screen.getByText('SECRET-CONTENT')).toBeDefined()
  })

  it('signOut clears the token and re-gates', async () => {
    const user = userEvent.setup()
    sessionStorage.setItem(STORAGE_KEY, 'ct_prior')
    render(
      <DevTokenProvider>
        <Probe />
      </DevTokenProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'out' }))

    expect(screen.queryByText('SECRET-CONTENT')).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(screen.getByText(/Dev sign-in/)).toBeDefined()
  })
})

describe('chooseAuthSeam (fail-closed seam selection)', () => {
  it('picks clerk whenever a publishable key is configured', () => {
    expect(chooseAuthSeam({ clerkKey: 'pk_live_x', isProduction: false })).toBe('clerk')
    expect(chooseAuthSeam({ clerkKey: 'pk_live_x', isProduction: true })).toBe('clerk')
  })

  it('keeps the dev-token form in a dev/local build with no key', () => {
    expect(chooseAuthSeam({ clerkKey: undefined, isProduction: false })).toBe('dev-token')
  })

  it('blocks a production build with no key rather than falling back to dev-token', () => {
    expect(chooseAuthSeam({ clerkKey: undefined, isProduction: true })).toBe('blocked')
  })
})

describe('ConfigErrorCard (production fail-closed state)', () => {
  it('renders a hard, unrecoverable error and no dev-token paste field', () => {
    render(<ConfigErrorCard />)
    expect(screen.getByRole('alert')).toBeDefined()
    expect(
      screen.getByText(/refusing to run in dev-token mode in a production build/),
    ).toBeDefined()
    expect(screen.queryByPlaceholderText('paste a human token')).toBeNull()
  })
})
