# Agent Portal — money-path research

**Date:** 5 November 2026. **Research only** — nothing built, installed, signed up for, charged, or published.
**Update Nov 7, 2026 — money model CHANGED:** the owner dropped $499/month. **New model: free to join, $100 per ready buyer claimed** (per-lead). Agents top up $500 by Zelle; Bge adds it to their balance by hand after checking the bank. Cap: 3 buyers waiting for a call; a buyer with no call in 48 hours goes back on the board and the $100 is refunded. The $499/month lines below are kept as history only — do not follow them for billing. The live billing page (`billing.html`) and the app/worker READMEs now say per-lead.
**Owner:** Bge. **Money model decided:** free to join, $100 per claimed buyer, no monthly charge.
**Separate project (Nov 6, 2026):** this portal has no connection to any other project — no other agent's name, listings, accounts, or data are used here.
**What exists today:** a demo installable web app (a "PWA" — a website that installs on a phone like an app) at `~/workspace/projects/agent-portal-app/`, static files only, no server, hosted free on GitHub Pages (public repo `bossmaster1979/agent-portal-preview`, SAMPLE data only). Agents sign in by tapping a name. Claims and outcomes live in one phone's browser only (a small store the browser keeps on the device, called localStorage).

## The three picks, up front

| Piece | Pick | In one line |
|---|---|---|
| (a) Shared store | **Cloudflare Workers + D1** | A tiny piece of code running on Cloudflare's computers (a "Worker") plus Cloudflare's small database (D1). Free, on a Cloudflare account of Bge's own. |
| (b) Real sign-in | **Per-agent passcode, checked by that same Worker** | Bge hands each approved agent their own passcode. The Worker stores only a scrambled form of it (a "hash" — a one-way scramble you cannot reverse), never the passcode itself. |
| (c) Monthly billing | **Stripe Payment Link for a $499/month recurring product** | Bge makes the link once in the Stripe Dashboard (no code). The agent taps it, pays on Stripe's own page. The app itself is not changed for payment. |

Why one supplier for (a) and (b): the Worker that holds the store is the same Worker that checks the passcode, so there is one free account, one place to switch an agent off, and nothing that pauses after a quiet week. The honest cost of that choice is that Cloudflare is a company service, not open-source software — see "Open-source check" below.

---

## Plain-words glossary (first use only)

- **Worker** — a small piece of code that runs on Cloudflare's computers when the app calls it. No server to rent or look after.
- **D1** — Cloudflare's small database. It speaks SQL, the normal database language. Think of it as one shared notebook every phone reads.
- **KV** — Cloudflare's simpler key-value store: you ask for a thing by its name and get one value back. Fast for reading, weak for "only one person may take this".
- **MAU (monthly active user)** — a person who signs in at least once in a calendar month. Free tiers count this, not total accounts.
- **Magic link** — an email with a sign-in link in it. Tap the link, you are in, no password.
- **Hash** — a one-way scramble of a passcode or password. You can check a guess against it, but you cannot turn it back into the original.
- **Payment Link** — a web address Stripe gives you that opens a Stripe-hosted checkout page. No code, no website change.
- **Stripe Billing** — Stripe's subscription part: it repeats the charge every month, retries a failed card, and sends receipts. It charges 0.7% of the recurring money on top of the card/bank fee.
- **Row Level Security (RLS)** — a rule inside Supabase's database that decides which signed-in user may see or change which rows.
- **Realtime** — the server pushes a change to every open phone at once, instead of each phone asking "anything new?" over and over (that asking is called **polling**).

---

## (a) Shared store — claims and outcomes visible on every phone

Need: one agent's claim must hide that buyer from other agents; no server to rent; works from a static GitHub Pages site. "Instant" in practice means within seconds: either the server pushes the change, or each phone re-reads the board every 20–30 seconds and on opening the app. True push needs a realtime service; polling is simpler and is enough at this size (a handful of agents, a handful of buyers).

### Candidate 1 — Cloudflare Workers + KV — CHECKED, DROPPED

- **Free limits (Cloudflare docs, via Oct–Nov 2026 write-ups):** 100,000 Worker requests a day; KV 100,000 reads a day, **only 1,000 writes a day**, 1 GB stored. Over the limit, requests fail until midnight UTC — no bill, because no card is on file.
- **Licence/terms:** proprietary Cloudflare service, not open source. Free tier is a commercial free plan.
- **Why dropped:** two hard problems. First, 1,000 writes a day is the ceiling for every claim, outcome, and sign-in combined — fine at this size, but it is 100 times smaller than the request limit and the first thing to run out. Second, KV has no safe "only one person takes this" step: two agents tapping Claim at the same second can both read "free" and both write "mine". KV is also eventually consistent (a write can take a moment to show everywhere), so a claimed buyer can briefly still look free on another phone.

### Candidate 2 — Cloudflare Workers + D1 — ✅ PICK

- **Free limits (Cloudflare docs, via Oct–Nov 2026 write-ups):** 100,000 Worker requests a day, 10 ms of computer time per request; D1: 5,000,000 rows read a day, 100,000 rows written a day, 5 GB storage in total (500 MB per database, up to 10 databases). Over the limit, queries fail until midnight UTC — no bill, no card.
- **Licence/terms:** proprietary Cloudflare service, not open source. Needs a Cloudflare account of Bge's own — never another project's account, never anyone else's login.
- **Why it fits:** D1 is a real database, so the claim can be one single step that cannot be split: "mark this buyer claimed by agent X, but only if nobody claimed it yet" — then look at how many rows changed. If the number is 1, that agent won; if 0, someone else got there first. That one-step trick matters because D1 does **not** let code open a long transaction with BEGIN/COMMIT (tested and reported by developers in 2026); the single conditional UPDATE is the safe way around that, and it is atomic (all-or-nothing) on its own. Writes are 100 times more generous than KV (100,000 rows a day vs 1,000). Reads are far beyond what a handful of agents polling every 20–30 seconds would use. The Worker is the guard: phones never talk to D1 directly, they ask the Worker, and the Worker checks the sign-in first.
- **Honest limits:**
  - No true push. Phones must poll (re-read every 20–30 seconds and when the board opens). A claim shows on another phone a few seconds later, not the same instant.
  - D1 is replicated around the world; I could **not** verify whether a write in one place is instantly visible to a read elsewhere, or whether there is a short delay. The claim step itself is safe (one writer wins), but a second phone might show a buyer as free for a few seconds after it was claimed. The app must handle the "sorry, just claimed" answer gracefully.
  - Free tier has no uptime promise and only community support. If Cloudflare changes the free limits, the numbers above move — re-check them on Cloudflare's pricing page before building.
  - Not open source. If Cloudflare ever shut the free tier, the store would need moving. The data is plain SQL, so it can be exported and moved.

### Candidate 3 — Firebase Firestore (Spark plan) — CHECKED, SECOND CHOICE

- **Free limits (Google pricing, checked Oct–Nov 2026):** Firestore 1 GiB stored, 50,000 document reads a day, 20,000 writes a day, 20,000 deletes a day, 10 GiB sent out a month. No card needed on Spark. **Cloud Functions and Cloud Storage need the paid Blaze plan** (since 3 Feb 2026 Spark projects have no Cloud Storage access at all). Phone sign-in by text message is Blaze-only.
- **Licence/terms:** proprietary Google service. No self-hosted version. No open-source licence.
- **Why it is second, not the pick:** it is genuinely good at this job — live updates are built in (a claim would appear on other phones at once, no polling), and Firestore transactions can do the safe one-winner claim. But it adds a second supplier (Google) next to Cloudflare, the Spark plan **shuts the product off for the rest of the month** if a daily limit is passed (instead of failing until midnight), and the app would need Google's SDK and a Google account Bge does not use today. At this size its limits are plenty; the pick is about keeping one supplier, not about Firestore being too small.

### Candidate 4 — Supabase (Postgres + Realtime) — CHECKED, DROPPED

- **Free limits (Supabase pricing, checked Sep–Nov 2026):** 500 MB database, 50,000 MAU, 5 GB data out a month (plus 5 GB cached), 1 GB file storage, 500,000 Edge Function calls a month, 200 live connections at once, 2 active projects. No card needed.
- **Licence/terms:** **Apache-2.0, real open source** (main repo ~113,000–114,000 stars on GitHub, actively maintained, updated Oct 2026; one third-party check reported 0 critical security holes — that check is third-party, not mine). Self-hosting with Docker is documented. This is the best licence verdict of any candidate.
- **Why dropped anyway:** **free projects pause after 1 week with no traffic.** A paused project does not answer until someone restores it in the dashboard. For an app agents may not open for a week, that means the board — and sign-in, if it lives on the same project — can be dead exactly when an agent opens it to work. That one rule kills it for a money app on the free tier. The paid fix is Pro at $25/month, which breaks the free-only rule. (Supabase also has a second trap, covered under (b): its built-in email sender only sends 2 emails an hour.)

### Candidate 5 — GitHub as the store (commits via the API) — CHECKED, DROPPED

- **Free limits:** REST API 5,000 requests an hour with a login token, 60 an hour without one; one file per request through the contents endpoint; files up to 1 MB through that endpoint. GitHub Pages hosting itself is free for a public repo.
- **Licence/terms:** GitHub is a proprietary service. The repo is already public, which is the problem.
- **Why dropped:** three hard problems. (1) **Privacy:** the repo is public, so buyer names, numbers and outcomes written into a file would be visible to the whole internet. A private repo fixes that only by putting a secret token in the app's JavaScript, which anyone can read — that is not a secret at all. (2) **Not instant:** a claim would be a commit, and GitHub Pages rebuilds take minutes; another phone would keep seeing the buyer as free. (3) **No safe one-winner step:** two claims at once are two commits; the last one wins and the loser is silently overwritten, or one commit is rejected and must be retried by hand. GitHub is the right place to store the app's code, not live claim data.

### Candidate 6 — Appwrite Cloud / PocketBase — CHECKED, DROPPED

- **What they are:** Appwrite (BSD-3-Clause licence, ~58,000 stars) and PocketBase (MIT licence, ~61,000 stars, one single file with a database, sign-in and live updates built in) are the two best open-source self-hosted backends found across the comparison sources.
- **Why dropped:** both need a computer to run on. Appwrite has a free Cloud tier (reported as 75,000 MAU, 2 GB storage, 5 GB bandwidth, and — in one comparison — free projects also pause after a week idle, same as Supabase; I did not verify Appwrite Cloud's own limits on its own pricing page, see "Not verified"). PocketBase is self-host only: free software, but the server it runs on is not free. The brief forbids renting a server, so both fail the constraint even though their licences are the cleanest. If a free server ever appears, PocketBase is the first place to look again.

### Candidate 7 — Convex — NOTED, NOT FULLY CHECKED

- Convex (reactive database, live updates built in) appears in the same comparisons with a free tier of about 1M function calls and 0.5 GB storage, paid from $25/developer/month. I did not check its free limits or licence on its own pages, and it would be a third supplier. Not picked, not fully vetted — listed so it is not silently forgotten.

---

## (b) Real agent sign-in — Bge controls who gets in, agents prove who they are

Need: an approved-agent list Bge controls; an agent must prove they are that agent, not just tap a name; no passwords stored in plain text; no new paid sign-in service.

### Candidate 1 — Per-agent passcode, checked by the Cloudflare Worker — ✅ PICK

- **How it works:** Bge creates one passcode per agent (a short code, handed over by phone call or text — never inside the app). The Worker stores only the hash of each passcode, plus the agent's name and whether they are still approved. The agent types their passcode once; the Worker checks the hash and hands back a short-lived session token (a random string the phone keeps, expiring after a day or so). Every claim or outcome call must carry that token. Bge switches an agent off by deleting their row — no code change, no redeploy.
- **Free limits:** none beyond the Worker's own 100,000 requests a day (see (a)). No email is sent, so no email limit applies. No extra account, no extra supplier.
- **Licence/terms:** the Worker code would be written for this project (Bge owns it). The hashing itself uses the platform's built-in crypto — no password library to vet.
- **Why it fits:** it is the only candidate with no email cap, no 7-day pause, no new account, no GitHub account for the agent, and it runs on the same Worker as the store — one list, one off-switch. It meets the brief exactly: no plain-text passwords (only hashes are stored), and tapping a name no longer signs anyone in.
- **Honest limits (say these plainly):**
  - A passcode is a shared secret, not a full account. If an agent shares it or it leaks, anyone with it can sign in as that agent until Bge changes it. Bge must hand passcodes out one-to-one and change one fast if it leaks.
  - No "forgot my passcode" button — the agent must ask Bge, who sets a new one. That is manual work per agent, fine for a handful of agents, painful past ~20.
  - The Worker must limit guesses (for example, lock an agent for a while after 5 wrong tries) or someone could try passcodes one by one. That limit must be built, not assumed.
  - Passcodes must be long enough to guess badly (a short 4-digit code is not enough). The build must set a real length rule.
  - This is weaker than a proper account system with password reset and second-factor checks. If the agent count grows past ~20, or Bge wants agents to reset their own sign-in, switch to Candidate 2 below.

### Candidate 2 — Firebase Auth, email + password — CHECKED, CLOSE SECOND

- **Free limits (Google pricing/docs, checked Oct–Nov 2026):** email, social and anonymous sign-in free up to 50,000 MAU on the Spark plan, no card. Password-reset emails: 150 a day on Spark. **Email-link (magic-link) sign-in: only 5 emails a day on Spark** (25,000 a day on Blaze) — so magic link is unusable on the free tier and password sign-in is the only workable Firebase route.
- **Licence/terms:** proprietary Google service. Passwords are hashed by Google; Bge never sees or stores one.
- **Why it is second:** it is the most "real" sign-in on the free tier — per-agent accounts, Bge creates and disables each one in the Firebase console, agents reset their own passwords (within the 150-a-day cap). It works from a static GitHub Pages site with Google's JavaScript SDK, no hosting move.
- **Why not the pick:** it adds a Google account and SDK, the Spark plan shuts Auth off for the rest of the month if a limit is passed, and the Worker would still need to check the agent's Firebase token against an allow-list (or treat "has a Firebase account" as the allow-list, since Bge creates every account by hand). More moving parts than the passcode route for a handful of agents. **Flip condition: if Bge wants self-serve password reset, or the agent list grows past ~20, this becomes the pick.**

### Candidate 3 — Supabase Auth, magic link — CHECKED, DROPPED

- **Free limits:** Auth 50,000 MAU on the free tier, same project limits as (a). But Supabase's **built-in email sender sends at most 2 emails an hour, for the whole project, and only to members of Bge's own Supabase organisation** (Supabase docs, production checklist, updated 2 Nov 2026). A third sign-in in one hour simply never arrives.
- **Licence/terms:** Apache-2.0 (GoTrue, the auth service underneath, is Apache-2.0).
- **Why dropped:** magic link is dead on the built-in sender. The fix is to connect Bge's own email sender (custom SMTP) — the free email services that fit are Resend (reported free tier 3,000 emails a month, max 100 a day) or Brevo (reported 300 emails a day free) — but that adds a second supplier, a domain to verify, and a sender to keep working, all to send a handful of sign-in emails. Supabase Auth with **email + password** (no magic link) would work inside the same limits, but the free project still pauses after 1 week idle, which kills sign-in exactly when it is needed — same reason as (a). Dropped.

### Candidate 4 — Firebase Auth, magic link — CHECKED, DROPPED

- Same service as Candidate 2, but the magic-link route: **5 sign-in emails a day on Spark.** Six agents signing in on one day breaks it. Password sign-in (Candidate 2) is the only Firebase route that works free. Dropped as a magic-link route, kept as a password route above.

### Candidate 5 — Cloudflare Access (Zero Trust free tier) — CHECKED, DROPPED AS PRIMARY

- **Free limits (Cloudflare plans, checked Sep–Oct 2026):** $0 for up to 50 users. One-time PIN by email is the built-in sign-in (no password at all). Logs kept only 24 hours on free; no uptime promise; community support only. Over 50 users it is about $7 per user per month — and reports say once an account moves off free, **every** seat becomes billable, not just the ones over 50 (not verified on Cloudflare's own page).
- **Licence/terms:** proprietary Cloudflare service.
- **Why dropped as primary:** Access protects a site only when the site's traffic runs through Cloudflare. The portal today lives on GitHub Pages at `bossmaster1979.github.io`, which Cloudflare does not front — Access cannot gate that address. Using it means moving the hosting to Cloudflare Pages (free) or pointing a custom domain's DNS at Cloudflare with the proxy on. That is doable, but it is a hosting move for the sake of sign-in. Second problem: Access gates the **whole site** — it proves "this person is on the allowed email list" but does not by itself tell the app *which* agent signed in; the Worker would still need to read Cloudflare's signed header to learn the agent's email and match it to the list. Real protection, but the wrong shape for per-agent identity inside the app, and it needs the hosting move first.

### Candidate 6 — GitHub OAuth via the Sveltia auth Worker — CHECKED, DROPPED

- **What it is:** GitHub OAuth through a small auth Worker — the open-source `sveltia/sveltia-cms-auth` project (MIT licence, updated Aug 2026, 158 stars). The Worker holds a GitHub OAuth app's secret; the sign-in flow sends the person to GitHub, GitHub sends back a code, the Worker swaps the code for a token, and the app checks that GitHub user can read a repo. This portal does NOT use it — it has its own Worker sign-in (passcodes) instead.
- **Free limits:** the Worker itself sits inside the same 100,000 requests a day. GitHub OAuth has no per-login fee.
- **Why dropped:** every agent would need a GitHub account, and Bge would have to add each one as a collaborator on a repo — a confusing ask for a real-estate agent who just wants to open an app and work. It also proves "this person has a GitHub account that can read a repo", not "this person is an approved, paying agent" — the Worker would still need its own allow-list on top. Reusing the Sveltia Worker code is allowed (MIT), but it is the heaviest sign-in for the agents and the wrong tool for a consumer-facing app. Not used by this portal.

### What sign-in must NOT be

- Tapping a name (today's demo) — no proof at all.
- A password or passcode written in the app's JavaScript or in a file in the repo — anyone can read the repo (it is public) and sign in as anyone.
- One passcode shared by all agents — one leak ends all of them, and Bge cannot switch one agent off without changing it for everyone.

---

## (c) Monthly billing at $499/month — Stripe, no code change in the app

Bge already has Stripe in use (for a $750 one-time deal). Nothing below touches that Stripe account, makes a test charge, or sets up a live subscription — this is public-docs research only.

### Candidate 1 — Stripe Payment Link, recurring $499/month — ✅ PICK

- **How it works (Stripe docs):** in the Stripe Dashboard, Bge creates a product ("Agent Portal — $499/month") with a recurring monthly price of $499, then creates a Payment Link for it. Stripe gives back a web address (like `buy.stripe.com/...`). That link goes on a simple billing page in the app, or Bge sends it by email/text after approving an agent. The agent taps it, pays on Stripe's own hosted checkout page (card, Apple Pay, Google Pay, or bank account if switched on), and Stripe creates the subscription. No code changes in the app. No website is needed — the link can be shared by email, text, or QR code.
- **Free limits / cost to Bge:** creating Payment Links costs nothing; Stripe has no monthly account fee. Stripe takes a fee **per successful payment only**:
  - By card (US domestic): **2.9% + $0.30** = $14.77 on $499. Plus Stripe Billing (the subscription part) **0.7%** of the recurring money = $3.49. **Total about $18.26; about $480.74 lands in Bge's account per agent per month.**
  - By bank account (ACH Direct Debit, US): **0.8%, capped at $5.00** = $3.99 on $499. Plus Billing 0.7% = $3.49. **Total about $7.48; about $491.52 lands.** Stripe's own docs say bank debits can be switched on for Payment Links from the Dashboard with no code, and other Stripe help pages say ACH works for USD subscriptions when it is switched on. A bank payment can take up to 4 business days to clear and can still fail after the agent taps pay (for example, not enough money in the account) — so access must only be switched on when Stripe shows the payment as confirmed, not when the agent taps the link.
  - Other costs if they happen: failed bank debit $4.00 each; dispute $15.00 each. A custom domain on Stripe-hosted pages is $10/month — **do not buy it**; use Stripe's own link address.
- **Licence/terms:** Stripe is a proprietary payment processor, not open source. There is no open-source way to take a card payment — a card has to go through a licensed payment processor. This is Bge's existing money route, not a new tool pick.
- **Why it fits:** it is the only route that is genuinely no-code, uses the Stripe account Bge already has, and repeats the charge every month without Bge chasing anyone. The agent can also manage their own subscription through Stripe's Customer Portal (switched on in the Dashboard, no code): update their card, or cancel, themselves.
- **Honest limits — what stays manual, and what the app does NOT do:**
  - **The app does not check Stripe.** Nothing in the app knows whether an agent paid. Bge must look in the Stripe Dashboard, see an active subscription, and only then add the agent to the approved list / hand over their passcode. If a payment fails or an agent cancels, Bge must remove them from the approved list by hand. If nobody watches the Dashboard, a cancelled agent keeps access.
  - **One link fits all, so Stripe cannot tell agents apart by itself.** The same link is used by every agent. Bge must match each payment to an agent — by the name/email on the Stripe payment, or by adding a custom field to the link (Stripe Payment Links let you add a custom field, for example "Agent name") so the agent types who they are at checkout. Without that, matching payments to agents is guesswork.
  - Stripe retries a failed card automatically and emails the agent, but Bge still has to notice a subscription that never recovers.
  - A subscription keeps charging until someone cancels it. There is no built-in "stop after 3 months" on a plain link — Bge would cancel it in the Dashboard, or set a cancel date on that subscription.
  - Prices and fees change. Re-check Stripe's pricing page in the Dashboard before the first live link is made.

### Candidate 2 — Stripe Invoicing — CHECKED, NOT PICKED

- **How it works:** Bge sends an invoice from the Dashboard each month; the agent pays from the invoice page. No code either.
- **Cost:** same card/bank fees, plus Invoicing at 0.4% per paid invoice (capped at $2) on top of Billing where it applies — check the Dashboard, as the exact stacking was not fully verified here.
- **Why not picked:** it makes Bge send an invoice every month to every agent, forever. The Payment Link charges automatically instead. Invoicing is the right fallback for one agent who cannot or will not use the link (for example, they want to pay by a method the link does not offer).

### Candidate 3 — Stripe Checkout embedded in the app — CHECKED, DROPPED

- **How it works:** a checkout form built into the app's own pages (Stripe Checkout or Payment Element). More control over how it looks, and the app could in principle know who paid.
- **Why dropped:** it needs code, and it needs a server-side step to confirm the payment safely — which is exactly the server this project does not have. It also does not remove the manual step: the app still has to be told "this agent paid". No gain for this size, real extra work. Revisit only if the app ever grows its own server.

### Candidate 4 — Plain bank transfer, no Stripe — CHECKED, KEPT AS FALLBACK ONLY

- **How it works:** the agent sends $499 a month by bank transfer; Bge checks the bank statement and switches access on by hand.
- **Cost:** bank-to-bank transfer fees depend on Bge's bank (not checked here); no Stripe fee at all.
- **Why fallback only:** it is the cheapest per payment and needs no Stripe setup, but Bge has to chase every payment every month, match each transfer to an agent, and remember to switch access off when one stops. That is the manual work the subscription is meant to remove. Keep it for an agent who cannot use Stripe, not as the main route.

---

## How the three picks fit together (build order, for later — not built now)

1. One Cloudflare Worker + one D1 database. Tables: agents (name, email, passcode hash, approved yes/no), buyers (the board — masked fields only), claims (buyer, agent, time), outcomes.
2. The Worker is the only thing that talks to D1. The app's pages call the Worker with the agent's session token. The claim step is the single conditional UPDATE in (a).
3. Bge's manual flow per agent: approve → send Stripe Payment Link → see the subscription active in the Dashboard → create the agent's passcode in D1 → hand the passcode to the agent by call/text → agent signs in and works. If payment fails or the agent cancels: remove/switch off the agent in D1.
4. Buyer data rule, unchanged from the demo: masked on the board (area, budget range, timeline, pre-approval, date ready, checks passed). Name, phone and email only on the handover sheet, only after a claim. Farm leads never go in this app.

---

## Open-source check (the rule, applied honestly)

- **Supabase, Sveltia CMS, sveltia-cms-auth, Appwrite, PocketBase:** real open-source licences (Apache-2.0, MIT, BSD-3-Clause), actively maintained, no malware/trackers/hidden collection found in this check, no known critical holes found in this check. They were **not** picked where they fail a hard constraint: Supabase pauses after a week idle; Appwrite/PocketBase need a server to run on.
- **Cloudflare Workers/D1/KV and Firebase:** proprietary company services, not open source. They were picked (Cloudflare) or kept as second choice (Firebase) because no open-source route meets "no server to rent" — every self-hosted open-source backend needs a computer to run on, and that computer is not free. That is a trade-off to name, not hide: the code Bge writes on top (the Worker, the app) is Bge's own, and the data is plain SQL that can be moved.
- **Stripe:** proprietary payment processor. No open-source substitute exists for taking card payments. It is Bge's existing money route.

## 8-source check (where a tool choice was involved)

| Source | What was done |
|---|---|
| GitHub | Checked directly: Supabase repo (Apache-2.0, ~114k stars), Sveltia CMS + sveltia-cms-auth repos (MIT), GitHub REST API rate limits (5,000/hour with a token, 60/hour without). |
| npm + PyPI | Not a separate hunt: the candidates are hosted services, not installable packages. Their JavaScript SDKs (Firebase, Supabase) are published on npm, but the service is the product — there is no npm/PyPI package that *is* the store or the sign-in. |
| AlternativeTo | Not opened as a page. Comparison round-ups that do the same job (Supabase vs Firebase vs Appwrite vs PocketBase vs Convex) were used instead — see sources below. |
| awesome-selfhosted | Not opened as a page. Its usual entries for this job (Appwrite, PocketBase, Supabase self-host) were identified through the comparison sources and checked on their own repos. |
| Product Hunt + Hacker News | Not searched directly. No Product Hunt / HN thread was used as evidence. |
| Reddit r/selfhosted + r/opensource | Searched; the results returned were comparison articles, not direct Reddit threads. No Reddit thread was used as evidence. |
| F-Droid | Not applicable — there is no Android app to find; the portal is a web app. |
| Docker Hub | Not applicable — by design there is no container or server to run. |

In short: GitHub and vendor docs were checked first-hand; the comparison sources below carried the AlternativeTo / awesome-selfhosted / Reddit angles; Product Hunt, Hacker News, F-Droid and Docker Hub added nothing to this choice and were not chased further. That is stated here rather than claimed as full coverage.

## Sources used (checked 5 Nov 2026; vendor pages change — re-check before building)

- Cloudflare Workers/KV/D1 free limits: Cloudflare pricing/limits docs as reported in Oct–Nov 2026 write-ups (100k requests/day; KV 100k reads / 1k writes a day; D1 5M rows read / 100k rows written a day, 5 GB). D1 no-BEGIN / batch-is-atomic behaviour: developer tests, 2026.
- Firebase Spark plan: Google pricing/docs as reported Oct–Nov 2026 (Firestore 1 GiB, 50k reads / 20k writes a day; Auth 50k MAU; email-link sign-in 5/day, password reset 150/day on Spark; Cloud Functions/Storage Blaze-only since 3 Feb 2026; Spark shuts a product off for the rest of the month if its quota is passed).
- Supabase free tier: Supabase pricing/docs as reported Sep–Nov 2026 (500 MB DB, 50k MAU, 5 GB egress, 1 GB storage, 500k Edge Function calls/month, 200 live connections, 2 projects, pause after 1 week idle; built-in auth email 2/hour, team-only; custom SMTP lifts it to 30/hour to start). Licence: Supabase docs architecture page + GitHub repo (Apache-2.0).
- Cloudflare Access / Zero Trust free tier: Cloudflare plans as reported Sep–Oct 2026 ($0 up to 50 users, ~$7/user/month after; 24-hour logs on free).
- GitHub API: rate limits 5,000/hour authenticated, 60/hour unauthenticated; contents endpoint 1 MB file limit, one file per request.
- Sveltia CMS repo (MIT, v0.250.1 Oct 2026); sveltia-cms-auth repo (MIT, updated Aug 2026) — open-source references only, not used by this portal.
- Stripe: Stripe docs on recurring payments and Payment Links (no code; one link for one or more products; subscriptions supported); Stripe bank-debit docs (bank debits can be switched on for Payment Links from the Dashboard, no code); Stripe US pricing as reported Sep–Oct 2026 (card 2.9% + $0.30; ACH 0.8% capped at $5; Billing 0.7% pay-as-you-go; failed ACH $4; dispute $15; custom domain on Stripe pages $10/month).
- Comparisons used for the wider field: Supabase vs Firebase 2026 round-ups; Firebase-alternatives round-ups (Supabase, Appwrite BSD-3-Clause, PocketBase MIT, Convex, Nhost); Supabase free-tier limit guides (Oct 2026).
- Resend/Brevo free email tiers (for the Supabase custom-SMTP fix only): reported Sep 2026 as Resend 3,000/month (max 100/day), Brevo 300/day — not verified on their own pricing pages.

## What I could NOT verify — say it plainly

1. **No hands-on test was done.** No Worker was written, no D1 database created, no Firebase/Supabase project opened, no Stripe link made, no live or test charge run. Every number above comes from vendor docs via Oct–Nov 2026 write-ups, not from running the thing. The first build must test the claim race (two phones, same second) for real.
2. **D1 read-after-write delay** — whether a claim written in one place is instantly visible to a read elsewhere. Not verified. The claim itself is safe (one winner), but a second phone may briefly show a claimed buyer as free.
3. **Cloudflare free-limit changes** — Cloudflare changes these numbers. Re-check the Workers/KV/D1 pricing page on the day of the build.
4. **Stripe fee stacking** — the card fee plus the 0.7% Billing fee is how the sources describe it; the exact total on the first real $499 payment must be read off the Stripe Dashboard, not taken from this file. The Invoicing 0.4% figure was not fully verified.
5. **Appwrite Cloud free limits and its idle-pause behaviour** — taken from a comparison article, not from Appwrite's own pricing page.
6. **Resend/Brevo free tiers** — taken from a Sep 2026 guide, not from their own pricing pages. They only matter if the Supabase email route is ever revived; they do not affect the picks.
7. **Cloudflare Access "every seat becomes billable over 50"** — reported by third parties, not verified on Cloudflare's own page. It does not affect the picks (Access was dropped).
8. **Supabase "0 critical CVEs"** — from a third-party repo-rating page, not from my own security audit. No candidate was penetration-tested or code-audited here.
9. **AlternativeTo, awesome-selfhosted, Product Hunt, Hacker News** — not opened directly (see the 8-source table). A further check there is unlikely to change the picks — the constraint that decides this is "no server to rent", and every self-hosted entry fails it — but it was not done, so it is recorded as not done.
10. **Buyer-data rules (DNC scrub, consents, pass-on consent)** are unchanged from the demo and the parked gate spec, but no legal check was done in this research. Nothing here is legal advice.
