'use strict';
// v4 suite: AI layer — adapter flag/budget, AI speech with template fallback,
// decoy punch-up validation, assistant tool loop. All offline via a fake client.
process.env.DB_PATH = require('path').join(
  require('os').tmpdir(),
  `grilled-ai-test-${process.pid}.db`
);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const request = require('supertest');

const { app } = require('../server/index');
const { db } = require('../server/db');
const config = require('../server/config');
const claude = require('../server/ai/claude');
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

// ---- helpers ---------------------------------------------------------------

function textResponse(text) {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

function fakeClient(handler) {
  return { messages: { create: async (params) => handler(params) } };
}

function withAI(t, handler) {
  config.AI_ENABLED = true;
  claude.setClientForTests(fakeClient(handler));
  t.after(() => {
    config.AI_ENABLED = false;
    claude.setClientForTests(null);
  });
}

async function createSpeechEvent(name = 'Dave') {
  const res = await request(app)
    .post('/api/events')
    .send({ name, occasion: 'stag do', tone: 'roast' })
    .expect(200);
  const { organiserKey, submissionKey } = res.body;
  await request(app)
    .post(`/api/submit/${submissionKey}`)
    .send({ entries: [{ promptKey: 'story', text: `${name} fell in the canal chasing a pigeon` }] })
    .expect(200);
  await request(app).post(`/api/events/${organiserKey}/dev-unlock`).send({ tier: 'speech' }).expect(200);
  return { organiserKey, submissionKey };
}

// ---- AI off (the default) --------------------------------------------------

test('AI off: speech uses the template engine, assistant is 503, event says aiEnabled:false', async () => {
  assert.equal(config.AI_ENABLED, false);
  const { organiserKey } = await createSpeechEvent('Tolly');

  const ev = await request(app).get(`/api/events/${organiserKey}`).expect(200);
  assert.equal(ev.body.aiEnabled, false);

  const built = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.equal(built.body.source, 'template');
  assert.ok(built.body.speech.includes('Tolly'));

  await request(app)
    .post(`/api/events/${organiserKey}/assistant`)
    .send({ message: 'approve everything' })
    .expect(503);
});

// ---- AI speech -------------------------------------------------------------

test('AI on: speech comes from the model, is stored, and includes the submissions in the brief', async (t) => {
  const prompts = [];
  withAI(t, (params) => {
    prompts.push(params);
    return textResponse('Ladies and gentlemen, an AI-crafted toast. To Dave!');
  });

  const { organiserKey } = await createSpeechEvent('Dave');
  const built = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.equal(built.body.source, 'ai');
  assert.equal(built.body.speech, 'Ladies and gentlemen, an AI-crafted toast. To Dave!');

  // stored for later GETs
  const sp = await request(app).get(`/api/events/${organiserKey}/speech`).expect(200);
  assert.equal(sp.body.speech, built.body.speech);

  // the brief carried the actual submission and the roast level
  const userMsg = prompts[0].messages[0].content;
  assert.ok(userMsg.includes('canal'), 'submission text in brief');
  assert.ok(userMsg.includes('FULL ROAST'), 'tone brief present');
  assert.equal(prompts[0].model, config.AI_MODEL);
});

test('AI failure or refusal: speech falls back to the template, still 200', async (t) => {
  let calls = 0;
  withAI(t, () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return { stop_reason: 'refusal', content: [] };
  });

  const { organiserKey } = await createSpeechEvent('Fallback Fred');
  const a = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.equal(a.body.source, 'template');
  const b = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.equal(b.body.source, 'template');
  assert.ok(b.body.speech.includes('Fallback Fred'));
});

test('AI budget cap: once spent, speech quietly falls back to template', async (t) => {
  withAI(t, () => textResponse('AI toast. To Cap!'));
  const { organiserKey } = await createSpeechEvent('Cap');
  db.prepare(`UPDATE events SET aiCalls = ? WHERE organiserKey = ?`).run(config.AI_CALL_CAP, organiserKey);

  const built = await request(app).post(`/api/events/${organiserKey}/speech/build`).expect(200);
  assert.equal(built.body.source, 'template');
});

// ---- decoy punch-up --------------------------------------------------------

function seedTwoTruths(organiserKey, n = 2) {
  const event = db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(organiserKey);
  const ins = db.prepare(
    `INSERT INTO questions (eventId, roundKey, format, questionText, options, correctIndex, sourceText, fingerprint, status, sortOrder, edited)
     VALUES (?, 'liedetector', 'twoTruths', 'Which of these is a real fact?', ?, 1, '', ?, 'pending', ?, 0)`
  );
  const ids = [];
  for (let i = 0; i < n; i++) {
    const info = ins.run(
      event.id,
      JSON.stringify([`generic lie A${i}`, `THE REAL FACT ${i}`, `generic lie B${i}`, `generic lie C${i}`]),
      `tt-fp-${event.id}-${i}`,
      i + 1
    );
    ids.push(Number(info.lastInsertRowid));
  }
  return { eventId: event.id, ids };
}

test('decoy punch-up: rewrites decoys, keeps the real fact in place, rejects bad payloads', async (t) => {
  const { organiserKey, submissionKey } = await createSpeechEvent('Decoy Dan');
  await request(app)
    .post(`/api/submit/${submissionKey}`)
    .send({ entries: [{ promptKey: 'fact', text: 'He alphabetises his crisps' }] })
    .expect(200);
  const { ids } = seedTwoTruths(organiserKey, 2);

  const briefs = [];
  withAI(t, (params) => {
    briefs.push(params);
    assert.ok(params.output_config, 'punch-up uses structured outputs');
    return textResponse(JSON.stringify({
      questions: [
        { id: ids[0], decoys: ['tailored lie one', 'tailored lie two', 'tailored lie three'] },
        { id: ids[1], decoys: ['only', 'two'] }, // invalid: not 3 → must be skipped
        { id: 999999, decoys: ['x', 'y', 'z'] }, // unknown id → must be skipped
      ],
    }));
  });

  // Call the punch-up directly (the build route would first regenerate the
  // question set from submissions, replacing our seeded rows).
  const { punchUpDecoys } = require('../server/ai/decoyWriter');
  const event = db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(organiserKey);
  const updated = await punchUpDecoys(event);
  assert.equal(updated, 1, 'exactly one valid punch-up applied');

  const q0 = db.prepare(`SELECT options, correctIndex FROM questions WHERE id = ?`).get(ids[0]);
  const opts = JSON.parse(q0.options);
  assert.deepEqual(opts, ['tailored lie one', 'THE REAL FACT 0', 'tailored lie two', 'tailored lie three']);
  assert.equal(q0.correctIndex, 1, 'real fact stays at its original index');

  // invalid payload left the second question untouched
  const q1 = db.prepare(`SELECT options FROM questions WHERE id = ?`).get(ids[1]);
  assert.ok(JSON.parse(q1.options).includes('generic lie A1'));

  // the brief quoted the true material for plausibility
  assert.ok(briefs[0].messages[0].content.includes('alphabetises his crisps'));
});

// ---- assistant -------------------------------------------------------------

test('assistant: gated to paid plans, executes tools scoped to the event, returns actions', async (t) => {
  const scripted = [];
  withAI(t, () => scripted.shift());

  // free event → 403 even with AI on
  const freeRes = await request(app)
    .post('/api/events')
    .send({ name: 'Freebie', occasion: 'do', tone: 'medium' })
    .expect(200);
  await request(app)
    .post(`/api/events/${freeRes.body.organiserKey}/assistant`)
    .send({ message: 'hi' })
    .expect(403);

  // paid event with a question to moderate
  const { organiserKey } = await createSpeechEvent('Tooly');
  const { ids } = seedTwoTruths(organiserKey, 1);

  scripted.push(
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Binning it now.' },
        { type: 'tool_use', id: 'tu_1', name: 'set_question_status', input: { id: ids[0], status: 'binned' } },
        { type: 'tool_use', id: 'tu_2', name: 'set_question_status', input: { id: 999999, status: 'binned' } },
      ],
    },
    textResponse('Done — binned the dodgy one. The other id did not exist in this quiz.')
  );

  const reply = await request(app)
    .post(`/api/events/${organiserKey}/assistant`)
    .send({ message: 'bin the lie detector question', history: [] })
    .expect(200);

  assert.match(reply.body.reply, /binned/i);
  assert.equal(reply.body.actionsTaken.length, 1); // the invalid id produced no action
  const q = db.prepare(`SELECT status FROM questions WHERE id = ?`).get(ids[0]);
  assert.equal(q.status, 'binned');

  // input validation
  await request(app).post(`/api/events/${organiserKey}/assistant`).send({ message: '' }).expect(400);
  await request(app)
    .post(`/api/events/${organiserKey}/assistant`)
    .send({ message: 'x'.repeat(1001) })
    .expect(400);
});

test('demo events never spend AI tokens, even with AI on', async (t) => {
  let aiCalls = 0;
  withAI(t, () => { aiCalls += 1; return textResponse('should never be used'); });

  const demo = await request(app).post('/api/demo').expect(200);
  const key = demo.body.organiserKey;

  const speech = await request(app).post(`/api/events/${key}/speech/build`).expect(200);
  assert.equal(speech.body.source, 'template');
  await request(app).post(`/api/events/${key}/build`).expect(200);
  await request(app).post(`/api/events/${key}/assistant`).send({ message: 'hi' }).expect(403);
  assert.equal(aiCalls, 0, 'no AI call may originate from a demo event');
});

test('assistant: budget cap ends the loop gracefully', async (t) => {
  withAI(t, () => textResponse('never reached'));
  const { organiserKey } = await createSpeechEvent('Skint');
  db.prepare(`UPDATE events SET aiCalls = ? WHERE organiserKey = ?`).run(config.AI_CALL_CAP, organiserKey);

  const reply = await request(app)
    .post(`/api/events/${organiserKey}/assistant`)
    .send({ message: 'approve everything' })
    .expect(200);
  assert.match(reply.body.reply, /budget/i);
  assert.deepEqual(reply.body.actionsTaken, []);
});
