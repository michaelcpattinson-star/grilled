'use strict';
// Roast & Toast speech engine. Same philosophy as the question engine:
// pure code, no AI APIs, deterministic given a seeded rng. The comedy comes
// from the submitted material quoted verbatim; we supply structure, rhythm
// and a landing. Output is plain text — rendering escapes it like everything
// else (submissions are hostile-adjacent by definition).

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

function cleanQuote(text) {
  let t = String(text || '').trim().replace(/\s+/g, ' ');
  if (t && !/[.!?…"']$/.test(t)) t += '.';
  return t;
}

function lowerFirst(t) {
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

const OPENERS = {
  gentle: [
    (n, o) => `Ladies and gentlemen, thank you for being here for ${n}'s ${o}. I've been given the honour of saying a few words about someone we all love — and, thanks to a secret little project, I've had help from everyone in this room.`,
    (n, o) => `For those who don't know me, I'm the one who was daft enough to volunteer for this speech. But here's my secret weapon: before tonight, ${n}'s nearest and dearest were quietly asked for their favourite stories. What follows is entirely their fault.`,
  ],
  medium: [
    (n, o) => `Ladies and gentlemen — before ${n}'s ${o} got underway, I did something a bit sneaky. I asked everyone who knows ${n} best to anonymously send me the dirt. I expected a trickle. I got a flood. ${n}, I want you to remember as you listen: these are your closest friends.`,
    (n, o) => `They say a good speech should be like a good story about ${n} — short, unbelievable, and ending in mild embarrassment. Luckily, I didn't have to write this one alone: everyone in this room grassed you up in advance, ${n}. Anonymously. Like cowards. Beautiful, loyal cowards.`,
  ],
  roast: [
    (n, o) => `Ladies and gentlemen, welcome to ${n}'s ${o} — or as I've been calling it since the anonymous submissions came in, the trial. ${n}: everything you're about to hear was sent in by the people you trust most. Nobody was paid. Nobody was pressured. They *volunteered*.`,
    (n, o) => `${n}, before tonight I asked your friends and family one simple question: "What's the worst thing you can tell me that I can legally repeat?" The response rate was one hundred percent. Some people replied twice. One person sent a follow-up with corrections. This is their work; I'm just the messenger.`,
  ],
};

const WORD_INTROS = {
  gentle: (n) => `I asked people for one word to describe ${n}. The answers paint a lovely picture:`,
  medium: (n) => `I asked for one word to describe ${n}. The jury's verdict, verbatim:`,
  roast: (n) => `One word to describe ${n}, I asked. The room did not hold back:`,
};

const STORY_INTROS = [
  (n) => `Let me read you one, exactly as it was sent in about ${n}:`,
  (n) => `Here's another, word for word:`,
  (n) => `And this one arrived with no apology whatsoever:`,
  (n) => `This next one I couldn't leave out:`,
];

const FACT_INTROS = {
  gentle: (n) => `A few things you might not know about ${n}:`,
  medium: (n) => `Now for the intelligence file. Things most people don't know about ${n}:`,
  roast: (n) => `The following facts about ${n} have been verified by people with nothing to gain and everything to drink:`,
};

const NEVER_INTROS = {
  gentle: (n) => `When asked to finish the sentence "${n} would never…", their friends knew exactly what to say.`,
  medium: (n) => `We asked people to finish the sentence "${n} would never…" — and the confidence of these answers tells you everything.`,
  roast: (n) => `"${n} would never…" — we asked. The answers came back sworn, notarised, and bitter with experience.`,
};

const CATCHPHRASE_INTROS = {
  gentle: (n) => `And of course, no portrait of ${n} is complete without the catchphrase we all know:`,
  medium: (n) => `If you've spent more than ten minutes with ${n}, you've heard it. All together now:`,
  roast: (n) => `${n} has a catchphrase. You know it. Your nan knows it. It's on the group chat's Wikipedia page:`,
};

const TOASTS = {
  gentle: (n, o) => `So — please charge your glasses and be upstanding. To ${n}: much loved, occasionally embarrassed, and never, ever boring. To ${n}!`,
  medium: (n, o) => `So raise your glasses, everyone. To ${n} — the star of every one of these stories, and the only person in this room who didn't get a say tonight. We wouldn't change a single word of you. To ${n}!`,
  roast: (n, o) => `So charge your glasses and get on your feet. To ${n}: roasted by their own people, convicted on all counts, and somehow still the best of us. To ${n}!`,
};

/**
 * generateSpeech({submissions, tone, guestName, occasion, gameResults, rng})
 * submissions: [{promptKey, text}] · tone: 'gentle'|'medium'|'roast'
 * gameResults: {winner:{nickname,score}, knowsBest:{nickname,correct,answered}} | null
 * → { title, fullText, wordCount }
 */
function generateSpeech({ submissions = [], tone = 'medium', guestName, occasion, gameResults = null, rng = Math.random }) {
  if (!OPENERS[tone]) tone = 'medium';
  const n = guestName;
  const byKind = { story: [], fact: [], word: [], never: [], sentence: [] };
  for (const s of submissions) {
    if (byKind[s.promptKey] && s.text && String(s.text).trim()) byKind[s.promptKey].push(String(s.text).trim());
  }

  const paras = [];

  // 1. Opener
  paras.push(pick(rng, OPENERS[tone])(n, occasion));

  // 2. One-word portraits
  const words = byKind.word.slice(0, 5).map((w) => `"${cleanQuote(w).replace(/\.$/, '')}"`);
  if (words.length) {
    paras.push(`${WORD_INTROS[tone](n)} ${joinList(words)}. ${words.length > 1 ? 'Consistency. You love to see it.' : "Just the one answer — but everyone who read it nodded."}`);
  }

  // 3. Story beats — the headliners, quoted verbatim
  const stories = byKind.story.slice(0, 3);
  stories.forEach((story, i) => {
    paras.push(`${STORY_INTROS[Math.min(i, STORY_INTROS.length - 1)](n)}\n\n"${cleanQuote(story)}"`);
  });
  if (stories.length) {
    paras.push(
      tone === 'gentle'
        ? `I'm assured every word of that is true — and honestly, it's why we love ${n}.`
        : tone === 'roast'
          ? `${n}, you can't sue — it was anonymous, and frankly the evidence is overwhelming.`
          : `No names were attached to any of that, ${n}, so your revenge options are limited to glaring at the whole room at once.`
    );
  }

  // 4. Facts
  const facts = byKind.fact.slice(0, 2);
  if (facts.length) {
    paras.push(`${FACT_INTROS[tone](n)}\n\n${facts.map((f) => `— ${cleanQuote(f)}`).join('\n')}`);
  }

  // 5. Would never
  const nevers = byKind.never.slice(0, 2);
  if (nevers.length) {
    paras.push(`${NEVER_INTROS[tone](n)}\n\n${nevers.map((x) => `— "${n} would never ${cleanQuote(lowerFirst(x))}"`).join('\n')}`);
  }

  // 6. Catchphrase
  if (byKind.sentence.length) {
    paras.push(`${CATCHPHRASE_INTROS[tone](n)} "${cleanQuote(byKind.sentence[0])}"`);
  }

  // 7. Quiz-night callback
  if (gameResults && gameResults.winner) {
    let line = `And if you doubt any of this, know that we put it all to the test — a full quiz about ${n}, played by this very room. ` +
      `Congratulations to ${gameResults.winner.nickname}, our champion`;
    if (gameResults.knowsBest && gameResults.knowsBest.nickname && gameResults.knowsBest.nickname !== gameResults.winner.nickname) {
      line += `, and a special mention to ${gameResults.knowsBest.nickname}, who knows ${n} suspiciously well (${gameResults.knowsBest.correct}/${gameResults.knowsBest.answered} correct — we have questions of our own)`;
    }
    line += '.';
    paras.push(line);
  }

  // Sparse-material safety net: always deliverable
  if (!words.length && !stories.length && !facts.length && !nevers.length && !byKind.sentence.length) {
    paras.push(
      `Now, the anonymous submissions about ${n} were… sparse. Which either means ${n} has lived a blameless life, or the group chat is protecting someone. Knowing this room, I'll let you decide which.`
    );
  }

  // 8. Toast
  paras.push(TOASTS[tone](n, occasion));

  const fullText = paras.join('\n\n');
  return {
    title: `A toast to ${n}`,
    fullText,
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
  };
}

module.exports = { generateSpeech };
