// Connection state derived from navigator.onLine PLUS realtime channel state,
// never navigator.onLine alone. Three states:
//   ONLINE / RECONNECTING / OFFLINE — LOCAL CACHE

export type NetState = 'ONLINE' | 'RECONNECTING' | 'OFFLINE'

const listeners = new Set<() => void>()
let browserOnline = navigator.onLine
let realtimeOk = true
let state: NetState = browserOnline ? 'ONLINE' : 'OFFLINE'

function recompute(): void {
  const next: NetState = !browserOnline ? 'OFFLINE' : realtimeOk ? 'ONLINE' : 'RECONNECTING'
  if (next !== state) {
    state = next
    listeners.forEach((l) => l())
  }
}

export function getNetState(): NetState {
  return state
}

export function onNetState(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function reportRealtimeStatus(ok: boolean): void {
  realtimeOk = ok
  recompute()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    const was = getNetState()
    browserOnline = true
    recompute()
    if (was === 'OFFLINE') {
      window.dispatchEvent(new CustomEvent('crimechat:connectivity-restored'))
    }
    void probe()
  })
  window.addEventListener('offline', () => {
    browserOnline = false
    recompute()
  })

  // Active probe: navigator.onLine alone is not trustworthy (browsers infer it
  // from recent network failures, and a cache-served cold launch may never
  // fail a request). A no-store fetch against this dedicated probe file gives
  // a definitive answer, and drives the OFFLINE banner + outbox flush.
  // The file is deliberately NOT in the SW precache glob, and the cache-busting
  // query keeps it out of any runtime cache — a 200 always comes from the wire.
  async function probe(): Promise<void> {
    if (!navigator.onLine) {
      browserOnline = false
      recompute()
      return
    }
    const was = getNetState()
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}crimechat-probe.txt?ts=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(3000),
      })
      browserOnline = r.ok
    } catch {
      browserOnline = false
    }
    recompute()
    if (was === 'OFFLINE' && getNetState() !== 'OFFLINE') {
      window.dispatchEvent(new CustomEvent('crimechat:connectivity-restored'))
    }
  }
  setInterval(() => void probe(), 3000)
  setTimeout(() => void probe(), 1500)
}
