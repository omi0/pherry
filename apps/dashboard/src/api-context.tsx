/**
 * The API context — bridges the auth seam's `getToken` into a {@link DashboardApi}
 * bound to the configured base URL, and hands it to the views via {@link useApi}.
 * Tests inject a fake `DashboardApi` straight into {@link ApiContext}.
 */
import { type ReactNode, createContext, useContext, useMemo } from 'react'
import { type DashboardApi, createApi } from './api'
import { useAuth } from './auth'
import { config } from './config'

/** The shared API context; `null` until a provider supplies a client. */
export const ApiContext = createContext<DashboardApi | null>(null)

/** Build the real client from `config.apiUrl` + the auth seam's token source. */
export function ApiProvider({ children }: { children: ReactNode }): ReactNode {
  const { getToken } = useAuth()
  const api = useMemo(() => createApi({ apiUrl: config.apiUrl, getToken }), [getToken])
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
}

/** Read the API client. Throws if used outside a provider. */
export function useApi(): DashboardApi {
  const api = useContext(ApiContext)
  if (api === null) throw new Error('useApi must be used within an ApiProvider')
  return api
}
