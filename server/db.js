'use strict';
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'grilled.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  occasion TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT 'medium',
  organiserKey TEXT NOT NULL UNIQUE,
  submissionKey TEXT NOT NULL UNIQUE,
  gameCode TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'collecting',
  isDemo INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  promptKey TEXT NOT NULL,
  text TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  eventId INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  roundKey TEXT NOT NULL,
  format TEXT NOT NULL,
  questionText TEXT NOT NULL,
  options TEXT NOT NULL,           -- JSON array of strings
  correctIndex INTEGER NOT NULL,
  sourceText TEXT,                 -- the story shown at reveal
  fingerprint TEXT NOT NULL,       -- stable id of (format+source) so edits/bins survive rebuilds
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|binned
  sortOrder INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_event ON questions(eventId);
CREATE INDEX IF NOT EXISTS idx_submissions_event ON submissions(eventId);
CREATE TABLE IF NOT EXISTS game_checkpoints (
  eventId INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  state TEXT NOT NULL,             -- JSON
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS magic_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  eventId INTEGER REFERENCES events(id) ON DELETE CASCADE,  -- set → this is a claim link
  expiresAt TEXT NOT NULL,
  usedAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// v2 columns on events (guarded ALTERs — SQLite has no ADD COLUMN IF NOT EXISTS)
{
  const cols = new Set(db.prepare(`PRAGMA table_info(events)`).all().map((c) => c.name));
  if (!cols.has('plan')) db.exec(`ALTER TABLE events ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'`);
  if (!cols.has('paidAt')) db.exec(`ALTER TABLE events ADD COLUMN paidAt TEXT`);
  if (!cols.has('stripeSessionId')) db.exec(`ALTER TABLE events ADD COLUMN stripeSessionId TEXT`);
  if (!cols.has('userId')) db.exec(`ALTER TABLE events ADD COLUMN userId INTEGER REFERENCES users(id)`);
  if (!cols.has('speechText')) db.exec(`ALTER TABLE events ADD COLUMN speechText TEXT`);
}

// Retention sweeps on boot: events after 30 days (the trust feature),
// plus expired auth artefacts.
db.prepare(`DELETE FROM events WHERE createdAt < datetime('now', '-30 days')`).run();
db.prepare(`DELETE FROM magic_tokens WHERE expiresAt < datetime('now')`).run();
db.prepare(`DELETE FROM sessions WHERE expiresAt < datetime('now')`).run();

function randomKey(bytes) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function newGameCode() {
  // 4 uppercase letters, avoiding ambiguous chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    const clash = db.prepare(`SELECT 1 FROM events WHERE gameCode = ?`).get(code);
    if (!clash) return code;
  }
  throw new Error('could not allocate game code');
}

module.exports = { db, randomKey, newGameCode };
