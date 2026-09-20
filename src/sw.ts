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
  // SW scope is the deployed base path (e.g. /cc/) — the precached shell lives
  // under it, so resolve index.html relative to the scope, not the origin root.
  const shellUrl = self.registration.scope + 'index.html'
  const cache = await caches.open(PAGE_CACHE)
  const cached = await cache.match(shellUrl)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) await cache.put(shellUrl, fresh.clone())
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
  // workbox-window's registerSW(...)(true) posts SKIP_WAITING to the waiting
  // worker; accept our legacy tag too. Without this, the in-app Reload
  // prompt never activates the new service worker.
  const type = (event.data as { type?: string })?.type
  if (type === 'SKIP_WAITING' || type === 'crimechat-skip-waiting') {
    self.skipWaiting()
  }
})

// ---------------------------------------------------------------------------
// Web Push: the crimechat-push edge function wakes this worker even when the
// app is fully closed. Every push must show a notification (userVisibleOnly).
// ---------------------------------------------------------------------------

interface PushPayload {
  title?: string
  body?: string
  threadId?: number
  kind?: string
}

self.addEventListener('push', (event: Event) => {
  const e = event as PushEvent
  let data: PushPayload = {}
  try {
    data = e.data ? (e.data.json() as PushPayload) : {}
  } catch {
    data = {}
  }
  const title = data.title || 'CRIMECHAT'
  const body = data.body || 'New traffic on the wire.'
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.threadId != null ? `crimechat:thread:${data.threadId}` : 'crimechat',
      data: { threadId: data.threadId ?? null },
      icon: self.registration.scope + 'icons/icon-192.png',
      badge: self.registration.scope + 'icons/icon-192.png',
    }),
  )
})

self.addEventListener('notificationclick', (event: Event) => {
  const e = event as NotificationEvent
  e.notification.close()
  const threadId = (e.notification.data as { threadId?: number } | undefined)?.threadId
  const target = self.registration.scope + (threadId != null ? '?thread=' + threadId : '')
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.startsWith(self.registration.scope))
      if (existing) {
        existing.navigate(target)
        existing.focus()
      } else {
        void self.clients.openWindow(target)
      }
    }),
  )
})
