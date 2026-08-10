'use strict';

// Curated decoy banks for the question engine.
//
// Every wrong answer a player sees comes from here (or from another guest's real
// submission, which questions.js handles). The register is British party / pub-quiz,
// PG-13, funny but deliberately generic enough to be plausible about ANY guest of
// honour — nothing references a name, a gender-specific detail, or a specific date.
//
// Entries are either:
//   - a plain string (reads the same at every tone), or
//   - a tone-variant object { gentle, medium, roast } used where the framing of the
//     decoy itself shifts with the tone dial (roast versions lean harder, gentle
//     versions soften — same joke, different heat).
//
// Banks are keyed by submission kind:
//   story    → fake anecdote summaries (used as wrong options in whoseStory)
//   fact     → fake "little-known facts" (howWell distractors, twoTruths lies)
//   never    → fake "…would never" completions
//   sentence → fake catchphrases
//   word     → fake one-word descriptors

const DECOYS = {

  story: [
    {
      gentle: 'Got politely asked to leave a Wetherspoons for starting a conga line',
      medium: 'Got escorted out of a Wetherspoons for starting a conga line',
      roast:  'Got barred from a Wetherspoons. A Wetherspoons.',
    },
    {
      gentle: 'Welled up at the John Lewis Christmas advert',
      medium: 'Cried at the John Lewis Christmas advert in front of everyone',
      roast:  'Full-on sobbed at the John Lewis Christmas advert, then denied it for a year',
    },
    'Fell asleep on the night bus and woke up at the depot',
    'Rang in sick to work from the actual queue at Alton Towers',
    'Got a lifetime ban from a crazy golf course over a disputed scorecard',
    'Waved back at someone who was waving at the person behind them, then had to commit to the bit',
    'Got locked out in a dressing gown and had to borrow the neighbour’s ladder',
    'Told the hairdresser "just a trim" and then sat in the car park processing it for forty minutes',
    'Won the pub quiz single-handedly, then immediately knocked the trophy off the bar',
    'Sent "love you loads xx" to the work group chat instead of their mum',
    'Got stuck in a child’s swing at the park and had to be freed by a passing dog walker',
    'Confidently ordered "the usual" in Spanish on holiday and received four plates of squid',
    'Chased the bin lorry down the street in slippers, and lost',
    'Set off the smoke alarm making beans on toast',
    'Claimed to be fluent in French right up until an actual French person turned up',
    'Fell off a stationary exercise bike during the gym induction',
    'Was photographed fast asleep at a wedding — during the vows',
    'Tried to pay for a round with a Nando’s loyalty card',
    'Missed a flight while sitting at the wrong gate having the airport pint',
    'Called the teacher "mum" at parents’ evening. As the parent.',
    'Entered a karaoke competition, forgot every single word, and styled it out with humming',
    'Reversed into their own wheelie bin and reported the council',
    'Got overtaken by a mobility scooter at their one and only parkrun',
    'Ate the display food at IKEA',
    'Started a small fire at a barbecue armed only with a disposable one and misplaced confidence',
    'Wore two different shoes to a job interview and still got the job',
    'Locked the keys inside the car with the engine running — outside the RAC office',
    'Applauded when the plane landed, alone, in row 14',
  ],

  fact: [
    'Once auditioned for a TV talent show and got through two whole rounds',
    'Has a tattoo they have never fully explained to anyone',
    'Was briefly a hand model for a local catalogue',
    'Can recite the entire Fresh Prince theme without taking a breath',
    {
      gentle: 'Is quietly retired from Monopoly at family Christmas after one heated game',
      medium: 'Is banned from Monopoly at family Christmas for being too competitive',
      roast:  'Is banned from Monopoly at family Christmas after flipping the board. Twice.',
    },
    'Once met a soap star in a big Tesco and asked for a photo of just the trolley',
    'Keeps a spreadsheet ranking every roast dinner they have ever eaten',
    'Slept through an entire hotel fire alarm, evacuation and all',
    'Has never seen a single Star Wars film and lies about it constantly',
    'Won £50 on a scratchcard and spent £60 celebrating',
    'Was once on the local news for about four seconds',
    'Cannot whistle and refuses to accept it',
    'Got a certificate in cheese tasting on a weekend away and lists it on LinkedIn',
    'Holds fierce loyalty to a football team they have watched live exactly twice',
    'Once phoned a radio station to settle a pub argument, live on air',
    'Is weirdly brilliant at darts, but only after 9pm',
    'Has cried at a nature documentary on more than one occasion',
    'Owns more mugs than plates',
    'Was a football mascot as a child and tripped over the flag on live TV',
    'Once returned a library book eleven years late with a handwritten apology',
    'Claims to have invented a sandwich that a high street chain later "stole"',
    'Can name every Eurovision winner since 2004, unprompted',
    'Faked a food allergy for years purely to avoid olives',
    'Got stuck in a lift with their old headteacher for over an hour',
    'Runs a secret second phone just for eBay bidding wars',
    'Learned first aid entirely from medical dramas and is worryingly confident about it',
    'Has a five-star Uber rating and mentions it unprompted',
  ],

  never: [
    'Say no to a second helping',
    'Admit they’re lost',
    'Leave a party before the food’s gone',
    'Read the terms and conditions',
    'Turn down a karaoke mic',
    'Split the bill without opening the calculator app',
    'Arrive anywhere on time',
    'Let someone else pick the playlist',
    'Order the small chips',
    {
      gentle: 'Be the first to apologise (they get there eventually)',
      medium: 'Apologise first',
      roast:  'Apologise first — or second, or at all',
    },
    'Go camping voluntarily',
    'Skip the bread basket',
    'Say "no more for me, thanks" and mean it',
    'Back down from a quiz answer, even a wrong one',
    'Walk past a dog without saying hello to it',
    'Delete a single photo from their phone',
    'Watch a film without asking questions all the way through',
    'Hand over the aux cable willingly',
    'Leave a voicemail under four minutes',
    'Choose the salad',
    'Admit the sat nav was right',
    'Miss a happy hour',
    'Return something to a shop without delivering a speech',
    'Let the barbecue be someone else’s job',
    'Go to bed before the end of the box set',
    'Keep a houseplant alive past a fortnight',
    'Let a parking ticket go unchallenged',
  ],

  sentence: [
    'I’m not drunk, I’m festive',
    {
      gentle: 'One more song, then I really am going home',
      medium: 'One more, then I’m definitely going',
      roast:  'One more, then I’m definitely going (narrator: they were not going)',
    },
    'It’s basically free if it was on offer',
    'I know a shortcut',
    'We go again',
    'Diet starts Monday',
    'It’s five o’clock somewhere',
    'Trust me, I’ve done this before',
    'I’ll just have a bit of yours',
    'It was like that when I got here',
    'I’m not being funny, but…',
    'Shall we get chips?',
    'I’ve got a good feeling about this',
    'That’s going in the group chat',
    'Right, I’m leaving in five minutes',
    'You can’t put a price on a good breakfast',
    'I was literally just about to say that',
    'Right, what’s the plan?',
    'It’ll be fine',
    'Whose round is it?',
    'I peaked in Year 11 and I’m at peace with it',
    'This is why we can’t have nice things',
    'Just Google it',
    'I’m not competitive, I just hate losing',
    'Honestly, the state of it',
    'I’m never drinking again',
    'Wait, say that again but slower',
  ],

  word: [
    'Chaotic',
    'Dramatic',
    'Iconic',
    'Loud',
    'Unbothered',
    'Relentless',
    'Caffeinated',
    'Wobbly',
    'Legendary',
    'Snacky',
    'Dependable',
    'Sparkly',
    'Stubborn',
    'Golden',
    'Shameless',
    'Cosy',
    'Turbocharged',
    'Mischievous',
    'Unstoppable',
    'Windswept',
    'Bubbly',
    'Nocturnal',
    'Extra',
    'Crispy',
    'Wholesome',
    'Rogue',
    { gentle: 'Lively', medium: 'Rowdy', roast: 'Feral' },
    'Punctual…ish',
  ],
};

// --- helpers -----------------------------------------------------------------

function resolveDecoy(entry, tone) {
  if (typeof entry === 'string') return entry;
  return entry[tone] || entry.medium || entry.gentle || entry.roast;
}

// Small local text-similarity kit (kept self-contained so decoys.js has no deps).
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

function fisherYates(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Pick `count` decoys from the bank for `kind`, resolved for `tone`, avoiding
 * anything too similar to the strings in `avoid` (so a decoy can never
 * accidentally duplicate the real answer). Strings in `exclude` (decoys already
 * used elsewhere in the quiz) are skipped while fresh material remains, so the
 * same gag doesn't turn up in two questions. Deterministic given a seeded rng.
 */
function pickDecoys({ kind, tone = 'medium', count, rng = Math.random, avoid = [], exclude = [] }) {
  const bank = (DECOYS[kind] || []).map(e => resolveDecoy(e, tone));
  const shuffled = fisherYates(bank, rng);
  const chosen = [];
  const excluded = new Set(exclude.map(e => normTokens(e).join(' ')));

  const tooClose = (candidate, threshold) => {
    for (const a of avoid) if (diceSim(candidate, a) >= threshold) return true;
    for (const c of chosen) if (diceSim(candidate, c) >= threshold) return true;
    return false;
  };

  // First pass: strict — nothing resembling the real answer(s), each other,
  // or anything already used in another question.
  for (const c of shuffled) {
    if (chosen.length >= count) break;
    if (excluded.has(normTokens(c).join(' '))) continue;
    if (!tooClose(c, 0.6)) chosen.push(c);
  }
  // Relaxed pass (only if the strict filter starved us): allow near-ish, never exact.
  for (const c of shuffled) {
    if (chosen.length >= count) break;
    if (!tooClose(c, 0.95)) chosen.push(c);
  }
  // Last resort: borrow from the other banks (fixed order for determinism).
  if (chosen.length < count) {
    for (const otherKind of Object.keys(DECOYS)) {
      if (otherKind === kind) continue;
      const other = fisherYates(DECOYS[otherKind].map(e => resolveDecoy(e, tone)), rng);
      for (const c of other) {
        if (chosen.length >= count) break;
        if (!tooClose(c, 0.95)) chosen.push(c);
      }
      if (chosen.length >= count) break;
    }
  }
  return chosen.slice(0, count);
}

module.exports = { DECOYS, resolveDecoy, pickDecoys };
