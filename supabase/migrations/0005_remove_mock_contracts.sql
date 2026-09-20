-- The 0001 migration seeded ten theatrical MOCK_CONTRACTS with invented
-- poster addresses. Those posters do not exist in crimechat_profiles, so
-- their "Open channel" flow can never resolve — illegitimate listings.
-- Delete every contract whose poster is not a real profile. Scoped to
-- crimechat_contracts; real postings (poster in profiles) are untouched.
delete from public.crimechat_contracts c
where not exists (
  select 1 from public.crimechat_profiles p where p.address = c.poster_address
);
