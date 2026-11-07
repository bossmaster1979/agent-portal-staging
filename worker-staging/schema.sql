-- Agent Portal — D1 schema + SAMPLE seed data.
-- Run once against a fresh D1 database (see README.md in this folder).
-- SAMPLE data only: the same 4 made-up buyers as data.js. No real
-- people, no real phone numbers (555-0100 range, set aside for
-- fiction), no real emails (example.com). No farm leads, ever.
-- This portal is a separate project: no agent, buyer, listing, or
-- account from any other project appears here.
--
-- Agents are seeded with passcode_hash 'NOT-SET' on purpose: no
-- passcode works until Bge sets a real one with hash-passcode.mjs.
-- Nothing that can sign in is stored in this repo.

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  passcode_hash TEXT NOT NULL DEFAULT 'NOT-SET',
  passcode_salt TEXT NOT NULL DEFAULT '',
  approved INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY,
  area TEXT NOT NULL,
  budget TEXT NOT NULL,
  timeline TEXT NOT NULL,
  preapproval TEXT NOT NULL,
  ready_since TEXT NOT NULL,
  first_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  wants TEXT NOT NULL,
  call_time TEXT NOT NULL,
  text_consent TEXT NOT NULL,
  email_consent TEXT NOT NULL,
  pass_on_consent TEXT NOT NULL,
  consent_date TEXT NOT NULL,
  scrub_date TEXT NOT NULL,
  claimed_by TEXT,
  claimed_at TEXT
);

CREATE TABLE IF NOT EXISTS outcomes (
  buyer_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS failed_signins (
  agent_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

-- Agents: the two SAMPLE agents, same as data.js. The first real
-- agent is still to be approved by Bge.
INSERT OR IGNORE INTO agents (id, name, role) VALUES
  ('maria', 'Maria Torres', 'SAMPLE agent — made-up example'),
  ('david', 'David Chen', 'SAMPLE agent — made-up example');

-- Buyers: the 4 SAMPLE buyers. A buyer who says NO to being passed
-- to another agent never reaches this board — with no originating
-- agent in this portal, there is nobody who could claim them.
INSERT OR IGNORE INTO buyers
  (id, area, budget, timeline, preapproval, ready_since, first_name, phone, email, wants, call_time, text_consent, email_consent, pass_on_consent, consent_date, scrub_date)
VALUES
  ('A', 'North Park', '$600,000 – $750,000', 'Now', 'Yes', 'Nov 5, 2026', 'Sam', '(555) 010-1001', 'sam@example.com', 'A 3-bedroom house near the park, close to schools.', 'Thu Nov 6 at 6:00 PM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026'),
  ('B', 'La Jolla', '$1,000,000 – $1,250,000', 'Soon', 'Not yet', 'Nov 5, 2026', 'Alex', '(555) 010-1002', 'alex@example.com', 'A condo with a sea view, two bedrooms, no stairs.', 'Fri Nov 7 at 10:00 AM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026'),
  ('D', 'Pacific Beach', '$750,000 – $900,000', 'Soon', 'Yes', 'Nov 5, 2026', 'Ben', '(555) 010-1004', 'ben@example.com', 'A townhouse within walking distance of the beach.', 'Sat Nov 8 at 11:00 AM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026'),
  ('E', 'Escondido', '$450,000 – $600,000', 'Now', 'Not yet', 'Nov 5, 2026', 'Mia', '(555) 010-1005', 'mia@example.com', 'A house with a yard for two dogs.', 'Fri Nov 7 at 5:00 PM Pacific', 'Yes', 'Yes', 'Yes', 'Nov 5, 2026', 'Oct 30, 2026');
