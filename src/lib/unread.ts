import { db } from './db'
import { metaGet, metaSet } from './store'

// Unread tracking, per thread: a 'read:<threadId>' marker in meta holds the
// ISO timestamp up to which the user has read. Messages from the counterparty
// newer than the marker count as unread. Threads without a marker are treated
// as fully read (history predates the feature) until the user opens them.

const key = (threadId: number) => 'read:' + threadId

export async function markThreadRead(threadId: number): Promise<void> {
  const now = new Date().toISOString()
  const existing = await metaGet<string>(key(threadId))
  // Skip near-duplicate writes: metaSet notifies, which re-runs useLive
  // queries, which would call us again — the guard breaks that loop.
  if (existing && Math.abs(new Date(now).getTime() - new Date(existing).getTime()) < 1500) return
  await metaSet(key(threadId), now)
}

export async function unreadByThread(me: string): Promise<Map<number, number>> {
  const markers = await db.meta.toArray()
  const read = new Map<number, string>()
  for (const m of markers) {
    if (m.key.startsWith('read:')) read.set(Number(m.key.slice(5)), m.value as string)
  }
  const counts = new Map<number, number>()
  const messages = await db.messages.toArray()
  for (const m of messages) {
    if (m.sender_address.toLowerCase() === me) continue
    const marker = read.get(m.thread_id)
    if (!marker || m.created_at <= marker) continue
    counts.set(m.thread_id, (counts.get(m.thread_id) ?? 0) + 1)
  }
  return counts
}

// One-time-per-thread baseline so pre-existing history doesn't count as
// unread. Called at boot; also when we ourselves create a channel.
export async function initReadMarkers(): Promise<void> {
  const markers = new Set(
    (await db.meta.toArray()).filter((m) => m.key.startsWith('read:')).map((m) => m.key),
  )
  const threads = await db.threads.toArray()
  for (const t of threads) {
    if (!markers.has(key(t.id))) await metaSet(key(t.id), t.last_message_at)
  }
}
