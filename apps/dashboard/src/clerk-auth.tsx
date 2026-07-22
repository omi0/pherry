/**
 * The Clerk implementation of the auth seam — deliberately isolated in its own module
 * so `auth.tsx` can `lazy`-load it. A clerk-less build never executes this code, and
 * no test path imports it: Clerk lives here and nowhere else in the dashboard.
 *
 * It wires a `ClerkProvider`, shows Clerk's hosted `SignIn` when signed out, and — when
 * signed in — bridges Clerk's `useAuth`/`useUser` into the seam's {@link Auth} shape.
 */
import {
  ClerkProvider,
  SignIn,
  SignedIn,
  SignedOut,
  useAuth as useClerkAuth,
  useUser,
} from '@clerk/clerk-react'
import { type ReactNode, useMemo } from 'react'
import { type Auth, AuthContext } from './auth'

/** The Clerk-backed provider. Default export so `auth.tsx` can `lazy(() => import())` it. */
export default function ClerkAuthProvider({
  publishableKey,
  children,
}: {
  publishableKey: string
  children: ReactNode
}): ReactNode {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <SignedOut>
        <div className="signin-shell">
          <SignIn routing="virtual" />
        </div>
      </SignedOut>
      <SignedIn>
        <ClerkBridge>{children}</ClerkBridge>
      </SignedIn>
    </ClerkProvider>
  )
}

/** Bridge Clerk's signed-in session into the seam's {@link Auth} value. */
function ClerkBridge({ children }: { children: ReactNode }): ReactNode {
  const { getToken, signOut } = useClerkAuth()
  const { user } = useUser()

  const value = useMemo<Auth>(() => {
    const label =
      user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? user?.username ?? 'Signed in'
    return {
      mode: 'clerk',
      getToken: () => getToken(),
      identity: { label },
      signOut: () => {
        void signOut()
      },
    }
  }, [getToken, signOut, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
