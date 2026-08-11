'use strict';
// REST API tests (supertest against the express app). NOTE: these transitively
// require server/engine/{prompts,questions}.js — run at integration time once
// the engine module exists.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-api-test-${process.pid}-${Date.now()}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const request = require('supertest');

const { app } = require('../server/index');
const apiRouter = require('../server/routes/api');
const { db } = require('../server/db');

test.beforeEach(() => {
  apiRouter.__resetRateLimit(); // each test gets a fresh 30-POST budget
});

// Fills an event with enough submissions to build a meaty quiz.
const RICH_SUBMISSIONS = [
  { promptKey: 'story', text: 'Dave fell asleep at his own surprise party before anyone shouted surprise.' },
  { promptKey: 'story', text: 'Dave once drove forty minutes back to a pub because he thought he had underpaid by 20p.' },
  { promptKey: 'story', text: 'At the Christmas do, Dave introduced himself to the same colleague three times in one hour.' },
  { promptKey: 'fact', text: 'Dave has never seen Star Wars but pretends he has in every conversation.' },
  { promptKey: 'fact', text: 'Dave irons his socks. All of them. Including the sports ones.' },
  { promptKey: 'word', text: 'Meticulous' },
  { promptKey: 'word', text: 'Feral' },
  { promptKey: 'never', text: 'admit the sat nav was right all along.' },
  { promptKey: 'never', text: 'share his chips, even with his own mother.' },
  { promptKey: 'sentence', text: 'To be fair, though...' },
];

async function createEvent(overrides = {}) {
  const res = await request(app)
    .post('/api/events')
    .send({ name: 'Dave', occasion: 'stag do', tone: 'medium', ...overrides });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body; // {organiserKey, submissionKey}
}

async function seedAndBuild() {
  const keys = await createEvent();
  const sub = await request(app)
    .post(`/api/submit/${keys.submissionKey}`)
    .send({ entries: RICH_SUBMISSIONS });
  assert.equal(sub.status, 200);
  const built = await request(app).post(`/api/events/${keys.organiserKey}/build`).send({});
  assert.equal(built.status, 200);
  assert.equal(built.body.built, true);
  return keys;
}

async function approveAll(organiserKey) {
  const { body } = await request(app).get(`/api/events/${organiserKey}/questions`);
  for (const q of body.questions) {
    const res = await request(app)
      .patch(`/api/questions/${q.id}`)
      .send({ organiserKey, status: 'approved' });
    assert.equal(res.status, 200);
  }
  return body.questions;
}

// ---------- events ------------------------------------------------------------
test('POST /api/events creates an event and returns both keys', async () => {
  const body = await createEvent();
  assert.ok(body.organiserKey && typeof body.organiserKey === 'string');
  assert.ok(body.submissionKey && typeof body.submissionKey === 'string');
  assert.notEqual(body.organiserKey, body.submissionKey);
  assert.ok(body.organiserKey.length >= 16); // randomKey(12) → 16 chars base64url
  assert.ok(body.submissionKey.length >= 10);

  const res = await request(app).get(`/api/events/${body.organiserKey}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Dave');
  assert.equal(res.body.occasion, 'stag do');
  assert.equal(res.body.tone, 'medium');
  assert.equal(res.body.status, 'collecting');
  assert.equal(res.body.submissionCount, 0);
  assert.deepEqual(res.body.questionCounts, { pending: 0, approved: 0, binned: 0 });
  assert.equal(res.body.gameCode, null);
  assert.equal(res.body.submissionUrl, `/s/${body.submissionKey}`);
  assert.equal(res.body.hostUrl, `/host/${body.organiserKey}`);
});

test('POST /api/events validation: missing fields, long name, bad tone', async () => {
  for (const bad of [
    {},
    { name: 'Dave' },
    { occasion: 'party' },
    { name: '  ', occasion: 'party' },
    { name: 'x'.repeat(61), occasion: 'party' },
    { name: 'Dave', occasion: 'party', tone: 'savage' },
  ]) {
    const res = await request(app).post('/api/events').send(bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.ok(res.body.error, 'error message present');
  }
});

test('GET /api/events with unknown key → 404 {error}', async () => {
  const res = await request(app).get('/api/events/not-a-real-key');
  assert.equal(res.status, 404);
  assert.ok(res.body.error);
});

// ---------- submissions -------------------------------------------------------
test('submit flow: GET shows rendered prompts, POST stores entries', async () => {
  const keys = await createEvent();
  const info = await request(app).get(`/api/submit/${keys.submissionKey}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.guestName, 'Dave');
  assert.equal(info.body.occasion, 'stag do');
  assert.equal(info.body.open, true);
  assert.ok(Array.isArray(info.body.prompts) && info.body.prompts.length >= 4);
  for (const p of info.body.prompts) {
    assert.ok(p.key && typeof p.label === 'string' && typeof p.placeholder === 'string');
  }
  assert.ok(info.body.prompts.some((p) => p.label.includes('Dave')), 'labels pre-rendered with guest name');
  // never leak the organiser key to submitters
  assert.ok(!JSON.stringify(info.body).includes(keys.organiserKey));

  const post = await request(app)
    .post(`/api/submit/${keys.submissionKey}`)
    .send({ entries: [{ promptKey: 'word', text: '  Feral  ' }, { promptKey: 'story', text: '' }] });
  assert.equal(post.status, 200);
  assert.deepEqual(post.body, { ok: true });
  assert.ok(!JSON.stringify(post.body).includes(keys.organiserKey));

  const dash = await request(app).get(`/api/events/${keys.organiserKey}`);
  assert.equal(dash.body.submissionCount, 1); // empty entry filtered out, text trimmed
});

test('submit validation: no entries, all-empty entries, >500 chars, bad key', async () => {
  const keys = await createEvent();
  let res = await request(app).post(`/api/submit/${keys.submissionKey}`).send({});
  assert.equal(res.status, 400);
  res = await request(app)
    .post(`/api/submit/${keys.submissionKey}`)
    .send({ entries: [{ promptKey: 'word', text: '   ' }] });
  assert.equal(res.status, 400);
  res = await request(app)
    .post(`/api/submit/${keys.submissionKey}`)
    .send({ entries: [{ promptKey: 'story', text: 'x'.repeat(501) }] });
  assert.equal(res.status, 400);
  res = await request(app).post('/api/submit/no-such-key').send({ entries: [{ promptKey: 'word', text: 'hi' }] });
  assert.equal(res.status, 404);
});

// ---------- build + moderation ------------------------------------------------
test('build generates questions; edits and bins survive a rebuild', async () => {
  const keys = await seedAndBuild();

  const dash = await request(app).get(`/api/events/${keys.organiserKey}`);
  const total =
    dash.body.questionCounts.pending + dash.body.questionCounts.approved + dash.body.questionCounts.binned;
  assert.ok(total > 0, 'build produced questions');

  const { body } = await request(app).get(`/api/events/${keys.organiserKey}/questions`);
  assert.ok(body.questions.length > 0);
  for (const q of body.questions) {
    assert.ok(q.id && q.roundKey && q.format && q.questionText);
    assert.ok(Array.isArray(q.options) && q.options.length === 4);
    assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4);
    assert.equal(q.status, 'pending');
    assert.equal(typeof q.sourceText, 'string');
  }

  // edit one, bin another, approve a third
  const [q1, q2, q3] = body.questions;
  const newOptions = ['Opt one', 'Opt two', 'Opt three', 'Opt four'];
  let res = await request(app)
    .patch(`/api/questions/${q1.id}`)
    .send({ organiserKey: keys.organiserKey, questionText: 'My edited question?', options: newOptions, status: 'approved' });
  assert.equal(res.status, 200);
  res = await request(app).patch(`/api/questions/${q2.id}`).send({ organiserKey: keys.organiserKey, status: 'binned' });
  assert.equal(res.status, 200);
  res = await request(app).patch(`/api/questions/${q3.id}`).send({ organiserKey: keys.organiserKey, status: 'approved' });
  assert.equal(res.status, 200);

  // rebuild — same submissions → same fingerprints
  res = await request(app).post(`/api/events/${keys.organiserKey}/build`).send({});
  assert.equal(res.status, 200);

  const after = (await request(app).get(`/api/events/${keys.organiserKey}/questions`)).body.questions;
  const e1 = after.find((q) => q.id === q1.id);
  const e2 = after.find((q) => q.id === q2.id);
  const e3 = after.find((q) => q.id === q3.id);
  assert.ok(e1, 'edited question survives rebuild');
  assert.equal(e1.questionText, 'My edited question?');
  assert.deepEqual(e1.options, newOptions);
  assert.equal(e1.status, 'approved');
  assert.ok(e2, 'binned question still present');
  assert.equal(e2.status, 'binned', 'binned stays binned after rebuild');
  assert.equal(e3.status, 'approved', 'approval survives rebuild');
});

test('PATCH question validation and auth', async () => {
  const keys = await seedAndBuild();
  const other = await createEvent({ name: 'Mel' });
  const { body } = await request(app).get(`/api/events/${keys.organiserKey}/questions`);
  const q = body.questions[0];

  // wrong organiser key → 403
  let res = await request(app).patch(`/api/questions/${q.id}`).send({ organiserKey: other.organiserKey, status: 'approved' });
  assert.equal(res.status, 403);
  res = await request(app).patch(`/api/questions/${q.id}`).send({ status: 'approved' });
  assert.equal(res.status, 403);
  // bad status
  res = await request(app).patch(`/api/questions/${q.id}`).send({ organiserKey: keys.organiserKey, status: 'excellent' });
  assert.equal(res.status, 400);
  // bad options: wrong arity, wrong types, too long
  for (const options of [['a', 'b', 'c'], ['a', 'b', 'c', 4], ['a', 'b', 'c', 'x'.repeat(201)], 'nope']) {
    res = await request(app).patch(`/api/questions/${q.id}`).send({ organiserKey: keys.organiserKey, options });
    assert.equal(res.status, 400, JSON.stringify(options));
  }
  // unknown question
  res = await request(app).patch('/api/questions/999999').send({ organiserKey: keys.organiserKey, status: 'approved' });
  assert.equal(res.status, 404);
});

// ---------- ready gate + locked behaviours ------------------------------------
test('ready requires ≥10 approved; locking closes submissions and rebuilds', async () => {
  const keys = await seedAndBuild();

  // gate: nothing approved yet
  let res = await request(app).post(`/api/events/${keys.organiserKey}/ready`).send({});
  assert.equal(res.status, 400);
  assert.ok(res.body.error);

  const questions = await approveAll(keys.organiserKey);
  assert.ok(questions.length >= 10, `need ≥10 questions from rich submissions, got ${questions.length}`);

  apiRouter.__resetRateLimit();
  res = await request(app).post(`/api/events/${keys.organiserKey}/ready`).send({});
  assert.equal(res.status, 200);
  assert.match(res.body.gameCode, /^[A-Z]{4}$/);
  const gameCode = res.body.gameCode;

  // idempotent ready
  res = await request(app).post(`/api/events/${keys.organiserKey}/ready`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.gameCode, gameCode);

  // locked event: build → 409, submit → 403 {error:'closed'}, GET submit open:false
  res = await request(app).post(`/api/events/${keys.organiserKey}/build`).send({});
  assert.equal(res.status, 409);
  res = await request(app)
    .post(`/api/submit/${keys.submissionKey}`)
    .send({ entries: [{ promptKey: 'word', text: 'late' }] });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'closed');
  res = await request(app).get(`/api/submit/${keys.submissionKey}`);
  assert.equal(res.body.open, false);

  const dash = await request(app).get(`/api/events/${keys.organiserKey}`);
  assert.equal(dash.body.status, 'locked');
  assert.equal(dash.body.gameCode, gameCode);
});

// ---------- demo --------------------------------------------------------------
test('POST /api/demo creates a built, fully-approved, unlocked event', async () => {
  const res = await request(app).post('/api/demo').send({});
  assert.equal(res.status, 200);
  const { organiserKey } = res.body;
  assert.ok(organiserKey);

  const dash = await request(app).get(`/api/events/${organiserKey}`);
  assert.equal(dash.status, 200);
  assert.equal(dash.body.name, 'Gary');
  assert.equal(dash.body.occasion, 'wedding');
  assert.equal(dash.body.status, 'collecting', 'demo is NOT auto-locked');
  assert.ok(dash.body.submissionCount >= 8);
  assert.equal(dash.body.questionCounts.pending, 0);
  assert.equal(dash.body.questionCounts.binned, 0);
  assert.ok(dash.body.questionCounts.approved > 0, 'all demo questions pre-approved');

  const row = db.prepare(`SELECT isDemo FROM events WHERE organiserKey = ?`).get(organiserKey);
  assert.equal(row.isDemo, 1);

  // the demo should be ready to lock immediately if it produced ≥10 questions
  if (dash.body.questionCounts.approved >= 10) {
    const ready = await request(app).post(`/api/events/${organiserKey}/ready`).send({});
    assert.equal(ready.status, 200);
    assert.match(ready.body.gameCode, /^[A-Z]{4}$/);
  }
});

// ---------- rate limiting -----------------------------------------------------
test('61st POST within a minute from one IP → 429 (burst cap 60 for shared party wifi)', async () => {
  apiRouter.__resetRateLimit();
  for (let i = 0; i < 60; i++) {
    const res = await request(app).post('/api/events').send({ name: `G${i}`, occasion: 'party' });
    assert.equal(res.status, 200, `request ${i + 1} should pass`);
  }
  const res = await request(app).post('/api/events').send({ name: 'Over', occasion: 'party' });
  assert.equal(res.status, 429);
  assert.ok(res.body.error);
  // GETs are not rate limited
  const get = await request(app).get('/api/events/whatever-key');
  assert.notEqual(get.status, 429);
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
