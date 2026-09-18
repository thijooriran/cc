# CRIMECHAT

A React PWA that demos a fictional, stylized **"underworld marketplace"** chat app — a noir
pastiche in the spirit of a heist film's fixer screens. Backed by Supabase (Postgres + Realtime +
anonymous auth) with a full offline story (service worker precache + IndexedDB outbox), and
installable to the home screen.

> **DEMO — SIMULATED NETWORK — NO REAL FUNDS.** Every operative, contract, balance and
> transaction is invented. There is no real chain and no real value anywhere in this app.

## Stack

- Vite + React 18 + TypeScript
- `vite-plugin-pwa` (injectManifest) — service worker + manifest, custom reload prompt
- `@supabase/supabase-js` — Postgres, Realtime, anonymous auth
- `dexie` (IndexedDB) — mirrors every table the user can see; all UI reads hit Dexie
- No UI kit, no other runtime deps — one hand-rolled stylesheet

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build → dist/
npm run preview    # serve the production build (test the service worker here)
```

### Two modes

| Mode | How | What happens |
|---|---|---|
| **Supabase** | set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `.env` | Real multi-user chat, transfers, escrows |
| **Local-only** | leave either var unset (default) | Everything demos against seeded mock data with scripted bot replies — no backend at all |

## Supabase setup (project `tripleshit-ledger`)

The migration lives at [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
All objects are prefixed `crimechat_` so nothing collides with other schemas in the shared project.

```bash
supabase link --project-ref jwarmlwtkhbotbfezvuq
supabase db push          # applies supabase/migrations/0001_init.sql
```

In the Supabase dashboard for the project you must also:

1. **Unpause the project** (Settings → General → Restore project) if it is paused.
2. Enable **anonymous sign-ins**: Authentication → Sign In / Providers → Anonymous sign-ins.

`.env`:

```bash
VITE_SUPABASE_URL=https://jwarmlwtkhbotbfezvuq.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key from Settings → API>
```

### What the migration creates

- 9 tables, all RLS-enabled: `crimechat_profiles`, `crimechat_contacts`, `crimechat_threads`,
  `crimechat_messages`, `crimechat_balances`, `crimechat_transfers`, `crimechat_contracts`,
  `crimechat_escrows`, `crimechat_tokens` (+ a block-number sequence)
- RLS: rows readable/writable only by participants; contracts readable by all authenticated
  users, writable only by the poster; balances readable only by the owner
- Atomic RPCs for every balance movement (client-side forgery impossible):
  `crimechat_send_transfer`, `crimechat_open_thread`, `crimechat_post_contract`,
  `crimechat_escrow_create/fund/deliver/release/dispute/refund`
- Idempotent replay: `messages.client_id` and `transfers.client_id` are unique — the offline
  outbox upserts on them, so retries never duplicate
- Reputation nudges applied inside the settlement RPCs (release bumps both parties, dispute drops)
- Seeded token registry (10 fake tokens) and ~10 fictional contract listings
- Realtime publication for messages, threads, transfers, escrows, contracts, profiles

## Testing two users in two browser profiles

1. Start the dev server with real env vars: `npm run dev`.
2. Open the app in **two different browser profiles** (e.g. Chrome + an Incognito window, or
   Safari + Chrome — separate cookie jars).
3. In profile A, copy your address from the header (click the chip to copy).
4. In profile B: **Channels → + New**, paste A's address, open the channel.
5. Exchange messages — they arrive with no refresh (Realtime), with typing indicators and
   online dots.
6. Try a transfer: the card flips pending → confirmed in ~2s and appears in both histories.
7. Run an escrow to RELEASED: one side proposes + funds, the other marks delivered, the payer
   releases. The stepper, vault total, and system cards update live on both clients.

**Pull the cable mid-session** (kill `npm run dev`, or devtools → Network → Offline): the banner
reads `OFFLINE — LOCAL CACHE`, transfer/escrow buttons disable themselves with an explanation,
and new messages queue at 60% opacity with a clock glyph. Restart the server: the outbox flushes
exactly once — no duplicates on either client.

**Install it**: in a Chromium browser, the header shows an **Install** button once
`beforeinstallprompt` fires. After installing, cold-launch with the server off — the app shell
renders from the service worker cache.

**PWA offline notes**: navigations are stale-while-revalidate; the app shell (HTML/JS/CSS/icons)
is precached. The connection banner is derived from `navigator.onLine` **plus** an active probe
**plus** Realtime channel state — never `navigator.onLine` alone (browsers infer it from recent
network failures, and a cache-served cold launch may never fail a request).

## Project layout

```
supabase/migrations/0001_init.sql   # full schema + RLS + RPCs + seeds
src/lib/                            # config, auth, sync, realtime, outbox, net, mock, dexie
src/components/                     # Header, Chat, Board, Vault, Modals, bits
src/sw.ts                           # injectManifest service worker (precache + SWR navigations + Background Sync)
```

## Acceptance checklist status

1. ✅ Two profiles chat by address, no refresh (Realtime)
2. ✅ Killing the server mid-session: threads render from cache, messages queue, banner `OFFLINE — LOCAL CACHE`
3. ✅ Reconnect flushes the outbox exactly once (upsert on `client_id`)
4. ✅ Transfers debit/credit atomically in the `crimechat_send_transfer` RPC, visible in both histories
5. ✅ Transfer/escrow/contract controls visibly disabled offline, with tooltip
6. ✅ Escrow runs PROPOSED → FUNDED → DELIVERED → RELEASED across two clients (guarded RPCs)
7. ✅ Installs to home screen; cold-launches offline from SW precache
8. ✅ No env vars → full demo against local mock data with bot replies
9. ✅ Usable at 375px (single-pane layout under 820px)
