# Agent Portal Worker — deployable, NOT deployed

Owner: Bge. The Worker is the shared store + sign-in check for the
Agent Portal app: one Cloudflare Worker + one D1 database (free tier).
Going live is the owner's tap — nothing here has been deployed, and
no Cloudflare account was touched by this build.

## What it does

- `POST /api/signin` — checks an agent's passcode against a stored
  PBKDF2 hash (100,000 rounds, SHA-256, per-passcode salt — see the
  comment at the top of `worker.js` for why). Hands back a session
  token good for one day. Locks an agent out for 15 minutes after
  5 wrong guesses.
- `GET /api/board` — masked board only: area, budget, timeline,
  pre-approval, date ready, checks passed. Never names/phones/emails.
- `POST /api/claim` — ONE conditional UPDATE ("mark claimed only if
  nobody claimed it yet"), so exactly one agent wins even if two tap
  Claim at the same second. D1 has no BEGIN/COMMIT transactions, so
  this single step is the safe way.
- `GET /api/handover?buyer=X` — full details only for the agent who
  claimed that buyer.
- `GET /api/my-leads` — buyers this agent claimed, with outcomes.
- `POST /api/outcome` — records called / no-answer / deal closed,
  only for the agent who claimed the buyer.
- `GET /api/health` — no sign-in needed, just "ok".

## Files

| File | What it is |
|---|---|
| `worker.js` | The Worker. All endpoints, hashing, lockout, claim step. |
| `wrangler.toml` | Worker name + D1 binding. `database_id` is a placeholder until deploy. |
| `schema.sql` | D1 tables + the 4 SAMPLE buyers + the 2 SAMPLE agents. Passcodes seeded as `NOT-SET` — no passcode works until Bge sets one. |
| `hash-passcode.mjs` | Makes a salt + hash for one agent's passcode. Run locally, store the hash in D1. The passcode itself is never stored. |
| `README.md` | This file. |

## Deploy steps (for later — do NOT run until the owner says go)

```sh
cd ~/workspace/projects/agent-portal-app/worker
npx wrangler login            # Bge's OWN Cloudflare account — never
                              # another project's account, never
                              # anyone else's login
npx wrangler d1 create agent-portal
# copy the real database_id it prints into wrangler.toml
npx wrangler d1 execute agent-portal --remote --file schema.sql
# one passcode per agent (8+ characters, handed over by call/text):
node hash-passcode.mjs maria <passcode>
# run the UPDATE line it prints, then repeat for each agent
npx wrangler deploy
# copy the Worker address it prints (https://agent-portal-worker.<name>.workers.dev)
```

Then set that address as `APP_CONFIG.apiBase` at the top of
`app.js` in the app, and redeploy the app. Until then the app runs
in DEMO mode (see the app README).

## Local test (no account needed)

```sh
cd ~/workspace/projects/agent-portal-app/worker
npx wrangler dev --local --port 8787
# in another shell: set a test passcode in the LOCAL database only
node hash-passcode.mjs maria test-passcode-456
npx wrangler d1 execute agent-portal --local --command "UPDATE agents SET passcode_hash = '<hash>', passcode_salt = '<salt>' WHERE id = 'maria';"
curl http://localhost:8787/api/health
```

The local database lives under `.wrangler/state/` and is never
committed. Test passcodes only ever exist there.

Two gotchas learned Nov 7, 2026 (sandbox run — both bit us):
1. Reseeding does NOT remove buyers the seed no longer has:
   `schema.sql` uses INSERT OR IGNORE, so a buyer removed from the
   seed (buyer C, Nov 6) stays in the local database. To reseed
   clean, stop the dev server, delete `.wrangler/state/` entirely,
   then run the schema file again.
2. Killing the server: `kill` on the PID of the `npx` wrapper does
   NOT kill wrangler itself — the old server keeps port 8787 and
   keeps serving the deleted database (sign-in then fails with a
   database error). Kill the actual wrangler process (find it with
   `ps aux | grep "wrangler dev"`), confirm nothing is on 8787,
   then start it again.

## Switching an agent off

No code change, no redeploy:

```sh
npx wrangler d1 execute agent-portal --remote --command "UPDATE agents SET approved = 0 WHERE id = '<agent-id>';"
```

Their token stops working at once, and sign-in is refused.

## Honest limits (from money-path-research.md)

- Polling, not instant: phones re-read the board every 20–30
  seconds. A claim shows on another phone a few seconds later.
- D1 read-after-write delay is unverified: a second phone might
  briefly show a buyer as free after it was claimed. The claim
  itself is safe (one winner); the app handles "sorry, just
  claimed".
- Free tier has no uptime promise, community support only. Re-check
  the Workers/D1 pricing page on the day of the deploy.
- Cloudflare is a company service, not open-source software. The
  code here is Bge's own; the data is plain SQL and can be moved.
- A passcode is a shared secret, not a full account. If one leaks,
  change it fast. No "forgot my passcode" button — the agent asks
  Bge, who sets a new one. Past ~20 agents, switch to Firebase Auth
  (see the research file).
- The app does NOT check Zelle (owner decision, Nov 6, 2026 —
  Stripe dropped for this billing). Bge looks in his bank, sees
  the $499 Zelle payment arrived, and only then hands over
  a passcode. If a payment is missed, Bge switches
  the agent off by hand (see above).
