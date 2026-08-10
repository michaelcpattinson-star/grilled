'use strict';

// Submission prompts — pinned by docs/CONTRACTS.md. Do not change shapes or wording;
// the submission form and the engine both key off these.
// kinds: 'story' | 'fact' | 'word' | 'never' | 'sentence'

const PROMPTS = [
  { key: 'story',    kind: 'story',    label: n => `Tell us about a time ${n} embarrassed themselves (or you)…`, placeholder: 'The more detail the better…' },
  { key: 'fact',     kind: 'fact',     label: n => `A fact about ${n} most people don't know`, placeholder: 'They once…' },
  { key: 'word',     kind: 'word',     label: n => `One word that describes ${n}`, placeholder: 'e.g. chaotic' },
  { key: 'never',    kind: 'never',    label: n => `Finish the sentence: "${n} would never…"`, placeholder: '…' },
  { key: 'sentence', kind: 'sentence', label: n => `${n}'s catchphrase or most-used sentence`, placeholder: '"…"' },
];

module.exports = { PROMPTS };
