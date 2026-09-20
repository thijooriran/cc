-- Web Push infrastructure for CRIMECHAT (shared project — crimechat_ prefix only).
-- 1. Subscription store: one row per browser/device, targeted by operative address.
-- 2. A database webhook (pg_net) that calls the crimechat-push edge function on
--    every message insert, so push fires even when the sender's client vanishes
--    right after sending. The anon key below is public by design (it ships in
--    the client bundle); RLS keeps the data safe.

create table if not exists public.crimechat_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  address text not null,               -- operative address, lowercased
  endpoint text not null unique,       -- push service URL — unique per device
  subscription jsonb not null,         -- full PushSubscription JSON
  created_at timestamptz not null default now()
);

create index if not exists crimechat_push_subscriptions_address_idx
  on public.crimechat_push_subscriptions (address);

alter table public.crimechat_push_subscriptions enable row level security;

-- Operatives manage only their own device subscriptions.
create policy crimechat_push_subscriptions_own
  on public.crimechat_push_subscriptions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.crimechat_push_subscriptions to anon, authenticated;

-- Database webhook → edge function (async via pg_net; never blocks the insert).
create extension if not exists pg_net;

create or replace function public.crimechat_push_webhook()
returns trigger
language plpgsql
as $$
begin
  perform net.http_post(
    url := 'https://jwarmlwtkhbotbfezvuq.functions.supabase.co/crimechat-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp3YXJtbHd0a2hib3RiZmV6dnVxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2MTc3NjcsImV4cCI6MjEwMzE5Mzc2N30.dl2YsE9Fj5a2o5mT-xQUyaWkebTLlTWP41r5nhOp6tc'
    ),
    body := jsonb_build_object('record', row_to_json(new))
  );
  return new;
end
$$;

create trigger crimechat_messages_push
  after insert on public.crimechat_messages
  for each row execute function public.crimechat_push_webhook();
