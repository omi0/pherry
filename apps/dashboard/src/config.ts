/**
 * Runtime configuration, read defensively from Vite's `import.meta.env` so a build
 * with **no** env vars set still succeeds and the app boots against local defaults.
 *
 * - `VITE_API_URL` — the control plane's base URL (default `http://127.0.0.1:3000`).
 * - `VITE_CLERK_PUBLISHABLE_KEY` — when present, the auth seam runs in `clerk` mode;
 *   absent, it falls back to the dev-token paste form.
 */

/** The resolved dashboard configuration. */
export interface DashboardConfig {
  /** The control-plane base URL the API client talks to. */
  readonly apiUrl: string
  /** The Clerk publishable key, or `undefined` to run the dev-token seam. */
  readonly clerkPublishableKey: string | undefined
}

/** Read one `VITE_*` var, treating an empty string as absent. */
function readEnv(key: string): string | undefined {
  const env = import.meta.env as Record<string, string | undefined> | undefined
  const value = env?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The single resolved config, evaluated once at module load. */
export const config: DashboardConfig = {
  apiUrl: readEnv('VITE_API_URL') ?? 'http://127.0.0.1:3000',
  clerkPublishableKey: readEnv('VITE_CLERK_PUBLISHABLE_KEY'),
}
