// ---------------------------------------------------------------------------
// Web Push subscription lifecycle. The service worker shows the notification;
// this module keeps the server-side store in sync so the crimechat-push edge
// function can reach this device even when the app is fully closed.
// ---------------------------------------------------------------------------

import { ONLINE } from './config'
import { supabase } from './supabase'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

export async function getPushState(): Promise<'unsupported' | 'unsubscribed' | 'subscribed'> {
  if (!ONLINE || !supabase || !('PushManager' in window) || !VAPID_PUBLIC) return 'unsupported'
  const reg = await getRegistration()
  if (!reg || !reg.pushManager) return 'unsupported'
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'unsubscribed'
}

// Idempotent: safe to call on every boot. Requires Notification permission to
// already be granted — browsers tie push subscription to it.
export async function ensurePushSubscription(identity: { userId: string; address: string }): Promise<boolean> {
  if (!ONLINE || !supabase || !('PushManager' in window) || !VAPID_PUBLIC) return false
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  try {
    const reg = await getRegistration()
    if (!reg) return false
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) as BufferSource,
      })
    }
    const json = sub.toJSON()
    const { error } = await supabase.from('crimechat_push_subscriptions').upsert(
      {
        user_id: identity.userId,
        address: identity.address.toLowerCase(),
        endpoint: sub.endpoint,
        subscription: json,
      },
      { onConflict: 'endpoint' },
    )
    if (error) console.warn('[crimechat] push subscription save failed', error.message)
    return !error
  } catch (e) {
    // Headless/denied environments land here — push stays off, app unaffected.
    console.warn('[crimechat] push subscribe failed', e)
    return false
  }
}

// Called from the SW lifecycle when the push service rotates keys; without a
// stored VAPID key in the SW we can't resubscribe there, so best-effort noop.
export async function unsubscribePush(): Promise<void> {
  const reg = await getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await supabase?.from('crimechat_push_subscriptions').delete().eq('endpoint', sub.endpoint)
  await sub.unsubscribe()
}
