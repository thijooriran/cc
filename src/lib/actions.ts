import { ONLINE } from './config'
import { supabase, rpc } from './supabase'
import { db, type ContractRow, type EscrowRow, type ThreadRow } from './db'
import { notify, upsertContract, upsertEscrow, upsertMessage, upsertThread } from './store'
import { enqueueMessage } from './outbox'
import { isValidAddress } from './identity'
import { getNetState } from './net'
import { isBotAddress, mockEscrowTransition } from './mock'

// ---------------------------------------------------------------------------
// High-level actions used by the UI. Every action writes into Dexie; network
// calls only happen when ONLINE. Balance-changing actions check the net state
// and refuse while OFFLINE — never optimistically debit an unconfirmed balance.
// ---------------------------------------------------------------------------

export async function startThread(
  me: string,
  counterparty: string,
  contractId: number | null = null,
): Promise<{ thread: ThreadRow | null; error?: string }> {
  counterparty = counterparty.trim()
  if (!isValidAddress(counterparty)) return { thread: null, error: 'invalid address — expect 0x + 40 hex chars' }
  if (counterparty.toLowerCase() === me.toLowerCase())
    return { thread: null, error: 'sending to yourself is bad for business' }

  if (!ONLINE || !supabase) {
    if (!isBotAddress(counterparty)) {
      const known = await db.profiles.get(counterparty.toLowerCase())
      if (!known) return { thread: null, error: 'no such operative on this network' }
    }
    const a = me.toLowerCase()
    const b = counterparty.toLowerCase()
    const existing = await db.threads
      .where('[participant_a+participant_b]')
      .equals([a < b ? a : b, a < b ? b : a])
      .first()
    if (existing) return { thread: existing }
    const id = 1000 + Math.floor(Math.random() * 900000)
    const thread: ThreadRow = {
      id,
      participant_a: a < b ? a : b,
      participant_b: a < b ? b : a,
      contract_id: contractId,
      last_message_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }
    await upsertThread(thread)
    return { thread }
  }

  const { data: profile } = await supabase
    .from('crimechat_profiles')
    .select('address')
    .ilike('address', counterparty)
    .maybeSingle()
  if (!profile) return { thread: null, error: 'no such operative on this network' }

  const { data, error } = await rpc<ThreadRow>('crimechat_open_thread', {
    p_with: counterparty,
    p_contract_id: contractId,
  })
  if (error || !data) return { thread: null, error: error?.message ?? 'failed to open channel' }
  await upsertThread(data)
  // Lazy subscription for the new thread (idempotent).
  const { subscribeThread } = await import('./realtime')
  await subscribeThread(data.id)
  return { thread: data }
}

export async function sendTextMessage(me: string, threadId: number, body: string): Promise<void> {
  const text = body.trim()
  if (!text) return
  await enqueueMessage({
    thread_id: threadId,
    sender_address: me,
    body: text,
    kind: 'text',
    payload: {},
  })
  await db.threads.where('id').equals(threadId).modify({ last_message_at: new Date().toISOString() })
  notify()
}

export async function addContact(userId: string, address: string, nickname: string): Promise<void> {
  const key: [string, string] = [userId, address.toLowerCase()]
  const existing = await db.contacts.where('[owner_id+contact_address]').equals(key).first()
  const row = { owner_id: userId, contact_address: address.toLowerCase(), nickname: nickname || null }
  if (existing) await db.contacts.where('[owner_id+contact_address]').equals(key).modify({ nickname: row.nickname })
  else await db.contacts.put(row as never)
  if (ONLINE && supabase) {
    await supabase.from('crimechat_contacts').upsert(
      { owner_id: userId, contact_address: address.toLowerCase(), nickname: nickname || null },
      { onConflict: 'owner_id,contact_address' },
    )
  }
  notify()
}

// ---- balance-changing actions (refuse while offline) ----------------------

function requireOnline(): string | null {
  if (!ONLINE) return null // mock mode is always "connected"
  if (getNetState() === 'OFFLINE') return 'You are offline — balance changes are disabled while on the local cache.'
  return null
}

export interface TransferResult {
  ok: boolean
  error?: string
}

export async function sendTransfer(me: string, args: {
  to: string
  token: string
  amount: number
  memo: string
  threadId: number | null
}): Promise<TransferResult> {
  const offlineMsg = requireOnline()
  if (offlineMsg) return { ok: false, error: offlineMsg }
  if (!isValidAddress(args.to)) return { ok: false, error: 'invalid recipient address' }
  if (args.to.toLowerCase() === me.toLowerCase()) return { ok: false, error: 'sending to yourself is bad for business' }
  if (!(args.amount > 0)) return { ok: false, error: 'amount must be positive' }

  if (!ONLINE || !supabase) {
    const known = await db.profiles.get(args.to.toLowerCase())
    if (!known && !isBotAddress(args.to)) return { ok: false, error: 'unknown recipient' }
    const myProfile = await db.profiles.get(me.toLowerCase())
    const bal = myProfile ? await db.balances.get([myProfile.id, args.token]) : undefined
    if (bal && bal.amount < args.amount) return { ok: false, error: `insufficient ${args.token} balance` }
    await enqueueMessage({
      thread_id: args.threadId ?? 0,
      sender_address: me,
      body: 'transfer',
      kind: 'transfer',
      payload: {
        to: args.to,
        token: args.token,
        amount: args.amount,
        memo: args.memo,
        thread_id: args.threadId ?? 0,
        from: me,
        direction: 'out',
        counterparty: args.to,
        status: 'pending',
      },
    })
    return { ok: true }
  }

  const { data: profile } = await supabase
    .from('crimechat_profiles')
    .select('address')
    .ilike('address', args.to)
    .maybeSingle()
  if (!profile) return { ok: false, error: 'unknown recipient' }

  // Client-side guard before hitting the RPC (server enforces again).
  const myProfile = await db.profiles.get(me.toLowerCase())
  const bal = myProfile ? await db.balances.get([myProfile.id, args.token]) : undefined
  if (bal && bal.amount < args.amount) return { ok: false, error: `insufficient ${args.token} balance` }

  await enqueueMessage({
    thread_id: args.threadId ?? 0,
    sender_address: me,
    body: 'transfer',
    kind: 'transfer',
    payload: {
      to: args.to,
      token: args.token,
      amount: args.amount,
      memo: args.memo,
      thread_id: args.threadId ?? 0,
      from: me,
      direction: 'out',
      counterparty: args.to,
      status: 'pending',
    },
  })
  return { ok: true }
}

export async function postContract(me: string, args: {
  title: string
  blurb: string
  token: string
  amount: number
  region: string
  deadline: string
  risk: string
}): Promise<{ ok: boolean; error?: string }> {
  const offlineMsg = requireOnline()
  if (offlineMsg) return { ok: false, error: offlineMsg }
  if (args.title.trim().length < 4) return { ok: false, error: 'title too short' }
  if (!(args.amount > 0)) return { ok: false, error: 'reward must be positive' }

  if (!ONLINE || !supabase) {
    const id = 5000 + Math.floor(Math.random() * 90000)
    const row: ContractRow = {
      id,
      poster_address: me,
      title: args.title.trim(),
      blurb: args.blurb.trim(),
      reward_token: args.token,
      reward_amount: args.amount,
      region: args.region.trim() || 'Undisclosed',
      deadline: args.deadline,
      risk_tier: args.risk.toUpperCase() as ContractRow['risk_tier'],
      open: true,
      created_at: new Date().toISOString(),
    }
    await upsertContract(row)
    return { ok: true }
  }

  const { data, error } = await rpc<ContractRow>('crimechat_post_contract', {
    p_title: args.title.trim(),
    p_blurb: args.blurb.trim(),
    p_token: args.token,
    p_amount: args.amount,
    p_region: args.region.trim() || 'Undisclosed',
    p_deadline: args.deadline,
    p_risk_tier: args.risk,
  })
  if (error || !data) return { ok: false, error: error?.message ?? 'failed to post' }
  await upsertContract(data)
  return { ok: true }
}

export async function createEscrow(me: string, threadId: number, token: string, amount: number): Promise<{ ok: boolean; error?: string }> {
  const offlineMsg = requireOnline()
  if (offlineMsg) return { ok: false, error: offlineMsg }
  if (!(amount > 0)) return { ok: false, error: 'amount must be positive' }

  if (!ONLINE || !supabase) {
    const thread = await db.threads.get(threadId)
    if (!thread) return { ok: false, error: 'no such channel' }
    const other = thread.participant_a === me.toLowerCase() ? thread.participant_b : thread.participant_a
    const id = 7000 + Math.floor(Math.random() * 90000)
    const now = new Date().toISOString()
    const row: EscrowRow = {
      id, thread_id: threadId, contract_id: null,
      payer_address: me, payee_address: other,
      token_symbol: token, amount, state: 'PROPOSED',
      created_at: now, updated_at: now,
    }
    await upsertEscrow(row)
    await upsertMessage({
      id: 'escrow-local-' + id,
      thread_id: threadId,
      sender_address: me,
      body: 'escrow proposed',
      kind: 'escrow',
      payload: { escrow_id: id, state: 'PROPOSED', token, amount: String(amount), payer: me, payee: other },
      client_id: null,
      created_at: now,
      status: 'sent',
    })
    return { ok: true }
  }

  const { data, error } = await rpc<EscrowRow>('crimechat_escrow_create', {
    p_thread_id: threadId,
    p_token: token,
    p_amount: amount,
  })
  if (error || !data) return { ok: false, error: error?.message ?? 'failed to open escrow' }
  await upsertEscrow(data)
  return { ok: true }
}

export async function escrowTransition(me: string, escrowId: number, transition: 'fund' | 'deliver' | 'release' | 'dispute' | 'refund'): Promise<{ ok: boolean; error?: string }> {
  const offlineMsg = requireOnline()
  if (offlineMsg) return { ok: false, error: offlineMsg }

  if (!ONLINE || !supabase) {
    try {
      await mockEscrowTransition(escrowId, transition, me)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'transition failed' }
    }
  }

  const fn = {
    fund: 'crimechat_escrow_fund',
    deliver: 'crimechat_escrow_deliver',
    release: 'crimechat_escrow_release',
    dispute: 'crimechat_escrow_dispute',
    refund: 'crimechat_escrow_refund',
  }[transition]
  const { data, error } = await rpc<EscrowRow>(fn, { p_escrow_id: escrowId })
  if (error || !data) return { ok: false, error: error?.message ?? 'transition failed' }
  await upsertEscrow(data)
  return { ok: true }
}
