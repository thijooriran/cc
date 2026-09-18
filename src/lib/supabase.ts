import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ONLINE, SUPABASE_ANON_KEY, SUPABASE_URL } from './config'

// Singleton Supabase client. In LOCAL-ONLY mode there is no backend at all.
export const supabase: SupabaseClient | null = ONLINE
  ? createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'crimechat-auth',
      },
      realtime: {
        params: { eventsPerSecond: 10 },
      },
    })
  : null

export function rpc<T>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: { message: string } | null }> {
  if (!supabase) return Promise.resolve({ data: null, error: { message: 'offline' } })
  return supabase.rpc(fn, args) as unknown as Promise<{ data: T | null; error: { message: string } | null }>
}
