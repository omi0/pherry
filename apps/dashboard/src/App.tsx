/**
 * The app root: router → auth seam → API provider → routes. The auth seam gates every
 * route behind sign-in, so both `/` and `/cli-auth/:requestId` get the sign-in surface
 * first when signed out, then their content.
 */
import type { ReactNode } from 'react'
import { Navigate, Route, BrowserRouter as Router, Routes } from 'react-router-dom'
import { ApiProvider } from './api-context'
import { AuthProvider } from './auth'
import { CliAuthPage } from './routes/CliAuth'
import { Console } from './routes/Console'

/** The composed application. */
export function App(): ReactNode {
  return (
    <Router>
      <AuthProvider>
        <ApiProvider>
          <Routes>
            <Route path="/" element={<Console />} />
            <Route path="/cli-auth/:requestId" element={<CliAuthPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ApiProvider>
      </AuthProvider>
    </Router>
  )
}
