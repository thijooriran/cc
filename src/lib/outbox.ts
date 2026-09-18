import { ONLINE } from './config'
import { supabase } from './supabase'
import { db, type MessageRow, type TransferRow } from './db'
import { notify, upsertMessage, upsertTransfer } from './store'
import { uuid } from './format'
import { getNetState } from './net'
import { mockDeliverTransfer, mockScheduleBotReply } from './mock'

// ---------------------------------------------------------------------------
// Outbox: outgoing messages get a client-generated uuid, land in Dexie
// immediately with `pending` status, and enqueue here. A flush runs on
// reconnect (and via Background Sync where supported), upserting on
// client_id so retries are idempotent — no duplicates, ever.
// ---------------------------------------------------------------------------

let flushing = false

// Replace a local pending message with its server-confirmed version. Dexie's
// modify() cannot change a primary key, so this deletes + re-puts.
async function finalizeLocalMessage(clientId: string, patch: Partial<MessageRow>): Promise<void> {
  const row = await db.messages.where('client_id').equals(clientId).first()
  if (!row) return
  const updated: MessageRow = { ...row, ...patch }
  if (patch.id !== undefined && patch.id !== row.id) await db.messages.delete(row.id)
  await db.messages.put(updated)
  notify()
}

export async function enqueueMessage(row: {
  thread_id: number
  sender_address: string
  body: string
  kind: MessageRow['kind']
  payload: Record<string, unknown>
}): Promise<MessageRow> {
  const client_id = uuid()
  const localId = 'local-' + client_id
  const message: MessageRow = {
    id: localId,
    thread_id: row.thread_id,
    sender_address: row.sender_address,
    body: row.body,
    kind: row.kind,
    payload: row.payload,
    client_id,
    created_at: new Date().toISOString(),
    status: 'pending',
  }
  await db.messages.put(message)
  await db.outbox.put({
    client_id,
    kind: row.kind === 'transfer' ? 'transfer' : 'message',
    payload: { ...row, client_id },
    status: 'queued',
    attempts: 0,
    created_at: message.created_at,
  })
  notify()
  void flushOutbox()
  return message
}

export async function retryMessage(clientId: string): Promise<void> {
  await db.outbox.where('client_id').equals(clientId).modify({ status: 'queued' })
  await db.messages.where('client_id').equals(clientId).modify({ status: 'pending' })
  notify()
  void flushOutbox()
}

export async function registerBackgroundSync(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.ready
    await (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register(
      'crimechat-outbox',
    )
  } catch {
    /* unsupported — the online event also triggers a flush */
  }
}

export async function flushOutbox(): Promise<void> {
  if (flushing) return
  if (getNetState() === 'OFFLINE') return // everything stays queued until reconnect
  if (!ONLINE || !supabase) {
    // LOCAL-ONLY mode delivers straight into Dexie; scripted bots answer.
    await flushMock()
    return
  }
  flushing = true
  try {
    const queue = await db.outbox.where('status').anyOf('queued', 'failed').toArray()
    for (const item of queue.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
      await db.outbox.where('client_id').equals(item.client_id).modify({ status: 'sending' })
      try {
        if (item.kind === 'transfer') {
          const outer = item.payload as { thread_id: number; payload: Record<string, unknown> }
          const p = {
            ...(outer.payload as {
              to: string
              token: string
              amount: number
              memo: string
            }),
            thread_id: outer.thread_id,
            client_id: item.client_id,
          }
          const { data, error } = await supabase.rpc('crimechat_send_transfer', {
            p_to: p.to,
            p_token: p.token,
            p_amount: p.amount,
            p_memo: p.memo,
            p_thread_id: p.thread_id,
            p_client_id: p.client_id,
          })
          if (error) throw new Error(error.message)
          const tr = data as TransferRow
          await upsertTransfer(tr)
          await finalizeLocalMessage(item.client_id, {
            status: 'sent',
            id: tr.id,
            payload: {
              ...outer.payload,
              transfer_id: tr.id,
              tx_hash: tr.tx_hash,
              block_number: tr.block_number,
              status: 'confirmed',
            },
          })
        } else {
          const p = item.payload as {
            thread_id: number
            sender_address: string
            body: string
            kind: string
            payload: Record<string, unknown>
            client_id: string
            created_at: string
          }
          const { data, error } = await supabase
            .from('crimechat_messages')
            .upsert(
              {
                thread_id: p.thread_id,
                sender_address: p.sender_address,
                body: p.body,
                kind: p.kind,
                payload: p.payload,
                client_id: p.client_id,
                created_at: p.created_at,
              },
              { onConflict: 'client_id' },
            )
            .select()
            .single()
          if (error) throw new Error(error.message)
          const row = data as Record<string, unknown>
          await finalizeLocalMessage(item.client_id, {
            status: 'sent',
            id: row.id as number,
            created_at: row.created_at as string,
          })
        }
        await db.outbox.where('client_id').equals(item.client_id).delete()
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'send failed'
        await db.outbox.where('client_id').equals(item.client_id).modify({
          status: 'failed',
          attempts: item.attempts + 1,
        })
        await db.messages.where('client_id').equals(item.client_id).modify({
          status: 'failed',
          payload: { ...(item.payload as Record<string, unknown>), error: msg },
        })
      }
      notify()
    }
  } finally {
    flushing = false
  }
}

// LOCAL-ONLY mode: deliver queued items straight into Dexie and let the
// scripted bots answer.
async function flushMock(): Promise<void> {
  const queue = await db.outbox.where('status').anyOf('queued', 'failed').toArray()
  for (const item of queue.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (item.kind === 'transfer') {
      const outer = item.payload as { thread_id: number; payload: Record<string, unknown> }
      const tr = await mockDeliverTransfer({
        ...(outer.payload as {
          to: string
          token: string
          amount: number
          memo: string
          from: string
        }),
        thread_id: outer.thread_id,
      })
      await upsertTransfer(tr)
      await finalizeLocalMessage(item.client_id, {
        status: 'sent',
        id: tr.id,
        payload: { ...outer.payload, transfer_id: tr.id, tx_hash: tr.tx_hash, block_number: tr.block_number, status: 'confirmed' },
      })
    } else {
      const p = item.payload as { thread_id: number; sender_address: string; body: string; kind: string; payload: Record<string, unknown>; created_at: string }
      await finalizeLocalMessage(item.client_id, { status: 'sent' })
      await mockScheduleBotReply(p.thread_id, p.sender_address)
    }
    await db.outbox.where('client_id').equals(item.client_id).delete()
    notify()
  }
}

// SW → client message: Background Sync fired.
if (typeof window !== 'undefined') {
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if ((event.data as { type?: string })?.type === 'crimechat-flush-outbox') void flushOutbox()
  })
  // Connectivity restored → flush queued messages (idempotent on client_id).
  window.addEventListener('crimechat:connectivity-restored', () => {
    void flushOutbox()
    void registerBackgroundSync()
  })
}
