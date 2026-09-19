-- Grants for CRIMECHAT objects only (shared project — never touch non-crimechat_ objects).
-- The 0001 migration created tables/RPCs without grants, so the API roles got
-- "permission denied" even when RLS policies allowed the row.

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on
  public.crimechat_tokens,
  public.crimechat_profiles,
  public.crimechat_contacts,
  public.crimechat_threads,
  public.crimechat_messages,
  public.crimechat_balances,
  public.crimechat_transfers,
  public.crimechat_contracts,
  public.crimechat_escrows
to anon, authenticated;

-- Identity-column sequences (bigint generated always as identity) need USAGE for inserts.
do $$
declare s record;
begin
  for s in
    select oid::regclass as name
    from pg_class
    where relkind = 'S'
      and relnamespace = 'public'::regnamespace
      and relname like 'crimechat\_%'
  loop
    execute format('grant usage, select on sequence %s to anon, authenticated', s.name);
  end loop;
end $$;

-- EXECUTE on every client-facing crimechat_ RPC (scoped by name prefix).
do $$
declare f record;
begin
  for f in
    select oid::regprocedure as sig
    from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname like 'crimechat\_%'
  loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
