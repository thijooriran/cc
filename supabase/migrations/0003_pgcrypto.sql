-- crimechat_send_transfer mints tx hashes via gen_random_bytes(), which lives
-- in the pgcrypto extension. This project did not have it installed, so the
-- RPC errored with 42883 (surfaced to clients as a 404). Installing it places
-- the function in the public schema, which the RPC's search_path resolves.
create extension if not exists pgcrypto;
