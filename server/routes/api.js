'use strict';
// REST API for Grilled — shapes pinned by docs/CONTRACTS.md. Do not deviate.
const express = require('express');
const { db, randomKey, newGameCode } = require('../db');
const { PROMPTS } = require('../engine/prompts');
const { generateQuiz } = require('../engine/questions');
const { getSessionUser } = require('./auth');
const { generateSpeech } = require('../engine/speech');
const config = require('../config');

const router = express.Router();

// --- schema shim: track organiser edits so rebuilds can preserve them -------
// db.js owns the base schema; we add the `edited` flag (ARCHITECTURE.md's
// "edited overrides") with a guarded migration so rebuilds know which rows to keep.
{
  const cols = db.prepare(`PRAGMA table_info(questions)`).all();
  if (!cols.some((c) => c.name === 'edited')) {
    db.exec(`ALTER TABLE questions ADD COLUMN edited INTEGER NOT NULL DEFAULT 0`);
  }
}

const TONES = ['gentle', 'medium', 'roast'];
const MAX_SUBMISSION_CHARS = 500;
const MAX_NAME_CHARS = 60;
const MAX_OCCASION_CHARS = 100;
const MAX_QUESTION_CHARS = 500;
const MAX_OPTION_CHARS = 200;
const PROMPT_KEYS = new Set(PROMPTS.map((p) => p.key));

// --- rate limit: in-memory token bucket, 30 POSTs/min/IP → 429 --------------
const RATE_CAP = 60; // burst capacity — party guests often share one NAT'd IP (venue wifi)
const RATE_PER_MIN = 30; // refill rate
const buckets = new Map(); // ip → {tokens, last}

function rateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: RATE_CAP, last: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(RATE_CAP, b.tokens + ((now - b.last) * RATE_PER_MIN) / 60000);
  b.last = now;
  if (b.tokens < 1) {
    return res.status(429).json({ error: 'Too many requests — slow down and try again in a minute.' });
  }
  b.tokens -= 1;
  next();
}
router.use(rateLimit);
// test hook (not a public API)
router.__resetRateLimit = () => buckets.clear();

// --- helpers -----------------------------------------------------------------
function getEventByOrganiserKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(key);
}

function getEventBySubmissionKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return db.prepare(`SELECT * FROM events WHERE submissionKey = ?`).get(key);
}

function cleanString(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Regenerate questions for an event, preserving moderation state by fingerprint:
// - existing fingerprints keep their status; edited rows also keep questionText/options/correctIndex
// - new fingerprints inserted as 'pending'
// - fingerprints no longer generated are deleted UNLESS status='approved' AND edited
function runBuild(event, toneOverride) {
  const tone = toneOverride || event.tone;
  const submissions = db
    .prepare(`SELECT id, promptKey, text FROM submissions WHERE eventId = ? ORDER BY id`)
    .all(event.id);
  const quiz = generateQuiz({ submissions, tone, guestName: event.name });

  const existing = db.prepare(`SELECT * FROM questions WHERE eventId = ?`).all(event.id);
  const byFingerprint = new Map(existing.map((q) => [q.fingerprint, q]));

  const insert = db.prepare(
    `INSERT INTO questions (eventId, roundKey, format, questionText, options, correctIndex, sourceText, fingerprint, status, sortOrder, edited)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`
  );
  const updateFresh = db.prepare(
    `UPDATE questions SET roundKey = ?, format = ?, questionText = ?, options = ?, correctIndex = ?, sourceText = ?, sortOrder = ? WHERE id = ?`
  );
  const updateEdited = db.prepare(
    `UPDATE questions SET roundKey = ?, format = ?, sourceText = ?, sortOrder = ? WHERE id = ?`
  );
  const remove = db.prepare(`DELETE FROM questions WHERE id = ?`);

  const tx = db.transaction(() => {
    const seen = new Set();
    let sortOrder = 0;
    for (const round of quiz.rounds || []) {
      for (const q of round.questions || []) {
        if (seen.has(q.fingerprint)) continue; // guard against engine dupes
        seen.add(q.fingerprint);
        sortOrder += 1;
        const prev = byFingerprint.get(q.fingerprint);
        if (!prev) {
          insert.run(
            event.id, round.roundKey, q.format, q.questionText,
            JSON.stringify(q.options), q.correctIndex, q.sourceText || '',
            q.fingerprint, sortOrder
          );
        } else if (prev.edited) {
          // keep organiser's text/options/correctIndex; refresh placement metadata
          updateEdited.run(round.roundKey, q.format, q.sourceText || '', sortOrder, prev.id);
        } else {
          // keep status, refresh generated content
          updateFresh.run(
            round.roundKey, q.format, q.questionText, JSON.stringify(q.options),
            q.correctIndex, q.sourceText || '', sortOrder, prev.id
          );
        }
      }
    }
    for (const prev of existing) {
      if (seen.has(prev.fingerprint)) continue;
      if (prev.status === 'approved' && prev.edited) continue; // organiser invested in it — keep
      remove.run(prev.id);
    }
    if (toneOverride && toneOverride !== event.tone) {
      db.prepare(`UPDATE events SET tone = ? WHERE id = ?`).run(toneOverride, event.id);
    }
  });
  tx();

  return db.prepare(`SELECT COUNT(*) AS c FROM questions WHERE eventId = ?`).get(event.id).c;
}

// --- POST /api/events --------------------------------------------------------
router.post('/events', (req, res) => {
  const body = req.body || {};
  const name = cleanString(body.name);
  const occasion = cleanString(body.occasion);
  const tone = body.tone === undefined ? 'medium' : cleanString(body.tone);

  if (!name || !occasion) return res.status(400).json({ error: 'Guest name and occasion are both required.' });
  if (name.length > MAX_NAME_CHARS) return res.status(400).json({ error: `Name must be ${MAX_NAME_CHARS} characters or fewer.` });
  if (occasion.length > MAX_OCCASION_CHARS) return res.status(400).json({ error: `Occasion must be ${MAX_OCCASION_CHARS} characters or fewer.` });
  if (!TONES.includes(tone)) return res.status(400).json({ error: `Tone must be one of: ${TONES.join(', ')}.` });

  const organiserKey = randomKey(12);
  const submissionKey = randomKey(8);
  db.prepare(
    `INSERT INTO events (name, occasion, tone, organiserKey, submissionKey) VALUES (?, ?, ?, ?, ?)`
  ).run(name, occasion, tone, organiserKey, submissionKey);

  res.json({ organiserKey, submissionKey });
});

// --- GET /api/events/:organiserKey -------------------------------------------
router.get('/events/:organiserKey', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const submissionCount = db
    .prepare(`SELECT COUNT(*) AS c FROM submissions WHERE eventId = ?`).get(event.id).c;
  const rows = db
    .prepare(`SELECT status, COUNT(*) AS c FROM questions WHERE eventId = ? GROUP BY status`)
    .all(event.id);
  const questionCounts = { pending: 0, approved: 0, binned: 0 };
  for (const r of rows) if (r.status in questionCounts) questionCounts[r.status] = r.c;

  const user = getSessionUser(req);
  res.json({
    name: event.name,
    occasion: event.occasion,
    tone: event.tone,
    status: event.status,
    submissionCount,
    questionCounts,
    gameCode: event.gameCode || null,
    submissionUrl: `/s/${event.submissionKey}`,
    hostUrl: `/host/${event.organiserKey}`,
    plan: event.plan || 'free',
    freeQuestionLimit: config.FREE_QUESTION_LIMIT,
    speechPricePence: config.SPEECH_PRICE_PENCE,
    paymentsEnabled: config.PAYMENTS_ENABLED,
    claimed: !!event.userId,
    claimedByYou: !!(user && event.userId === user.id),
  });
});

// --- POST /api/events/:organiserKey/build ------------------------------------
router.post('/events/:organiserKey/build', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.status === 'locked') return res.status(409).json({ error: 'Quiz is locked — it cannot be rebuilt.' });

  const body = req.body || {};
  let toneOverride;
  if (body.tone !== undefined) {
    toneOverride = cleanString(body.tone);
    if (!TONES.includes(toneOverride)) {
      return res.status(400).json({ error: `Tone must be one of: ${TONES.join(', ')}.` });
    }
  }

  const questionCount = runBuild(event, toneOverride);
  res.json({ built: true, questionCount });
});

// --- GET /api/events/:organiserKey/questions ----------------------------------
router.get('/events/:organiserKey/questions', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const rows = db
    .prepare(`SELECT id, roundKey, format, questionText, options, correctIndex, sourceText, status
              FROM questions WHERE eventId = ? ORDER BY sortOrder, id`)
    .all(event.id);
  res.json({
    questions: rows.map((r) => ({
      id: r.id,
      roundKey: r.roundKey,
      format: r.format,
      questionText: r.questionText,
      options: JSON.parse(r.options),
      correctIndex: r.correctIndex,
      sourceText: r.sourceText || '',
      status: r.status,
    })),
  });
});

// --- PATCH /api/questions/:id -------------------------------------------------
router.patch('/questions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid question id.' });
  const body = req.body || {};

  const question = db.prepare(`SELECT * FROM questions WHERE id = ?`).get(id);
  if (!question) return res.status(404).json({ error: 'Question not found.' });

  const event = getEventByOrganiserKey(cleanString(body.organiserKey));
  if (!event || event.id !== question.eventId) {
    return res.status(403).json({ error: 'Organiser key does not match this question.' });
  }

  const sets = [];
  const args = [];

  if (body.status !== undefined) {
    const status = cleanString(body.status);
    if (!['pending', 'approved', 'binned'].includes(status)) {
      return res.status(400).json({ error: 'Status must be pending, approved or binned.' });
    }
    sets.push('status = ?');
    args.push(status);
  }
  if (body.questionText !== undefined) {
    const text = cleanString(body.questionText);
    if (!text) return res.status(400).json({ error: 'Question text cannot be empty.' });
    if (text.length > MAX_QUESTION_CHARS) {
      return res.status(400).json({ error: `Question text must be ${MAX_QUESTION_CHARS} characters or fewer.` });
    }
    sets.push('questionText = ?', 'edited = 1');
    args.push(text);
  }
  if (body.options !== undefined) {
    const opts = body.options;
    if (!Array.isArray(opts) || opts.length !== 4 || !opts.every((o) => typeof o === 'string')) {
      return res.status(400).json({ error: 'Options must be an array of exactly 4 strings.' });
    }
    const trimmed = opts.map((o) => o.trim());
    if (trimmed.some((o) => !o || o.length > MAX_OPTION_CHARS)) {
      return res.status(400).json({ error: `Each option must be 1–${MAX_OPTION_CHARS} characters.` });
    }
    sets.push('options = ?', 'edited = 1');
    args.push(JSON.stringify(trimmed));
  }

  if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

  args.push(id);
  db.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  res.json({ ok: true });
});

// --- Roast & Toast speech (plan 'speech' only) --------------------------------
const MAX_SPEECH_CHARS = 20000;

// Pull winner + best-accuracy player out of the game checkpoint, if the game ran.
function gameResultsForEvent(eventId) {
  const row = db.prepare(`SELECT state FROM game_checkpoints WHERE eventId = ?`).get(eventId);
  if (!row) return null;
  let state;
  try {
    state = JSON.parse(row.state);
  } catch {
    return null;
  }
  const players = state.players || [];
  if (!players.length) return null;
  const winner = players.reduce((a, b) => (b.score > a.score ? b : a));
  if (!winner.score) return null; // game never really happened
  const knowers = players.filter((p) => p.stats && p.stats.answered > 0);
  let knowsBest = null;
  if (knowers.length) {
    const best = knowers.reduce((a, b) =>
      b.stats.correct / b.stats.answered > a.stats.correct / a.stats.answered ? b : a
    );
    knowsBest = { nickname: best.nickname, correct: best.stats.correct, answered: best.stats.answered };
  }
  return { winner: { nickname: winner.nickname, score: winner.score }, knowsBest };
}

router.get('/events/:organiserKey/speech', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  res.json({
    unlocked: event.plan === 'speech',
    speech: event.plan === 'speech' ? event.speechText || null : null,
  });
});

router.post('/events/:organiserKey/speech/build', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.plan !== 'speech') {
    return res.status(403).json({ error: 'The speech needs the Roast & Toast plan.' });
  }
  const submissions = db
    .prepare(`SELECT promptKey, text FROM submissions WHERE eventId = ? ORDER BY id`)
    .all(event.id);
  const speech = generateSpeech({
    submissions,
    tone: event.tone,
    guestName: event.name,
    occasion: event.occasion,
    gameResults: gameResultsForEvent(event.id),
  });
  db.prepare(`UPDATE events SET speechText = ? WHERE id = ?`).run(speech.fullText, event.id);
  res.json({ speech: speech.fullText, wordCount: speech.wordCount });
});

router.patch('/events/:organiserKey/speech', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.plan !== 'speech') {
    return res.status(403).json({ error: 'The speech needs the Roast & Toast plan.' });
  }
  const text = (req.body || {}).text;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'The speech needs some words.' });
  }
  if (text.length > MAX_SPEECH_CHARS) {
    return res.status(400).json({ error: `Speeches cap out at ${MAX_SPEECH_CHARS} characters — nobody wants a two-hour toast.` });
  }
  db.prepare(`UPDATE events SET speechText = ? WHERE id = ?`).run(text, event.id);
  res.json({ ok: true });
});

// --- POST /api/events/:organiserKey/ready ------------------------------------
router.post('/events/:organiserKey/ready', (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.status === 'locked' && event.gameCode) {
    return res.json({ gameCode: event.gameCode }); // idempotent
  }

  const approved = db
    .prepare(`SELECT COUNT(*) AS c FROM questions WHERE eventId = ? AND status = 'approved'`)
    .get(event.id).c;
  if (approved < 10) {
    return res.status(400).json({ error: `You need at least 10 approved questions to play (you have ${approved}).` });
  }

  const gameCode = newGameCode();
  db.prepare(`UPDATE events SET gameCode = ?, status = 'locked' WHERE id = ?`).run(gameCode, event.id);
  res.json({ gameCode });
});

// --- GET /api/submit/:submissionKey -------------------------------------------
router.get('/submit/:submissionKey', (req, res) => {
  const event = getEventBySubmissionKey(req.params.submissionKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  res.json({
    guestName: event.name,
    occasion: event.occasion,
    open: event.status === 'collecting',
    prompts: PROMPTS.map((p) => ({
      key: p.key,
      label: p.label(event.name),
      placeholder: p.placeholder,
    })),
  });
});

// --- POST /api/submit/:submissionKey ------------------------------------------
router.post('/submit/:submissionKey', (req, res) => {
  const event = getEventBySubmissionKey(req.params.submissionKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.status !== 'collecting') return res.status(403).json({ error: 'closed' });

  const entries = (req.body || {}).entries;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'Entries must be an array.' });

  const valid = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const promptKey = cleanString(entry.promptKey);
    if (!PROMPT_KEYS.has(promptKey)) continue;
    if (typeof entry.text !== 'string') continue;
    const text = entry.text.trim();
    if (!text) continue;
    if (text.length > MAX_SUBMISSION_CHARS) {
      return res.status(400).json({ error: `Each answer must be ${MAX_SUBMISSION_CHARS} characters or fewer.` });
    }
    valid.push({ promptKey, text });
  }
  if (!valid.length) return res.status(400).json({ error: 'Fill in at least one prompt before submitting.' });

  const insert = db.prepare(`INSERT INTO submissions (eventId, promptKey, text) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const v of valid) insert.run(event.id, v.promptKey, v.text);
  });
  tx();
  res.json({ ok: true });
});

// --- POST /api/demo -----------------------------------------------------------
const DEMO_SUBMISSIONS = [
  { promptKey: 'story', text: "Gary got his tie caught in the office paper shredder mid-Zoom call and had to cut himself free with nail scissors while forty colleagues watched in silence. He kept saying 'as per my last email' the whole time." },
  { promptKey: 'story', text: "On a stag do in Blackpool, Gary lost a bet and had to order every round for the rest of the night speaking only in pirate. By midnight the barman was adding a 'doubloon surcharge' and Gary paid it without breaking character." },
  { promptKey: 'fact', text: "Gary keeps a spreadsheet ranking every motorway service station he has ever visited. Tebay is top, Watford Gap is bottom, and he will defend the methodology with his life." },
  { promptKey: 'fact', text: "He has cried at the John Lewis Christmas advert three years running and blamed hay fever. In December." },
  { promptKey: 'word', text: 'Beige' },
  { promptKey: 'word', text: 'Chaotic' },
  { promptKey: 'never', text: 'turn down a carvery, even if he has already had a carvery that day.' },
  { promptKey: 'sentence', text: "I'm not being funny, but..." },
];

router.post('/demo', (req, res) => {
  const organiserKey = randomKey(12);
  const submissionKey = randomKey(8);
  // Demo events get the full plan — the demo is the shop window.
  const info = db
    .prepare(`INSERT INTO events (name, occasion, tone, organiserKey, submissionKey, isDemo, plan) VALUES (?, ?, ?, ?, ?, 1, 'full')`)
    .run('Gary', '30th birthday', 'medium', organiserKey, submissionKey);
  const eventId = info.lastInsertRowid;

  const insert = db.prepare(`INSERT INTO submissions (eventId, promptKey, text) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const s of DEMO_SUBMISSIONS) insert.run(eventId, s.promptKey, s.text);
  });
  tx();

  const event = db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId);
  runBuild(event);
  db.prepare(`UPDATE questions SET status = 'approved' WHERE eventId = ?`).run(eventId);
  // deliberately NOT locked — the visitor gets to moderate and press "Ready to play"

  res.json({ organiserKey });
});

module.exports = router;
