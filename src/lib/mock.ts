import { db, type ContractRow, type ProfileRow, type TransferRow } from './db'
import { metaGet, metaSet, notify, upsertEscrow, upsertMessage } from './store'
import { TOKENS } from './tokens'
import { fakeTxHash } from './format'

// ---------------------------------------------------------------------------
// LOCAL-ONLY mode: seeded mock operatives, contracts, and scripted bot
// replies in a clipped, paranoid register. No backend involved at all.
// ---------------------------------------------------------------------------

export interface Bot {
  address: string
  alias: string
}

export const BOTS: Bot[] = [
  { address: '0x71B4c9D2e8F30a41C66d0E582F93a7B1eA4cD805', alias: 'Pale Horse' },
  { address: '0x9E02c4B7a15D36f0881e2A6C5dB490F7b3E18a24', alias: 'The Locksmith' },
  { address: '0x3A8fD1c6B952e4071aA94D20C55b78E64f3B0c91', alias: 'Number Nine' },
  { address: '0xC47bE02A19F35d61B0e2876C4a3D5f8092e1Bb38', alias: 'Vesper' },
]

const REPLY_POOL = [
  'moving now.',
  'half up front. non-negotiable.',
  "don't use this channel again.",
  'the harbor is watched. wait for fog.',
  'ask for the night clerk. say nothing else.',
  'it is done. check the third locker.',
  'prices changed. you did not hear it from me.',
  'burn this message in your head, not your pocket.',
  'tomorrow. the usual place. come alone.',
  'if this leaks, I was never here.',
]

const seededRandom = (seed: string) => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

export async function seedMockData(identity: { userId: string; address: string; alias: string }): Promise<void> {
  const seeded = await metaGet<boolean>('mock-seeded')
  if (seeded) return
  await db.tokens.bulkPut(TOKENS as never[])

  const botProfiles: ProfileRow[] = BOTS.map((b, i) => {
    const rnd = seededRandom(b.address)
    return {
      key: b.address.toLowerCase(),
      id: 'bot-' + i,
      address: b.address,
      alias: b.alias,
      reputation: 35 + Math.floor(rnd() * 60),
      contracts_completed: Math.floor(rnd() * 20),
      disputes: Math.floor(rnd() * 4),
      last_seen_at: new Date().toISOString(),
    }
  })
  await db.profiles.bulkPut(botProfiles)

  // My balances, deterministic from my address.
  const rnd = seededRandom(identity.address)
  const scale: Record<string, number> = {
    ETH: 12, WBTC: 0.4, USDT: 9000, USDC: 9000, DAI: 9000,
    LINK: 800, UNI: 600, AAVE: 120, SHIB: 5e7, PEPE: 5e7,
  }
  for (const t of TOKENS) {
    await db.balances.put({
      profile_id: identity.userId,
      token_symbol: t.symbol,
      amount: Math.round(rnd() * scale[t.symbol] * 1e6) / 1e6,
    })
  }
  for (const b of botProfiles) {
    const brnd = seededRandom(b.address)
    for (const t of TOKENS) {
      await db.balances.put({
        profile_id: b.id,
        token_symbol: t.symbol,
        amount: Math.round(brnd() * scale[t.symbol] * 1e6) / 1e6,
      })
    }
  }

  const now = Date.now()
  const contracts: ContractRow[] = MOCK_CONTRACTS.map((c, i) => ({
    id: i + 1,
    poster_address: c.poster,
    title: c.title,
    blurb: c.blurb,
    reward_token: c.token,
    reward_amount: c.amount,
    region: c.region,
    deadline: new Date(now + c.days * 86400000).toISOString(),
    risk_tier: c.risk,
    open: true,
    created_at: new Date(now - (i + 1) * 3600000).toISOString(),
  }))
  await db.contracts.bulkPut(contracts)

  // A welcome thread from Pale Horse.
  const a = identity.address.toLowerCase()
  const b = BOTS[0].address.toLowerCase()
  const thread = {
    id: 1,
    participant_a: a < b ? a : b,
    participant_b: a < b ? b : a,
    contract_id: null,
    last_message_at: new Date(now - 300000).toISOString(),
    created_at: new Date(now - 3600000).toISOString(),
  }
  await db.threads.put(thread)
  await db.messages.bulkPut([
    {
      id: -1,
      thread_id: 1,
      sender_address: BOTS[0].address,
      body: 'you are new. everyone is new once. keep your head down and your wallet empty.',
      kind: 'text',
      payload: {},
      client_id: null,
      created_at: new Date(now - 900000).toISOString(),
      status: 'sent',
    },
    {
      id: -2,
      thread_id: 1,
      sender_address: BOTS[0].address,
      body: 'check the board. there is work for someone with steady hands.',
      kind: 'text',
      payload: {},
      client_id: null,
      created_at: new Date(now - 300000).toISOString(),
      status: 'sent',
    },
  ])

  await metaSet('mock-block', 21084571)
  await metaSet('mock-seeded', true)
  notify()
}

export function isBotAddress(address: string): Bot | undefined {
  const l = address.toLowerCase()
  return BOTS.find((b) => b.address.toLowerCase() === l)
}

let localMsgId = -1000
let localTransferId = -1

async function nextBlock(): Promise<number> {
  const n = ((await metaGet<number>('mock-block')) ?? 21084570) + 1 + Math.floor(Math.random() * 3)
  await metaSet('mock-block', n)
  return n
}

// After the caller's message lands, scripted bot replies arrive on a
// 1.5–4s delay in a clipped, paranoid register.
export async function mockScheduleBotReply(threadId: number, senderAddress: string): Promise<void> {
  const thread = await db.threads.get(threadId)
  if (!thread) return
  const other = thread.participant_a === senderAddress.toLowerCase() ? thread.participant_b : thread.participant_a
  const bot = isBotAddress(other)
  if (!bot) return
  const delay = 1500 + Math.random() * 2500
  const reply = REPLY_POOL[Math.floor(Math.random() * REPLY_POOL.length)]
  setTimeout(() => {
    void (async () => {
      localMsgId -= 1
      const now = new Date().toISOString()
      await upsertMessage({
        id: localMsgId,
        thread_id: threadId,
        sender_address: bot.address,
        body: reply,
        kind: 'text',
        payload: {},
        client_id: null,
        created_at: now,
        status: 'sent',
      })
      await db.threads.where('id').equals(threadId).modify({ last_message_at: now })
      notify()
    })()
  }, delay)
}

export async function mockDeliverTransfer(p: {
  to: string
  token: string
  amount: number
  memo: string
  thread_id: number
  from: string
}): Promise<TransferRow> {
  // Debit sender, credit recipient if we hold their balance locally.
  const me = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === p.from.toLowerCase())
  if (me) {
    const bal = await db.balances.get([me.id, p.token])
    if (bal) await db.balances.put({ ...bal, amount: Math.max(0, bal.amount - p.amount) })
  }
  const recipient = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === p.to.toLowerCase())
  if (recipient) {
    const bal = await db.balances.get([recipient.id, p.token])
    await db.balances.put({
      profile_id: recipient.id,
      token_symbol: p.token,
      amount: (bal?.amount ?? 0) + p.amount,
    })
  }
  localTransferId -= 1
  const tr: TransferRow = {
    id: localTransferId,
    from_address: p.from,
    to_address: p.to,
    token_symbol: p.token,
    amount: p.amount,
    memo: p.memo,
    tx_hash: fakeTxHash(),
    block_number: await nextBlock(),
    status: 'confirmed',
    client_id: null,
    created_at: new Date().toISOString(),
  }
  return tr
}

// Mock escrow helpers (local state machine mirroring the RPC guards).
export async function mockEscrowTransition(
  escrowId: number,
  transition: 'fund' | 'deliver' | 'release' | 'dispute' | 'refund',
  caller: string,
): Promise<void> {
  const e = await db.escrows.get(escrowId)
  if (!e) throw new Error('no such escrow')
  const ok =
    (transition === 'fund' && e.state === 'PROPOSED' && e.payer_address.toLowerCase() === caller.toLowerCase()) ||
    (transition === 'deliver' && e.state === 'FUNDED' && e.payee_address.toLowerCase() === caller.toLowerCase()) ||
    (transition === 'release' && e.state === 'DELIVERED' && e.payer_address.toLowerCase() === caller.toLowerCase()) ||
    (transition === 'dispute' &&
      ['FUNDED', 'DELIVERED'].includes(e.state) &&
      [e.payer_address, e.payee_address].some((a) => a.toLowerCase() === caller.toLowerCase())) ||
    (transition === 'refund' && e.state === 'DISPUTED' && e.payer_address.toLowerCase() === caller.toLowerCase())
  if (!ok) throw new Error('transition not allowed')

  const stateMap: Record<string, EscrowState> = {
    fund: 'FUNDED',
    deliver: 'DELIVERED',
    release: 'RELEASED',
    dispute: 'DISPUTED',
    refund: 'REFUNDED',
  }
  const next = stateMap[transition]
  if (transition === 'fund') {
    const payer = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === e.payer_address.toLowerCase())
    if (payer) {
      const bal = await db.balances.get([payer.id, e.token_symbol])
      if (!bal || bal.amount < e.amount) throw new Error('insufficient balance')
      await db.balances.put({ ...bal, amount: bal.amount - e.amount })
    }
  }
  if (transition === 'release') {
    const payee = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === e.payee_address.toLowerCase())
    if (payee) {
      const bal = await db.balances.get([payee.id, e.token_symbol])
      await db.balances.put({ profile_id: payee.id, token_symbol: e.token_symbol, amount: (bal?.amount ?? 0) + e.amount })
    }
    for (const addr of [e.payer_address, e.payee_address]) {
      const prof = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === addr.toLowerCase())
      if (prof) await db.profiles.where('key').equals(prof.address.toLowerCase()).modify({ reputation: Math.min(100, prof.reputation + 2), contracts_completed: prof.contracts_completed + 1 })
    }
  }
  if (transition === 'dispute') {
    for (const addr of [e.payer_address, e.payee_address]) {
      const prof = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === addr.toLowerCase())
      if (prof) await db.profiles.where('key').equals(prof.address.toLowerCase()).modify({ reputation: Math.max(0, prof.reputation - 5), disputes: prof.disputes + 1 })
    }
  }
  if (transition === 'refund') {
    const payer = (await db.profiles.toArray()).find((pr) => pr.address.toLowerCase() === e.payer_address.toLowerCase())
    if (payer) {
      const bal = await db.balances.get([payer.id, e.token_symbol])
      await db.balances.put({ profile_id: payer.id, token_symbol: e.token_symbol, amount: (bal?.amount ?? 0) + e.amount })
    }
  }
  const now = new Date().toISOString()
  await upsertEscrow({ ...e, state: next, updated_at: now })
  await upsertMessage({
    id: --localMsgId,
    thread_id: e.thread_id,
    sender_address: caller,
    body: 'escrow ' + next.toLowerCase(),
    kind: 'escrow',
    payload: { escrow_id: e.id, state: next, token: e.token_symbol, amount: String(e.amount), payer: e.payer_address, payee: e.payee_address },
    client_id: null,
    created_at: now,
    status: 'sent',
  })
  await db.threads.where('id').equals(e.thread_id).modify({ last_message_at: now })
  notify()
}

type EscrowState = 'PROPOSED' | 'FUNDED' | 'DELIVERED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED'

const MOCK_CONTRACTS: {
  poster: string
  title: string
  blurb: string
  token: string
  amount: number
  region: string
  days: number
  risk: 'LOW' | 'MEDIUM' | 'EXTREME'
}[] = [
  { poster: BOTS[1].address, title: 'The Unwilling Briefcase', blurb: 'Retrieve a briefcase from a man who does not want to give it up. The case changes hands at midnight; be elsewhere by one.', token: 'ETH', amount: 4.2, region: 'Harbor District', days: 6, risk: 'MEDIUM' },
  { poster: BOTS[2].address, title: 'Amnesia on Commission', blurb: 'Convince a witness to develop amnesia before Friday. No theatrical masks — just a quiet word that lands.', token: 'USDC', amount: 18000, region: 'Civic Center', days: 4, risk: 'LOW' },
  { poster: BOTS[3].address, title: 'Yacht off the Books', blurb: 'Make a yacht disappear off the books. Paper trail first, hull second. The marina has cameras and a lazy guard.', token: 'WBTC', amount: 0.6, region: 'North Marina', days: 12, risk: 'EXTREME' },
  { poster: BOTS[0].address, title: 'The Lost Weekend', blurb: 'A ledger went missing for one weekend. Return it without the weekend. The owner suspects everyone, so suspect no one.', token: 'DAI', amount: 9500, region: 'Old Financial Quarter', days: 8, risk: 'LOW' },
  { poster: BOTS[1].address, title: 'A Quiet Exit', blurb: 'An associate needs to stop being an associate. New name, new coast, no goodbyes. Logistics only; sentiment extra.', token: 'ETH', amount: 2.75, region: 'Union Station', days: 15, risk: 'MEDIUM' },
  { poster: BOTS[2].address, title: 'The Painted Pigeon', blurb: 'A pigeon of considerable sentimental value was painted the wrong color. Restore the original, then forget the address.', token: 'LINK', amount: 420, region: 'Botanical Heights', days: 3, risk: 'LOW' },
  { poster: BOTS[3].address, title: 'Silence in Row 4', blurb: 'Row 4 of the Grand Odeon must remain silent for one performance. The ushers are honest; the audience is not.', token: 'UNI', amount: 3100, region: 'Grand Odeon', days: 5, risk: 'MEDIUM' },
  { poster: BOTS[0].address, title: 'The Borrowed Constable', blurb: "Borrow a constable's helmet for forty-eight hours. It must come back with the badge still attached and the story plausible.", token: 'AAVE', amount: 88, region: 'Precinct Row', days: 9, risk: 'EXTREME' },
  { poster: BOTS[1].address, title: 'Cold Storage', blurb: 'Something valuable is being kept too cold. Warm it up to exactly room temperature and the key will stop mattering.', token: 'USDT', amount: 24000, region: 'Dockside Coldstore', days: 7, risk: 'EXTREME' },
  { poster: BOTS[2].address, title: 'The Polite Heist', blurb: 'Remove a painting, leave a receipt. The receipt must rhyme. Frame excluded unless the rhyme is exceptional.', token: 'ETH', amount: 1.1, region: 'Meridian Gallery', days: 20, risk: 'LOW' },
]
