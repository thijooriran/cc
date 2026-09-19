import Dexie, { type Table } from 'dexie'

// ---------------------------------------------------------------------------
// Dexie mirrors every table the user can see. All UI reads hit Dexie;
// Supabase writes into Dexie, never straight into React state.
// Column names mirror the crimechat_* Postgres tables (snake_case).
// ---------------------------------------------------------------------------

export interface TokenRow {
  symbol: string
  name: string
  decimals: number
  usd_price: number
}

export interface ProfileRow {
  key: string // lowercase address — Dexie primary key
  id: string // auth uid
  address: string // checksummed display address
  alias: string
  reputation: number
  contracts_completed: number
  disputes: number
  last_seen_at: string
}

export interface ContactRow {
  id?: number
  owner_id: string
  contact_address: string
  nickname: string | null
  created_at?: string
}

export interface ThreadRow {
  id: number
  participant_a: string
  participant_b: string
  contract_id: number | null
  last_message_at: string
  created_at: string
}

export interface MessageRow {
  id: number | string // number from server, negative local ids for pending
  thread_id: number
  sender_address: string
  body: string
  kind: 'text' | 'transfer' | 'escrow' | 'system'
  payload: Record<string, unknown>
  client_id: string | null
  created_at: string
  // local-only fields:
  status?: 'pending' | 'sent' | 'failed'
}

export interface BalanceRow {
  profile_id: string
  token_symbol: string
  amount: number
}

export interface TransferRow {
  id: number
  from_address: string
  to_address: string
  token_symbol: string
  amount: number
  memo: string
  tx_hash: string
  block_number: number
  status: 'pending' | 'confirmed'
  client_id: string | null
  created_at: string
}

export interface ContractRow {
  id: number
  poster_address: string
  title: string
  blurb: string
  reward_token: string
  reward_amount: number
  region: string
  deadline: string
  risk_tier: 'LOW' | 'MEDIUM' | 'EXTREME'
  open: boolean
  created_at: string
}

export interface EscrowRow {
  id: number
  thread_id: number
  contract_id: number | null
  payer_address: string
  payee_address: string
  token_symbol: string
  amount: number
  state: 'PROPOSED' | 'FUNDED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED'
  created_at: string
  updated_at: string
}

export interface OutboxRow {
  client_id: string
  kind: 'message' | 'transfer'
  payload: Record<string, unknown>
  status: 'queued' | 'sending' | 'failed'
  attempts: number
  created_at: string
}

export interface MetaRow {
  key: string
  value: unknown
}

class CrimeChatDB extends Dexie {
  tokens!: Table<TokenRow, string>
  profiles!: Table<ProfileRow, string>
  contacts!: Table<ContactRow, string>
  threads!: Table<ThreadRow, number>
  messages!: Table<MessageRow, number | string>
  balances!: Table<BalanceRow, string>
  transfers!: Table<TransferRow, number>
  contracts!: Table<ContractRow, number>
  escrows!: Table<EscrowRow, number>
  outbox!: Table<OutboxRow, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('crimechat')
    this.version(1).stores({
      tokens: 'symbol',
      profiles: 'key, alias, last_seen_at',
      contacts: '[owner_id+contact_address], owner_id',
      threads: 'id, participant_a, participant_b, last_message_at',
      messages: 'id, thread_id, client_id, created_at',
      balances: '[profile_id+token_symbol], profile_id',
      transfers: 'id, from_address, to_address, created_at',
      contracts: 'id, open, reward_token, risk_tier, deadline, created_at',
      escrows: 'id, thread_id, payer_address, state',
      outbox: 'client_id, status',
      meta: 'key',
    })
    // v2: index transfers by client_id so the boot cleanup can match the
    // optimistic card to its confirmed server row.
    this.version(2).stores({
      transfers: 'id, from_address, to_address, created_at, client_id',
    })
  }
}

export const db = new CrimeChatDB()
