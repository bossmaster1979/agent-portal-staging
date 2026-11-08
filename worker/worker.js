/* Agent Portal Worker — the shared store + sign-in check for the Agent Portal app.
 *
 * Deployable, NOT deployed. Going live is the owner's tap; see README.md
 * in this folder for the deploy steps.
 *
 * What it does, in plain words:
 *  - Checks an agent's passcode against a stored hash (never the passcode
 *    itself) and hands back a short-lived session token.
 *  - Serves the masked board: area, budget, timeline, pre-approval, date
 *    ready, checks passed. Never names, phones, or emails.
 *  - Claims a buyer with ONE conditional UPDATE ("mark claimed only if
 *    nobody claimed it yet") so exactly one agent wins, even if two tap
 *    Claim at the same second. A claim costs $100, taken off the
 *    agent's balance (topped up by Zelle, $500 at a time, added by
 *    Bge after checking the bank). An agent may hold at most 3 buyers
 *    waiting for a call; a buyer with no call recorded in 48 hours
 *    goes back on the board and the $100 goes back to the balance.
 *  - Records outcomes (called / no answer / deal closed).
 *  - Locks an agent out for a while after 5 wrong passcode guesses.
 *  - Keeps a money ledger (top-ups, claims, refunds) so Bge can
 *    check the books: balance is the sum of the ledger, and the
 *    agent's stored balance must match it.
 *
 * Why one conditional UPDATE: D1 does not let code open a long
 * transaction with BEGIN/COMMIT (reported by developers in 2026), so
 * the safe step is a single UPDATE that only succeeds when the buyer
 * is still unclaimed, then looking at how many rows changed. 1 row =
 * this agent won. 0 rows = someone else got there first. That single
 * step is atomic (all-or-nothing) on its own.
 *
 * Why PBKDF2 for the passcode hash: the Workers runtime has WebCrypto
 * built in, and PBKDF2 is the slow, salted hash it offers — no extra
 * password library to vet, nothing to install. "Slow on purpose" is
 * the point: 100,000 rounds makes guessing one passcode at a time
 * expensive, while checking one real sign-in still takes well under
 * a second. Each passcode gets its own random salt, so two agents
 * with the same passcode still get different stored hashes, and a
 * stolen database cannot be checked against a pre-made list.
 * bcrypt/scrypt are not available in the Workers runtime; PBKDF2
 * with 100,000 rounds of SHA-256 is the standard fallback here.
 * Passcodes must be at least 8 characters (a short 4-digit code is
 * not enough — see money-path-research.md). The length rule is
 * enforced when Bge sets a passcode, in hash-passcode.mjs.
 *
 * The app never talks to D1 directly. It only calls this Worker,
 * and every call except sign-in and health must carry the session
 * token from sign-in.
 *
 * Free tier (Cloudflare docs, via Oct–Nov 2026 write-ups — re-check
 * on Cloudflare's pricing page on the day of the deploy):
 * 100,000 Worker requests a day; D1 5,000,000 rows read / 100,000
 * rows written a day. Over the limit, requests fail until midnight
 * UTC — no bill, because no card is on file.
 *
 * Honest limits (from the research, say them plainly):
 *  - No true push. Phones re-read the board every 20–30 seconds.
 *    A claim shows on another phone a few seconds later, not the
 *    same instant.
 *  - D1 read-after-write delay is unverified: a second phone might
 *    briefly show a buyer as free after it was claimed. The claim
 *    itself is safe (one winner), and the app handles the
 *    "sorry, just claimed" answer.
 *  - Cloudflare is a company service, not open-source software.
 *    The code here is Bge's own, and the data is plain SQL that
 *    can be exported and moved.
 */

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // a token lasts one day
const MAX_WRONG_GUESSES = 5;               // lock after this many wrong tries
const LOCKOUT_MS = 15 * 60 * 1000;         // locked out for 15 minutes
const PBKDF2_ROUNDS = 100000;

// Money — per-lead model, decided by the owner Nov 7, 2026 (replaces
// $499/month). Joining is free; each claimed buyer costs $100.
// Agents top up by Zelle ($500 at a time); Bge adds it by hand after
// checking the bank. Amounts are in cents — never floats for money.
const LEAD_PRICE_CENTS = 10000;            // $100 per claimed buyer
const TOPUP_CENTS = 50000;                 // $500 per Zelle top-up
const MAX_ACTIVE_CLAIMS = 3;               // buyers waiting for a call
const CLAIM_CALL_WINDOW_MS = 48 * 60 * 60 * 1000; // call within 2 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // The app is hosted on GitHub Pages; the Worker must answer it.
    // Allow any origin — the token, not the origin, is the check.
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      let res;
      if (path === "/api/health") {
        res = json({ ok: true });
      } else if (path === "/api/signin" && request.method === "POST") {
        res = await signin(request, env);
      } else if (path === "/api/board") {
        res = await authed(request, env, board);
      } else if (path === "/api/claim" && request.method === "POST") {
        res = await authed(request, env, claim);
      } else if (path === "/api/handover") {
        res = await authed(request, env, handover);
      } else if (path === "/api/my-leads") {
        res = await authed(request, env, myLeads);
      } else if (path === "/api/outcome" && request.method === "POST") {
        res = await authed(request, env, outcome);
      } else {
        res = json({ ok: false, error: "not-found" }, 404);
      }
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const res = json({ ok: false, error: "server-error" }, 500);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // Never let a browser or proxy cache an API answer: the board
    // must be re-read fresh, or a claim by another agent would show
    // up late (or not at all until the cache expired).
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/* ---- passcode hashing (PBKDF2, see the header comment) ---- */

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
async function hashPasscode(passcode, saltHex) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    key, 256);
  return { salt: hex(salt), hash: hex(bits) };
}
async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/* ---- sessions ---- */

async function agentFromToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT agent_id, expires_at FROM sessions WHERE token_hash = ?"
  ).bind(await sha256Hex(token)).first();
  if (!row || row.expires_at < Date.now()) return null;
  const agent = await env.DB.prepare(
    "SELECT id, name, balance_cents FROM agents WHERE id = ? AND approved = 1"
  ).bind(row.agent_id).first();
  return agent || null;
}

async function authed(request, env, handler) {
  const agent = await agentFromToken(request, env);
  if (!agent) return json({ ok: false, error: "not-signed-in" }, 401);
  return handler(request, env, agent);
}

/* ---- sign-in, with lockout after too many wrong guesses ---- */

async function signin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-request" }, 400); }
  const agentId = String(body.agentId || "");
  const passcode = String(body.passcode || "");
  if (!agentId || !passcode) return json({ ok: false, error: "missing" }, 400);

  // Lockout check first — a locked agent gets no more guesses.
  const lock = await env.DB.prepare(
    "SELECT attempts, locked_until FROM failed_signins WHERE agent_id = ?"
  ).bind(agentId).first();
  if (lock && lock.locked_until > Date.now()) {
    return json({ ok: false, error: "locked-out", retryAfterMs: lock.locked_until - Date.now() }, 429);
  }

  const agent = await env.DB.prepare(
    "SELECT id, name, passcode_hash, passcode_salt FROM agents WHERE id = ? AND approved = 1"
  ).bind(agentId).first();

  // Wrong agent or wrong passcode: same answer, same cost. Never say
  // which one was wrong — that would tell a guesser what exists.
  let good = false;
  if (agent && agent.passcode_hash !== "NOT-SET") {
    const check = await hashPasscode(passcode, agent.passcode_salt);
    good = check.hash === agent.passcode_hash;
  }

  if (!good) {
    const attempts = (lock ? lock.attempts : 0) + 1;
    const lockedUntil = attempts >= MAX_WRONG_GUESSES ? Date.now() + LOCKOUT_MS : 0;
    await env.DB.prepare(
      "INSERT INTO failed_signins (agent_id, attempts, locked_until) VALUES (?, ?, ?) " +
      "ON CONFLICT(agent_id) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until"
    ).bind(agentId, attempts, lockedUntil).run();
    if (lockedUntil) {
      return json({ ok: false, error: "locked-out", retryAfterMs: LOCKOUT_MS }, 429);
    }
    return json({ ok: false, error: "wrong-passcode" }, 401);
  }

  // Right passcode: clear the failed guesses, hand back a token.
  await env.DB.prepare("DELETE FROM failed_signins WHERE agent_id = ?").bind(agentId).run();
  const token = crypto.randomUUID() + "-" + hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, agent_id, expires_at) VALUES (?, ?, ?)"
  ).bind(await sha256Hex(token), agent.id, Date.now() + SESSION_TTL_MS).run();
  return json({ ok: true, token, agent: { id: agent.id, name: agent.name } });
}

/* ---- money: active claims, expiry, ledger ---- */

const MASKED = "id, area, budget, timeline, preapproval, ready_since, scrub_date, pass_on_consent";

// A claim counts as "active" (holding one of the agent's 3 slots)
// while the buyer is claimed and no outcome is recorded yet. Once
// the agent records called / no-answer / closed, the slot frees.
async function activeClaimsCount(env, agentId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM buyers b WHERE b.claimed_by = ? " +
    "AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.buyer_id = b.id)"
  ).bind(agentId).first();
  return row ? row.n : 0;
}

// Release buyers whose agent never called within 48 hours: the
// buyer goes back on the board, the $100 goes back to the balance,
// and both steps are written to the ledger. Runs lazily, at the
// start of every board/claim/my-leads/handover read — no separate
// timer needed, and a buyer is never shown as claimed past its
// deadline on the next read after it. The release UPDATE is
// conditional (still claimed by the same agent, same claimed_at),
// so two reads at once can only release a buyer once; the refund
// runs only when that UPDATE changed a row.
async function releaseExpired(env) {
  const cutoff = new Date(Date.now() - CLAIM_CALL_WINDOW_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, claimed_by, claimed_at FROM buyers " +
    "WHERE claimed_by IS NOT NULL AND claimed_at < ? " +
    "AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.buyer_id = buyers.id)"
  ).bind(cutoff).all();
  for (const b of results) {
    const released = await env.DB.prepare(
      "UPDATE buyers SET claimed_by = NULL, claimed_at = NULL " +
      "WHERE id = ? AND claimed_by = ? AND claimed_at = ?"
    ).bind(b.id, b.claimed_by, b.claimed_at).run();
    if (released.meta.changes === 1) {
      await env.DB.prepare(
        "UPDATE agents SET balance_cents = balance_cents + ? WHERE id = ?"
      ).bind(LEAD_PRICE_CENTS, b.claimed_by).run();
      await env.DB.prepare(
        "INSERT INTO ledger (agent_id, kind, amount_cents, buyer_id, note, created_at) " +
        "VALUES (?, 'refund', ?, ?, 'buyer back on board — no call in 48 hours', ?)"
      ).bind(b.claimed_by, LEAD_PRICE_CENTS, b.id, new Date().toISOString()).run();
    }
  }
}

async function board(request, env, agent) {
  await releaseExpired(env);
  const { results } = await env.DB.prepare(
    "SELECT " + MASKED + " FROM buyers WHERE claimed_by IS NULL ORDER BY ready_since, id"
  ).all();
  return json({
    ok: true,
    agent: { id: agent.id, name: agent.name },
    balanceCents: agent.balance_cents,
    leadPriceCents: LEAD_PRICE_CENTS,
    maxActiveClaims: MAX_ACTIVE_CLAIMS,
    activeClaims: await activeClaimsCount(env, agent.id),
    buyers: results.map(b => ({
      id: b.id, area: b.area, budget: b.budget, timeline: b.timeline,
      preapproval: b.preapproval, readySince: b.ready_since,
      scrubDate: b.scrub_date, checksPassed: true,
      passOnConsent: b.pass_on_consent,
    })),
  });
}

/* ---- claim: ONE conditional UPDATE — the safe step (see header) ----
   Plus the money rules, in order: the buyer must still be free, the
   agent must have a free slot (fewer than 3 buyers waiting for a
   call), and the balance must cover the $100. The claim UPDATE is
   the one atomic step; the $100 comes off only after it wins. If
   the balance fell between the check and the deduction (two taps at
   once), the claim is released again and the agent is told to top
   up — never charged for a buyer they did not get. */
async function claim(request, env, agent) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-request" }, 400); }
  const buyerId = String(body.buyerId || "");
  if (!buyerId) return json({ ok: false, error: "missing" }, 400);

  await releaseExpired(env);

  const buyer = await env.DB.prepare(
    "SELECT id, claimed_by FROM buyers WHERE id = ?"
  ).bind(buyerId).first();
  if (!buyer) return json({ ok: false, error: "no-such-buyer" }, 404);
  if (buyer.claimed_by) return json({ ok: false, error: "already-claimed" }, 409);

  // Slot check: at most 3 buyers waiting for a call.
  if (await activeClaimsCount(env, agent.id) >= MAX_ACTIVE_CLAIMS) {
    return json({ ok: false, error: "claim-limit", maxActiveClaims: MAX_ACTIVE_CLAIMS }, 403);
  }

  // Friendly balance check first (the deduction below is the real
  // gate — this just gives the plain-words answer sooner).
  const balance = await env.DB.prepare(
    "SELECT balance_cents FROM agents WHERE id = ?"
  ).bind(agent.id).first();
  if (!balance || balance.balance_cents < LEAD_PRICE_CENTS) {
    return json({ ok: false, error: "not-enough-balance", leadPriceCents: LEAD_PRICE_CENTS, balanceCents: balance ? balance.balance_cents : 0 }, 403);
  }

  // The one safe step. Only succeeds when nobody claimed it yet.
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE buyers SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL"
  ).bind(agent.id, now, buyerId).run();

  if (result.meta.changes !== 1) {
    // 0 rows changed: someone else claimed it between the board read
    // and this tap. The app shows "sorry, just claimed" and re-reads.
    return json({ ok: false, error: "already-claimed" }, 409);
  }

  // Claim won: take the $100 off the balance, conditional on it
  // still being there. If it is not (two taps at once), release
  // the claim again — never charge for a buyer not kept.
  const deducted = await env.DB.prepare(
    "UPDATE agents SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?"
  ).bind(LEAD_PRICE_CENTS, agent.id, LEAD_PRICE_CENTS).run();
  if (deducted.meta.changes !== 1) {
    await env.DB.prepare(
      "UPDATE buyers SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?"
    ).bind(buyerId, agent.id).run();
    return json({ ok: false, error: "not-enough-balance", leadPriceCents: LEAD_PRICE_CENTS }, 403);
  }
  try {
    await env.DB.prepare(
      "INSERT INTO ledger (agent_id, kind, amount_cents, buyer_id, note, created_at) " +
      "VALUES (?, 'claim', ?, ?, '', ?)"
    ).bind(agent.id, -LEAD_PRICE_CENTS, buyerId, now).run();
  } catch (e) {
    // The ledger row is the audit trail, the balance is the truth.
    // If writing it fails, give the money back and release the
    // claim rather than leave a charge with no record.
    await env.DB.prepare(
      "UPDATE agents SET balance_cents = balance_cents + ? WHERE id = ?"
    ).bind(LEAD_PRICE_CENTS, agent.id).run();
    await env.DB.prepare(
      "UPDATE buyers SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ?"
    ).bind(buyerId, agent.id).run();
    return json({ ok: false, error: "server-error" }, 500);
  }
  const after = await env.DB.prepare(
    "SELECT balance_cents FROM agents WHERE id = ?"
  ).bind(agent.id).first();
  return json({ ok: true, buyerId, claimedBy: agent.id, claimedAt: now, balanceCents: after ? after.balance_cents : 0 });
}

/* ---- handover: full details only for the agent who claimed it ---- */

async function handover(request, env, agent) {
  await releaseExpired(env);
  const buyerId = new URL(request.url).searchParams.get("buyer") || "";
  const buyer = await env.DB.prepare("SELECT * FROM buyers WHERE id = ?").bind(buyerId).first();
  if (!buyer) return json({ ok: false, error: "no-such-buyer" }, 404);
  if (!buyer.claimed_by) return json({ ok: false, error: "not-claimed" }, 403);
  if (buyer.claimed_by !== agent.id) {
    const other = await env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(buyer.claimed_by).first();
    return json({ ok: false, error: "already-claimed", claimedByName: other ? other.name : "another agent" }, 403);
  }
  return json({ ok: true, buyer: buyerRow(buyer) });
}

function buyerRow(b) {
  return {
    id: b.id, area: b.area, budget: b.budget, timeline: b.timeline,
    preapproval: b.preapproval, readySince: b.ready_since,
    firstName: b.first_name, phone: b.phone, email: b.email,
    wants: b.wants, call: b.call_time,
    textConsent: b.text_consent, emailConsent: b.email_consent,
    passOnConsent: b.pass_on_consent, consentDate: b.consent_date,
    scrubDate: b.scrub_date, claimedAt: b.claimed_at,
  };
}

/* ---- my leads: buyers this agent claimed, with outcomes ---- */

async function myLeads(request, env, agent) {
  await releaseExpired(env);
  const { results } = await env.DB.prepare(
    "SELECT * FROM buyers WHERE claimed_by = ? ORDER BY claimed_at"
  ).bind(agent.id).all();
  const { results: outs } = await env.DB.prepare(
    "SELECT buyer_id, outcome FROM outcomes WHERE agent_id = ?"
  ).bind(agent.id).all();
  const outcomes = {};
  for (const o of outs) outcomes[o.buyer_id] = o.outcome;
  return json({ ok: true, leads: results.map(buyerRow), outcomes, balanceCents: agent.balance_cents, leadPriceCents: LEAD_PRICE_CENTS });
}

/* ---- outcome: only the agent who claimed the buyer may set it ---- */

async function outcome(request, env, agent) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad-request" }, 400); }
  const buyerId = String(body.buyerId || "");
  const outcome = String(body.outcome || "");
  if (!["called", "no-answer", "closed"].includes(outcome)) {
    return json({ ok: false, error: "bad-outcome" }, 400);
  }
  const buyer = await env.DB.prepare(
    "SELECT claimed_by FROM buyers WHERE id = ?"
  ).bind(buyerId).first();
  if (!buyer) return json({ ok: false, error: "no-such-buyer" }, 404);
  if (buyer.claimed_by !== agent.id) {
    return json({ ok: false, error: "not-yours" }, 403);
  }
  await env.DB.prepare(
    "INSERT INTO outcomes (buyer_id, agent_id, outcome, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(buyer_id) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at"
  ).bind(buyerId, agent.id, outcome, new Date().toISOString()).run();
  return json({ ok: true });
}
