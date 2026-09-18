/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope

// Precache the full app shell (injected at build time by vite-plugin-pwa).
precacheAndRoute(self.__WB_MANIFEST)

// Navigations: stale-while-revalidate against a dedicated page cache, so a
// cold launch with the host unreachable still renders the app shell.
const PAGE_CACHE = 'crimechat-pages-v1'

async function navigationHandler({ request }: { request: Request }): Promise<Response> {
  const cache = await caches.open(PAGE_CACHE)
  const cached = await cache.match('/index.html')
  try {
    const fresh = await fetch(request)
    if (fresh.ok) await cache.put('/index.html', fresh.clone())
    return cached ?? fresh
  } catch {
    return cached ?? Response.error()
  }
}

registerRoute(new NavigationRoute(navigationHandler))

// Background Sync: nudge the client to flush its outbox when connectivity
// returns (best-effort — unsupported browsers fall back to the online event).
interface SyncEvent extends ExtendableEvent {
  tag: string
}

self.addEventListener('sync', (event: Event) => {
  const e = event as SyncEvent
  if (e.tag === 'crimechat-outbox') {
    e.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'crimechat-flush-outbox' }))
      }),
    )
  }
})

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if ((event.data as { type?: string })?.type === 'crimechat-skip-waiting') {
    self.skipWaiting()
  }
})
