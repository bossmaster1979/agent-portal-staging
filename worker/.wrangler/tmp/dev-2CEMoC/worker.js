var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
var MAX_WRONG_GUESSES = 5;
var LOCKOUT_MS = 15 * 60 * 1e3;
var PBKDF2_ROUNDS = 1e5;
var LEAD_PRICE_CENTS = 1e4;
var MAX_ACTIVE_CLAIMS = 3;
var CLAIM_CALL_WINDOW_MS = 48 * 60 * 60 * 1e3;
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
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
  }
};
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    // Never let a browser or proxy cache an API answer: the board
    // must be re-read fresh, or a claim by another agent would show
    // up late (or not at all until the cache expired).
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
__name(json, "json");
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hex, "hex");
function unhex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(unhex, "unhex");
async function hashPasscode(passcode, saltHex) {
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passcode),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    key,
    256
  );
  return { salt: hex(salt), hash: hex(bits) };
}
__name(hashPasscode, "hashPasscode");
async function sha256Hex(text) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
__name(sha256Hex, "sha256Hex");
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
__name(agentFromToken, "agentFromToken");
async function authed(request, env, handler) {
  const agent = await agentFromToken(request, env);
  if (!agent) return json({ ok: false, error: "not-signed-in" }, 401);
  return handler(request, env, agent);
}
__name(authed, "authed");
async function signin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad-request" }, 400);
  }
  const agentId = String(body.agentId || "");
  const passcode = String(body.passcode || "");
  if (!agentId || !passcode) return json({ ok: false, error: "missing" }, 400);
  const lock = await env.DB.prepare(
    "SELECT attempts, locked_until FROM failed_signins WHERE agent_id = ?"
  ).bind(agentId).first();
  if (lock && lock.locked_until > Date.now()) {
    return json({ ok: false, error: "locked-out", retryAfterMs: lock.locked_until - Date.now() }, 429);
  }
  const agent = await env.DB.prepare(
    "SELECT id, name, passcode_hash, passcode_salt FROM agents WHERE id = ? AND approved = 1"
  ).bind(agentId).first();
  let good = false;
  if (agent && agent.passcode_hash !== "NOT-SET") {
    const check = await hashPasscode(passcode, agent.passcode_salt);
    good = check.hash === agent.passcode_hash;
  }
  if (!good) {
    const attempts = (lock ? lock.attempts : 0) + 1;
    const lockedUntil = attempts >= MAX_WRONG_GUESSES ? Date.now() + LOCKOUT_MS : 0;
    await env.DB.prepare(
      "INSERT INTO failed_signins (agent_id, attempts, locked_until) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET attempts = excluded.attempts, locked_until = excluded.locked_until"
    ).bind(agentId, attempts, lockedUntil).run();
    if (lockedUntil) {
      return json({ ok: false, error: "locked-out", retryAfterMs: LOCKOUT_MS }, 429);
    }
    return json({ ok: false, error: "wrong-passcode" }, 401);
  }
  await env.DB.prepare("DELETE FROM failed_signins WHERE agent_id = ?").bind(agentId).run();
  const token = crypto.randomUUID() + "-" + hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, agent_id, expires_at) VALUES (?, ?, ?)"
  ).bind(await sha256Hex(token), agent.id, Date.now() + SESSION_TTL_MS).run();
  return json({ ok: true, token, agent: { id: agent.id, name: agent.name } });
}
__name(signin, "signin");
var MASKED = "id, area, budget, timeline, preapproval, ready_since, scrub_date, pass_on_consent";
async function activeClaimsCount(env, agentId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM buyers b WHERE b.claimed_by = ? AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.buyer_id = b.id)"
  ).bind(agentId).first();
  return row ? row.n : 0;
}
__name(activeClaimsCount, "activeClaimsCount");
async function releaseExpired(env) {
  const cutoff = new Date(Date.now() - CLAIM_CALL_WINDOW_MS).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, claimed_by, claimed_at FROM buyers WHERE claimed_by IS NOT NULL AND claimed_at < ? AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.buyer_id = buyers.id)"
  ).bind(cutoff).all();
  for (const b of results) {
    const released = await env.DB.prepare(
      "UPDATE buyers SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ? AND claimed_at = ?"
    ).bind(b.id, b.claimed_by, b.claimed_at).run();
    if (released.meta.changes === 1) {
      await env.DB.prepare(
        "UPDATE agents SET balance_cents = balance_cents + ? WHERE id = ?"
      ).bind(LEAD_PRICE_CENTS, b.claimed_by).run();
      await env.DB.prepare(
        "INSERT INTO ledger (agent_id, kind, amount_cents, buyer_id, note, created_at) VALUES (?, 'refund', ?, ?, 'buyer back on board \u2014 no call in 48 hours', ?)"
      ).bind(b.claimed_by, LEAD_PRICE_CENTS, b.id, (/* @__PURE__ */ new Date()).toISOString()).run();
    }
  }
}
__name(releaseExpired, "releaseExpired");
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
    buyers: results.map((b) => ({
      id: b.id,
      area: b.area,
      budget: b.budget,
      timeline: b.timeline,
      preapproval: b.preapproval,
      readySince: b.ready_since,
      scrubDate: b.scrub_date,
      checksPassed: true,
      passOnConsent: b.pass_on_consent
    }))
  });
}
__name(board, "board");
async function claim(request, env, agent) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad-request" }, 400);
  }
  const buyerId = String(body.buyerId || "");
  if (!buyerId) return json({ ok: false, error: "missing" }, 400);
  await releaseExpired(env);
  const buyer = await env.DB.prepare(
    "SELECT id, claimed_by FROM buyers WHERE id = ?"
  ).bind(buyerId).first();
  if (!buyer) return json({ ok: false, error: "no-such-buyer" }, 404);
  if (buyer.claimed_by) return json({ ok: false, error: "already-claimed" }, 409);
  if (await activeClaimsCount(env, agent.id) >= MAX_ACTIVE_CLAIMS) {
    return json({ ok: false, error: "claim-limit", maxActiveClaims: MAX_ACTIVE_CLAIMS }, 403);
  }
  const balance = await env.DB.prepare(
    "SELECT balance_cents FROM agents WHERE id = ?"
  ).bind(agent.id).first();
  if (!balance || balance.balance_cents < LEAD_PRICE_CENTS) {
    return json({ ok: false, error: "not-enough-balance", leadPriceCents: LEAD_PRICE_CENTS, balanceCents: balance ? balance.balance_cents : 0 }, 403);
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const result = await env.DB.prepare(
    "UPDATE buyers SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL"
  ).bind(agent.id, now, buyerId).run();
  if (result.meta.changes !== 1) {
    return json({ ok: false, error: "already-claimed" }, 409);
  }
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
      "INSERT INTO ledger (agent_id, kind, amount_cents, buyer_id, note, created_at) VALUES (?, 'claim', ?, ?, '', ?)"
    ).bind(agent.id, -LEAD_PRICE_CENTS, buyerId, now).run();
  } catch (e) {
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
__name(claim, "claim");
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
__name(handover, "handover");
function buyerRow(b) {
  return {
    id: b.id,
    area: b.area,
    budget: b.budget,
    timeline: b.timeline,
    preapproval: b.preapproval,
    readySince: b.ready_since,
    firstName: b.first_name,
    phone: b.phone,
    email: b.email,
    wants: b.wants,
    call: b.call_time,
    textConsent: b.text_consent,
    emailConsent: b.email_consent,
    passOnConsent: b.pass_on_consent,
    consentDate: b.consent_date,
    scrubDate: b.scrub_date,
    claimedAt: b.claimed_at
  };
}
__name(buyerRow, "buyerRow");
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
__name(myLeads, "myLeads");
async function outcome(request, env, agent) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad-request" }, 400);
  }
  const buyerId = String(body.buyerId || "");
  const outcome2 = String(body.outcome || "");
  if (!["called", "no-answer", "closed"].includes(outcome2)) {
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
    "INSERT INTO outcomes (buyer_id, agent_id, outcome, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(buyer_id) DO UPDATE SET outcome = excluded.outcome, updated_at = excluded.updated_at"
  ).bind(buyerId, agent.id, outcome2, (/* @__PURE__ */ new Date()).toISOString()).run();
  return json({ ok: true });
}
__name(outcome, "outcome");

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-ZNoSM0/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-ZNoSM0/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
