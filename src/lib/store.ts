import { useEffect, useState, useSyncExternalStore } from 'react'
import { db, type BalanceRow, type ContractRow, type EscrowRow, type TransferRow } from './db'

// ---------------------------------------------------------------------------
// Minimal live store: every write to Dexie goes through helpers here that
// bump a version counter; components re-query Dexie via useLive().
// ---------------------------------------------------------------------------

let version = 0
const listeners = new Set<() => void>()

export function notify(): void {
  version++
  listeners.forEach((l) => l())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useStoreVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

export function useLive<T>(querier: () => Promise<T> | T, deps: unknown[] = []): T | undefined {
  const [, setV] = useState(0)
  const [data, setData] = useState<T | undefined>(undefined)
  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const r = await querier()
        if (alive) setData(r)
      } catch {
        /* Dexie closed / transient — keep last data */
      }
    }
    void run()
    const un = subscribe(() => void run())
    return () => {
      alive = false
      un()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return data
}

// ---- meta helpers ---------------------------------------------------------

export async function metaGet<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

export async function metaSet(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
  notify()
}

// ---- upsert helpers ---------------------------------------------------------

export async function upsertProfile(row: {
  id: string
  address: string
  alias: string
  reputation: number
  contracts_completed: number
  disputes: number
  last_seen_at: string
}): Promise<void> {
  await db.profiles.put({ ...row, key: row.address.toLowerCase() })
  notify()
}

export async function upsertThread(row: {
  id: number
  participant_a: string
  participant_b: string
  contract_id: number | null
  last_message_at: string
  created_at: string
}): Promise<void> {
  // Normalize to lowercase: addresses are EIP-55 checksummed at generation,
  // and every reader compares participants against a lowercased `me`.
  await db.threads.put({
    ...row,
    participant_a: row.participant_a.toLowerCase(),
    participant_b: row.participant_b.toLowerCase(),
  })
  notify()
}

export async function upsertMessage(row: {
  id: number | string
  thread_id: number
  sender_address: string
  body: string
  kind: 'text' | 'transfer' | 'escrow' | 'system'
  payload: Record<string, unknown>
  client_id: string | null
  created_at: string
  status?: 'pending' | 'sent' | 'failed'
}): Promise<void> {
  await db.messages.put(row)
  notify()
}

export async function upsertTransfer(row: TransferRow): Promise<void> {
  await db.transfers.put(row)
  notify()
}

export async function upsertContract(row: ContractRow): Promise<void> {
  await db.contracts.put(row)
  notify()
}

export async function upsertEscrow(row: EscrowRow): Promise<void> {
  await db.escrows.put(row)
  notify()
}

export async function upsertBalance(row: BalanceRow): Promise<void> {
  await db.balances.put(row)
  notify()
}

// Repair transfer cards written by older builds: the confirm handler used to
// OVERWRITE the optimistic payload (losing token/amount — the "??? " card) and
// the server's system echo created a duplicate. Runs once per boot; matches
// local cards to confirmed server rows by client_id and drops echoes.
export async function cleanupTransferCards(): Promise<void> {
  const locals = await db.messages
    .filter((m) => m.client_id != null && m.kind === 'transfer')
    .toArray()
  let changed = false
  for (const m of locals) {
    const tr = await db.transfers.where('client_id').equals(m.client_id!).first()
    if (!tr) continue
    await db.messages.where('id').equals(m.id).modify((mm) => {
      mm.status = 'sent'
      mm.payload = {
        ...mm.payload,
        transfer_id: tr.id,
        token: tr.token_symbol,
        amount: tr.amount,
        memo: tr.memo,
        to: tr.to_address,
        tx_hash: tr.tx_hash,
        block_number: tr.block_number,
        status: 'confirmed',
      }
    })
    await db.messages
      .where('thread_id')
      .equals(m.thread_id)
      .filter(
        (x) =>
          x.client_id == null &&
          x.kind === 'transfer' &&
          (x.payload as Record<string, unknown> | undefined)?.transfer_id === tr.id,
      )
      .delete()
    changed = true
  }
  if (changed) notify()
}
