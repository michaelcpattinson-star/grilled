'use strict';
// Adversarial QA edge-case tests — new file, does not touch existing tests.
// Covers gaps: long/unicode/HTML inputs, tone handling, rebuild-preserves-edits,
// timer boundaries, large lobbies, checkpoint resume mid-round.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-qa-test-${process.pid}-${Date.now()}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const request = require('supertest');

const { app } = require('../server/index');
const apiRouter = require('../server/routes/api');
const { db } = require('../server/db');
const { generateQuiz } = require('../server/engine/questions');
const { Game, createOrResumeGame, TIMER_SECONDS } = require('../server/game/gameManager');

test.beforeEach(() => apiRouter.__resetRateLimit());

// deterministic rng
function mul(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function allQ(quiz) { return quiz.rounds.flatMap((r) => r.questions); }

// ---------------------------------------------------------------------------
// LAYER 1 — engine / input handling edge cases
// ---------------------------------------------------------------------------

test('500-char submission is accepted; 501 is rejected (boundary)', async () => {
  apiRouter.__resetRateLimit();
  const ev = await request(app).post('/api/events').send({ name: 'Dave', occasion: 'party' });
  const { submissionKey } = ev.body;
  const ok = await request(app).post(`/api/submit/${submissionKey}`)
    .send({ entries: [{ promptKey: 'story', text: 'a'.repeat(500) }] });
  assert.equal(ok.status, 200, '500 chars should pass');
  const bad = await request(app).post(`/api/submit/${submissionKey}`)
    .send({ entries: [{ promptKey: 'story', text: 'a'.repeat(501) }] });
  assert.equal(bad.status, 400, '501 chars should fail');
});

test('emoji / unicode guest name survives creation and prompt rendering', async () => {
  apiRouter.__resetRateLimit();
  const name = '🔥Dàvé 王小明 <O\'Neill>';
  const ev = await request(app).post('/api/events').send({ name, occasion: 'party' });
  assert.equal(ev.status, 200);
  const dash = await request(app).get(`/api/events/${ev.body.organiserKey}`);
  assert.equal(dash.body.name, name);
  const submit = await request(app).get(`/api/submit/${ev.body.submissionKey}`);
  assert.ok(submit.body.prompts.some((p) => p.label.includes(name)), 'name interpolated into label');
});

test('HTML / script-tag submissions survive into options as intact text (not stripped, not mangled)', () => {
  const subs = [
    { id: 1, promptKey: 'story', text: '<script>alert(1)</script> Dave climbed onto the pub roof to rescue a frisbee and got stuck up there for an hour' },
    { id: 2, promptKey: 'fact', text: '<img src=x onerror=alert(2)> secretly loves cheese strings' },
    { id: 3, promptKey: 'word', text: '<b>chaotic</b>' },
    { id: 4, promptKey: 'never', text: 'eat "olives" & chips <script>' },
    { id: 5, promptKey: 'sentence', text: 'to be fair' },
  ];
  const quiz = generateQuiz({ submissions: subs, tone: 'medium', guestName: 'Dave', rng: mul(1) });
  const reals = allQ(quiz).map((q) => q.options[q.correctIndex]);
  // the raw markup must be preserved verbatim somewhere (rendering escapes it, engine must not)
  assert.ok(reals.some((o) => o.includes('<script>alert(1)</script>')), 'script tag preserved in story option');
  assert.ok(reals.some((o) => o.includes('<img src=x onerror=alert(2)>')), 'img tag preserved in fact option');
  assert.ok(reals.some((o) => o.includes('<b>chaotic</b>')), 'markup preserved in word option');
  // and the & / quotes inside the never completion are intact
  assert.ok(reals.some((o) => o.includes('"olives" & chips <script>')), 'entities preserved in never option');
});

test('invalid tone falls back to medium in the engine; API rejects invalid tone', async () => {
  const q1 = generateQuiz({ submissions: [{ id: 1, promptKey: 'word', text: 'chaotic' }], tone: 'nonsense', guestName: 'Dave', rng: mul(2) });
  const q2 = generateQuiz({ submissions: [{ id: 1, promptKey: 'word', text: 'chaotic' }], tone: 'medium', guestName: 'Dave', rng: mul(2) });
  assert.deepEqual(q1, q2, 'unknown tone should behave as medium');
  apiRouter.__resetRateLimit();
  const bad = await request(app).post('/api/events').send({ name: 'Dave', occasion: 'party', tone: 'savage' });
  assert.equal(bad.status, 400);
});

test('all three valid tones produce distinct framing but identical fingerprints', () => {
  const subs = [
    { id: 1, promptKey: 'story', text: 'Dave got locked out in a dressing gown and borrowed a neighbours ladder to climb back in through a window.' },
    { id: 2, promptKey: 'fact', text: 'Dave has a spreadsheet ranking every service station in Britain.' },
    { id: 3, promptKey: 'never', text: 'turn down a carvery.' },
  ];
  const fps = {};
  for (const tone of ['gentle', 'medium', 'roast']) {
    const quiz = generateQuiz({ submissions: subs, tone, guestName: 'Dave', rng: mul(5) });
    fps[tone] = allQ(quiz).map((q) => q.fingerprint).sort();
  }
  assert.deepEqual(fps.gentle, fps.medium);
  assert.deepEqual(fps.medium, fps.roast);
});

test('rebuild preserves an organiser edit and re-approval by fingerprint (API)', async () => {
  apiRouter.__resetRateLimit();
  const ev = await request(app).post('/api/events').send({ name: 'Dave', occasion: 'party' });
  const { organiserKey, submissionKey } = ev.body;
  await request(app).post(`/api/submit/${submissionKey}`).send({
    entries: [
      { promptKey: 'story', text: 'Dave sang the wrong national anthem at a football match, loudly, for a full minute.' },
      { promptKey: 'fact', text: 'Dave once ate an entire wheel of brie on a dare and regretted nothing.' },
      { promptKey: 'word', text: 'Feral' },
      { promptKey: 'never', text: 'admit he is lost.' },
      { promptKey: 'sentence', text: 'To be fair though.' },
    ],
  });
  await request(app).post(`/api/events/${organiserKey}/build`).send({});
  const before = (await request(app).get(`/api/events/${organiserKey}/questions`)).body.questions;
  const target = before[0];
  const edited = { organiserKey, questionText: 'EDITED — spot the lie?', options: ['Uno', 'Dos', 'Tres', 'Quatro'], status: 'approved' };
  const patch = await request(app).patch(`/api/questions/${target.id}`).send(edited);
  assert.equal(patch.status, 200);
  await request(app).post(`/api/events/${organiserKey}/build`).send({});
  const after = (await request(app).get(`/api/events/${organiserKey}/questions`)).body.questions;
  const same = after.find((q) => q.id === target.id);
  assert.ok(same, 'edited question survives rebuild');
  assert.equal(same.questionText, 'EDITED — spot the lie?');
  assert.deepEqual(same.options, ['Uno', 'Dos', 'Tres', 'Quatro']);
  assert.equal(same.status, 'approved');
});

// ---------------------------------------------------------------------------
// LAYER 1 — game state machine edge cases
// ---------------------------------------------------------------------------

let keyCounter = 0;
function seedEvent(questions) {
  keyCounter += 1;
  const info = db.prepare(`INSERT INTO events (name, occasion, tone, plan, organiserKey, submissionKey, gameCode, status)
      VALUES ('Dave','stag do','medium','full',?,?,?, 'locked')`)
    .run(`qa-org-${keyCounter}`, `qa-sub-${keyCounter}`, `QGC${keyCounter}`);
  const eventId = info.lastInsertRowid;
  const ins = db.prepare(`INSERT INTO questions (eventId, roundKey, format, questionText, options, correctIndex, sourceText, fingerprint, status, sortOrder)
      VALUES (?,?,?,?,?,?,?,?, 'approved', ?)`);
  questions.forEach((q, i) => ins.run(eventId, q.roundKey, q.format, q.questionText, JSON.stringify(q.options), q.correctIndex, q.sourceText || '', `qfp-${eventId}-${i}`, i + 1));
  return eventId;
}
function twoRoundQuestions() {
  const o = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  return [
    { roundKey: 'warmup', format: 'howWell', questionText: 'W1?', options: o, correctIndex: 0 },
    { roundKey: 'warmup', format: 'howWell', questionText: 'W2?', options: o, correctIndex: 1 },
    { roundKey: 'stories', format: 'whoseStory', questionText: 'S1?', options: o, correctIndex: 2, sourceText: 'story' },
    { roundKey: 'stories', format: 'whoseStory', questionText: 'S2?', options: o, correctIndex: 3, sourceText: 'story2' },
  ];
}

test('timer boundary: answer exactly at timerEndsAt counts (min score 100); one ms later is rejected', () => {
  const game = new Game(seedEvent(twoRoundQuestions()));
  game.addPlayer('OnTime');
  game.addPlayer('TooLate');
  game.start();
  const ends = game.timerEndsAt;
  assert.equal(game.answer('OnTime', 0, ends), true, 'exactly at the buzzer should count');
  assert.throws(() => game.answer('TooLate', 0, ends + 1), /too slow/i);
  game.next(); // reveal
  assert.equal(game.players.get('OnTime').score, 100, 'buzzer-beater clamps to 100');
  assert.equal(game.players.get('TooLate').score, 0);
});

test('8-player game plays through to podium without error', () => {
  const game = new Game(seedEvent(twoRoundQuestions()));
  for (let i = 1; i <= 8; i++) game.addPlayer('Player' + i);
  assert.equal(game.connectedCount(), 8);
  game.start();
  let guard = 0;
  while (game.phase !== 'podium' && guard++ < 50) {
    if (game.phase === 'question') {
      // everyone answers, staggered times
      let idx = 0;
      for (const nick of game.players.keys()) {
        try { game.answer(nick, idx % 4, game.timerEndsAt - 1000 * (idx % 10)); } catch (e) { /* ignore */ }
        idx++;
      }
    }
    game.next();
  }
  assert.equal(game.phase, 'podium');
  const s = game.buildStatePayload(null);
  assert.ok(s.podium.top.length >= 1 && s.podium.top.length <= 3);
  assert.equal(s.players.length, 8);
  assert.ok(s.podium.superlatives.length >= 3);
});

test('checkpoint resume mid-round restores phase, index, scores and stats', () => {
  const eventId = seedEvent(twoRoundQuestions());
  const game = new Game(eventId);
  game.addPlayer('A');
  game.addPlayer('B');
  game.start();               // round0 q0
  game.answer('A', 0, game.timerEndsAt - 5000);
  game.next();                // reveal (scores A)
  game.next();                // round0 q1 — mid-round
  const scoreA = game.players.get('A').score;
  assert.ok(scoreA >= 100);
  const resumed = createOrResumeGame(eventId);
  assert.equal(resumed.phase, 'question');
  assert.equal(resumed.roundIdx, 0);
  assert.equal(resumed.questionIdx, 1);
  assert.equal(resumed.players.get('A').score, scoreA);
  assert.equal(resumed.players.get('A').stats.correct, 1);
  assert.equal(resumed.players.get('A').connected, false, 'resumed players start disconnected');
  assert.equal(resumed.addPlayer('A'), 'A');
  assert.equal(resumed.players.get('A').connected, true);
});

test('mid-question joiner is blocked from the current question but can answer the next', () => {
  const game = new Game(seedEvent(twoRoundQuestions()));
  game.addPlayer('A');
  game.addPlayer('B');
  game.start(); // q0
  const late = game.addPlayer('Late'); // joins during a live question
  assert.throws(() => game.answer(late, 0, game.timerEndsAt - 100), /mid-question/i);
  game.next(); // reveal
  game.next(); // q1
  assert.equal(game.answer(late, 0, game.timerEndsAt - 100), true, 'can answer from next question');
});

test('leaderboard ties share a rank (dense-ish rank per implementation)', () => {
  const game = new Game(seedEvent(twoRoundQuestions()));
  game.addPlayer('A');
  game.addPlayer('B');
  game.addPlayer('C');
  // give A and B equal scores, C zero
  game.players.get('A').score = 150;
  game.players.get('B').score = 150;
  const board = game.leaderboard();
  assert.equal(board[0].rank, 1);
  assert.equal(board[1].rank, 1, 'tied score shares rank 1');
  assert.equal(board[2].rank, 3, 'next rank skips to 3');
});

test.after(() => {
  try {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
  } catch { /* best effort */ }
});
