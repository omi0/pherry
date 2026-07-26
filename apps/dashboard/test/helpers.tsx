/** Shared test harness: fake API, fake auth seam, and a provider-wrapped render. */
import { type RenderResult, render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import type { DashboardApi } from '../src/api'
import { ApiContext } from '../src/api-context'
import { type Auth, AuthContext } from '../src/auth'

/** A rejecting stub for an API method not wired by a given test. */
function notStubbed(name: string): () => Promise<never> {
  return vi.fn(async () => {
    throw new Error(`${name} was called but not stubbed`)
  })
}

/** Build a fake {@link DashboardApi}; every method is a `vi.fn`, overridable per test. */
export function makeFakeApi(overrides: Partial<DashboardApi> = {}): DashboardApi {
  return {
    me: overrides.me ?? notStubbed('me'),
    listHosts: overrides.listHosts ?? notStubbed('listHosts'),
    pairHost: overrides.pairHost ?? notStubbed('pairHost'),
    revokeHost: overrides.revokeHost ?? notStubbed('revokeHost'),
    listSessions: overrides.listSessions ?? notStubbed('listSessions'),
    listDevices: overrides.listDevices ?? notStubbed('listDevices'),
    revokeDevice: overrides.revokeDevice ?? notStubbed('revokeDevice'),
    listAttention: overrides.listAttention ?? notStubbed('listAttention'),
    listAudit: overrides.listAudit ?? notStubbed('listAudit'),
    ackAttention: overrides.ackAttention ?? notStubbed('ackAttention'),
    describeCliAuth: overrides.describeCliAuth ?? notStubbed('describeCliAuth'),
    approveCliAuth: overrides.approveCliAuth ?? notStubbed('approveCliAuth'),
  }
}

/** Build a fake {@link Auth} seam value (dev-token mode by default). */
export function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    mode: overrides.mode ?? 'dev-token',
    getToken: overrides.getToken ?? (async () => 'test-token'),
    identity: overrides.identity !== undefined ? overrides.identity : { label: 'Tester' },
    signOut: overrides.signOut ?? vi.fn(),
  }
}

/** Options for {@link renderWithProviders}. */
export interface RenderOptions {
  api?: DashboardApi
  auth?: Auth
  /** The initial router entry (default `/`). */
  route?: string
  /** When set, wrap `ui` in a `<Route path>` so `useParams` resolves. */
  path?: string
}

/** Render `ui` inside the router + fake auth + fake API providers. */
export function renderWithProviders(ui: ReactElement, opts: RenderOptions = {}): RenderResult {
  const api = opts.api ?? makeFakeApi()
  const auth = opts.auth ?? fakeAuth()
  const route = opts.route ?? '/'
  const inner =
    opts.path !== undefined ? (
      <Routes>
        <Route path={opts.path} element={ui} />
      </Routes>
    ) : (
      ui
    )
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <ApiContext.Provider value={api}>{inner}</ApiContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}
