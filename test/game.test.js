'use strict';
// Unit tests for the game state machine + a socket.io integration test.
// These do NOT need the question engine: questions are seeded straight into the db.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-game-test-${process.pid}-${Date.now()}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');

const { db, newGameCode } = require('../server/db');
const { Game, createOrResumeGame, TIMER_SECONDS } = require('../server/game/gameManager');
const { attachSockets } = require('../server/game/sockets');

// ---------- fixtures ----------------------------------------------------------
let keyCounter = 0;
function seedEvent({ gameCode = null, status = 'locked', questions = defaultQuestions() } = {}) {
  keyCounter += 1;
  const info = db
    .prepare(`INSERT INTO events (name, occasion, tone, plan, organiserKey, submissionKey, gameCode, status)
              VALUES ('Dave', 'stag do', 'medium', 'full', ?, ?, ?, ?)`)
    .run(`org-test-${keyCounter}`, `sub-test-${keyCounter}`, gameCode, status);
  const eventId = info.lastInsertRowid;
  const insert = db.prepare(`INSERT INTO questions
      (eventId, roundKey, format, questionText, options, correctIndex, sourceText, fingerprint, status, sortOrder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?)`);
  questions.forEach((q, i) => {
    insert.run(eventId, q.roundKey, q.format, q.questionText, JSON.stringify(q.options),
      q.correctIndex, q.sourceText || '', `fp-${eventId}-${i}`, i + 1);
  });
  return { eventId, organiserKey: `org-test-${keyCounter}` };
}

function defaultQuestions() {
  // two rounds of two → phases: lobby q r q r leaderboard q r q r podium
  const opts = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
  return [
    { roundKey: 'warmup', format: 'howWell', questionText: 'W1?', options: opts, correctIndex: 0, sourceText: '' },
    { roundKey: 'warmup', format: 'howWell', questionText: 'W2?', options: opts, correctIndex: 1, sourceText: '' },
    { roundKey: 'stories', format: 'whoseStory', questionText: 'S1?', options: opts, correctIndex: 2, sourceText: 'the story' },
    { roundKey: 'stories', format: 'whoseStory', questionText: 'S2?', options: opts, correctIndex: 3, sourceText: 'another story' },
  ];
}

// ---------- gameManager units -------------------------------------------------
test('duplicate nicknames get -2/-3 suffixes; rejoin restores the record', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  assert.equal(game.addPlayer('Sam'), 'Sam');
  assert.equal(game.addPlayer('Sam'), 'Sam-2');
  assert.equal(game.addPlayer('Sam'), 'Sam-3');
  // rejoin: disconnect then join with the same nickname → same record, score kept
  game.players.get('Sam-2').score = 250;
  game.markDisconnected('Sam-2');
  assert.equal(game.addPlayer('Sam-2'), 'Sam-2');
  assert.equal(game.players.get('Sam-2').score, 250);
  assert.equal(game.players.get('Sam-2').connected, true);
  // 20-char cap incl. suffix
  const long = 'x'.repeat(25);
  assert.equal(game.addPlayer(long), 'x'.repeat(20));
  assert.equal(game.addPlayer(long), 'x'.repeat(18) + '-2');
});

test('start requires at least 2 connected players', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  assert.throws(() => game.start(), /at least 2/i);
  game.addPlayer('A');
  assert.throws(() => game.start(), /at least 2/i);
  game.addPlayer('B');
  game.start();
  assert.equal(game.phase, 'question');
});

test('phase sequence inserts leaderboard between rounds and ends at podium', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  game.addPlayer('A');
  game.addPlayer('B');
  game.start();
  const seen = [game.phase];
  for (let i = 0; i < 12 && game.phase !== 'podium'; i++) {
    game.next();
    seen.push(game.phase);
  }
  assert.deepEqual(seen, [
    'question', 'reveal', 'question', 'reveal',
    'leaderboard',
    'question', 'reveal', 'question', 'reveal',
    'podium',
  ]);
  // next() on podium is a no-op
  game.next();
  assert.equal(game.phase, 'podium');
});

test('scoring: 100 + round(50 × timeLeft/20s), clamped at ≥100 when correct', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  game.addPlayer('Fast');
  game.addPlayer('Slow');
  game.addPlayer('Wrong');
  game.start(); // W1, correct = 0

  const endsAt = game.timerEndsAt;
  assert.equal(game.answer('Fast', 0, endsAt - TIMER_SECONDS * 1000), true); // instant → full bonus
  assert.equal(game.answer('Slow', 0, endsAt), true); // at the buzzer → clamp to 100
  assert.equal(game.answer('Wrong', 3, endsAt - 10000), true);
  // after the timer → rejected
  game.addPlayer('Late'); // joined mid-question — also blocked
  assert.throws(() => game.answer('Late', 0, endsAt - 5000), /mid-question/i);
  assert.equal(game.answer('Fast', 0, endsAt + 1), false); // already answered → silent no-op
  assert.equal(game.answer('Slow', 1, endsAt - 5000), false); // first answer counts, second ignored

  game.next(); // reveal → scores applied
  assert.equal(game.players.get('Fast').score, 150);
  assert.equal(game.players.get('Slow').score, 100);
  assert.equal(game.players.get('Wrong').score, 0);
  const reveal = game.lastReveal;
  const per = Object.fromEntries(reveal.perPlayer.map((p) => [p.nickname, p]));
  assert.equal(per.Fast.correct, true);
  assert.equal(per.Fast.gained, 150);
  assert.equal(per.Wrong.correct, false);
  assert.equal(per.Wrong.gained, 0);
  assert.equal(reveal.correctIndex, 0);
});

test('answers after timerEndsAt are rejected', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  game.addPlayer('A');
  game.addPlayer('B');
  game.start();
  assert.throws(() => game.answer('A', 0, game.timerEndsAt + 1), /too slow/i);
  const p = game.players.get('A');
  assert.equal(p.currentAnswer, null);
});

test('state payload matches the contract shape in each phase', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  game.addPlayer('A');
  game.addPlayer('B');

  let s = game.buildStatePayload(null);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.guestName, 'Dave');
  assert.deepEqual(Object.keys(s).sort(), ['code', 'guestName', 'leaderboard', 'phase', 'players', 'podium', 'question', 'reveal', 'round', 'you'].sort());
  assert.equal(s.round, null);
  assert.equal(s.question, null);
  assert.equal(s.you, null);

  game.start();
  game.answer('A', 0, game.timerEndsAt - 1000);
  s = game.buildStatePayload('A');
  assert.equal(s.phase, 'question');
  assert.equal(s.question.number, 1);
  assert.equal(s.question.totalInRound, 2);
  assert.equal(s.question.options.length, 4); // options ALWAYS present in question phase
  assert.ok(s.question.timerEndsAt > Date.now());
  assert.deepEqual(s.round, { roundKey: 'warmup', title: 'Warm-Up: How Well Do You Know Them?', number: 1, total: 2 });
  assert.deepEqual(s.you, { nickname: 'A', score: 0, lockedAnswer: 0 });
  const a = s.players.find((p) => p.nickname === 'A');
  const b = s.players.find((p) => p.nickname === 'B');
  assert.equal(a.answeredThisQuestion, true);
  assert.equal(b.answeredThisQuestion, false);

  game.next(); // reveal
  s = game.buildStatePayload('A');
  assert.equal(s.reveal.correctIndex, 0);
  assert.equal(s.reveal.perPlayer.length, 2);
  assert.equal(s.you.score, game.players.get('A').score); // score applied at reveal

  game.next(); // q2
  game.next(); // reveal
  game.next(); // leaderboard between rounds
  s = game.buildStatePayload(null);
  assert.equal(s.phase, 'leaderboard');
  assert.ok(Array.isArray(s.leaderboard));
  assert.equal(s.leaderboard[0].rank, 1);

  game.next(); // round 2 q1
  game.next(); // reveal
  game.next(); // q2
  game.next(); // reveal
  game.next(); // podium
  s = game.buildStatePayload(null);
  assert.equal(s.phase, 'podium');
  assert.ok(s.podium.top.length >= 1 && s.podium.top.length <= 3);
  assert.ok(s.podium.superlatives.length >= 3, `expected ≥3 superlatives, got ${JSON.stringify(s.podium.superlatives)}`);
  for (const sup of s.podium.superlatives) {
    assert.ok(sup.title && sup.nickname && typeof sup.detail === 'string');
  }
});

test('checkpoint/resume round-trips mid-game state', () => {
  const { eventId } = seedEvent();
  const game = new Game(eventId);
  game.addPlayer('A');
  game.addPlayer('B');
  game.start();
  game.answer('A', 0, game.timerEndsAt - 10000);
  game.next(); // reveal (checkpoints)
  game.next(); // q2 (checkpoints)

  const resumed = createOrResumeGame(eventId);
  assert.notEqual(resumed, game);
  assert.equal(resumed.phase, 'question');
  assert.equal(resumed.questionIdx, 1);
  assert.equal(resumed.players.get('A').score, game.players.get('A').score);
  assert.ok(resumed.players.get('A').score >= 100);
  assert.equal(resumed.players.get('B').score, 0);
  // players come back disconnected until they rejoin
  assert.equal(resumed.players.get('A').connected, false);
  assert.equal(resumed.addPlayer('A'), 'A'); // rejoin restores
  assert.equal(resumed.players.get('A').connected, true);
  // stats survive for superlatives
  assert.equal(resumed.players.get('A').stats.correct, 1);
});

test('createOrResumeGame with no checkpoint starts a fresh lobby', () => {
  const { eventId } = seedEvent();
  const game = createOrResumeGame(eventId);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.players.size, 0);
});

// ---------- socket.io integration --------------------------------------------
const ioClient = require('socket.io-client');

function connect(port) {
  const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  socket.on('state', (s) => {
    socket.__lastState = s; // remember the latest state so waits can't miss a broadcast
  });
  return socket;
}

function waitForState(socket, pred, label) {
  if (socket.__lastState && pred(socket.__lastState)) return Promise.resolve(socket.__lastState);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('state', onState);
      reject(new Error(`timed out waiting for state: ${label}`));
    }, 5000);
    const onState = (s) => {
      if (pred(s)) {
        clearTimeout(timer);
        socket.off('state', onState);
        resolve(s);
      }
    };
    socket.on('state', onState);
  });
}

function waitForError(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for errorMsg')), 5000);
    socket.once('errorMsg', (e) => {
      clearTimeout(timer);
      resolve(e);
    });
  });
}

test('socket integration: 3-player game with disconnect and rejoin', async () => {
  const { Server } = require('socket.io');
  const gameCode = newGameCode();
  const { organiserKey } = seedEvent({ gameCode, status: 'locked' });

  const httpServer = http.createServer();
  const io = new Server(httpServer);
  attachSockets(io);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const clients = [];
  try {
    const host = connect(port);
    clients.push(host);
    host.emit('host:join', { organiserKey });
    let s = await waitForState(host, (x) => x.phase === 'lobby', 'host lobby');
    assert.equal(s.code, gameCode);
    assert.equal(s.you, null); // host gets no 'you'

    // starting with <2 players is rejected
    host.emit('host:start');
    const err = await waitForError(host);
    assert.match(err.message, /at least 2/i);

    const [p1, p2, p3] = [connect(port), connect(port), connect(port)];
    clients.push(p1, p2, p3);
    p1.emit('player:join', { code: gameCode, nickname: 'Ana' });
    await waitForState(p1, (x) => x.you && x.you.nickname === 'Ana', 'p1 joined');
    p2.emit('player:join', { code: gameCode.toLowerCase(), nickname: 'Ben' }); // code case-insensitive
    await waitForState(p2, (x) => x.you && x.you.nickname === 'Ben', 'p2 joined');
    p3.emit('player:join', { code: gameCode, nickname: 'Ana' }); // duplicate → Ana-2
    await waitForState(p3, (x) => x.you && x.you.nickname === 'Ana-2', 'p3 suffixed');
    s = await waitForState(host, (x) => x.players.length === 3, 'lobby full');

    // only the host may start
    p1.emit('host:start');
    assert.match((await waitForError(p1)).message, /only the host/i);

    host.emit('host:start');
    s = await waitForState(host, (x) => x.phase === 'question', 'question 1');
    assert.equal(s.question.options.length, 4);
    const correct = 0; // W1 correctIndex per fixture

    p1.emit('player:answer', { index: correct });
    await waitForState(host, (x) => x.players.find((p) => p.nickname === 'Ana').answeredThisQuestion, 'Ana locked in');
    p3.emit('player:answer', { index: 3 }); // wrong
    await waitForState(host, (x) => x.players.filter((p) => p.answeredThisQuestion).length === 2, 'two answers in');

    host.emit('host:next');
    s = await waitForState(host, (x) => x.phase === 'reveal', 'reveal 1');
    const per = Object.fromEntries(s.reveal.perPlayer.map((p) => [p.nickname, p]));
    assert.equal(per['Ana'].correct, true);
    assert.ok(per['Ana'].gained >= 100);
    assert.equal(per['Ana-2'].correct, false);
    assert.equal(per['Ben'].gained, 0);
    const anaScore = s.players.find((p) => p.nickname === 'Ana').score;
    assert.ok(anaScore >= 100);

    // Ana disconnects — she stays on the scoreboard
    p1.disconnect();
    s = await waitForState(host, (x) => x.players.length === 3, 'still 3 on board after disconnect');

    // …and rejoins with the same nickname, score restored
    const p1b = connect(port);
    clients.push(p1b);
    p1b.emit('player:join', { code: gameCode, nickname: 'Ana' });
    s = await waitForState(p1b, (x) => x.you && x.you.nickname === 'Ana', 'Ana rejoined');
    assert.equal(s.you.score, anaScore);

    // play out to the podium: q2 reveal, leaderboard, round 2 ×2, podium
    const advance = async (pred, label) => {
      host.emit('host:next');
      return waitForState(host, pred, label);
    };
    await advance((x) => x.phase === 'question' && x.question.number === 2, 'question 2');
    await advance((x) => x.phase === 'reveal', 'reveal 2');
    s = await advance((x) => x.phase === 'leaderboard', 'leaderboard');
    assert.equal(s.leaderboard.length, 3);
    assert.equal(s.leaderboard[0].nickname, 'Ana');
    s = await advance((x) => x.phase === 'question', 'round 2 q1');
    assert.equal(s.round.roundKey, 'stories');
    assert.equal(s.round.number, 2);
    await advance((x) => x.phase === 'reveal', 'round 2 reveal 1');
    await advance((x) => x.phase === 'question', 'round 2 q2');
    await advance((x) => x.phase === 'reveal', 'round 2 reveal 2');
    s = await advance((x) => x.phase === 'podium', 'podium');
    assert.ok(s.podium.top.length >= 1);
    assert.ok(s.podium.superlatives.length >= 3);
    assert.equal(s.podium.top[0].nickname, 'Ana');
  } finally {
    for (const c of clients) c.close();
    io.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }
});

test.after(() => {
  try {
    db.close();
    fs.rmSync(process.env.DB_PATH, { force: true });
    fs.rmSync(process.env.DB_PATH + '-wal', { force: true });
    fs.rmSync(process.env.DB_PATH + '-shm', { force: true });
  } catch {
    /* best effort */
  }
});
