'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROMPTS } = require('../server/engine/prompts');
const { DECOYS } = require('../server/engine/decoys');
const { generateQuiz } = require('../server/engine/questions');

// --- helpers -----------------------------------------------------------------

// Deterministic seeded rng (mulberry32) so runs are reproducible in tests.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// True when every token of `part` appears in `whole` (how we recognise a cleaned/
// trimmed submission inside an option without re-implementing the cleaner).
function tokensSubset(part, whole) {
  const w = new Set(normTokens(whole));
  const p = normTokens(part);
  return p.length > 0 && p.every(t => w.has(t));
}

function allQuestions(quiz) {
  return quiz.rounds.flatMap(r => r.questions);
}

const GUEST = 'Dave';

const FIXTURE = [
  { id: 's1', promptKey: 'story',    text: "At Leo's wedding Dave tried a backflip on the dance floor, split his trousers in front of the bride's nan, and spent the rest of the night in the DJ's spare joggers." },
  { id: 'f1', promptKey: 'fact',     text: 'He once got his head stuck in a stair banister and the fire brigade had to come out.' },
  { id: 'f2', promptKey: 'fact',     text: 'Dave keeps every birthday card he has ever received in a shoebox under the bed.' },
  { id: 'f3', promptKey: 'fact',     text: 'He supported two different football teams for three years so he always won.' },
  { id: 'n1', promptKey: 'never',    text: '…turn down a free sample at the supermarket' },
  { id: 'w1', promptKey: 'word',     text: 'spreadsheety.' },
  { id: 'c1', promptKey: 'sentence', text: '"I\'ll sort it Monday."' },
];

function build(opts = {}) {
  return generateQuiz({
    submissions: FIXTURE,
    tone: 'medium',
    guestName: GUEST,
    rng: mulberry32(42),
    ...opts,
  });
}

// --- prompts contract --------------------------------------------------------

test('PROMPTS matches the pinned contract shape', () => {
  assert.equal(PROMPTS.length, 5);
  const kinds = ['story', 'fact', 'word', 'never', 'sentence'];
  for (const p of PROMPTS) {
    assert.ok(kinds.includes(p.kind), `unknown kind ${p.kind}`);
    assert.equal(typeof p.key, 'string');
    assert.equal(typeof p.placeholder, 'string');
    assert.equal(typeof p.label, 'function');
    assert.ok(p.label('Dave').includes('Dave'), 'label must interpolate the guest name');
  }
  assert.deepEqual(PROMPTS.map(p => p.key), ['story', 'fact', 'word', 'never', 'sentence']);
});

test('decoy banks are broad enough (25+ per bank)', () => {
  for (const [kind, bank] of Object.entries(DECOYS)) {
    assert.ok(bank.length >= 25, `${kind} bank has only ${bank.length} entries`);
  }
});

// --- structural contract -----------------------------------------------------

test('every question has exactly 4 unique string options at every tone', () => {
  for (const tone of ['gentle', 'medium', 'roast']) {
    const quiz = build({ tone, rng: mulberry32(7) });
    const questions = allQuestions(quiz);
    assert.ok(questions.length > 0);
    for (const q of questions) {
      assert.equal(q.options.length, 4, `${q.format} must have 4 options`);
      for (const o of q.options) {
        assert.equal(typeof o, 'string');
        assert.ok(o.trim().length > 0, 'no empty options');
      }
      assert.equal(new Set(q.options).size, 4, `duplicate options in ${q.format}: ${q.options.join(' | ')}`);
    }
  }
});

test('correctIndex is valid post-shuffle and questions carry contract fields', () => {
  const quiz = build();
  for (const round of quiz.rounds) {
    assert.ok(['warmup', 'stories', 'liedetector'].includes(round.roundKey));
    assert.equal(typeof round.title, 'string');
    for (const q of round.questions) {
      assert.ok(['whoseStory', 'twoTruths', 'finishSentence', 'howWell'].includes(q.format));
      assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex <= 3,
        `bad correctIndex ${q.correctIndex}`);
      assert.equal(typeof q.questionText, 'string');
      assert.ok(q.questionText.length > 0);
      assert.equal(typeof q.sourceText, 'string');
      assert.equal(typeof q.fingerprint, 'string');
      assert.ok(q.fingerprint.length > 0);
    }
  }
});

test('rounds land the right formats and empty rounds are omitted', () => {
  const quiz = build();
  const byKey = Object.fromEntries(quiz.rounds.map(r => [r.roundKey, r]));
  for (const q of byKey.warmup.questions) assert.ok(['howWell', 'finishSentence'].includes(q.format));
  for (const q of byKey.stories.questions) assert.equal(q.format, 'whoseStory');
  for (const q of byKey.liedetector.questions) assert.equal(q.format, 'twoTruths');
  for (const r of quiz.rounds) assert.ok(r.questions.length > 0, 'no empty rounds');

  // With <3 facts there is no liedetector round at all (see twoTruths design note).
  const twoFacts = generateQuiz({
    submissions: FIXTURE.filter(s => s.id !== 'f3'),
    tone: 'medium', guestName: GUEST, rng: mulberry32(1),
  });
  assert.ok(!twoFacts.rounds.some(r => r.roundKey === 'liedetector'));
  // …but the facts still show up as howWell questions.
  assert.ok(allQuestions(twoFacts).some(q => q.format === 'howWell'));
});

// --- the real answer really is at correctIndex -------------------------------

test('the real submission text sits at correctIndex, never mangled into another question', () => {
  const subById = new Map(FIXTURE.map(s => [s.id, s]));
  const quiz = build();
  for (const q of allQuestions(quiz)) {
    assert.ok(Array.isArray(q.sourceSubmissionIds) && q.sourceSubmissionIds.length > 0);
    if (q.format === 'twoTruths') {
      const factTexts = q.sourceSubmissionIds.map(id => subById.get(id).text);
      // The three truths are the (cleaned) real facts…
      const truths = q.options.filter((_, i) => i !== q.correctIndex);
      for (const t of truths) {
        assert.ok(factTexts.some(ft => tokensSubset(t, ft)),
          `truth option not traceable to a real fact: "${t}"`);
      }
      // …and the "correct" pick (the lie) is NOT any real submission.
      const lie = q.options[q.correctIndex];
      assert.ok(!FIXTURE.some(s => tokensSubset(lie, s.text)),
        `lie option is actually a real submission: "${lie}"`);
    } else {
      const source = subById.get(q.sourceSubmissionIds[0]);
      const real = q.options[q.correctIndex];
      assert.ok(tokensSubset(real, source.text),
        `correct option "${real}" not derived from source "${source.text}"`);
      // No other option should be that same submission.
      q.options.forEach((o, i) => {
        if (i === q.correctIndex) return;
        assert.ok(!tokensSubset(o, source.text) || normTokens(o).length < 2,
          `decoy duplicates the real answer: "${o}"`);
      });
    }
  }
});

test('options are cleaned: no wrapping quotes, no trailing full stops, capitalised', () => {
  const quiz = build();
  for (const q of allQuestions(quiz)) {
    const real = q.options[q.correctIndex];
    assert.ok(!/^["'“”‘’]/.test(real), `leading quote survived: "${real}"`);
    // A truncated whoseStory summary may legitimately end with a truncation "…";
    // everything else must lose its trailing punctuation.
    const trailing = q.format === 'whoseStory' ? /[.\s]$/ : /[.…\s]$/;
    assert.ok(!trailing.test(real), `trailing punctuation survived: "${real}"`);
    assert.notEqual(real[0], real[0].toLowerCase() === real[0].toUpperCase() ? null : real[0].toLowerCase(),
      `not capitalised: "${real}"`);
  }
  // The 'never' completion loses its "…"/"would never" lead-in.
  const never = allQuestions(quiz).find(q => q.sourceSubmissionIds[0] === 'n1' && q.format === 'finishSentence');
  assert.equal(never.options[never.correctIndex], 'Turn down a free sample at the supermarket');
});

// --- tone dial ---------------------------------------------------------------

test('tone changes framing text (stems and round titles), not the material', () => {
  const gentle = build({ tone: 'gentle', rng: mulberry32(9) });
  const roast = build({ tone: 'roast', rng: mulberry32(9) });

  const gTitles = gentle.rounds.map(r => r.title);
  const rTitles = roast.rounds.map(r => r.title);
  assert.notDeepEqual(gTitles, rTitles, 'round titles should differ by tone');

  const gStems = allQuestions(gentle).map(q => q.questionText).sort();
  const rStems = allQuestions(roast).map(q => q.questionText).sort();
  assert.notDeepEqual(gStems, rStems, 'question stems should differ by tone');

  // Same material either way: identical fingerprints and question counts.
  const gFp = allQuestions(gentle).map(q => q.fingerprint).sort();
  const rFp = allQuestions(roast).map(q => q.fingerprint).sort();
  assert.deepEqual(gFp, rFp);
});

// --- degradation -------------------------------------------------------------

test('0 submissions → empty rounds, no crash', () => {
  const quiz = generateQuiz({ submissions: [], tone: 'medium', guestName: GUEST, rng: mulberry32(3) });
  assert.deepEqual(quiz, { rounds: [] });
  // Also survives being called with no args at all.
  assert.deepEqual(generateQuiz(), { rounds: [] });
});

test('1 submission → still at least one valid question, for every kind', () => {
  for (const sub of FIXTURE) {
    const quiz = generateQuiz({ submissions: [sub], tone: 'medium', guestName: GUEST, rng: mulberry32(5) });
    const questions = allQuestions(quiz);
    assert.ok(questions.length >= 1, `no questions from a single ${sub.promptKey} submission`);
    for (const q of questions) {
      assert.equal(q.options.length, 4);
      assert.ok(q.correctIndex >= 0 && q.correctIndex <= 3);
    }
  }
});

test('a healthy varied pile of submissions yields a solid quiz (10+ questions)', () => {
  const many = [
    ...FIXTURE,
    { id: 's2', promptKey: 'story', text: 'He once drove forty minutes to a McDonald\'s that was closed, then queued at the drive-thru anyway out of pure denial.' },
    { id: 'f4', promptKey: 'fact', text: 'Dave has a certificate for winning a regional air guitar contest in 2011.' },
    { id: 'f5', promptKey: 'fact', text: 'He is afraid of swans but insists it is "mutual respect".' },
    { id: 'f6', promptKey: 'fact', text: 'Dave learned to swim at 27 because of a stag do.' },
    { id: 'n2', promptKey: 'never', text: 'admit he has lost his glasses while wearing them' },
    { id: 'w2', promptKey: 'word', text: 'unsinkable' },
    { id: 'c2', promptKey: 'sentence', text: 'It\'s cheaper to buy two' },
  ];
  const quiz = generateQuiz({ submissions: many, tone: 'medium', guestName: GUEST, rng: mulberry32(11) });
  assert.ok(allQuestions(quiz).length >= 10, `only ${allQuestions(quiz).length} questions`);
});

// --- dedupe & caps -----------------------------------------------------------

test('near-identical submissions are deduped (normalised similarity)', () => {
  const subs = [
    { id: 'a', promptKey: 'fact', text: 'He once ate twelve doughnuts in one sitting.' },
    { id: 'b', promptKey: 'fact', text: 'he once ate twelve doughnuts in one sitting!!' },
    { id: 'c', promptKey: 'fact', text: 'He once ate 12 doughnuts in one sitting' },
  ];
  const quiz = generateQuiz({ submissions: subs, tone: 'medium', guestName: GUEST, rng: mulberry32(13) });
  const howWell = allQuestions(quiz).filter(q => q.format === 'howWell');
  assert.equal(howWell.length, 1, 'duplicates should collapse to one question');
  assert.deepEqual(howWell[0].sourceSubmissionIds, ['a'], 'first submission wins');
});

test('per-source cap: a submission appears at most once per format', () => {
  const quiz = build();
  const seen = new Map(); // `${format}:${id}` → count
  for (const q of allQuestions(quiz)) {
    for (const id of q.sourceSubmissionIds) {
      const key = `${q.format}:${id}`;
      seen.set(key, (seen.get(key) || 0) + 1);
      assert.ok(seen.get(key) <= 1, `submission ${id} used twice in ${q.format}`);
    }
  }
});

test('one prolific prompt cannot dominate the quiz (>50%) when other voices exist', () => {
  const subs = [
    { id: 'f1', promptKey: 'fact', text: 'He collects novelty bottle openers from every airport he has been through.' },
    { id: 'f2', promptKey: 'fact', text: 'Dave got a hole in one at pitch and putt and talks about it every summer.' },
    { id: 'f3', promptKey: 'fact', text: 'He alphabetised the spice rack at a house party, uninvited.' },
    { id: 'f4', promptKey: 'fact', text: 'Dave was an extra in a crowd scene once and bought the DVD.' },
    { id: 'f5', promptKey: 'fact', text: 'He wears his lucky socks for every single job interview.' },
    { id: 'f6', promptKey: 'fact', text: 'Dave once won a meat raffle two weeks running.' },
    { id: 'w1', promptKey: 'word', text: 'thorough' },
    { id: 'n1', promptKey: 'never', text: 'leave a quiz machine with money still in it' },
  ];
  const quiz = generateQuiz({ submissions: subs, tone: 'medium', guestName: GUEST, rng: mulberry32(17) });
  const questions = allQuestions(quiz);
  const factCount = questions.filter(q => q.sourceSubmissionIds.some(id => String(id).startsWith('f'))).length;
  assert.ok(factCount <= Math.ceil(questions.length / 2),
    `fact prompt supplies ${factCount}/${questions.length} questions`);
});

test('decoys stay fresh: no wrong answer is recycled across questions (while banks allow)', () => {
  const quiz = build();
  const seenDecoys = new Set();
  for (const q of allQuestions(quiz)) {
    q.options.forEach((o, i) => {
      if (q.format !== 'twoTruths' && i === q.correctIndex) return; // real answers may echo across formats by design
      if (q.format === 'twoTruths' && i !== q.correctIndex) return; // truths are real submissions
      assert.ok(!seenDecoys.has(o), `decoy reused across questions: "${o}"`);
      seenDecoys.add(o);
    });
  }
});

// --- fingerprints & determinism ----------------------------------------------

test('fingerprints are stable across rebuilds with different rngs', () => {
  const run1 = build({ rng: mulberry32(1) });
  const run2 = build({ rng: mulberry32(999) });
  const fp1 = allQuestions(run1).map(q => q.fingerprint).sort();
  const fp2 = allQuestions(run2).map(q => q.fingerprint).sort();
  assert.deepEqual(fp1, fp2, 'same submissions must produce the same fingerprints regardless of rng');
  // And fingerprints are unique within a quiz.
  assert.equal(new Set(fp1).size, fp1.length);
  // Shuffles CAN differ, but the correct answer text is the same for source-backed formats.
  const byFp1 = new Map(allQuestions(run1).map(q => [q.fingerprint, q]));
  for (const q2 of allQuestions(run2)) {
    const q1 = byFp1.get(q2.fingerprint);
    assert.equal(q1.format, q2.format);
    if (q1.format !== 'twoTruths') {
      assert.equal(q1.options[q1.correctIndex], q2.options[q2.correctIndex]);
    }
  }
});

test('identical seed + input → byte-identical quiz (pure & deterministic)', () => {
  const a = build({ rng: mulberry32(1234) });
  const b = build({ rng: mulberry32(1234) });
  assert.deepEqual(a, b);
});
