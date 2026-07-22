/** Two small hooks the views share: a one-shot loader and a self-clearing interval. */
import { useCallback, useEffect, useRef, useState } from 'react'

/** The state of a {@link useLoad} call. */
export interface Loadable<T> {
  /** The loaded value, or `null` before the first success. */
  data: T | null
  /** The last rejection, or `null`. */
  error: unknown
  /** True while a load is in flight. */
  loading: boolean
  /** Re-run the loader. */
  reload: () => void
}

/**
 * Run `load` on mount and whenever `deps` change, exposing `{ data, error, loading,
 * reload }`. A superseded or unmounted load is ignored (no state after unmount, so no
 * spinner-forever and no act warnings). `reload()` forces a re-run.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: caller owns `deps`; `load` is re-created each render on purpose.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    load().then(
      (result) => {
        if (cancelled) return
        setData(result)
        setError(null)
        setLoading(false)
      },
      (err) => {
        if (cancelled) return
        setError(err)
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [...deps, nonce])

  return { data, error, loading, reload }
}

/**
 * Call `callback` every `ms`. Passing `null` for `ms` pauses it. The latest callback
 * is always used without resetting the timer, and the interval is cleared on unmount
 * so nothing lingers after a test tears the tree down.
 */
export function useInterval(callback: () => void, ms: number | null): void {
  const saved = useRef(callback)
  useEffect(() => {
    saved.current = callback
  }, [callback])
  useEffect(() => {
    if (ms === null) return
    const id = setInterval(() => saved.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
