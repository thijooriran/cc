-- CRIMECHAT — initial schema
-- All objects are prefixed with crimechat_ so nothing in this shared project collides.
-- Fictional demo data only: no real chain, no real value.

create extension if not exists citext;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Static token registry (fake USD prices for the demo)
create table if not exists public.crimechat_tokens (
  symbol text primary key,
  name text not null,
  decimals int not null,
  usd_price numeric not null
);

create table if not exists public.crimechat_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  address citext unique not null,
  alias text not null,
  reputation int not null default 50 check (reputation between 0 and 100),
  contracts_completed int not null default 0,
  disputes int not null default 0,
  last_seen_at timestamptz not null default now()
);

create table if not exists public.crimechat_contacts (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.crimechat_profiles (id) on delete cascade,
  contact_address citext not null,
  nickname text,
  created_at timestamptz not null default now(),
  unique (owner_id, contact_address)
);

-- participant_a < participant_b (enforced by trigger below)
create table if not exists public.crimechat_threads (
  id bigint generated always as identity primary key,
  participant_a citext not null,
  participant_b citext not null,
  contract_id bigint null,
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (participant_a, participant_b),
  check (participant_a < participant_b)
);

create table if not exists public.crimechat_messages (
  id bigint generated always as identity primary key,
  thread_id bigint not null references public.crimechat_threads (id) on delete cascade,
  sender_address citext not null,
  body text not null default '',
  kind text not null default 'text' check (kind in ('text', 'transfer', 'escrow', 'system')),
  payload jsonb not null default '{}'::jsonb,
  client_id uuid unique,          -- idempotent replay from the offline outbox
  created_at timestamptz not null default now()
);

create table if not exists public.crimechat_balances (
  profile_id uuid not null references public.crimechat_profiles (id) on delete cascade,
  token_symbol text not null references public.crimechat_tokens (symbol),
  amount numeric(38, 18) not null default 0 check (amount >= 0),
  primary key (profile_id, token_symbol)
);

create table if not exists public.crimechat_transfers (
  id bigint generated always as identity primary key,
  from_address citext not null,
  to_address citext not null,
  token_symbol text not null references public.crimechat_tokens (symbol),
  amount numeric(38, 18) not null check (amount > 0),
  memo text not null default '',
  tx_hash text not null,
  block_number bigint not null,
  status text not null default 'confirmed' check (status in ('pending', 'confirmed')),
  client_id uuid unique,          -- idempotent replay
  created_at timestamptz not null default now()
);

create table if not exists public.crimechat_contracts (
  id bigint generated always as identity primary key,
  poster_address citext not null,
  title text not null,
  blurb text not null,
  reward_token text not null references public.crimechat_tokens (symbol),
  reward_amount numeric(38, 18) not null check (reward_amount > 0),
  region text not null,
  deadline timestamptz not null,
  risk_tier text not null default 'LOW' check (risk_tier in ('LOW', 'MEDIUM', 'EXTREME')),
  open boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.crimechat_escrows (
  id bigint generated always as identity primary key,
  thread_id bigint not null references public.crimechat_threads (id) on delete cascade,
  contract_id bigint null references public.crimechat_contracts (id) on delete set null,
  payer_address citext not null,
  payee_address citext not null,
  token_symbol text not null references public.crimechat_tokens (symbol),
  amount numeric(38, 18) not null check (amount > 0),
  state text not null default 'PROPOSED'
    check (state in ('PROPOSED', 'FUNDED', 'DELIVERED', 'RELEASED', 'DISPUTED', 'REFUNDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence if not exists public.crimechat_block_seq start with 21084571;

-- ---------------------------------------------------------------------------
-- Helpers (security definer so RLS policies can resolve the caller's address)
-- ---------------------------------------------------------------------------

create or replace function public.crimechat_my_address()
returns citext
language sql stable security definer set search_path = public as
$$ select address from public.crimechat_profiles where id = auth.uid() $$;

create or replace function public.crimechat_my_profile_id()
returns uuid
language sql stable security definer set search_path = public as
$$ select id from public.crimechat_profiles where id = auth.uid() $$;

create or replace function public.crimechat_is_thread_participant(p_thread_id bigint)
returns boolean
language sql stable security definer set search_path = public as
$$
  select exists (
    select 1 from public.crimechat_threads t
    where t.id = p_thread_id
      and crimechat_my_address() in (t.participant_a, t.participant_b)
  )
$$;

-- Keep threads canonical: a < b, and stamp last_message_at on new messages.
create or replace function public.crimechat_normalize_thread()
returns trigger language plpgsql set search_path = public as $$
declare lo citext; hi citext;
begin
  lo := least(new.participant_a, new.participant_b);
  hi := greatest(new.participant_a, new.participant_b);
  new.participant_a := lo;
  new.participant_b := hi;
  return new;
end $$;

drop trigger if exists crimechat_threads_normalize on public.crimechat_threads;
create trigger crimechat_threads_normalize
  before insert on public.crimechat_threads
  for each row execute function public.crimechat_normalize_thread();

create or replace function public.crimechat_touch_thread()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.crimechat_threads set last_message_at = new.created_at where id = new.thread_id;
  update public.crimechat_profiles set last_seen_at = now() where address = new.sender_address;
  return new;
end $$;

drop trigger if exists crimechat_messages_touch on public.crimechat_messages;
create trigger crimechat_messages_touch
  after insert on public.crimechat_messages
  for each row execute function public.crimechat_touch_thread();

-- Deterministically seed balances for a fresh profile, derived from the address.
create or replace function public.crimechat_seed_balances()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.crimechat_balances (profile_id, token_symbol, amount)
  select new.id, t.symbol,
         (abs(('x' || substr(md5(lower(new.address::text) || t.symbol), 1, 15))::bit(60)::bigint))
           / 1e18
           * case t.symbol
               when 'ETH'  then 12
               when 'WBTC' then 0.4
               when 'USDT' then 9000
               when 'USDC' then 9000
               when 'DAI'  then 9000
               when 'LINK' then 800
               when 'UNI'  then 600
               when 'AAVE' then 120
               else 50000000  -- SHIB / PEPE
             end
  from public.crimechat_tokens t;
  return new;
end $$;

drop trigger if exists crimechat_profiles_seed on public.crimechat_profiles;
create trigger crimechat_profiles_seed
  after insert on public.crimechat_profiles
  for each row execute function public.crimechat_seed_balances();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.crimechat_tokens enable row level security;
alter table public.crimechat_profiles enable row level security;
alter table public.crimechat_contacts enable row level security;
alter table public.crimechat_threads enable row level security;
alter table public.crimechat_messages enable row level security;
alter table public.crimechat_balances enable row level security;
alter table public.crimechat_transfers enable row level security;
alter table public.crimechat_contracts enable row level security;
alter table public.crimechat_escrows enable row level security;

create policy crimechat_tokens_read on public.crimechat_tokens for select to authenticated using (true);

create policy crimechat_profiles_read on public.crimechat_profiles for select to authenticated using (true);
create policy crimechat_profiles_insert_self on public.crimechat_profiles for insert to authenticated
  with check (id = auth.uid());
-- Address becomes server-owned after first insert: no update/delete policies on purpose.

create policy crimechat_contacts_all on public.crimechat_contacts for all to authenticated
  using (owner_id = crimechat_my_profile_id())
  with check (owner_id = crimechat_my_profile_id());

create policy crimechat_threads_read on public.crimechat_threads for select to authenticated
  using (crimechat_my_address() in (participant_a, participant_b));
create policy crimechat_threads_insert on public.crimechat_threads for insert to authenticated
  with check (crimechat_my_address() in (participant_a, participant_b));

create policy crimechat_messages_read on public.crimechat_messages for select to authenticated
  using (crimechat_is_thread_participant(thread_id));
create policy crimechat_messages_insert on public.crimechat_messages for insert to authenticated
  with check (
    sender_address = crimechat_my_address()
    and crimechat_is_thread_participant(thread_id)
  );

create policy crimechat_balances_read on public.crimechat_balances for select to authenticated
  using (profile_id = crimechat_my_profile_id());

create policy crimechat_transfers_read on public.crimechat_transfers for select to authenticated
  using (crimechat_my_address() in (from_address, to_address));

create policy crimechat_contracts_read on public.crimechat_contracts for select to authenticated using (true);
create policy crimechat_contracts_insert on public.crimechat_contracts for insert to authenticated
  with check (poster_address = crimechat_my_address());
create policy crimechat_contracts_close on public.crimechat_contracts for update to authenticated
  using (poster_address = crimechat_my_address())
  with check (poster_address = crimechat_my_address());

create policy crimechat_escrows_read on public.crimechat_escrows for select to authenticated
  using (crimechat_is_thread_participant(thread_id));

-- ---------------------------------------------------------------------------
-- RPCs — all balance movement and escrow transitions are atomic server-side
-- ---------------------------------------------------------------------------

-- Open or reuse the canonical thread between the caller and a counterparty.
create or replace function public.crimechat_open_thread(p_with citext, p_contract_id bigint default null)
returns public.crimechat_threads language plpgsql security definer set search_path = public as $$
declare me citext; other citext; lo citext; hi citext; t public.crimechat_threads;
begin
  me := crimechat_my_address();
  if p_with is null or lower(p_with::text) !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid counterparty address';
  end if;
  other := p_with;
  if lower(other::text) = lower(me::text) then
    raise exception 'cannot open a channel with yourself';
  end if;
  if not exists (select 1 from public.crimechat_profiles where address = other) then
    raise exception 'no such operative on this network';
  end if;
  lo := least(me, other); hi := greatest(me, other);
  insert into public.crimechat_threads (participant_a, participant_b, contract_id)
  values (lo, hi, p_contract_id)
  on conflict (participant_a, participant_b) do nothing;
  select * into t from public.crimechat_threads where participant_a = lo and participant_b = hi;
  return t;
end $$;

-- Post a system message into a thread (used by the RPCs below).
create or replace function public.crimechat_post_system(
  p_thread_id bigint, p_body text, p_kind text default 'system', p_payload jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.crimechat_messages (thread_id, sender_address, body, kind, payload)
  values (p_thread_id, crimechat_my_address(), p_body, p_kind, p_payload);
end $$;

-- Atomic transfer: idempotent on client_id, guarded balance, posts a transfer card.
create or replace function public.crimechat_send_transfer(
  p_to citext, p_token text, p_amount numeric, p_memo text default '',
  p_thread_id bigint default null, p_client_id uuid default null)
returns public.crimechat_transfers language plpgsql security definer set search_path = public as $$
declare me citext; from_id uuid; to_id uuid; existing public.crimechat_transfers; tr public.crimechat_transfers;
begin
  if p_client_id is not null then
    select * into existing from public.crimechat_transfers where client_id = p_client_id;
    if found then return existing; end if;
  end if;
  me := crimechat_my_address();
  if p_to is null or lower(p_to::text) !~ '^0x[0-9a-f]{40}$' then
    raise exception 'invalid recipient address';
  end if;
  if lower(p_to::text) = lower(me::text) then
    raise exception 'sending to yourself is bad for business';
  end if;
  select id into to_id from public.crimechat_profiles where address = p_to;
  if not found then raise exception 'unknown recipient'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  select id into from_id from public.crimechat_profiles where address = me for update;
  update public.crimechat_balances
     set amount = amount - p_amount
   where profile_id = from_id and token_symbol = p_token and amount >= p_amount;
  if not found then raise exception 'insufficient % balance', p_token; end if;
  insert into public.crimechat_balances (profile_id, token_symbol, amount)
  values (to_id, p_token, p_amount)
  on conflict (profile_id, token_symbol) do update set amount = public.crimechat_balances.amount + p_amount;
  insert into public.crimechat_transfers
    (from_address, to_address, token_symbol, amount, memo, tx_hash, block_number, client_id)
  values (me, p_to, p_token, p_amount, coalesce(p_memo, ''),
          '0x' || encode(gen_random_bytes(32), 'hex'), nextval('public.crimechat_block_seq'), p_client_id)
  returning * into tr;
  if p_thread_id is not null and crimechat_is_thread_participant(p_thread_id) then
    perform public.crimechat_post_system(p_thread_id, 'transfer', 'transfer',
      jsonb_build_object('transfer_id', tr.id, 'token', tr.token_symbol, 'amount', tr.amount::text,
                         'memo', tr.memo, 'tx_hash', tr.tx_hash, 'block_number', tr.block_number,
                         'direction', 'out', 'counterparty', tr.to_address::text));
  end if;
  return tr;
end $$;

create or replace function public.crimechat_post_contract(
  p_title text, p_blurb text, p_token text, p_amount numeric,
  p_region text, p_deadline timestamptz, p_risk_tier text)
returns public.crimechat_contracts language plpgsql security definer set search_path = public as $$
declare c public.crimechat_contracts;
begin
  if p_title is null or length(trim(p_title)) < 4 then raise exception 'title too short'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'reward must be positive'; end if;
  insert into public.crimechat_contracts
    (poster_address, title, blurb, reward_token, reward_amount, region, deadline, risk_tier)
  values (crimechat_my_address(), trim(p_title), coalesce(p_blurb, ''), p_token, p_amount,
          coalesce(p_region, 'Undisclosed'), p_deadline, upper(coalesce(p_risk_tier, 'LOW')))
  returning * into c;
  return c;
end $$;

-- Escrow state machine. Transitions are guarded by state and caller identity.
create or replace function public.crimechat_escrow_create(
  p_thread_id bigint, p_token text, p_amount numeric, p_contract_id bigint default null)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare t public.crimechat_threads; me citext; e public.crimechat_escrows;
begin
  me := crimechat_my_address();
  if not crimechat_is_thread_participant(p_thread_id) then raise exception 'not your channel'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'amount must be positive'; end if;
  select * into t from public.crimechat_threads where id = p_thread_id;
  insert into public.crimechat_escrows
    (thread_id, contract_id, payer_address, payee_address, token_symbol, amount, state)
  values (p_thread_id, p_contract_id, me,
          case when lower(t.participant_a::text) = lower(me::text) then t.participant_b else t.participant_a end,
          p_token, p_amount, 'PROPOSED')
  returning * into e;
  perform public.crimechat_post_system(p_thread_id, 'escrow proposed', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol,
                       'amount', e.amount::text, 'payer', e.payer_address::text, 'payee', e.payee_address::text));
  return e;
end $$;

create or replace function public.crimechat_escrow_fund(p_escrow_id bigint)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare me citext; e public.crimechat_escrows; from_id uuid;
begin
  me := crimechat_my_address();
  select * into e from public.crimechat_escrows where id = p_escrow_id for update;
  if not found then raise exception 'no such escrow'; end if;
  if lower(e.payer_address::text) != lower(me::text) then raise exception 'only the payer can fund'; end if;
  if e.state != 'PROPOSED' then raise exception 'escrow is not in PROPOSED state'; end if;
  select id into from_id from public.crimechat_profiles where address = me for update;
  update public.crimechat_balances
     set amount = amount - e.amount
   where profile_id = from_id and token_symbol = e.token_symbol and amount >= e.amount;
  if not found then raise exception 'insufficient % balance', e.token_symbol; end if;
  update public.crimechat_escrows set state = 'FUNDED', updated_at = now() where id = e.id returning * into e;
  perform public.crimechat_post_system(e.thread_id, 'escrow funded', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol, 'amount', e.amount::text));
  return e;
end $$;

create or replace function public.crimechat_escrow_deliver(p_escrow_id bigint)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare me citext; e public.crimechat_escrows;
begin
  me := crimechat_my_address();
  select * into e from public.crimechat_escrows where id = p_escrow_id for update;
  if not found then raise exception 'no such escrow'; end if;
  if lower(e.payee_address::text) != lower(me::text) then raise exception 'only the payee can mark delivered'; end if;
  if e.state != 'FUNDED' then raise exception 'escrow is not FUNDED'; end if;
  update public.crimechat_escrows set state = 'DELIVERED', updated_at = now() where id = e.id returning * into e;
  perform public.crimechat_post_system(e.thread_id, 'escrow delivered', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol, 'amount', e.amount::text));
  return e;
end $$;

create or replace function public.crimechat_escrow_release(p_escrow_id bigint)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare me citext; e public.crimechat_escrows; to_id uuid;
begin
  me := crimechat_my_address();
  select * into e from public.crimechat_escrows where id = p_escrow_id for update;
  if not found then raise exception 'no such escrow'; end if;
  if lower(e.payer_address::text) != lower(me::text) then raise exception 'only the payer can release'; end if;
  if e.state != 'DELIVERED' then raise exception 'escrow is not DELIVERED'; end if;
  select id into to_id from public.crimechat_profiles where address = e.payee_address for update;
  insert into public.crimechat_balances (profile_id, token_symbol, amount)
  values (to_id, e.token_symbol, e.amount)
  on conflict (profile_id, token_symbol) do update set amount = public.crimechat_balances.amount + e.amount;
  update public.crimechat_profiles
     set reputation = least(100, reputation + 2), contracts_completed = contracts_completed + 1
   where address in (e.payer_address, e.payee_address);
  update public.crimechat_escrows set state = 'RELEASED', updated_at = now() where id = e.id returning * into e;
  perform public.crimechat_post_system(e.thread_id, 'escrow released', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol, 'amount', e.amount::text));
  return e;
end $$;

create or replace function public.crimechat_escrow_dispute(p_escrow_id bigint)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare me citext; e public.crimechat_escrows;
begin
  me := crimechat_my_address();
  select * into e from public.crimechat_escrows where id = p_escrow_id for update;
  if not found then raise exception 'no such escrow'; end if;
  if lower(me::text) not in (lower(e.payer_address::text), lower(e.payee_address::text)) then
    raise exception 'not a party to this escrow';
  end if;
  if e.state not in ('FUNDED', 'DELIVERED') then raise exception 'escrow cannot be disputed now'; end if;
  update public.crimechat_profiles
     set reputation = greatest(0, reputation - 5), disputes = disputes + 1
   where address in (e.payer_address, e.payee_address);
  update public.crimechat_escrows set state = 'DISPUTED', updated_at = now() where id = e.id returning * into e;
  perform public.crimechat_post_system(e.thread_id, 'escrow disputed', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol, 'amount', e.amount::text));
  return e;
end $$;

create or replace function public.crimechat_escrow_refund(p_escrow_id bigint)
returns public.crimechat_escrows language plpgsql security definer set search_path = public as $$
declare me citext; e public.crimechat_escrows; from_id uuid;
begin
  me := crimechat_my_address();
  select * into e from public.crimechat_escrows where id = p_escrow_id for update;
  if not found then raise exception 'no such escrow'; end if;
  if lower(e.payer_address::text) != lower(me::text) then raise exception 'only the payer can refund'; end if;
  if e.state != 'DISPUTED' then raise exception 'escrow is not DISPUTED'; end if;
  select id into from_id from public.crimechat_profiles where address = me for update;
  insert into public.crimechat_balances (profile_id, token_symbol, amount)
  values (from_id, e.token_symbol, e.amount)
  on conflict (profile_id, token_symbol) do update set amount = public.crimechat_balances.amount + e.amount;
  update public.crimechat_escrows set state = 'REFUNDED', updated_at = now() where id = e.id returning * into e;
  perform public.crimechat_post_system(e.thread_id, 'escrow refunded', 'escrow',
    jsonb_build_object('escrow_id', e.id, 'state', e.state, 'token', e.token_symbol, 'amount', e.amount::text));
  return e;
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_messages') then
    execute 'alter publication supabase_realtime add table public.crimechat_messages';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_threads') then
    execute 'alter publication supabase_realtime add table public.crimechat_threads';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_transfers') then
    execute 'alter publication supabase_realtime add table public.crimechat_transfers';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_escrows') then
    execute 'alter publication supabase_realtime add table public.crimechat_escrows';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_contracts') then
    execute 'alter publication supabase_realtime add table public.crimechat_contracts';
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crimechat_profiles') then
    execute 'alter publication supabase_realtime add table public.crimechat_profiles';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Seed: token registry + fictional contract listings (no real counterparties)
-- ---------------------------------------------------------------------------

insert into public.crimechat_tokens (symbol, name, decimals, usd_price) values
  ('ETH',  'Ether',        18, 3421.50),
  ('WBTC', 'Wrapped BTC',   8, 67400.00),
  ('USDT', 'Tether USD',    6, 1.00),
  ('USDC', 'USD Coin',      6, 1.00),
  ('DAI',  'Dai',          18, 1.00),
  ('LINK', 'Chainlink',    18, 17.40),
  ('UNI',  'Uniswap',      18, 9.80),
  ('AAVE', 'Aave',         18, 152.30),
  ('SHIB', 'Shiba Inu',    18, 0.0000212),
  ('PEPE', 'Pepe',         18, 0.00000891)
on conflict (symbol) do nothing;

insert into public.crimechat_contracts
  (poster_address, title, blurb, reward_token, reward_amount, region, deadline, risk_tier) values
  ('0x7B3f9a1C4dE82b94F7A1d205c66B10c884e2D1a5', 'The Unwilling Briefcase',
   'Retrieve a briefcase from a man who does not want to give it up. The case changes hands at midnight; be elsewhere by one.',
   'ETH', 4.2, 'Harbor District', now() + interval '6 days', 'MEDIUM'),
  ('0x91c4Ee02Ab0D5F9378c1B6a3F44d90E7aA2cB3d7', 'Amnesia on Commission',
   'Convince a witness to develop amnesia before Friday. No theatrical masks, nothing from a cartoon — just a quiet word that lands.',
   'USDC', 18000, 'Civic Center', now() + interval '4 days', 'LOW'),
  ('0xA9d0F1b2C3e4567890AbCdEf1234567890aBcDeF', 'Yacht off the Books',
   'Make a yacht disappear off the books. Paper trail first, hull second. The marina has cameras and a lazy guard.',
   'WBTC', 0.6, 'North Marina', now() + interval '12 days', 'EXTREME'),
  ('0x3E8a21fB9d0C47E6b5A2c4F81d90E3aB7c65D210', 'The Lost Weekend',
   'A ledger went missing for one weekend. Return it without the weekend. The owner suspects everyone, so suspect no one.',
   'DAI', 9500, 'Old Financial Quarter', now() + interval '8 days', 'LOW'),
  ('0x6C1d94A0b2E3f4567890aBcDeF1234567890ABc1', 'A Quiet Exit',
   'An associate needs to stop being an associate. New name, new coast, no goodbyes. Logistics only; sentiment extra.',
   'ETH', 2.75, 'Union Station', now() + interval '15 days', 'MEDIUM'),
  ('0xF45a90B1c2D3e4567890aBcDeF1234567890Ab2C', 'The Painted Pigeon',
   'A pigeon of considerable sentimental value was painted the wrong color. Restore the original color, then forget the address.',
   'LINK', 420, 'Botanical Heights', now() + interval '3 days', 'LOW'),
  ('0x1De2Fc3Ba495867890aBcDeF1234567890aB34D', 'Silence in Row 4',
   'Row 4 of the Grand Odeon must remain silent for one performance. The ushers are honest; the audience is not.',
   'UNI', 3100, 'Grand Odeon', now() + interval '5 days', 'MEDIUM'),
  ('0x809aB1c2D3e4F567890aBcDeF1234567890aBC56', 'The Borrowed Constable',
   'Borrow a constable''s helmet for forty-eight hours. It must come back with the badge still attached and the story plausible.',
   'AAVE', 88, 'Precinct Row', now() + interval '9 days', 'EXTREME'),
  ('0xB2c3D4e5F6a78901234567890aBcDeF1234567A8', 'Cold Storage',
   'Something valuable is being kept too cold. Warm it up to exactly room temperature and the key will stop mattering.',
   'USDT', 24000, 'Dockside Coldstore', now() + interval '7 days', 'EXTREME'),
  ('0x4D5e6F7A8b901234567890aBcDeF1234567890B1', 'The Polite Heist',
   'Remove a painting, leave a receipt. The receipt must rhyme. Frame excluded unless the rhyme is exceptional.',
   'ETH', 1.1, 'Meridian Gallery', now() + interval '20 days', 'LOW')
on conflict do nothing;
