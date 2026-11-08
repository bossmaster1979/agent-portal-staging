// Agent Portal — fail-able check, Playwright. Run from
// ~/workspace/projects/reel-DfWR5BWiGct/playwright-test with:
//   npx playwright test tests/agent-portal.spec.js
// Needs TWO copies of the app (the source app.js now ships the
// production Worker address, so serving the source directly is LIVE
// mode against production — never do that for the demo tests):
//   DEMO copy at http://localhost:8130 (apiBase empty):
//     rm -rf /tmp/agent-portal-demo && cp -r ~/workspace/projects/agent-portal-app /tmp/agent-portal-demo
//     sed -i 's#apiBase: "https://agent-portal-worker.bossmaster1979.workers.dev"#apiBase: ""#' /tmp/agent-portal-demo/app.js
//     python3 -m http.server 8130 --directory /tmp/agent-portal-demo
//
// The last test ("live: ...") also needs:
//   1. The Worker running locally: cd ~/workspace/projects/agent-portal-app/worker
//      && npx wrangler dev --local --port 8787 (after `wrangler d1 execute
//      agent-portal --local --file schema.sql` once, and test passcodes set
//      with hash-passcode.mjs — see worker/README.md. Test passcodes live
//      ONLY in the local D1 database as hashes, and the two values below
//      are staging/local-only test values — they do NOT work against the
//      production Worker (production passcodes are NOT-SET until Bge
//      approves a real agent, verified Nov 7, 2026). Set them locally
//      with `node hash-passcode.mjs <agent-id> <passcode>` and run ONLY
//      the FIRST UPDATE it prints (passcode_hash + passcode_salt) — the
//      helper also prints a switch-off UPDATE (approved = 0); running
//      that one locks the agent out of sign-in entirely (caught in
//      Sandbox 1, Nov 7, 2026).
//      The test below expects the passcodes to be "test-passcode-456"
//      for maria and "test-passcode-789" for david — set exactly those
//      two locally, or edit the two fill() lines to match yours.
//   2. A LIVE copy of the app (same files, apiBase pointed at the local
//      Worker) served at http://localhost:8131:
//        rm -rf /tmp/agent-portal-live && cp -r ~/workspace/projects/agent-portal-app /tmp/agent-portal-live
//        sed -i 's#apiBase: "https://agent-portal-worker.bossmaster1979.workers.dev"#apiBase: "http://localhost:8787"#' /tmp/agent-portal-live/app.js
//        python3 -m http.server 8131 --directory /tmp/agent-portal-live
//      (The sed must match the production URL now in app.js — the old
//      `apiBase: ""` pattern no longer matches, and a missed sed would
//      point the "live" copy at the PRODUCTION Worker.)
//   3. Fresh local D1 state before the run (claims from earlier runs
//      would hide buyers). Wipe + reseed first if the schema changed
//      (balance_cents + ledger arrived Nov 7, 2026 — an old local D1
//      has neither; delete worker/.wrangler/state and run schema.sql
//      again), then run these three commands:
//        npx wrangler d1 execute agent-portal --local --command "UPDATE buyers SET claimed_by = NULL, claimed_at = NULL; DELETE FROM outcomes; DELETE FROM sessions; DELETE FROM failed_signins; DELETE FROM ledger; UPDATE agents SET balance_cents = 50000 WHERE id = 'maria'; UPDATE agents SET balance_cents = 15000 WHERE id = 'david';"
//        npx wrangler d1 execute agent-portal --local --command "INSERT OR REPLACE INTO buyers (id, area, budget, timeline, preapproval, ready_since, first_name, phone, email, wants, call_time, text_consent, email_consent, pass_on_consent, consent_date, scrub_date, claimed_by, claimed_at) VALUES ('F', 'Chula Vista', '\$500,000 - \$650,000', 'Soon', 'Yes', 'Nov 5, 2026', 'Noah', '(555) 010-1006', 'noah@example.com', 'A starter home with a garage.', 'Sun Nov 9 at 2:00 PM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026', 'david', datetime('now', '-3 days'));"
//        npx wrangler d1 execute agent-portal --local --command "INSERT OR REPLACE INTO buyers (id, area, budget, timeline, preapproval, ready_since, first_name, phone, email, wants, call_time, text_consent, email_consent, pass_on_consent, consent_date, scrub_date) VALUES ('G', 'Oceanside', '\$700,000 - \$850,000', 'Now', 'Yes', 'Nov 5, 2026', 'Zoe', '(555) 010-1007', 'zoe@example.com', 'A house near the coast, three bedrooms.', 'Mon Nov 10 at 4:00 PM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026');"
//      Buyer F is the expiry case: claimed by David 3 days ago with
//      no outcome, so the first board read must release it and refund
//      him $100 (his $150 becomes $250). Buyer G is the extra buyer
//      the cap test needs. Both live ONLY in the local D1, never in
//      schema.sql or data.js.
// If the Worker is not reachable, the live test skips itself — the demo
// tests still run. The live test is only "passed" when it actually runs.
const { test, expect } = require("@playwright/test");

const BASE = "http://localhost:8130";
const BASE_LIVE = "http://localhost:8131";
const WORKER = "http://localhost:8787";

test("portal: sign-in, board masked, balance, claims deduct $100, cap of 3, handover gated, outcomes saved, SW registers", async ({ page }) => {
  const failed = [];
  page.on("response", r => { if (r.status() >= 400) failed.push(r.url() + " -> " + r.status()); });
  page.on("pageerror", e => failed.push("pageerror: " + e.message));

  // 1. Sign-in page loads; two SAMPLE agents, passcode boxes.
  // Demo mode says plainly the passcode is not checked and nothing is sent.
  await page.goto(BASE + "/index.html");
  await expect(page.locator("h1")).toHaveText("Agent Portal");
  const agentCards = page.locator("#agent-list .card");
  await expect(agentCards).toHaveCount(2);
  await expect(agentCards.nth(0)).toContainText("Maria Torres");
  await expect(agentCards.nth(0)).toContainText("SAMPLE");
  await expect(agentCards.nth(1)).toContainText("SAMPLE");
  await expect(page.locator('input[type="password"]')).toHaveCount(2);
  await expect(page.locator("#mode-note")).toContainText("Demo mode");
  await expect(page.locator("body")).toContainText("passcode is not checked");
  await expect(page.locator("body")).toContainText("Bge is your lead provider");

  // 2. Sign in as Maria (passcode filled, not checked in demo mode) ->
  // board with 4 masked SAMPLE buyers, no phone/email visible, balance $500.
  // The header now says the signed-in agent's own name, not anyone else's.
  await agentCards.nth(0).locator('input[type="password"]').fill("demo-passcode");
  await agentCards.nth(0).locator("button").click();
  await expect(page).toHaveURL(/board\.html/);
  await expect(page.locator("#brand")).toContainText("MARIA TORRES");
  await expect(page.locator("#brand")).toContainText("AGENT PORTAL");
  await expect(page.locator("#board .card")).toHaveCount(4);
  await expect(page.locator("#balance-line")).toContainText("Your balance: $500");
  await expect(page.locator("#balance-line")).toContainText("Each claim costs $100");
  await expect(page.locator("#board .card").first().locator("button")).toHaveText("Claim this buyer — $100");
  const boardText = await page.locator("#board").innerText();
  expect(boardText).not.toContain("(555)");
  expect(boardText).not.toContain("example.com");
  expect(boardText).not.toContain("Sam");
  expect(boardText).toContain("SAMPLE");
  expect(boardText).toContain("Checks");
  expect(boardText).toContain("Passed");

  // 3. Handover before claim is refused.
  await page.goto(BASE + "/handover.html?buyer=B");
  await expect(page.locator("#sheet")).toContainText("Not claimed yet");
  await expect(page.locator("#sheet")).not.toContainText("(555) 010-1002");

  // 4. Claim buyer A -> handover sheet shows SAMPLE data; balance $400.
  await page.goto(BASE + "/board.html");
  await page.locator("#board .card", { hasText: "Ready buyer A" }).locator("button").click();
  await expect(page).toHaveURL(/handover\.html\?buyer=A/);
  await expect(page.locator("#sheet")).toContainText("Sam");
  await expect(page.locator("#sheet")).toContainText("(555) 010-1001");
  await expect(page.locator("#sheet")).toContainText("sam@example.com");
  await expect(page.locator("#sheet")).toContainText("Thu Nov 6 at 6:00 PM Pacific");

  // 5. Board no longer shows buyer A (3 left); balance $400.
  await page.goto(BASE + "/board.html");
  await expect(page.locator("#board .card")).toHaveCount(3);
  await expect(page.locator("#board")).not.toContainText("Ready buyer A");
  await expect(page.locator("#balance-line")).toContainText("Your balance: $400");

  // 6. Claim B and D: balance $200, 3 buyers waiting for a call.
  await page.locator("#board .card", { hasText: "Ready buyer B" }).locator("button").click();
  await expect(page).toHaveURL(/handover\.html\?buyer=B/);
  await page.goto(BASE + "/board.html");
  await page.locator("#board .card", { hasText: "Ready buyer D" }).locator("button").click();
  await expect(page).toHaveURL(/handover\.html\?buyer=D/);
  await page.goto(BASE + "/board.html");
  await expect(page.locator("#board .card")).toHaveCount(1);
  await expect(page.locator("#balance-line")).toContainText("Your balance: $200");
  await expect(page.locator("#balance-line")).toContainText("3 of 3 buyers waiting for a call");

  // 7. The cap: a 4th claim is refused with the plain-words message,
  // shown right on the board (not a pop-up box). The message comes
  // after the claim round-trip, so the text check waits for it.
  await page.locator("#board .card", { hasText: "Ready buyer E" }).locator("button").click();
  await expect(page).toHaveURL(/board\.html/);
  await expect(page.locator("#claim-error")).toContainText("3 buyers waiting for a call");
  await expect(page.locator("#board .card")).toHaveCount(1);
  await expect(page.locator("#balance-line")).toContainText("Your balance: $200");

  // 8. My leads shows A, B, D; record "Called" on A; it sticks after reload.
  await page.goto(BASE + "/my-leads.html");
  await expect(page.locator("#mine .card")).toHaveCount(3);
  await expect(page.locator("#mine")).toContainText("Ready buyer A");
  await expect(page.locator("#balance-line")).toContainText("Your balance: $200");
  await page.locator("#mine .card", { hasText: "Ready buyer A" }).locator("button", { hasText: "Called" }).click();
  await expect(page.locator("#mine")).toContainText("Called — spoke to the buyer");
  await page.reload();
  await expect(page.locator("#mine")).toContainText("Called — spoke to the buyer");

  // 9. The "Called" freed a slot: Maria can claim E now; balance $100.
  await page.goto(BASE + "/board.html");
  await expect(page.locator("#balance-line")).toContainText("2 of 3 buyers waiting for a call");
  await page.locator("#board .card", { hasText: "Ready buyer E" }).locator("button").click();
  await expect(page).toHaveURL(/handover\.html\?buyer=E/);
  await expect(page.locator("#sheet")).toContainText("Mia");
  await page.goto(BASE + "/board.html");
  await expect(page.locator("#board")).toContainText("No ready buyers on the board right now");
  await expect(page.locator("#balance-line")).toContainText("Your balance: $100");

  // 10. Second agent cannot claim or view buyer A. Only the sign-in
  // is cleared — Maria's claims stay (same phone, same store), so
  // David sees an empty board.
  await page.evaluate(() => { localStorage.removeItem("agentPortal.agent"); });
  await page.goto(BASE + "/index.html");
  await page.locator("#agent-list .card").nth(1).locator('input[type="password"]').fill("demo-passcode");
  await page.locator("#agent-list .card").nth(1).locator("button").click();
  await expect(page).toHaveURL(/board\.html/);
  // David signed in: the header says DAVID CHEN now, not Maria.
  await expect(page.locator("#brand")).toContainText("DAVID CHEN");
  await expect(page.locator("#brand")).not.toContainText("MARIA");
  await expect(page.locator("#board")).toContainText("No ready buyers on the board right now");
  await page.goto(BASE + "/handover.html?buyer=A");
  await expect(page.locator("#sheet")).toContainText("Already claimed");
  await expect(page.locator("#sheet")).toContainText("Maria Torres");
  await expect(page.locator("#sheet")).not.toContainText("(555) 010-1001");

  // 11. Other pages load: about (no names, no listings), install.
  await page.goto(BASE + "/about.html");
  await expect(page.locator("body")).toContainText("How the portal works");
  await expect(page.locator("body")).toContainText("separate project");
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  await expect(page.locator('a[href^="mailto:"]')).toHaveCount(0);
  await page.goto(BASE + "/install.html");
  await expect(page.locator("h1")).toHaveText("Install the app");
  await expect(page.locator("body")).toContainText("Add to Home Screen");

  // 12. Manifest valid + icons load; service worker registered.
  const manifest = await page.request.get(BASE + "/manifest.json");
  expect(manifest.status()).toBe(200);
  const m = await manifest.json();
  expect(m.display).toBe("standalone");
  expect(m.icons.length).toBe(2);
  for (const icon of m.icons) {
    const r = await page.request.get(BASE + "/" + icon.src);
    expect(r.status()).toBe(200);
  }
  await page.goto(BASE + "/index.html");
  await page.waitForTimeout(1500);
  const sw = await page.evaluate(() => navigator.serviceWorker.getRegistration());
  expect(sw).toBeTruthy();

  expect(failed).toEqual([]);
});

test("portal: signed-out visitor going straight to board.html is sent to sign-in", async ({ page }) => {
  await page.goto(BASE + "/board.html");
  await expect(page).toHaveURL(/index\.html/);
  await expect(page.locator("h1")).toHaveText("Agent Portal");
  await page.goto(BASE + "/my-leads.html");
  await expect(page).toHaveURL(/index\.html/);
  await page.goto(BASE + "/handover.html?buyer=A");
  await expect(page).toHaveURL(/index\.html/);
});

test("portal: billing page shows $100 per buyer by Zelle, free to join, address never on page, charges nothing on its own", async ({ page }) => {
  const failed = [];
  page.on("response", r => { if (r.status() >= 400) failed.push(r.url() + " -> " + r.status()); });
  await page.goto(BASE + "/billing.html");
  await expect(page.locator("h1")).toHaveText("Billing");
  await expect(page.locator("body")).toContainText("Free to join");
  await expect(page.locator("body")).toContainText("$100 per ready buyer");
  await expect(page.locator("body")).toContainText("Paid by Zelle");
  await expect(page.locator("body")).toContainText("never shown on this page");
  await expect(page.locator("body")).toContainText("no card form on this page");
  await expect(page.locator("body")).toContainText("Top up $500 by Zelle");
  await expect(page.locator("body")).toContainText("sends you your passcode");
  await expect(page.locator("body")).toContainText("never written in this app");
  await expect(page.locator("body")).toContainText("3 buyers at a time");
  await expect(page.locator("body")).toContainText("Call within 2 days");
  await expect(page.locator("body")).toContainText("handover sheet");
  // No payment link anywhere on the page — nothing to tap, nothing charged.
  await expect(page.locator('a[href*="stripe"], a[href*="buy.stripe"], a[href*="checkout"]')).toHaveCount(0);
  // Linked from the board nav and the sign-in page.
  await page.goto(BASE + "/index.html");
  await expect(page.locator('a[href="billing.html"]')).toHaveCount(2); // nav + footer link
  await page.locator("#agent-list .card").nth(0).locator("button").click();
  await expect(page).toHaveURL(/board\.html/);
  await expect(page.locator('nav a[href="billing.html"]')).toHaveCount(1);
  expect(failed).toEqual([]);
});

test("live: per-lead claims, balance, cap, expiry refund, cross-context claim (Worker + local D1)", async ({ browser }) => {
  // Skip (don't fake a pass) if the local Worker or live copy is not up.
  const health = await fetch(WORKER + "/api/health").then(r => r.ok).catch(() => false);
  const liveUp = await fetch(BASE_LIVE + "/index.html").then(r => r.ok).catch(() => false);
  test.skip(!health || !liveUp, "local Worker (8787) or live app copy (8131) not running — see the header comment");

  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  const failed = [];
  for (const p of [p1, p2]) {
    // 401 on a wrong passcode, 403 on a refused handover, and 403 on a
    // refused claim (not-enough-balance / claim-limit) are expected
    // answers in this test, not failures — skip those.
    p.on("response", r => {
      if (r.status() >= 400 &&
        !(r.url().endsWith("/api/signin") && r.status() === 401) &&
        !(r.url().includes("/api/handover") && r.status() === 403) &&
        !(r.url().endsWith("/api/claim") && r.status() === 403)) {
        failed.push(r.url() + " -> " + r.status());
      }
    });
    p.on("pageerror", e => failed.push("pageerror: " + e.message));
  }

  // Wrong passcode is refused, with a plain-words message, no redirect.
  await p1.goto(BASE_LIVE + "/index.html");
  await expect(p1.locator("#mode-note")).toContainText("Live mode");
  await p1.locator("#agent-list .card").nth(0).locator('input[type="password"]').fill("wrong-wrong-wrong");
  await p1.locator("#agent-list .card").nth(0).locator("button").click();
  await expect(p1.locator("#signin-error")).toContainText("Wrong passcode");
  await expect(p1).toHaveURL(/index\.html/);

  // Context 1 signs in as Maria (real passcode check). Her first board
  // read releases buyer F (claimed by David 3 days ago, no outcome):
  // F is back on the board, so 6 buyers show, balance $500.
  await p1.locator("#agent-list .card").nth(0).locator('input[type="password"]').fill("test-passcode-456");
  await p1.locator("#agent-list .card").nth(0).locator("button").click();
  await expect(p1).toHaveURL(/board\.html/);
  await expect(p1.locator("#board .card")).toHaveCount(6);
  await expect(p1.locator("#balance-line")).toContainText("Your balance: $500");

  // Context 2 signs in as David. His $150 became $250: the $100 refund
  // for buyer F landed. Board shows 6 buyers too (F is back).
  await p2.goto(BASE_LIVE + "/index.html");
  await p2.locator("#agent-list .card").nth(1).locator('input[type="password"]').fill("test-passcode-789");
  await p2.locator("#agent-list .card").nth(1).locator("button").click();
  await expect(p2).toHaveURL(/board\.html/);
  await expect(p2.locator("#board .card")).toHaveCount(6);
  await expect(p2.locator("#balance-line")).toContainText("Your balance: $250");

  // Context 1 claims buyer A through the Worker -> handover sheet, balance $400.
  await p1.locator("#board .card", { hasText: "Ready buyer A" }).locator("button").click();
  await expect(p1).toHaveURL(/handover\.html\?buyer=A/);
  await expect(p1.locator("#sheet")).toContainText("Sam");

  // Context 2 re-reads the board: buyer A is gone — the claim crossed
  // contexts through the shared store, not this phone's localStorage.
  await p2.goto(BASE_LIVE + "/board.html");
  await expect(p2.locator("#board .card")).toHaveCount(5);
  await expect(p2.locator("#board")).not.toContainText("Ready buyer A");

  // Context 2 cannot see buyer A's handover sheet either.
  await p2.goto(BASE_LIVE + "/handover.html?buyer=A");
  await expect(p2.locator("#sheet")).toContainText("Already claimed");
  await expect(p2.locator("#sheet")).toContainText("Maria Torres");

  // David claims B ($250 -> $150) and D ($150 -> $50), then E is refused:
  // not enough balance, plain-words message, E stays on the board.
  await p2.goto(BASE_LIVE + "/board.html");
  await p2.locator("#board .card", { hasText: "Ready buyer B" }).locator("button").click();
  await expect(p2).toHaveURL(/handover\.html\?buyer=B/);
  await p2.goto(BASE_LIVE + "/board.html");
  await expect(p2.locator("#balance-line")).toContainText("Your balance: $150");
  await p2.locator("#board .card", { hasText: "Ready buyer D" }).locator("button").click();
  await expect(p2).toHaveURL(/handover\.html\?buyer=D/);
  await p2.goto(BASE_LIVE + "/board.html");
  await expect(p2.locator("#balance-line")).toContainText("Your balance: $50");
  await expect(p2.locator("#board .card")).toHaveCount(3);
  await p2.locator("#board .card", { hasText: "Ready buyer E" }).locator("button").click();
  await expect(p2).toHaveURL(/board\.html/);
  await expect(p2.locator("#claim-error")).toContainText("Not enough balance");
  await expect(p2.locator("#board .card")).toHaveCount(3);
  await expect(p2.locator("#balance-line")).toContainText("Your balance: $50");

  // Maria claims E and F (2 active, then 3 active), then G is refused:
  // the cap, plain-words message, G stays on the board.
  await p1.goto(BASE_LIVE + "/board.html");
  await expect(p1.locator("#board .card")).toHaveCount(3);
  await p1.locator("#board .card", { hasText: "Ready buyer E" }).locator("button").click();
  await expect(p1).toHaveURL(/handover\.html\?buyer=E/);
  await p1.goto(BASE_LIVE + "/board.html");
  await expect(p1.locator("#balance-line")).toContainText("Your balance: $300");
  await p1.locator("#board .card", { hasText: "Ready buyer F" }).locator("button").click();
  await expect(p1).toHaveURL(/handover\.html\?buyer=F/);
  await p1.goto(BASE_LIVE + "/board.html");
  await expect(p1.locator("#balance-line")).toContainText("Your balance: $200");
  await expect(p1.locator("#balance-line")).toContainText("3 of 3 buyers waiting for a call");
  await expect(p1.locator("#board .card")).toHaveCount(1);
  await p1.locator("#board .card", { hasText: "Ready buyer G" }).locator("button").click();
  await expect(p1).toHaveURL(/board\.html/);
  await expect(p1.locator("#claim-error")).toContainText("3 buyers waiting for a call");
  await expect(p1.locator("#board .card")).toHaveCount(1);

  // Context 1 records an outcome through the Worker; it sticks.
  await p1.goto(BASE_LIVE + "/my-leads.html");
  await expect(p1.locator("#mine .card")).toHaveCount(3);
  await expect(p1.locator("#balance-line")).toContainText("Your balance: $200");
  await p1.locator("#mine .card", { hasText: "Ready buyer A" }).locator("button", { hasText: "Called" }).click();
  await expect(p1.locator("#mine")).toContainText("Called — spoke to the buyer");
  await p1.reload();
  await expect(p1.locator("#mine")).toContainText("Called — spoke to the buyer");

  await ctx1.close();
  await ctx2.close();
  expect(failed).toEqual([]);
});
