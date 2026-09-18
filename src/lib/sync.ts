import { ONLINE } from './config'
import { supabase } from './supabase'
import { db } from './db'
import { metaGet, metaSet, notify, upsertProfile } from './store'
import { TOKENS } from './tokens'
import { getNetState } from './net'

// ---------------------------------------------------------------------------
// Incremental sync: pull anything newer than the last synced created_at per
// table, upsert into Dexie. Runs at boot and on reconnect (gap fill) before
// re-subscribing, so nothing is lost in the outage window.
// ---------------------------------------------------------------------------

const iso = (d: unknown): string => (d as string) ?? new Date(0).toISOString()

async function lastSync(key: string): Promise<string> {
  return (await metaGet<string>('sync:' + key)) ?? new Date(0).toISOString()
}

async function bumpSync(key: string, ts: string | null): Promise<void> {
  if (ts) await metaSet('sync:' + key, ts)
}

export async function syncTokens(): Promise<void> {
  if (ONLINE && supabase) {
    const { data } = await supabase.from('crimechat_tokens').select('*')
    if (data) {
      await db.tokens.bulkPut(data as never[])
      notify()
      return
    }
  }
  await db.tokens.bulkPut(TOKENS as never[])
  notify()
}

export async function syncMyProfile(userId: string): Promise<void> {
  if (!ONLINE || !supabase) return
  const { data } = await supabase.from('crimechat_profiles').select('*').eq('id', userId).maybeSingle()
  if (data) await upsertProfile(data as never as Parameters<typeof upsertProfile>[0])
}

export async function syncMyBalances(userId: string): Promise<void> {
  if (!ONLINE || !supabase) return
  const { data } = await supabase.from('crimechat_balances').select('*').eq('profile_id', userId)
  if (data) {
    await db.balances.where('profile_id').equals(userId).delete()
    await db.balances.bulkPut(data as never[])
    notify()
  }
}

export async function syncContacts(userId: string): Promise<void> {
  if (!ONLINE || !supabase) return
  const { data } = await supabase.from('crimechat_contacts').select('*').eq('owner_id', userId)
  if (data) {
    await db.contacts.where('owner_id').equals(userId).delete()
    await db.contacts.bulkPut(data as never[])
    notify()
  }
}

export async function syncThreads(me: string): Promise<number[]> {
  if (!ONLINE || !supabase) {
    const mine = await db.threads.toArray()
    return mine.map((t) => t.id)
  }
  const since = await lastSync('threads')
  const { data } = await supabase
    .from('crimechat_threads')
    .select('*')
    .eq('participant_a', me)
    .gt('last_message_at', since)
    .order('last_message_at', { ascending: true })
  let newest = data && data.length ? iso((data[data.length - 1] as Record<string, unknown>).last_message_at) : null
  if (newest) {
    await db.threads.bulkPut(data as never[])
    notify()
  }
  // Also pick up threads with no messages yet (created but silent)
  const { data: fresh } = await supabase
    .from('crimechat_threads')
    .select('*')
    .eq('participant_a', me)
    .order('created_at', { ascending: false })
    .limit(50)
  if (fresh) {
    await db.threads.bulkPut(fresh as never[])
    notify()
  }
  if (!newest) newest = await lastSync('threads')
  await bumpSync('threads', newest ?? new Date().toISOString())
  const all = await db.threads.toArray()
  return all.filter((t) => t.participant_a === me || t.participant_b === me).map((t) => t.id)
}

export async function syncMessagesForThread(threadId: number): Promise<void> {
  if (!ONLINE || !supabase) return
  const since = await lastSync('messages:' + threadId)
  const { data } = await supabase
    .from('crimechat_messages')
    .select('*')
    .eq('thread_id', threadId)
    .gt('created_at', since)
    .order('created_at', { ascending: true })
    .limit(500)
  if (data && data.length) {
    const newest = iso((data[data.length - 1] as Record<string, unknown>).created_at)
    await db.messages.bulkPut(
      (data as Record<string, unknown>[]).map((m) => ({ ...m, status: 'sent' })) as never[],
    )
    await bumpSync('messages:' + threadId, newest)
    notify()
  }
}

export async function syncTransfers(me: string): Promise<void> {
  if (!ONLINE || !supabase) return
  const since = await lastSync('transfers')
  const q = (col: string) =>
    supabase!
      .from('crimechat_transfers')
      .select('*')
      .eq(col, me)
      .gt('created_at', since)
      .order('created_at', { ascending: true })
      .limit(300)
  const a = await q('from_address')
  const b = await q('to_address')
  const rows = [...(a.data ?? []), ...(b.data ?? [])] as Record<string, unknown>[]
  if (rows.length) {
    const newest = rows.map((r) => iso(r.created_at)).sort().pop() ?? null
    await db.transfers.bulkPut(rows as never[])
    await bumpSync('transfers', newest)
    notify()
  }
}

export async function syncEscrowsForThread(threadId: number): Promise<void> {
  if (!ONLINE || !supabase) return
  const since = await lastSync('escrows:' + threadId)
  const { data } = await supabase
    .from('crimechat_escrows')
    .select('*')
    .eq('thread_id', threadId)
    .gt('updated_at', since)
    .order('updated_at', { ascending: true })
  if (data && data.length) {
    const newest = iso((data[data.length - 1] as Record<string, unknown>).updated_at)
    await db.escrows.bulkPut(data as never[])
    await bumpSync('escrows:' + threadId, newest)
    notify()
  }
}

export async function syncContracts(): Promise<void> {
  if (!ONLINE || !supabase) return
  const since = await lastSync('contracts')
  const { data } = await supabase
    .from('crimechat_contracts')
    .select('*')
    .gt('created_at', since)
    .order('created_at', { ascending: true })
  if (data && data.length) {
    const newest = iso((data[data.length - 1] as Record<string, unknown>).created_at)
    await db.contracts.bulkPut(data as never[])
    await bumpSync('contracts', newest)
    notify()
  }
}

// Full incremental pass — used at boot and on every reconnect.
export async function syncAll(identity: { userId: string; address: string }): Promise<number[]> {
  if (!ONLINE || getNetState() === 'OFFLINE') {
    return (await db.threads.toArray()).map((t) => t.id)
  }
  await syncTokens()
  await syncMyProfile(identity.userId)
  await syncMyBalances(identity.userId)
  await syncContacts(identity.userId)
  await syncContracts()
  await syncTransfers(identity.address)
  const threadIds = await syncThreads(identity.address)
  for (const id of threadIds) {
    await syncMessagesForThread(id)
    await syncEscrowsForThread(id)
  }
  return threadIds
}
