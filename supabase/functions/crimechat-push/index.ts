// CRIMECHAT push dispatcher.
// Invoked by the crimechat_messages_push database webhook (pg_net) on every
// message insert. Verifies the message is genuine (abuse guard against direct
// calls), resolves the recipient from the thread, and fans out Web Push
// notifications to every device subscribed under the recipient's address.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3'

interface MessageRecord {
  id: number
  thread_id: number
  sender_address: string
  body: string
  kind: string
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!

webpush.setVapidDetails('https://thijooriran.github.io/cc/', VAPID_PUBLIC, VAPID_PRIVATE)

function bodyFor(m: MessageRecord): string {
  const text = (m.body ?? '').slice(0, 120)
  if (m.kind === 'transfer') return 'Sent you a transfer'
  if (m.kind === 'escrow') return 'Escrow update'
  return text.length === 120 ? text + '…' : text
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  let record: MessageRecord
  try {
    const payload = await req.json()
    record = payload.record as MessageRecord
    if (!record?.id || !record?.thread_id) throw new Error('bad payload')
  } catch {
    return Response.json({ error: 'bad payload' }, { status: 400 })
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  // Abuse guard: only relay messages that really exist in the database.
  const { data: message } = await admin
    .from('crimechat_messages')
    .select('id, thread_id, sender_address, body, kind')
    .eq('id', record.id)
    .maybeSingle()
  if (!message) return Response.json({ error: 'no such message' }, { status: 404 })
  const msg = message as unknown as MessageRecord

  const { data: thread } = await admin
    .from('crimechat_threads')
    .select('participant_a, participant_b')
    .eq('id', msg.thread_id)
    .maybeSingle()
  if (!thread) return Response.json({ error: 'no such thread' }, { status: 404 })

  const sender = (msg.sender_address ?? '').toLowerCase()
  const t = thread as unknown as { participant_a: string; participant_b: string }
  const recipient = t.participant_a.toLowerCase() === sender ? t.participant_b : t.participant_a

  const { data: senderProfile } = await admin
    .from('crimechat_profiles')
    .select('alias')
    .ilike('address', msg.sender_address)
    .maybeSingle()
  const alias = (senderProfile as unknown as { alias: string } | null)?.alias

  const { data: subs } = await admin
    .from('crimechat_push_subscriptions')
    .select('id, endpoint, subscription')
    .ilike('address', recipient)
  if (!subs?.length) return Response.json({ delivered: 0 }, { status: 200 })

  const pushPayload = JSON.stringify({
    title: alias ? `${alias} · new message` : 'New message',
    body: bodyFor(msg),
    threadId: msg.thread_id,
    kind: msg.kind,
  })

  let delivered = 0
  const dead: string[] = []
  for (const row of subs as unknown as { id: string; subscription: unknown }[]) {
    try {
      await webpush.sendNotification(row.subscription as never, pushPayload)
      delivered++
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) dead.push(row.id)
      else console.error('push send failed', status, (e as Error).message)
    }
  }
  if (dead.length) await admin.from('crimechat_push_subscriptions').delete().in('id', dead)

  return Response.json({ delivered, dead: dead.length }, { status: 200 })
})
