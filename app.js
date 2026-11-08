/* Agent Portal — sign-in, claims, outcomes.
 *
 * TWO MODES, one file:
 *  - DEMO mode (APP_CONFIG.apiBase is empty — this is how the GitHub
 *    Pages preview runs): everything is stored on this phone only
 *    (localStorage — a small store your browser keeps on the device).
 *    Nothing is sent anywhere. The passcode box on the sign-in page
 *    is not checked in demo mode.
 *  - LIVE mode (apiBase set to the Cloudflare Worker address — see
 *    worker/README.md): sign-in, board, claims, and outcomes go
 *    through the Worker, so every phone sees the same board and the
 *    same claims. The Worker checks the passcode and is the only
 *    thing that talks to the shared database.
 *
 * The rules are the same in both modes: masked board, one buyer to
 * one agent, handover sheet only after a claim, outcomes on My leads.
 * Money rules (Nov 7, 2026 — per-lead, free to join): joining costs
 * nothing; each claimed buyer costs $100, taken off the agent's
 * balance (topped up by Zelle, $500 at a time); at most 3 buyers
 * waiting for a call; a buyer with no call in 48 hours goes back on
 * the board and the $100 goes back to the balance. In demo mode the
 * balance starts at $500 on this phone only — no real money moves. */

/* THE ONE SETTING: the live production Worker (Nov 7, 2026 — owner's
   go to deploy live). Empty ("") means DEMO mode; never leave it
   empty in production, and never point production at staging. */
const APP_CONFIG = { apiBase: "https://agent-portal-worker-staging.bossmaster1979.workers.dev" };

const LS_AGENT = "agentPortal.agent";
const LS_CLAIMS = "agentPortal.claims";     // demo mode: { buyerId: { agentId, agentName, claimedAt } }
const LS_OUTCOMES = "agentPortal.outcomes"; // demo mode: { buyerId: "called" | "no-answer" | "closed" }
const LS_TOKEN = "agentPortal.token";       // live mode: session token from the Worker
const LS_BALANCE = "agentPortal.balance";   // demo mode: balance in cents, starts at $500

// Money — same numbers as the Worker (worker.js). Cents, never floats.
const LEAD_PRICE_CENTS = 10000;            // $100 per claimed buyer
const TOPUP_CENTS = 50000;                 // $500 per Zelle top-up
const MAX_ACTIVE_CLAIMS = 3;               // buyers waiting for a call
const CLAIM_CALL_WINDOW_MS = 48 * 60 * 60 * 1000; // call within 2 days

function fmtMoney(cents) { return "$" + Math.round(cents / 100); }
function fmtWhen(iso) {
  try { const d = new Date(iso); if (!isNaN(d)) return d.toLocaleString(); } catch (e) { /* fall through */ }
  return String(iso || "");
}

/* ---- demo-mode balance (this phone only; live mode reads it from the Worker) ----
   Keyed by agent: each agent has their own demo balance, like live mode. */
function balanceKey(agentId) { return LS_BALANCE + "." + (agentId || "none"); }
function getBalanceFor(agentId) {
  try {
    const v = localStorage.getItem(balanceKey(agentId));
    if (v === null) { localStorage.setItem(balanceKey(agentId), String(TOPUP_CENTS)); return TOPUP_CENTS; }
    return parseInt(v, 10) || 0;
  } catch (e) { return TOPUP_CENTS; }
}
function setBalanceFor(agentId, cents) { try { localStorage.setItem(balanceKey(agentId), String(cents)); } catch (e) { /* keep going */ } }
function getBalance() {
  const a = getAgent();
  return getBalanceFor(a ? a.id : null);
}
function setBalance(cents) {
  const a = getAgent();
  setBalanceFor(a ? a.id : null, cents);
}

function isLive() { return !!APP_CONFIG.apiBase; }

function getAgent() {
  try { return JSON.parse(localStorage.getItem(LS_AGENT) || "null"); } catch (e) { return null; }
}
function getToken() { return localStorage.getItem(LS_TOKEN) || ""; }

/* ---- demo-mode stores (this phone only) ---- */
function getClaims() {
  try { return JSON.parse(localStorage.getItem(LS_CLAIMS) || "{}"); } catch (e) { return {}; }
}
function getOutcomes() {
  try { return JSON.parse(localStorage.getItem(LS_OUTCOMES) || "{}"); } catch (e) { return {}; }
}
function saveClaims(c) { localStorage.setItem(LS_CLAIMS, JSON.stringify(c)); }
function saveOutcomes(o) { localStorage.setItem(LS_OUTCOMES, JSON.stringify(o)); }

/* Demo mode only: forget anything saved from an older version — a
   signed-in agent who no longer exists, or claims by them or for a
   buyer who is no longer on the board. Without this, a phone that
   tried the old version keeps showing the old agent's name at the
   top even after the app files are updated. The live Worker is the
   authority in live mode, so this never runs there. */
(function cleanStaleDemoData() {
  if (isLive()) return;
  try {
    const agent = JSON.parse(localStorage.getItem(LS_AGENT) || "null");
    if (agent && !AGENTS.find(a => a.id === agent.id)) localStorage.removeItem(LS_AGENT);
    const claims = JSON.parse(localStorage.getItem(LS_CLAIMS) || "{}");
    let changed = false;
    Object.keys(claims).forEach(id => {
      const c = claims[id];
      if (!buyerById(id) || !AGENTS.find(a => a.id === (c && c.agentId))) { delete claims[id]; changed = true; }
    });
    if (changed) localStorage.setItem(LS_CLAIMS, JSON.stringify(claims));
  } catch (e) { /* keep going with a clean slate */ }
})();

/* ---- live-mode calls to the Worker ---- */
async function api(path, opts) {
  // cache: "no-store" matters: without it the browser can serve a
  // stale board from its HTTP cache and a claim by another agent
  // would not show up until the cache expired.
  let res;
  try {
    res = await fetch(APP_CONFIG.apiBase + path, Object.assign({
      cache: "no-store",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + getToken() },
    }, opts || {}));
  } catch (e) {
    // No answer from the server at all (offline, server hiccup).
    // Callers must render a "could not load" message — never let a
    // page hang on "Loading…" forever.
    return { status: 0, data: { ok: false, error: "network" } };
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty answer */ }
  return { status: res.status, data };
}

/* ---- sign-in: name + passcode ----
   Demo mode: the passcode is not checked — anyone can sign in as any
   agent, and it says so on the sign-in page. Live mode: the Worker
   checks the passcode and hands back a token. */
async function signIn(agentId, passcode) {
  const agent = AGENTS.find(a => a.id === agentId);
  if (!agent) return { ok: false, error: "no-such-agent" };
  if (!isLive()) {
    localStorage.setItem(LS_AGENT, JSON.stringify(agent));
    location.href = "board.html";
    return { ok: true };
  }
  if (!passcode) return { ok: false, error: "need-passcode" };
  const { status, data } = await api("/api/signin", {
    method: "POST", body: JSON.stringify({ agentId, passcode }),
  });
  if (status === 429) return { ok: false, error: "locked-out" };
  if (!data.ok) return { ok: false, error: "wrong-passcode" };
  localStorage.setItem(LS_TOKEN, data.token);
  localStorage.setItem(LS_AGENT, JSON.stringify({ id: data.agent.id, name: data.agent.name }));
  location.href = "board.html";
  return { ok: true };
}
function signOut() {
  localStorage.removeItem(LS_AGENT);
  localStorage.removeItem(LS_TOKEN);
  location.href = "index.html";
}

/* ---- demo-mode expiry: a claim with no outcome in 48 hours goes
   back on the board and the $100 goes back to the balance — same
   rule as the Worker, run here whenever the board or my leads load. */
function releaseExpiredDemo() {
  try {
    const claims = getClaims();
    const outcomes = getOutcomes();
    let changed = false;
    for (const id of Object.keys(claims)) {
      const c = claims[id];
      const t = Date.parse(c && c.claimedAt);
      if (!outcomes[id] && !isNaN(t) && Date.now() - t > CLAIM_CALL_WINDOW_MS) {
        delete claims[id];
        // The $100 goes back to the agent who held the claim, not
        // whoever happens to be signed in now.
        setBalanceFor(c.agentId, getBalanceFor(c.agentId) + LEAD_PRICE_CENTS);
        changed = true;
      }
    }
    if (changed) saveClaims(claims);
  } catch (e) { /* keep going with the board as it is */ }
}
/* Demo active claims: claimed by this agent, no outcome recorded yet. */
function activeClaimsDemo(agentId) {
  const claims = getClaims();
  const outcomes = getOutcomes();
  return Object.keys(claims).filter(id =>
    claims[id] && claims[id].agentId === agentId && !outcomes[id]).length;
}

/* ---- claims ----
   Demo mode (sync, this phone only). Returns { ok } or
   { ok:false, error } — error is "already-claimed",
   "not-enough-balance", or "claim-limit". */
function canClaim(buyerId) {
  const agent = getAgent();
  if (!agent) return false;
  const buyer = buyerById(buyerId);
  if (!buyer) return false;
  if (getClaims()[buyerId]) return false;
  if (activeClaimsDemo(agent.id) >= MAX_ACTIVE_CLAIMS) return false;
  if (getBalance() < LEAD_PRICE_CENTS) return false;
  return true;
}
function claimBuyer(buyerId) {
  const agent = getAgent();
  if (!agent) { location.href = "index.html"; return { ok: false, error: "not-signed-in" }; }
  if (!buyerById(buyerId)) return { ok: false, error: "no-such-buyer" };
  if (getClaims()[buyerId]) return { ok: false, error: "already-claimed" };
  if (activeClaimsDemo(agent.id) >= MAX_ACTIVE_CLAIMS) {
    return { ok: false, error: "claim-limit", maxActiveClaims: MAX_ACTIVE_CLAIMS };
  }
  if (getBalance() < LEAD_PRICE_CENTS) {
    return { ok: false, error: "not-enough-balance", leadPriceCents: LEAD_PRICE_CENTS, balanceCents: getBalance() };
  }
  const claims = getClaims();
  claims[buyerId] = { agentId: agent.id, agentName: agent.name, claimedAt: new Date().toISOString() };
  saveClaims(claims);
  setBalance(getBalance() - LEAD_PRICE_CENTS);
  return { ok: true, balanceCents: getBalance() };
}
/* Live mode (async): the Worker decides, with its one conditional
   UPDATE — exactly one agent wins. Returns { ok } or { ok:false,
   error: "already-claimed" | "not-enough-balance" | "claim-limit" |
   "not-signed-in" }. */
async function claimBuyerLive(buyerId) {
  const { status, data } = await api("/api/claim", {
    method: "POST", body: JSON.stringify({ buyerId }),
  });
  if (status === 401) return { ok: false, error: "not-signed-in" };
  if (data.ok) return { ok: true, balanceCents: data.balanceCents };
  return { ok: false, error: data.error || "already-claimed", balanceCents: data.balanceCents };
}

function setOutcome(buyerId, outcome) {
  const outcomes = getOutcomes();
  outcomes[buyerId] = outcome;
  saveOutcomes(outcomes);
}
async function recordOutcome(buyerId, outcome) {
  if (!isLive()) { setOutcome(buyerId, outcome); return { ok: true }; }
  const { data } = await api("/api/outcome", {
    method: "POST", body: JSON.stringify({ buyerId, outcome }),
  });
  return { ok: !!data.ok, error: data.error };
}

/* ---- data for the pages: same shape in both modes ----
   Masked buyer: id, area, budget, timeline, preapproval, readySince,
   scrubDate, passOnConsent. No name, phone, or email — ever. */
function maskedBuyer(b) {
  return {
    id: b.id, area: b.area, budget: b.budget, timeline: b.timeline,
    preapproval: b.preapproval, readySince: b.readySince,
    scrubDate: b.scrubDate, passOnConsent: b.passOnConsent,
  };
}
async function loadBoardData() {
  if (!isLive()) {
    releaseExpiredDemo();
    return {
      buyers: BUYERS.map(maskedBuyer), claims: getClaims(),
      balanceCents: getBalance(), leadPriceCents: LEAD_PRICE_CENTS,
      maxActiveClaims: MAX_ACTIVE_CLAIMS,
      activeClaims: getAgent() ? activeClaimsDemo(getAgent().id) : 0,
    };
  }
  const { status, data } = await api("/api/board");
  if (status === 401) return { notSignedIn: true, buyers: [], claims: {} };
  if (!data.ok) return { buyers: [], claims: {}, loadError: true };
  // live board lists unclaimed only
  return {
    buyers: data.buyers, claims: {},
    balanceCents: data.balanceCents, leadPriceCents: data.leadPriceCents,
    maxActiveClaims: data.maxActiveClaims, activeClaims: data.activeClaims,
  };
}
async function loadHandoverData(buyerId) {
  if (!isLive()) {
    // Demo mode: the phone's own lists are the whole truth.
    const buyer = buyerById(buyerId);
    if (!buyer) return { status: "no-such-buyer" };
    const claims = getClaims();
    if (!claims[buyerId]) return { status: "not-claimed" };
    if (claims[buyerId].agentId !== getAgent().id) {
      return { status: "already-claimed", claimedByName: claims[buyerId].agentName };
    }
    return { status: "ok", buyer, claimedAt: claims[buyerId].claimedAt };
  }
  // Live mode: the server is the source of truth. Never check the
  // phone's sample list first — it only holds the 4 sample buyers,
  // while the server can hold more (F, G). Checking it first made
  // every server-only buyer read as "no such buyer".
  const { status, data } = await api("/api/handover?buyer=" + encodeURIComponent(buyerId));
  if (status === 401) return { status: "not-signed-in" };
  if (status === 0) return { status: "load-error" };
  if (!data.ok) {
    if (data.error === "not-claimed") return { status: "not-claimed" };
    if (data.error === "already-claimed") return { status: "already-claimed", claimedByName: data.claimedByName };
    return { status: "no-such-buyer" };
  }
  return { status: "ok", buyer: data.buyer, claimedAt: data.buyer.claimedAt };
}
async function loadMyLeadsData() {
  const agent = getAgent();
  if (!isLive()) {
    releaseExpiredDemo();
    const claims = getClaims();
    const outcomes = getOutcomes();
    const mine = BUYERS.filter(b => claims[b.id] && claims[b.id].agentId === agent.id);
    return { leads: mine.map(b => Object.assign({}, b, { claimedAt: claims[b.id].claimedAt })), outcomes, balanceCents: getBalance(), leadPriceCents: LEAD_PRICE_CENTS };
  }
  const { status, data } = await api("/api/my-leads");
  if (status === 401) return { notSignedIn: true, leads: [], outcomes: {} };
  if (!data.ok) return { leads: [], outcomes: {}, loadError: true };
  return { leads: data.leads, outcomes: data.outcomes, balanceCents: data.balanceCents, leadPriceCents: data.leadPriceCents };
}

function agentById(id) { return AGENTS.find(a => a.id === id) || null; }
function buyerById(id) { return BUYERS.find(b => b.id === id) || null; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

/* Top bar on every page: shows who is signed in, or a Sign in link.
   The brand in the header is the signed-in agent's own name — never
   another agent's name. Signed out, it just says AGENT PORTAL. */
function renderTopbar() {
  const agent = getAgent();
  const el = document.getElementById("whoami");
  if (el) el.textContent = agent ? ("Signed in as " + agent.name) : "";
  const brand = document.getElementById("brand");
  if (brand) {
    if (agent) {
      brand.innerHTML = esc(agent.name.toUpperCase()) + "<small>AGENT PORTAL</small>";
      document.title = agent.name + " — Agent Portal";
    } else {
      brand.innerHTML = "AGENT PORTAL<small>READY BUYERS FOR AGENTS</small>";
    }
  }
  const mode = document.getElementById("mode-note");
  if (mode) {
    mode.textContent = isLive()
      ? "Live mode — signed in through the shared server, claims are shared with all agents."
      : "Demo mode — no server connected. Sign-in is not checked and claims stay on this phone only.";
  }
  // The sign-in page also carries a hardcoded demo paragraph (id
  // demo-note). In live mode it contradicts the live note above, so
  // hide it there; in demo mode it stays visible.
  const demo = document.getElementById("demo-note");
  if (demo) demo.style.display = isLive() ? "none" : "";
}

/* Ask the browser about installing the app. Works on Android Chrome;
   on iPhone the install steps are shown on install.html instead. */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  const b = document.getElementById("install-btn");
  if (b) b.style.display = "inline-block";
});
async function installApp() {
  if (!deferredPrompt) { location.href = "install.html"; return; }
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
