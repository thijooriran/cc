// ---------------------------------------------------------------------------
// OS-level notifications for incoming traffic. Uses the Notification API so a
// backgrounded tab (or minimized PWA window) surfaces a system notification.
// Requires a one-time permission grant — the header bell drives that flow.
// ---------------------------------------------------------------------------

export type NotifyState = 'granted' | 'denied' | 'prompt' | 'unsupported'

export function getNotifyState(): NotifyState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  return 'prompt'
}

export async function requestNotifyPermission(): Promise<NotifyState> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'granted') return 'granted'
  if (Notification.permission === 'denied') return 'denied'
  try {
    const p = await Notification.requestPermission()
    return p === 'granted' ? 'granted' : p === 'denied' ? 'denied' : 'prompt'
  } catch {
    return getNotifyState()
  }
}

// App registers the thread that is currently open in the foreground so we
// don't ping the user for a conversation they are literally looking at.
let activeThreadProvider: (() => number | null) | null = null
export function setActiveThreadProvider(fn: () => number | null): void {
  activeThreadProvider = fn
}

// Clicking a notification should land the user on that channel.
let navigator: ((threadId: number) => void) | null = null
export function setNotifyNavigator(fn: (threadId: number) => void): void {
  navigator = fn
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export interface IncomingMessage {
  threadId: number
  sender: string
  alias?: string
  body: string
  kind: 'text' | 'transfer' | 'escrow' | 'system'
}

export function notifyIncomingMessage(m: IncomingMessage): void {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  // The in-app chime + badges already cover the focused case.
  if (document.visibilityState === 'visible' && document.hasFocus()) return
  if (m.threadId === activeThreadProvider?.()) return

  const title = m.alias ? `${m.alias} · new message` : 'New message'
  const body =
    m.kind === 'text'
      ? truncate(m.body, 120)
      : m.kind === 'transfer'
        ? 'Sent you a transfer'
        : m.kind === 'escrow'
          ? 'Escrow update'
          : truncate(m.body, 120)

  try {
    const n = new Notification(title, {
      body,
      tag: `crimechat:thread:${m.threadId}`, // replaces earlier notices from the same channel
      silent: true, // the in-app chime already played; avoid double sound
    })
    n.onclick = () => {
      window.focus()
      navigator?.(m.threadId)
      n.close()
    }
  } catch {
    // Some platforms construct via ServiceWorkerRegistration instead; ignore.
  }
}
