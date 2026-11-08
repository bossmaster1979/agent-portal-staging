// Make a PBKDF2 passcode hash for one agent, to store in D1.
// Same settings as worker.js: PBKDF2, 100,000 rounds, SHA-256,
// random 16-byte salt. Run it, then put the salt + hash into D1
// with `wrangler d1 execute` (see README.md). The passcode itself
// is never stored anywhere — Bge hands it to the agent by call/text.
//
// Usage:
//   node hash-passcode.mjs <agent-id> <passcode>
// Passcodes must be at least 8 characters. A short 4-digit code is
// not enough — see money-path-research.md.

import { pbkdf2Sync, randomBytes } from "node:crypto";

const [agentId, passcode] = process.argv.slice(2);
if (!agentId || !passcode) {
  console.error("Usage: node hash-passcode.mjs <agent-id> <passcode>");
  process.exit(1);
}
if (passcode.length < 8) {
  console.error("Passcode must be at least 8 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(passcode, salt, 100000, 32, "sha256");
console.log("Agent: " + agentId);
console.log("Salt:  " + salt.toString("hex"));
console.log("Hash:  " + hash.toString("hex"));
console.log("");
console.log("Run this to store it (replace <db> with the database name):");
console.log(
  `wrangler d1 execute <db> --remote --command "UPDATE agents SET passcode_hash = '${hash.toString("hex")}', passcode_salt = '${salt.toString("hex")}' WHERE id = '${agentId}';"`
);
console.log("");
console.log("To switch an agent off, no code change — just run:");
console.log(
  `wrangler d1 execute <db> --remote --command "UPDATE agents SET approved = 0 WHERE id = '${agentId}';"`
);
