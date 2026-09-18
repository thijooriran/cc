import { ONLINE } from './config'
import { supabase } from './supabase'
import { db, type ProfileRow } from './db'
import { metaGet, metaSet, notify, upsertProfile } from './store'
import {
  deterministicAlias,
  deterministicCounts,
  deterministicReputation,
  randomAddress,
} from './identity'

export interface Identity {
  userId: string // auth uid (mock mode: synthetic)
  address: string
  alias: string
}

// Boot the identity. Online: anonymous auth (session persisted so a cold
// offline launch still knows who you are); ensure the profile row exists and
// the address is bound server-side on first insert. Mock: local only.
export async function bootIdentity(): Promise<Identity> {
  if (!ONLINE || !supabase) return bootMockIdentity()

  const {
    data: { session },
  } = await supabase.auth.getSession()
  let userId = session?.user?.id
  if (!userId) {
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error || !data.user) throw new Error('anonymous sign-in failed: ' + error?.message)
    userId = data.user.id
  }

  const cached = await metaGet<Identity>('identity')
  if (cached && cached.userId === userId) {
    // Refresh profile into Dexie (session may be cold/offline — tolerate failure)
    const { data } = await supabase.from('crimechat_profiles').select('*').eq('id', userId).maybeSingle()
    if (data) await upsertProfile(mapProfile(data as Record<string, unknown>))
    return cached
  }

  // New (or switched) auth user: generate a fresh mock wallet + alias.
  const address = randomAddress()
  const alias = deterministicAlias(address)
  const reputation = deterministicReputation(address)
  const counts = deterministicCounts(address)
  const row = {
    id: userId,
    address,
    alias,
    reputation,
    contracts_completed: counts.completed,
    disputes: counts.disputes,
    last_seen_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('crimechat_profiles').insert(row)
  if (error) {
    // Row may already exist (retry after a failed boot) — load it.
    const { data } = await supabase.from('crimechat_profiles').select('*').eq('id', userId).maybeSingle()
    if (!data) throw new Error('profile insert failed: ' + error.message)
    await upsertProfile(mapProfile(data as Record<string, unknown>))
    const existing = mapProfile(data as Record<string, unknown>)
    const identity: Identity = { userId, address: existing.address, alias: existing.alias }
    await metaSet('identity', identity)
    return identity
  }
  await upsertProfile(row)
  const identity: Identity = { userId, address, alias }
  await metaSet('identity', identity)
  return identity
}

function mapProfile(r: Record<string, unknown>): Omit<ProfileRow, 'key'> {
  return {
    id: r.id as string,
    address: r.address as string,
    alias: r.alias as string,
    reputation: r.reputation as number,
    contracts_completed: r.contracts_completed as number,
    disputes: r.disputes as number,
    last_seen_at: r.last_seen_at as string,
  }
}

async function bootMockIdentity(): Promise<Identity> {
  const cached = await metaGet<Identity>('identity')
  if (cached) return cached
  const address = randomAddress()
  const alias = deterministicAlias(address)
  const identity: Identity = { userId: 'mock-' + address, address, alias }
  await metaSet('identity', identity)
  await upsertProfile({
    id: identity.userId,
    address,
    alias,
    reputation: deterministicReputation(address),
    contracts_completed: deterministicCounts(address).completed,
    disputes: deterministicCounts(address).disputes,
    last_seen_at: new Date().toISOString(),
  })
  return identity
}

// Switch identity: sign out, wipe IndexedDB, provision a fresh anonymous user
// so two browser profiles can chat with each other live.
export async function switchIdentity(): Promise<Identity> {
  if (supabase) await supabase.auth.signOut()
  await db.delete()
  notify()
  // Re-open the Dexie database (db.delete() closes it)
  db.open().catch(() => undefined)
  if (!supabase) {
    await metaSet('identity', null)
    return bootMockIdentity()
  }
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error || !data.user) throw new Error('anonymous sign-in failed: ' + error?.message)
  const userId = data.user.id
  const address = randomAddress()
  const alias = deterministicAlias(address)
  const row = {
    id: userId,
    address,
    alias,
    reputation: deterministicReputation(address),
    contracts_completed: deterministicCounts(address).completed,
    disputes: deterministicCounts(address).disputes,
    last_seen_at: new Date().toISOString(),
  }
  await supabase.from('crimechat_profiles').insert(row)
  await upsertProfile(row)
  const identity: Identity = { userId, address, alias }
  await metaSet('identity', identity)
  return identity
}
