'use strict';
// REST API for Grilled — shapes pinned by docs/CONTRACTS.md. Do not deviate.
const express = require('express');
const { db, randomKey, newGameCode } = require('../db');
const { PROMPTS } = require('../engine/prompts');
const { generateQuiz } = require('../engine/questions');
const { getSessionUser } = require('./auth');
const { generateSpeech } = require('../engine/speech');
const config = require('../config');
const { aiAvailable } = require('../ai/claude');
const { writeSpeech } = require('../ai/speechWriter');
const { punchUpDecoys } = require('../ai/decoyWriter');
const { runAssistant } = require('../ai/assistant');

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
    aiEnabled: aiAvailable(),
    claimed: !!event.userId,
    claimedByYou: !!(user && event.userId === user.id),
    isDemo: !!event.isDemo,
  });
});

// --- POST /api/events/:organiserKey/build ------------------------------------
router.post('/events/:organiserKey/build', async (req, res) => {
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

  // Paid events with AI on: punch up the "Two Truths" decoys so the lies
  // sound tailored to the guest. Best-effort — template decoys stay on failure.
  // Demo events are excluded: they carry the top plan for showcase purposes
  // but must never spend AI tokens (nobody paid).
  let aiDecoys = 0;
  if (!event.isDemo && (event.plan === 'full' || event.plan === 'speech') && aiAvailable()) {
    const fresh = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
    aiDecoys = await punchUpDecoys(fresh);
  }

  res.json({ built: true, questionCount, aiDecoys });
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

router.post('/events/:organiserKey/speech/build', async (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.plan !== 'speech') {
    return res.status(403).json({ error: 'The speech needs the Roast & Toast plan.' });
  }
  const submissions = db
    .prepare(`SELECT promptKey, text FROM submissions WHERE eventId = ? ORDER BY id`)
    .all(event.id);
  const gameResults = gameResultsForEvent(event.id);

  // AI first (bespoke prose), template as the always-working fallback.
  // Demos never spend tokens — their showcase speech is pre-written anyway.
  const aiText = event.isDemo ? null : await writeSpeech({
    submissions,
    tone: event.tone,
    guestName: event.name,
    occasion: event.occasion,
    gameResults,
    eventId: event.id,
  });
  const fullText = aiText || generateSpeech({
    submissions,
    tone: event.tone,
    guestName: event.name,
    occasion: event.occasion,
    gameResults,
  }).fullText;

  db.prepare(`UPDATE events SET speechText = ? WHERE id = ?`).run(fullText, event.id);
  res.json({
    speech: fullText,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
    source: aiText ? 'ai' : 'template',
  });
});

// --- POST /api/events/:organiserKey/assistant ---------------------------------
// The organiser assistant (paid plans, AI on). Chat history lives client-side.
router.post('/events/:organiserKey/assistant', async (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (!aiAvailable()) {
    return res.status(503).json({ error: 'The assistant is not switched on for this server.' });
  }
  if (event.plan !== 'full' && event.plan !== 'speech') {
    return res.status(403).json({ error: 'The assistant comes with the Full Grilling.' });
  }
  if (event.isDemo) {
    return res.status(403).json({ error: 'The assistant comes with real events — the demo moderates the old-fashioned way.' });
  }

  const body = req.body || {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Say something first.' });
  if (message.length > 1000) return res.status(400).json({ error: 'Keep it under 1000 characters.' });

  let history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  history = history.filter(
    (h) =>
      h && (h.role === 'user' || h.role === 'assistant') &&
      typeof h.content === 'string' && h.content.length > 0 && h.content.length <= 4000
  );

  try {
    const result = await runAssistant({ event, message, history });
    res.json(result);
  } catch (e) {
    console.error('assistant failed:', e.message);
    res.status(502).json({ error: 'The assistant tripped over the grill — try again in a moment.' });
  }
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
// The demo is the shop window: enough material that the engine builds ~20
// questions from PRIMARY framings only (secondary framings reuse answers and
// read as duplication), plus a hand-written Roast & Toast speech so visitors
// see the full product at its best.
const DEMO_SUBMISSIONS = [
  { promptKey: 'story', text: "Gary got his tie caught in the office paper shredder mid-Zoom call and had to cut himself free with nail scissors while forty colleagues watched in silence. He kept saying 'as per my last email' the whole time." },
  { promptKey: 'story', text: "On the stag do in Blackpool, Gary lost a bet and had to order every round for the rest of the night speaking only in pirate. By midnight the barman was adding a 'doubloon surcharge' and Gary paid it without breaking character." },
  { promptKey: 'story', text: "Gary once missed a boarding call because he'd gone back through security to buy a Toblerone. He only made the flight because it was delayed, and he still describes this as 'good instincts'." },
  { promptKey: 'story', text: "At a food festival Gary queued forty minutes for what he thought was free cheese. It was a raffle. He panicked, bought thirty tickets, and won a barbecue smoker he is now visibly afraid of." },
  { promptKey: 'fact', text: "Gary keeps a spreadsheet ranking every motorway service station he has ever visited. Tebay is top, Watford Gap is bottom, and he will defend the methodology with his life." },
  { promptKey: 'fact', text: "He has cried at the John Lewis Christmas advert three years running and blamed hay fever. In December." },
  { promptKey: 'fact', text: "He has a 200-day Duolingo streak in Welsh. He has never been to Wales and has no plans to go." },
  { promptKey: 'fact', text: "He calls his slow cooker 'the workhorse' and was once overheard describing it as 'the only one who really listens'." },
  { promptKey: 'fact', text: "He won the pub quiz single-handed in 2019 and has brought it up, on average, once a fortnight since." },
  { promptKey: 'fact', text: "He owns a 'good pen'. Nobody else is allowed to use the good pen. He can tell when it has been moved." },
  { promptKey: 'word', text: 'Beige' },
  { promptKey: 'word', text: 'Chaotic' },
  { promptKey: 'word', text: 'Thorough' },
  { promptKey: 'never', text: 'turn down a carvery, even if he has already had a carvery that day.' },
  { promptKey: 'never', text: 'say the barbecue is anything other than "two minutes away", regardless of all available evidence.' },
  { promptKey: 'never', text: 'walk past a dog without giving it a full match commentary.' },
  { promptKey: 'sentence', text: "I'm not being funny, but..." },
  { promptKey: 'sentence', text: 'To be fair, it was reduced.' },
];

// Hand-written Roast & Toast sample — the speech the demo shows off.
const DEMO_SPEECH = `Ladies and gentlemen, for those who don't know me, I'm the best man, which in Gary's case is less an honour and more a safeguarding role.

Before anything else, some thank yous. To everyone who travelled to be here, some of you from genuinely inconvenient places: thank you, and the bar is open. To the parents on both sides, for the welcome, the wisdom, and the discreet financing. To the bridesmaids, who have been magnificent all day and deserve far better than the dance moves heading their way this evening. And to the bride, who looks absolutely stunning. Gary, you look like a man who tried extremely hard, which for you is itself a triumph, and we are all quietly moved.

Now. Before tonight, we did something Gary doesn't know about. We sent a secret link to everyone who loves him and asked for the truth. No names, full anonymity. I want you to bear that in mind as you listen, Gary, because every word of what follows came from the people at these tables. Your people. The ones you invited. The ones currently avoiding eye contact.

I met Gary at university, in a kitchen, at two in the morning, during a fire alarm. Everyone else stood shivering in the car park with a coat. Gary emerged carrying his laptop, a dressing gown he wasn't wearing, and a single raw potato he has never adequately explained. I looked at this man and thought: there is a person who will be in my life forever. I was right, and I have spent twenty years paying for it.

Your friends were asked to describe him in one word. The three answers that came back were "thorough", "chaotic" and "beige". I can confirm all three are accurate, frequently within the same hour. Thorough: this is a man who keeps a spreadsheet ranking every motorway service station he has ever visited. Tebay at the top, Watford Gap at the bottom, and a scoring methodology he defends like it's his own child. Chaotic: he once missed a boarding call because he'd gone back through security for a Toblerone. He made the flight only because it was delayed, and to this day he describes that as "good instincts". Beige speaks for itself, and so does his wardrobe.

The stories came flooding in, and I want to read you one exactly as it arrived: "Gary got his tie caught in the office paper shredder mid-Zoom call and had to cut himself free with nail scissors while forty colleagues watched in silence. He kept saying 'as per my last email' the whole time." Forty witnesses. Nail scissors. And the man never once dropped his professional register. If that isn't the husband you want beside you in a crisis, I don't know who is.

Someone else reminded us about Blackpool. On the stag do, Gary lost a bet and had to order every round for the rest of the night speaking only in pirate. By midnight the barman was adding a "doubloon surcharge", and Gary paid it without breaking character. Think about what that tells you. Gary is a man of his word. Even when his word is "arrr". And then there was the food festival, where he queued forty minutes for what he believed was free cheese, discovered it was a raffle, panicked, bought thirty tickets, and won a barbecue smoker he is now visibly afraid of. It lives in the garage. He checks on it.

There is a softer side, and his friends made sure I knew about it. He has cried at the John Lewis Christmas advert three years running and blamed hay fever. In December. He has a 200-day Duolingo streak in Welsh, for a country he has never visited and has no plans to. He won the pub quiz single-handed in 2019 and has mentioned it, on average, once a fortnight since, and honestly, fair enough. He owns a "good pen" that nobody else may touch, and he can tell when it has been moved. And he calls his slow cooker "the workhorse", which was funny right up until someone overheard him describe it as "the only one who really listens". Not any more, Gary. You have a wife for that now, and she has questions.

And then she arrived, and those of us who have known Gary longest watched something remarkable happen. The spreadsheet gained a new column for her favourite stops. Tebay kept the top spot, but the methodology suddenly had room for a second opinion, which anyone familiar with the methodology will recognise as the single largest concession of Gary's adult life. He started saying "we" without noticing. He learned to share the good pen: one person on earth has borrowing rights, and she is wearing white. Because for all the chaos, there is nobody more loyal than Gary. He is the friend who turns up. Unasked, unannounced, admittedly usually with a carvery recommendation, but he turns up. And watching him with her these past few years, we have all seen the same thing. He turns up for her like it is the only fixture on the calendar.

We also asked what Gary would never do, and on this your friends were unanimous. He would never turn down a carvery, even if he has already had a carvery that day. He would never admit the barbecue is anything other than "two minutes away", regardless of all available evidence. And he would never walk past a dog without giving it a full match commentary. So to the bride: the man you have married is a simple creature, and he will love you the way he loves a carvery. Completely, and entirely without shame.

Married life advice was also collected anonymously, and the best of it deserves reading out. One: "the barbecue is never two minutes away, and neither is Gary, so tell him an earlier time." Two: "she is now the good pen. Irreplaceable. Notice if she has been moved."

So: please be upstanding and charge your glasses. To the woman who has heard "I'm not being funny, but..." a thousand times and married him anyway. To the man who once paid a doubloon surcharge out of sheer integrity. To the two of them, and the lifetime of stories their mates will one day submit about them both. Ladies and gentlemen: to the bride and groom!`;

router.post('/demo', (req, res) => {
  const organiserKey = randomKey(12);
  const submissionKey = randomKey(8);
  // Demo events get the top plan and a pre-written speech — the shop window
  // shows the whole product.
  const info = db
    .prepare(`INSERT INTO events (name, occasion, tone, organiserKey, submissionKey, isDemo, plan, speechText) VALUES (?, ?, ?, ?, ?, 1, 'speech', ?)`)
    .run('Gary', 'wedding', 'medium', organiserKey, submissionKey, DEMO_SPEECH);
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
