'use strict';
// Roast & Toast (v3): speech engine + tier plumbing.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-speech-test-${process.pid}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const request = require('supertest');

const { app } = require('../server/index');
const { db } = require('../server/db');
const config = require('../server/config');
const stripe = require('../server/payments/stripe');
const { generateSpeech } = require('../server/engine/speech');
const apiRouter = require('../server/routes/api');
const authRouter = require('../server/routes/auth').router;

test.beforeEach(() => {
  apiRouter.__resetRateLimit();
  authRouter.__resetRateLimit();
});

test.after(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch {}
  }
});

function seededRng(seed = 42) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const SUBS = [
  { promptKey: 'story', text: 'Dave fell in the canal chasing a pigeon that had his sausage roll' },
  { promptKey: 'story', text: 'Dave rang in sick from the seat next to his boss on a train' },
  { promptKey: 'fact', text: 'He alphabetises his crisps' },
  { promptKey: 'word', text: 'Chaotic' },
  { promptKey: 'word', text: 'Beige' },
  { promptKey: 'never', text: 'Admit the sat nav was right' },
  { promptKey: 'sentence', text: "I'm not being funny, but" },
];

// ---- engine ----------------------------------------------------------------

test('speech engine: quotes stories verbatim, honours structure, is deterministic', () => {
  const args = { submissions: SUBS, tone: 'medium', guestName: 'Dave', occasion: 'stag do', rng: seededRng() };
  const a = generateSpeech(args);
  const b = generateSpeech({ ...args, rng: seededRng() });
  assert.equal(a.fullText, b.fullText); // same seed → same speech
  assert.ok(a.fullText.includes('canal'), 'story 1 quoted');
  assert.ok(a.fullText.includes('train'), 'story 2 quoted');
  assert.ok(a.fullText.includes('"Chaotic"'), 'word quoted');
  assert.ok(a.fullText.includes('Dave would never admit the sat nav was right'), 'never-sentence assembled');
  assert.ok(a.fullText.includes("I'm not being funny, but"), 'catchphrase quoted');
  assert.ok(/To Dave!$/.test(a.fullText.trim()), 'ends on the toast');
  assert.ok(a.wordCount > 150, `speech long enough (${a.wordCount} words)`);
});

test('speech engine: tones differ, invalid tone falls back to medium', () => {
  const mk = (tone) => generateSpeech({ submissions: SUBS, tone, guestName: 'Dave', occasion: 'stag do', rng: seededRng(7) });
  const gentle = mk('gentle');
  const roast = mk('roast');
  assert.notEqual(gentle.fullText, roast.fullText);
  assert.equal(mk('nonsense').fullText, mk('medium').fullText);
});

test('speech engine: graceful with zero submissions; game results woven in', () => {
  const bare = generateSpeech({ submissions: [], tone: 'medium', guestName: 'Dave', occasion: 'stag do', rng: seededRng() });
  assert.ok(bare.fullText.includes('sparse'), 'empty-material safety net used');
  assert.ok(/To Dave!$/.test(bare.fullText.trim()));

  const withGame = generateSpeech({
    submissions: SUBS, tone: 'medium', guestName: 'Dave', occasion: 'stag do', rng: seededRng(),
    gameResults: { winner: { nickname: 'Alice', score: 900 }, knowsBest: { nickname: 'Bob', correct: 9, answered: 10 } },
  });
  assert.ok(withGame.fullText.includes('Alice'), 'winner named');
  assert.ok(withGame.fullText.includes('Bob'), 'knows-best named');
  assert.ok(withGame.fullText.includes('9/10'), 'accuracy quoted');
});

test('speech engine: hostile text passes through as inert text', () => {
  const s = generateSpeech({
    submissions: [{ promptKey: 'story', text: 'Dave did <script>alert(1)</script> at the office party' }],
    tone: 'roast', guestName: 'Dave', occasion: 'do', rng: seededRng(),
  });
  assert.ok(s.fullText.includes('<script>alert(1)</script>'), 'engine neither strips nor mangles; rendering escapes');
});

// ---- API + tiers -----------------------------------------------------------

async function createEvent(name = 'Dave') {
  const res = await request(app)
    .post('/api/events')
    .send({ name, occasion: 'stag do', tone: 'medium' })
    .expect(200);
  return res.body;
}

test('speech endpoints are locked until plan=speech; dev-unlock tier works', async () => {
  const { organiserKey, submissionKey } = await createEvent('Gaz');
  await request(app)
    .post(`/api/submit/${submissionKey}`)
    .send({ entries: [{ promptKey: 'story', text: 'Gaz superglued his hand to a bowling ball' }] })
    .expect(200);

  // free → locked
  await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(403);
  let sp = await request(app).get(`/api/events/${organiserKey}/speech`).expect(200);
  assert.equal(sp.body.unlocked, false);

  // full is NOT enough
  await request(app).post(`/api/events/${organiserKey}/dev-unlock`).send({ tier: 'full' }).expect(200);
  await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(403);

  // speech tier unlocks; upgrade-only from full
  const up = await request(app).post(`/api/events/${organiserKey}/dev-unlock`).send({ tier: 'speech' }).expect(200);
  assert.equal(up.body.plan, 'speech');

  const built = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.ok(built.body.speech.includes('bowling ball'), 'speech built from submissions');
  assert.ok(built.body.speech.includes('Gaz'));

  // stored + editable
  sp = await request(app).get(`/api/events/${organiserKey}/speech`).expect(200);
  assert.equal(sp.body.speech, built.body.speech);
  await request(app).patch(`/api/events/${organiserKey}/speech`).send({ text: 'Short and sweet. To Gaz!' }).expect(200);
  sp = await request(app).get(`/api/events/${organiserKey}/speech`).expect(200);
  assert.equal(sp.body.speech, 'Short and sweet. To Gaz!');

  // caps and validation
  await request(app).patch(`/api/events/${organiserKey}/speech`).send({ text: '' }).expect(400);
  await request(app).patch(`/api/events/${organiserKey}/speech`).send({ text: 'x'.repeat(20001) }).expect(400);

  // event payload advertises the price; bad tier rejected
  const ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'speech');
  assert.equal(ev.body.speechPricePence, config.SPEECH_PRICE_PENCE);
  await request(app).post(`/api/events/${organiserKey}/dev-unlock`).send({ tier: 'gold' }).expect(400);
});

test('speech tier: checkout charges £50 with tier metadata; webhook upgrades full→speech; never downgrades', async (t) => {
  config.PAYMENTS_ENABLED = true;
  config.STRIPE_SECRET_KEY = 'sk_test_fake';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  t.after(() => {
    config.PAYMENTS_ENABLED = false;
    stripe.setFetchForTests(null);
  });

  const { organiserKey } = await createEvent('Paidey');
  db.prepare(`UPDATE events SET plan = 'full' WHERE organiserKey = ?`).run(organiserKey);

  const calls = [];
  stripe.setFetchForTests(async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ id: 'cs_speech_1', url: 'https://checkout.stripe.com/pay/cs_speech_1' }) };
  });

  // full→speech checkout allowed; full→full blocked
  await request(app).post(`/api/events/${organiserKey}/checkout`).send({ tier: 'full' }).expect(409);
  const checkout = await request(app).post(`/api/events/${organiserKey}/checkout`).send({ tier: 'speech' }).expect(200);
  assert.equal(checkout.body.url, 'https://checkout.stripe.com/pay/cs_speech_1');
  assert.ok(calls[0].init.body.includes('5000'), 'charged 5000 pence');
  assert.match(calls[0].init.body, /tier%5D=speech|tier\]=speech/);

  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_speech_1', payment_status: 'paid', metadata: { organiserKey, tier: 'speech' } } },
  });
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', stripe.signPayloadForTests(payload, 'whsec_test_secret'))
    .set('Content-Type', 'application/json')
    .send(payload)
    .expect(200);
  let ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'speech');

  // a stray/duplicate 'full' webhook must not downgrade
  const downgrade = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_late_full', payment_status: 'paid', metadata: { organiserKey, tier: 'full' } } },
  });
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', stripe.signPayloadForTests(downgrade, 'whsec_test_secret'))
    .set('Content-Type', 'application/json')
    .send(downgrade)
    .expect(200);
  ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'speech');
});
