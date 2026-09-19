-- 0003 installed pgcrypto, but this project hosts extensions in a dedicated
-- schema that the RPC's `set search_path = public` cannot see. Replace the
-- pgcrypto-dependent tx-hash minting with gen_random_uuid(), which is core
-- since PostgreSQL 13 and lives in pg_catalog (always in the search path).
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
          '0x' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          nextval('public.crimechat_block_seq'), p_client_id)
  returning * into tr;
  if p_thread_id is not null and crimechat_is_thread_participant(p_thread_id) then
    perform public.crimechat_post_system(p_thread_id, 'transfer', 'transfer',
      jsonb_build_object('transfer_id', tr.id, 'token', tr.token_symbol, 'amount', tr.amount::text,
                         'memo', tr.memo, 'tx_hash', tr.tx_hash, 'block_number', tr.block_number,
                         'direction', 'out', 'counterparty', tr.to_address::text));
  end if;
  return tr;
end $$;
