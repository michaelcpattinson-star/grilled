'use strict';
// v2 suite: accounts (magic links, sessions, claim), payments (flag off/on,
// checkout, webhook signatures, idempotency), free-plan game enforcement.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-v2-test-${process.pid}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const request = require('supertest');

const { app } = require('../server/index');
const { db } = require('../server/db');
const config = require('../server/config');
const mailer = require('../server/mail/mailer');
const stripe = require('../server/payments/stripe');
const { Game } = require('../server/game/gameManager');
const authRouter = require('../server/routes/auth').router;
const apiRouter = require('../server/routes/api');

test.beforeEach(() => {
  authRouter.__resetRateLimit();
  apiRouter.__resetRateLimit();
});

test.after(() => {
  try { fs.rmSync(process.env.DB_PATH, { force: true }); } catch {}
  try { fs.rmSync(process.env.DB_PATH + '-wal', { force: true }); } catch {}
  try { fs.rmSync(process.env.DB_PATH + '-shm', { force: true }); } catch {}
});

// ---- helpers ---------------------------------------------------------------

const sentMail = [];
mailer.setTransportForTests(async (msg) => sentMail.push(msg));

function lastMailLinkToken() {
  const mail = sentMail[sentMail.length - 1];
  const m = /\/auth\/verify\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  assert.ok(m, `magic link not found in mail: ${mail.text}`);
  return m[1];
}

function cookieFrom(res) {
  const raw = res.headers['set-cookie'];
  assert.ok(raw && raw.length, 'expected a Set-Cookie header');
  return raw[0].split(';')[0];
}

async function createEvent(name = 'Dave') {
  const res = await request(app)
    .post('/api/events')
    .send({ name, occasion: 'stag do', tone: 'medium' })
    .expect(200);
  return res.body; // {organiserKey, submissionKey}
}

function seedApprovedQuestions(organiserKey, n) {
  const event = db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(organiserKey);
  const ins = db.prepare(
    `INSERT INTO questions (eventId, roundKey, format, questionText, options, correctIndex, sourceText, fingerprint, status, sortOrder)
     VALUES (?, 'warmup', 'howWell', ?, ?, 0, '', ?, 'approved', ?)`
  );
  for (let i = 0; i < n; i++) {
    ins.run(event.id, `Q${i}?`, JSON.stringify(['A', 'B', 'C', 'D']), `v2fp-${event.id}-${i}`, i + 1);
  }
  db.prepare(`UPDATE events SET status = 'locked', gameCode = ? WHERE id = ?`)
    .run(`V${String(event.id).padStart(3, '0')}`.slice(0, 4), event.id);
  return event.id;
}

// ---- auth: magic links -----------------------------------------------------

test('request-link: invalid email is 400, valid always ok (no enumeration)', async () => {
  await request(app).post('/api/auth/request-link').send({ email: 'nope' }).expect(400);
  const res1 = await request(app)
    .post('/api/auth/request-link')
    .send({ email: 'brand-new@example.com' })
    .expect(200);
  assert.equal(res1.body.ok, true);
  const res2 = await request(app)
    .post('/api/auth/request-link')
    .send({ email: 'brand-new@example.com' })
    .expect(200);
  assert.deepEqual(res1.body, res2.body); // identical body either way
});

test('magic link signs in, is single-use, and /api/me works', async () => {
  await request(app).post('/api/auth/request-link').send({ email: 'Olivia@Example.COM ' }).expect(200);
  const token = lastMailLinkToken();

  const verify = await request(app).get(`/auth/verify?token=${token}`).expect(302);
  assert.equal(verify.headers.location, '/account');
  const cookie = cookieFrom(verify);
  assert.match(verify.headers['set-cookie'][0], /HttpOnly/);

  const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
  assert.equal(me.body.email, 'olivia@example.com'); // normalised
  assert.deepEqual(me.body.events, []);

  // second use of the same token → error redirect, no cookie
  const reuse = await request(app).get(`/auth/verify?token=${token}`).expect(302);
  assert.equal(reuse.headers.location, '/account?authError=1');

  // no cookie → 401
  await request(app).get('/api/me').expect(401);
});

test('expired magic token is rejected', async () => {
  await request(app).post('/api/auth/request-link').send({ email: 'late@example.com' }).expect(200);
  const token = lastMailLinkToken();
  db.prepare(`UPDATE magic_tokens SET expiresAt = datetime('now', '-1 minute') WHERE token = ?`).run(token);
  const res = await request(app).get(`/auth/verify?token=${token}`).expect(302);
  assert.equal(res.headers.location, '/account?authError=1');
});

test('logout kills the session', async () => {
  await request(app).post('/api/auth/request-link').send({ email: 'bye@example.com' }).expect(200);
  const verify = await request(app).get(`/auth/verify?token=${lastMailLinkToken()}`).expect(302);
  const cookie = cookieFrom(verify);
  await request(app).get('/api/me').set('Cookie', cookie).expect(200);
  await request(app).post('/api/auth/logout').set('Cookie', cookie).expect(200);
  await request(app).get('/api/me').set('Cookie', cookie).expect(401);
});

// ---- auth: claiming events -------------------------------------------------

test('claim flow: email link attaches event to account; /api/me lists it', async () => {
  const { organiserKey } = await createEvent('Claire');

  await request(app)
    .post(`/api/events/${organiserKey}/claim`)
    .send({ email: 'organiser@example.com' })
    .expect(200);
  const mail = sentMail[sentMail.length - 1];
  assert.match(mail.subject, /Claire/);

  const verify = await request(app).get(`/auth/verify?token=${lastMailLinkToken()}`).expect(302);
  assert.equal(verify.headers.location, `/o/${organiserKey}?claimed=1`);
  const cookie = cookieFrom(verify);

  const me = await request(app).get('/api/me').set('Cookie', cookie).expect(200);
  assert.equal(me.body.events.length, 1);
  assert.equal(me.body.events[0].name, 'Claire');
  assert.equal(me.body.events[0].organiserUrl, `/o/${organiserKey}`);

  // event payload reflects the claim for the owner…
  const ev = await request(app).get(`/api/events/${organiserKey}`).set('Cookie', cookie).expect(200);
  assert.equal(ev.body.claimed, true);
  assert.equal(ev.body.claimedByYou, true);
  // …and claimed-but-not-you for strangers
  const anon = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(anon.body.claimed, true);
  assert.equal(anon.body.claimedByYou, false);
});

test('claiming an event already claimed by a different email → 409', async () => {
  const { organiserKey } = await createEvent('Rob');
  await request(app).post(`/api/events/${organiserKey}/claim`).send({ email: 'first@example.com' }).expect(200);
  await request(app).get(`/auth/verify?token=${lastMailLinkToken()}`).expect(302);

  const res = await request(app)
    .post(`/api/events/${organiserKey}/claim`)
    .send({ email: 'second@example.com' })
    .expect(409);
  assert.match(res.body.error, /already claimed/i);

  // same email may re-claim (re-send) without error
  await request(app).post(`/api/events/${organiserKey}/claim`).send({ email: 'first@example.com' }).expect(200);
});

test('organiserKey never leaks into auth surfaces', async () => {
  const { organiserKey } = await createEvent('Secret');
  await request(app).post(`/api/events/${organiserKey}/claim`).send({ email: 'leak@example.com' }).expect(200);
  const mail = sentMail[sentMail.length - 1];
  assert.ok(!mail.text.includes(organiserKey), 'claim email must not contain the organiser key');
});

// ---- payments: flag off ----------------------------------------------------

test('payments off: checkout reports paymentsEnabled:false; dev-unlock upgrades; webhook 404s', async () => {
  assert.equal(config.PAYMENTS_ENABLED, false); // default in tests
  const { organiserKey } = await createEvent('Freya');

  const ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'free');
  assert.equal(ev.body.paymentsEnabled, false);
  assert.equal(ev.body.freeQuestionLimit, config.FREE_QUESTION_LIMIT);

  const checkout = await request(app).post(`/api/events/${organiserKey}/checkout`).expect(200);
  assert.equal(checkout.body.paymentsEnabled, false);

  await request(app).post('/api/stripe/webhook').send({}).expect(404);

  await request(app).post(`/api/events/${organiserKey}/dev-unlock`).expect(200);
  const after = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(after.body.plan, 'full');

  // already full → checkout 409
  await request(app).post(`/api/events/${organiserKey}/checkout`).expect(409);
});

// ---- payments: flag on (fake Stripe fetch) ---------------------------------

test('payments on: checkout creates a session, webhook upgrades, bad signatures rejected', async (t) => {
  config.PAYMENTS_ENABLED = true;
  config.STRIPE_SECRET_KEY = 'sk_test_fake';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
  t.after(() => {
    config.PAYMENTS_ENABLED = false;
    stripe.setFetchForTests(null);
  });

  const { organiserKey } = await createEvent('Paid Pete');

  const stripeCalls = [];
  stripe.setFetchForTests(async (url, init) => {
    stripeCalls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123' }),
    };
  });

  // dev-unlock must not exist with payments on
  await request(app).post(`/api/events/${organiserKey}/dev-unlock`).expect(404);

  const checkout = await request(app).post(`/api/events/${organiserKey}/checkout`).expect(200);
  assert.equal(checkout.body.url, 'https://checkout.stripe.com/pay/cs_test_123');
  assert.match(stripeCalls[0].url, /checkout\/sessions/);
  assert.match(stripeCalls[0].init.body, /unit_amount%5D=1900|unit_amount\]=1900/);
  assert.ok(stripeCalls[0].init.body.includes(encodeURIComponent(organiserKey)));

  // webhook: garbage signature → 400, no upgrade
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123', payment_status: 'paid', metadata: { organiserKey } } },
  });
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', 't=1,v1=deadbeef')
    .set('Content-Type', 'application/json')
    .send(payload)
    .expect(400);
  let ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'free');

  // stale timestamp → 400
  const staleSig = stripe.signPayloadForTests(payload, 'whsec_test_secret', Math.floor(Date.now() / 1000) - 3600);
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', staleSig)
    .set('Content-Type', 'application/json')
    .send(payload)
    .expect(400);

  // valid signature → upgrade
  const goodSig = stripe.signPayloadForTests(payload, 'whsec_test_secret');
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', goodSig)
    .set('Content-Type', 'application/json')
    .send(payload)
    .expect(200);
  ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'full');
  const paidAt = db.prepare(`SELECT paidAt FROM events WHERE organiserKey = ?`).get(organiserKey).paidAt;
  assert.ok(paidAt);

  // duplicate delivery → 200, idempotent (paidAt unchanged)
  await request(app)
    .post('/api/stripe/webhook')
    .set('Stripe-Signature', stripe.signPayloadForTests(payload, 'whsec_test_secret'))
    .set('Content-Type', 'application/json')
    .send(payload)
    .expect(200);
  const paidAt2 = db.prepare(`SELECT paidAt FROM events WHERE organiserKey = ?`).get(organiserKey).paidAt;
  assert.equal(paidAt2, paidAt);
});

test('payments on: confirm-payment fallback verifies with Stripe by session id', async (t) => {
  config.PAYMENTS_ENABLED = true;
  config.STRIPE_SECRET_KEY = 'sk_test_fake';
  t.after(() => {
    config.PAYMENTS_ENABLED = false;
    stripe.setFetchForTests(null);
  });

  const { organiserKey } = await createEvent('Slowhook Sue');
  stripe.setFetchForTests(async (url) => {
    if (url.includes('/v1/checkout/sessions/cs_live_9')) {
      return {
        ok: true,
        json: async () => ({
          id: 'cs_live_9',
          payment_status: 'paid',
          metadata: { organiserKey },
        }),
      };
    }
    return { ok: true, json: async () => ({ id: 'cs_live_9', url: 'https://checkout.stripe.com/x' }) };
  });

  db.prepare(`UPDATE events SET stripeSessionId = 'cs_live_9' WHERE organiserKey = ?`).run(organiserKey);

  // wrong/unknown session id → 400
  await request(app)
    .post(`/api/events/${organiserKey}/confirm-payment`)
    .send({ sessionId: 'cs_other' })
    .expect(400);

  const res = await request(app)
    .post(`/api/events/${organiserKey}/confirm-payment`)
    .send({ sessionId: 'cs_live_9' })
    .expect(200);
  assert.equal(res.body.plan, 'full');
});

// ---- free-plan game enforcement --------------------------------------------

test('free plan: game plays first 15 approved questions and no superlatives; full plays all', async () => {
  const { organiserKey } = await createEvent('Capped Carl');
  const eventId = seedApprovedQuestions(organiserKey, 20);

  const freeGame = new Game(eventId);
  const freeCount = freeGame.rounds.reduce((n, r) => n + r.questions.length, 0);
  assert.equal(freeCount, config.FREE_QUESTION_LIMIT);
  freeGame.addPlayer('Alice');
  freeGame.addPlayer('Bob');
  assert.deepEqual(freeGame.superlatives(), []);

  db.prepare(`UPDATE events SET plan = 'full' WHERE id = ?`).run(eventId);
  const fullGame = new Game(eventId);
  const fullCount = fullGame.rounds.reduce((n, r) => n + r.questions.length, 0);
  assert.equal(fullCount, 20);
  fullGame.addPlayer('Alice');
  fullGame.addPlayer('Bob');
  fullGame.start();
  // run to podium
  while (fullGame.phase !== 'podium') fullGame.next();
  assert.ok(fullGame.buildStatePayload(null).podium.superlatives.length >= 1);
});

test('demo events are created on the Roast & Toast plan with a pre-written speech', async () => {
  const res = await request(app).post('/api/demo').expect(200);
  const ev = await request(app).get(`/api/events/${res.body.organiserKey}`).expect(200);
  assert.equal(ev.body.plan, 'speech');
  const sp = await request(app).get(`/api/events/${res.body.organiserKey}/speech`).expect(200);
  assert.equal(sp.body.unlocked, true);
  assert.match(sp.body.speech, /best man/i);
  assert.match(sp.body.speech, /To Gary!/);
});
