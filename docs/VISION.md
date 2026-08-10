# Vision

## One-liner
Grilled turns your mates' stories about the guest of honour into a live pub-quiz party game — friends secretly submit the dirt, the app builds the quiz, everyone plays on their phones on the night.

## The Problem
Every hen do, stag do, milestone birthday and leaving do has an organiser who wants a game that's *about the person*, not generic trivia. Today they either buy bland card packs, or one heroic friend spends a weekend building a PowerPoint quiz and a WhatsApp thread of collected stories. The personalised version is always the highlight of the night — it's just painful to make.

## Our Bet
A template-based question engine can turn raw submitted stories into a genuinely funny quiz with zero AI cost and zero marginal cost. The magic isn't clever text generation — it's the *format* ("Whose story is this?", "Two truths and a lie", "Finish the sentence") plus the guest of honour squirming in front of their friends. Formats are cheap; the content comes free from the friends.

## Target User
"The Organiser" — the maid of honour / best man / designated planner friend. Behaviour pattern: creates the WhatsApp group, collects the money, googles "hen do games" at 11pm. Wants maximum laughs for minimum prep, and wants credit for pulling it off.

## Success Criteria
1. An organiser can go from landing page to a shareable submission link in under 3 minutes, with no account beyond an email-free magic link.
2. A quiz of at least 15 questions is generated from 5+ submissions across 3+ question formats, and organisers rate at least 80% of generated questions as "usable" during moderation.
3. A full game — host screen plus 3+ phones joining by code — runs end-to-end (lobby → 3 rounds → winner reveal) without a crash or desync.
4. Total running cost: £0 (free-tier hostable, no external APIs).
5. First real-world validation: 5 complete games played by real groups within a month of launch.

## MVP Scope
- Create event (guest-of-honour name, occasion, tone dial: Gentle → Medium → Full Roast).
- Shareable submission link: friends anonymously submit stories, facts, and answers to structured prompts.
- Template question engine (no external AI): builds rounds from submissions — "Whose story is this?", "Two truths and a lie", "Finish the sentence", "How well do you know them?" (organiser-supplied answers).
- Moderation screen: organiser approves/edits/bins each generated question before game night.
- Live game: host screen (cast to TV) with rounds, timers, question reveals; players join on phones via 4-letter code; answers scored; live leaderboard; winner reveal.
- Single self-contained web app, runnable locally and deployable to a free tier.

## Anti-goals
- No payments/checkout in MVP (validate fun first, charge later).
- No user accounts, passwords, or email verification.
- No external AI APIs, no photo/audio rounds, no native apps.
- No public quiz gallery or social feed.
- No moderation beyond the organiser's own review (they know the room).

## Risks
1. **Template questions fall flat (High impact, Medium likelihood).** Mitigation: the humour is carried by the submitted stories and the live social moment, not the template prose; moderation screen lets the organiser cut duds; ship 4 diverse formats so weak submissions still map to at least one.
2. **Realtime multiplayer flakiness on party wifi (High impact, Medium likelihood).** Mitigation: design for reconnection from second one — join codes rejoin seamlessly, host screen is the source of truth, game state survives refreshes.
3. **Nobody submits stories (Medium impact, Medium likelihood).** Mitigation: structured prompts ("Tell us about a time Dave...") are far easier to answer than a blank box; organiser dashboard shows submission count so they can chase; quiz works from as few as 5 submissions.

## Decision
**GREEN LIGHT.** The distribution loop (every game is played by 10–40 future organisers at events that chain into more events) is unusually strong, marginal cost is zero, and the MVP is small enough to build and validate fast. The template-engine constraint is a feature, not a compromise: it forces the fun into formats and the live moment, where it belongs, and keeps running costs at zero while we learn.

## CEO Log
- 2026-08-10 — Initial strategic review. GREEN LIGHT on template-engine MVP under the name "Grilled". Deferred: payments, AI generation, photo rounds.
- 2026-08-10 (v2) — Founder green-lit the monetisation layer ahead of schedule. Scope extension approved: featherweight accounts (email magic-link, guest events still work at capability URLs with claim-by-email), £19 one-off "Full Grilling" per event via Stripe Checkout behind a config flag (app must run fully with payments off), marketing pages (pricing, how-it-works, upgraded landing), and deployability (render.yaml + DEPLOY.md). Anti-goals amended: payments and lightweight accounts move from "later" to "now"; passwords remain forbidden; players and submitters still never sign in. Success criterion added: the whole app must still run locally with `npm install && npm start` and £0 of external services.
