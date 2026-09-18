import { ONLINE } from './config'
import { supabase } from './supabase'
import { db } from './db'
import {
  notify,
  upsertContract,
  upsertEscrow,
  upsertMessage,
  upsertProfile,
  upsertThread,
  upsertTransfer,
} from './store'
import { getNetState, reportRealtimeStatus } from './net'
import {
  syncAll,
  syncContracts,
  syncEscrowsForThread,
  syncMessagesForThread,
  syncMyBalances,
  syncThreads,
  syncTokens,
  syncTransfers,
} from './sync'
import { flushOutbox, registerBackgroundSync } from './outbox'

// ---------------------------------------------------------------------------
// Realtime: per-thread channels carry messages, escrows, presence (online
// dots) and typing indicators. A global channel carries threads, transfers,
// contracts and profile updates for the signed-in operative.
// ---------------------------------------------------------------------------

export interface PresenceInfo {
  online: Set<string>
  typing: Set<string>
}

const presenceListeners = new Set<() => void>()
let presenceState: PresenceInfo = { online: new Set(), typing: new Set() }
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>()

function bumpPresence(): void {
  presenceListeners.forEach((l) => l())
}

export function onPresence(fn: () => void): () => void {
  presenceListeners.add(fn)
  return () => presenceListeners.delete(fn)
}

export function getPresence(): PresenceInfo {
  return presenceState
}

const subscribedThreads = new Set<number>()
let globalChannel: ReturnType<NonNullable<typeof supabase>['channel']> | null = null
let identityRef: { userId: string; address: string } | null = null
let restartTimer: ReturnType<typeof setTimeout> | null = null

export async function startRealtime(identity: { userId: string; address: string }): Promise<void> {
  if (!ONLINE || !supabase) return
  identityRef = identity
  await subscribeGlobal()
  const threadIds = await syncThreads(identity.address)
  for (const id of threadIds) await subscribeThread(id)
}

async function subscribeGlobal(): Promise<void> {
  if (!supabase || !identityRef) return
  if (globalChannel) await supabase.removeChannel(globalChannel)
  const me = identityRef.address
  const ch = supabase.channel('crimechat:me:' + me.toLowerCase(), { config: { presence: { key: me } } })

  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_threads', filter: `participant_a=eq.${me}` },
    (payload) => void handleThreadRow(payload.new as Record<string, unknown>, true))
  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crimechat_threads', filter: `participant_a=eq.${me}` },
    (payload) => void handleThreadRow(payload.new as Record<string, unknown>, false))

  for (const col of ['from_address', 'to_address']) {
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_transfers', filter: `${col}=eq.${me}` },
      (payload) => void handleTransferRow(payload.new as Record<string, unknown>))
  }

  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_contracts' },
    (payload) => void upsertContract(payload.new as never))
  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crimechat_contracts' },
    (payload) => void upsertContract(payload.new as never))

  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crimechat_profiles' },
    (payload) => void upsertProfile(payload.new as never))
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_profiles' },
    (payload) => void upsertProfile(payload.new as never))

  ch.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      reportRealtimeStatus(true)
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      reportRealtimeStatus(false)
      scheduleRestart()
    }
  })
  globalChannel = ch
}

async function handleThreadRow(row: Record<string, unknown>, isNew: boolean): Promise<void> {
  await upsertThread(row as never as Parameters<typeof upsertThread>[0])
  const id = row.id as number
  if (isNew && !subscribedThreads.has(id)) await subscribeThread(id)
}

async function handleTransferRow(row: Record<string, unknown>): Promise<void> {
  await upsertTransfer(row as never)
  if (identityRef) await syncMyBalances(identityRef.userId)
  // If we have a pending local card for this client_id, mark it sent.
  const clientId = row.client_id as string | null
  if (clientId) {
    await db.messages.where('client_id').equals(clientId).modify({
      status: 'sent',
      payload: { transfer_id: row.id, tx_hash: row.tx_hash, block_number: row.block_number, status: 'confirmed' },
    })
    notify()
  }
}

export async function subscribeThread(threadId: number): Promise<void> {
  if (!ONLINE || !supabase || subscribedThreads.has(threadId)) return
  subscribedThreads.add(threadId)
  const me = identityRef?.address ?? ''
  const ch = supabase.channel(`crimechat:thread:${threadId}`, { config: { presence: { key: me } } })

  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_messages', filter: `thread_id=eq.${threadId}` },
    async (payload) => {
      const row = payload.new as Record<string, unknown>
      await db.messages.put({ ...row, status: 'sent' } as never)
      await db.threads.where('id').equals(threadId).modify({ last_message_at: row.created_at as string })
      notify()
    })
  ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crimechat_escrows', filter: `thread_id=eq.${threadId}` },
    (payload) => void upsertEscrow(payload.new as never))
  ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crimechat_escrows', filter: `thread_id=eq.${threadId}` },
    (payload) => void upsertEscrow(payload.new as never))

  ch.on('presence', { event: 'sync' }, () => {
    const state = ch.presenceState<{ address: string }>()
    const online = new Set<string>()
    for (const key of Object.keys(state)) {
      for (const item of state[key]) if (item.address) online.add(item.address.toLowerCase())
    }
    presenceState = { ...presenceState, online }
    bumpPresence()
  })

  ch.on('broadcast', { event: 'typing' }, (payload) => {
    const p = payload as unknown as { address?: string }
    if (!p.address || p.address.toLowerCase() === me.toLowerCase()) return
    const addr = p.address.toLowerCase()
    presenceState.typing.add(addr)
    bumpPresence()
    const existing = typingTimers.get(addr)
    if (existing) clearTimeout(existing)
    typingTimers.set(
      addr,
      setTimeout(() => {
        presenceState.typing.delete(addr)
        bumpPresence()
      }, 2500),
    )
  })

  ch.subscribe((status) => {
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      reportRealtimeStatus(false)
      subscribedThreads.delete(threadId)
      scheduleRestart()
    } else if (status === 'SUBSCRIBED') {
      reportRealtimeStatus(true)
    }
  })
}

export function sendTyping(threadId: number): void {
  if (!supabase) return
  const ch = supabase.channel(`crimechat:thread:${threadId}`)
  void ch.send({ type: 'broadcast', event: 'typing', payload: { address: identityRef?.address } })
}

function scheduleRestart(): void {
  if (restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    void restart()
  }, 4000)
}

async function restart(): Promise<void> {
  if (!identityRef || getNetState() === 'OFFLINE') return
  // Gap fill before re-subscribing so nothing is lost in the outage window.
  await syncAll(identityRef)
  await subscribeGlobal()
  const ids = await syncThreads(identityRef.address)
  for (const id of ids) {
    subscribedThreads.delete(id)
    await subscribeThread(id)
  }
  reportRealtimeStatus(true)
  await flushOutbox()
}

// Presence heartbeat: announce ourselves in each subscribed thread channel.
export function startPresenceHeartbeat(identity: { address: string }): () => void {
  const client = supabase
  if (!ONLINE || !client) return () => undefined
  const timer = setInterval(() => {
    for (const threadId of subscribedThreads) {
      const ch = client.channel(`crimechat:thread:${threadId}`)
      void ch.track({ address: identity.address, at: Date.now() })
    }
  }, 5000)
  return () => clearInterval(timer)
}

// Reconnect wiring: gap-fill + resubscribe + flush when connectivity returns.
if (typeof window !== 'undefined') {
  window.addEventListener('crimechat:connectivity-restored', () => {
    void (async () => {
      if (!identityRef) return
      await syncTokens()
      await syncContracts()
      if (identityRef) {
        await syncMyBalances(identityRef.userId)
        await syncTransfers(identityRef.address)
        const ids = await syncThreads(identityRef.address)
        for (const id of ids) {
          await syncMessagesForThread(id)
          await syncEscrowsForThread(id)
        }
      }
      await flushOutbox()
      await registerBackgroundSync()
      await restart()
    })()
  })
}
