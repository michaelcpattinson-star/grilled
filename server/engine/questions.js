'use strict';

// Question engine — pure module. submissions + tone (+ seeded rng) → rounds of questions.
// No db, no io, no AI. Contract: docs/CONTRACTS.md (Engine section).
//
// Key design decisions (see also inline comments):
//
// * twoTruths and "exactly 4 options": the classic 2-truths-1-lie is a 3-option
//   game, and padding it to 4 with a second lie would make a single correctIndex
//   ambiguous. So: twoTruths is only generated when ≥3 real facts survive dedupe,
//   as THREE truths + ONE lie ("three truths and a lie — spot the lie"), which is
//   honest, four-option, and single-answer. With only 1–2 facts, those facts fall
//   back to the howWell format (1 real + 3 decoys) and the liedetector round is
//   simply omitted.
//
// * Per-source cap: each submission fuels AT MOST ONE question per format
//   (e.g. a fact can appear once in howWell and once inside a twoTruths group,
//   never twice in the same format). This is how one submission stretches to the
//   "≥15 questions" aim without any format repeating itself.
//
// * Secondary framings: word/never/sentence submissions primarily become
//   finishSentence questions; when the quiz is short of the 15-question target
//   they ALSO get a differently-worded howWell question. Selection of secondaries
//   is rng-independent (stable submission order) so fingerprints stay stable
//   across rebuilds.
//
// * Fingerprints hash format + sorted source submission ids ONLY — never the
//   shuffled option order or chosen decoys — so moderation edits/bins keyed on
//   fingerprint survive a rebuild with a different rng.

const { PROMPTS } = require('./prompts');
const { pickDecoys } = require('./decoys');

const TARGET_QUESTIONS = 15;
const TONES = ['gentle', 'medium', 'roast'];

// --- tiny text toolkit -------------------------------------------------------

function collapse(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function stripWrappingQuotes(text) {
  return text.replace(/^["'“”‘’\s]+/, '').replace(/["'“”‘’\s]+$/, '');
}

function tidyEnding(text) {
  // Drop trailing full stops / commas / ellipses; keep ! and ? (they carry tone).
  return text.replace(/[\s.,;:…]+$/, '');
}

function capFirst(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// Standard clean-up applied to any submission text before it becomes an option.
function cleanOption(text) {
  return capFirst(tidyEnding(stripWrappingQuotes(collapse(text))));
}

function normTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function diceSim(a, b) {
  const ta = new Set(normTokens(a));
  const tb = new Set(normTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "…turn down chips" / "Dave would never turn down chips" → "Turn down chips"
function cleanNeverCompletion(text, guestName) {
  let s = collapse(text).replace(/^[.…\s]+/, '');
  const name = escapeRegExp(collapse(guestName));
  const prefix = new RegExp(
    `^(?:(?:${name}|he|she|they)\\s+)?(?:would\\s+)?(?:never|not|ever)\\s+`, 'i');
  // Strip the lead-in at most twice ("Dave would never ever …").
  s = s.replace(prefix, '').replace(/^(?:never|ever)\s+/i, '');
  return cleanOption(s);
}

// Trim a story down to a one-breath quizmaster summary for use as an option.
function summariseStory(text) {
  const s = cleanOption(text);
  if (s.length <= 120) return s;
  // Prefer whole sentences.
  const sentences = collapse(text).split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > 120) break;
    out = next;
  }
  if (out.length >= 40) return cleanOption(out);
  // First sentence alone is huge — cut at a word boundary.
  const cut = s.slice(0, 117);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// Non-crypto stable hash (djb2 xor variant) — plenty for fingerprints.
function tinyHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function fingerprintOf(format, sourceIds) {
  const ids = sourceIds.map(String).slice().sort();
  return `${format}-${tinyHash(`${format}|${ids.join('+')}`)}`;
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickOne(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

// --- wording: stems and round titles, per tone -------------------------------
// Tone changes framing text ONLY — the material and answers are identical.

const ROUND_TITLES = {
  warmup: {
    gentle: n => `Getting to Know ${n}`,
    medium: n => `Warm-Up: How Well Do You Know ${n}?`,
    roast:  n => `Warm-Up: Prove You've Actually Met ${n}`,
  },
  stories: {
    gentle: n => `Story Time`,
    medium: n => `Whose Story Is This?`,
    roast:  n => `The Case Files: ${n}'s Finest Moments`,
  },
  liedetector: {
    gentle: n => `Truth or Fib`,
    medium: n => `The Lie Detector`,
    roast:  n => `The Lie Detector: ${n} Edition`,
  },
};

const STEMS = {
  whoseStory: {
    gentle: [
      n => `One of these lovely disasters really happened to ${n}. Which one?`,
      n => `Which of these stories about ${n} is actually true?`,
    ],
    medium: [
      n => `Which of these stories about ${n} is TRUE?`,
      n => `Three of these are made up. One genuinely happened to ${n}. Which?`,
    ],
    roast: [
      n => `One of these is a genuine, documented ${n} incident. Choose wisely.`,
      n => `Which of these did ${n} actually do? (There's no unknowing this.)`,
    ],
  },
  twoTruths: {
    gentle: [
      n => `Three of these are true about ${n}. Can you spot the fib?`,
      n => `Someone slipped one fib in among three truths about ${n}. Which is it?`,
    ],
    medium: [
      n => `Three truths and a lie about ${n} — which is the LIE?`,
      n => `Three of these are real facts about ${n}. Find the lie.`,
    ],
    roast: [
      n => `Three of these are cold, hard facts about ${n}. Find the lie — the truths are damning enough.`,
      n => `${n}'s mates confirmed three of these. Sniff out the lie.`,
    ],
  },
  howWell: {
    fact: {
      gentle: [
        n => `Which of these is a real fact about ${n}?`,
        n => `Only one of these is true of ${n} — which?`,
      ],
      medium: [
        n => `Three of these are inventions. Which is a REAL fact about ${n}?`,
        n => `Which of these is genuinely true of ${n}?`,
      ],
      roast: [
        n => `Somebody grassed ${n} up. Which of these is the real fact?`,
        n => `One of these is true, and ${n} would rather it wasn't. Which?`,
      ],
    },
    word: {
      gentle: [n => `Someone who loves ${n} described them in one word. Which was it?`],
      medium: [n => `A mate summed ${n} up in exactly one word. Which one?`],
      roast:  [n => `${n} in one word, according to someone who knows far too much. Which?`],
    },
    never: {
      gentle: [n => `According to a friend, which of these would ${n} never do?`],
      medium: [n => `A mate swears ${n} would never do one of these. Which?`],
      roast:  [n => `Which of these is ${n} genuinely incapable of, per a very reliable source?`],
    },
    sentence: {
      gentle: [n => `Which of these is something ${n} actually says?`],
      medium: [n => `Which of these is ${n}'s genuine catchphrase?`],
      roast:  [n => `Which of these does ${n} actually say, far too often?`],
    },
  },
  finishSentence: {
    never: {
      gentle: [n => `Finish the sentence: "${n} would never…"`],
      medium: [
        n => `Complete the sentence: "${n} would NEVER…"`,
        n => `Finish it: "${n} would never…"`,
      ],
      roast: [n => `Finish the sentence — and be honest: "${n} would never…"`],
    },
    sentence: {
      gentle: [n => `Finish the sentence: "${n}'s go-to line is…"`],
      medium: [n => `Complete the sentence: "You can always count on ${n} to say…"`],
      roast:  [n => `Finish it: "Oh no, here's ${n}, about to say…"`],
    },
    word: {
      gentle: [n => `Finish the sentence: "${n}, in a word, is…"`],
      medium: [n => `Complete the sentence: "${n} in one word:…"`],
      roast:  [n => `Finish the sentence: "The kindest word anyone found for ${n} was…"`],
    },
  },
};

// --- submission prep ---------------------------------------------------------

const KIND_BY_KEY = new Map(PROMPTS.map(p => [p.key, p.kind]));

function prepareSubmissions(submissions) {
  const byKind = { story: [], fact: [], word: [], never: [], sentence: [] };
  for (const sub of submissions) {
    const kind = KIND_BY_KEY.get(sub.promptKey);
    if (!kind) continue; // unknown prompt — not ours to guess at
    const text = collapse(sub.text);
    if (!text) continue;
    byKind[kind].push({ id: sub.id, text });
  }
  // Dedupe near-identical submissions within a kind (normalised similarity).
  // Later duplicates lose; order is submission order, so this is rng-independent.
  for (const kind of Object.keys(byKind)) {
    const kept = [];
    for (const sub of byKind[kind]) {
      const dupe = kept.some(k =>
        k.text.toLowerCase() === sub.text.toLowerCase() || diceSim(k.text, sub.text) >= 0.75);
      if (!dupe) kept.push(sub);
    }
    byKind[kind] = kept;
  }
  return byKind;
}

// --- question builders -------------------------------------------------------
// Each returns { question, promptKind } — promptKind feeds the dominance cap.

function assemble({ format, stem, realOption, decoyOptions, sourceText, sourceIds, rng }) {
  const options = shuffle([realOption, ...decoyOptions], rng);
  return {
    format,
    questionText: stem,
    options,
    correctIndex: options.indexOf(realOption),
    sourceText,
    fingerprint: fingerprintOf(format, sourceIds),
    sourceSubmissionIds: sourceIds.slice(), // extra (not in contract shape) — lets the backend link questions to rows
  };
}

// ctx = { tone, name, rng, used } — `used` collects every decoy already placed
// in this quiz so pickDecoys can keep gags from repeating across questions.

function buildWhoseStory(sub, ctx) {
  const { tone, name, rng, used } = ctx;
  const real = summariseStory(sub.text);
  const decoys = pickDecoys({ kind: 'story', tone, count: 3, rng, avoid: [real], exclude: used });
  used.push(...decoys);
  return assemble({
    format: 'whoseStory',
    stem: pickOne(STEMS.whoseStory[tone], rng)(name),
    realOption: real,
    decoyOptions: decoys,
    sourceText: collapse(sub.text),
    sourceIds: [sub.id],
    rng,
  });
}

function realOptionFor(kind, sub, guestName) {
  if (kind === 'never') return cleanNeverCompletion(sub.text, guestName);
  if (kind === 'word') return capFirst(tidyEnding(stripWrappingQuotes(collapse(sub.text))));
  return cleanOption(sub.text);
}

function buildHowWell(sub, kind, ctx) {
  const { tone, name, rng, used } = ctx;
  const real = realOptionFor(kind, sub, name);
  const decoys = pickDecoys({ kind, tone, count: 3, rng, avoid: [real], exclude: used });
  used.push(...decoys);
  return assemble({
    format: 'howWell',
    stem: pickOne(STEMS.howWell[kind][tone], rng)(name),
    realOption: real,
    decoyOptions: decoys,
    sourceText: collapse(sub.text),
    sourceIds: [sub.id],
    rng,
  });
}

function buildFinishSentence(sub, kind, ctx) {
  const { tone, name, rng, used } = ctx;
  const real = realOptionFor(kind, sub, name);
  const decoys = pickDecoys({ kind, tone, count: 3, rng, avoid: [real], exclude: used });
  used.push(...decoys);
  return assemble({
    format: 'finishSentence',
    stem: pickOne(STEMS.finishSentence[kind][tone], rng)(name),
    realOption: real,
    decoyOptions: decoys,
    sourceText: collapse(sub.text),
    sourceIds: [sub.id],
    rng,
  });
}

function buildTwoTruths(factSubs, ctx) {
  const { tone, name, rng, used } = ctx;
  const truths = factSubs.map(s => cleanOption(s.text));
  const [lie] = pickDecoys({ kind: 'fact', tone, count: 1, rng, avoid: truths, exclude: used });
  used.push(lie);
  const options = shuffle([...truths, lie], rng);
  return {
    format: 'twoTruths',
    questionText: pickOne(STEMS.twoTruths[tone], rng)(name),
    options,
    correctIndex: options.indexOf(lie),
    sourceText: `The other three are all true: ${truths.join(' · ')}`,
    fingerprint: fingerprintOf('twoTruths', factSubs.map(s => s.id)),
    sourceSubmissionIds: factSubs.map(s => s.id),
  };
}

// --- dominance cap -----------------------------------------------------------
// One prolific prompt (our only proxy for "one prolific submitter" — submissions
// are anonymous by design) must not supply more than ~half the quiz. Trimmed
// items are removed from the END of the dominant prompt's list, which is stable
// order, so trimming never reshuffles fingerprints.

function enforceDominanceCap(items) {
  const kinds = new Set(items.map(i => i.promptKind));
  if (kinds.size < 2) return items; // single-voice material: nothing to balance against
  const list = items.slice();
  for (;;) {
    const counts = new Map();
    for (const i of list) counts.set(i.promptKind, (counts.get(i.promptKind) || 0) + 1);
    let domKind = null;
    let domCount = 0;
    for (const [k, c] of counts) if (c > domCount) { domKind = k; domCount = c; }
    const others = list.length - domCount;
    if (domCount <= others || domCount <= 2) return list;
    const idx = list.map(i => i.promptKind).lastIndexOf(domKind);
    list.splice(idx, 1);
  }
}

// --- entry point -------------------------------------------------------------

function generateQuiz({ submissions = [], tone = 'medium', guestName = 'the guest of honour', rng = Math.random } = {}) {
  if (!TONES.includes(tone)) tone = 'medium';
  const name = collapse(guestName) || 'the guest of honour';
  const byKind = prepareSubmissions(submissions);

  // Primary questions, built in stable submission order (fingerprint safety).
  const ctx = { tone, name, rng, used: [] };
  const built = []; // { question, promptKind }

  for (const sub of byKind.story) {
    built.push({ question: buildWhoseStory(sub, ctx), promptKind: 'story' });
  }

  for (const sub of byKind.fact) {
    built.push({ question: buildHowWell(sub, 'fact', ctx), promptKind: 'fact' });
  }

  // twoTruths: 3 truths + 1 lie, only when ≥3 facts exist. Facts are grouped into
  // consecutive triples in stable id order (NOT rng order) so the same facts always
  // land in the same twoTruths question → stable fingerprint across rebuilds.
  const factsSorted = byKind.fact.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (let i = 0; i + 3 <= factsSorted.length; i += 3) {
    built.push({ question: buildTwoTruths(factsSorted.slice(i, i + 3), ctx), promptKind: 'fact' });
  }

  for (const kind of ['never', 'sentence', 'word']) {
    for (const sub of byKind[kind]) {
      built.push({ question: buildFinishSentence(sub, kind, ctx), promptKind: kind });
    }
  }

  // Secondary framings — only to close the gap to the 15-question aim, so small
  // quizzes get fuller and big quizzes never repeat an answer. Stable order.
  if (built.length < TARGET_QUESTIONS) {
    outer:
    for (const kind of ['never', 'sentence', 'word']) {
      for (const sub of byKind[kind]) {
        if (built.length >= TARGET_QUESTIONS) break outer;
        built.push({ question: buildHowWell(sub, kind, ctx), promptKind: kind });
      }
    }
  }

  const capped = enforceDominanceCap(built);

  // Rounds — omit any round with no questions.
  const warmup = capped.filter(i => i.question.format === 'howWell' || i.question.format === 'finishSentence');
  const stories = capped.filter(i => i.question.format === 'whoseStory');
  const liedetector = capped.filter(i => i.question.format === 'twoTruths');

  const rounds = [];
  const pushRound = (roundKey, items) => {
    if (items.length === 0) return;
    rounds.push({
      roundKey,
      title: ROUND_TITLES[roundKey][tone](name),
      questions: shuffle(items.map(i => i.question), rng),
    });
  };
  pushRound('warmup', warmup);
  pushRound('stories', stories);
  pushRound('liedetector', liedetector);

  return { rounds };
}

module.exports = { generateQuiz };
