# Product Spec — Grilled

## Overview
Grilled lets a party organiser build a live quiz about the guest of honour from stories their friends secretly submit. A template engine (no AI API) turns submissions into pub-quiz rounds; on the night, a host screen runs the show while everyone answers on their phones via a join code. It's different because the questions are about the person in the room, and because every game is played in front of 10–40 future customers.

## User Personas

- **Olivia the Organiser** (maid of honour, 29). Motivation: throw a hen do people talk about for years. Frustration: no time, and the PowerPoint quiz she made last time took a whole weekend.
- **Sam the Submitter** (mate of the guest of honour, 25–45). Motivation: land the perfect embarrassing story. Frustration: blank text boxes; wants prompts and 60 seconds, not homework.
- **Priya the Player** (guest at the party, any age). Motivation: laugh, compete, heckle. Frustration: apps that need downloads, accounts, or good wifi.

(The guest of honour is deliberately not a user — they experience the product, they never touch it.)

## User Journeys

### Journey: Create the event
**Persona:** Olivia · **Goal:** Get a submission link to drop in the WhatsApp group · **Entry point:** Landing page

| Step | User Action | System Response | Notes |
|------|------------|-----------------|-------|
| 1 | Clicks "Create a quiz" | Event form: guest-of-honour name, occasion, tone dial | No account needed |
| 2 | Fills form, submits | Event created; shows organiser dashboard with secret organiser link + public submission link | Organiser link is the "account" — warn her to keep it |
| 3 | Copies submission link | One-tap copy + suggested WhatsApp message | Pre-written message reduces friction |

**Success state:** Submission link in the group chat within 3 minutes; dashboard shows "0 submissions — chase your mates."
**Failure states:** Lost organiser link → recovery hint on landing page ("check the tab/bookmark; links can't be recovered" in MVP). Empty name → inline validation.

### Journey: Submit the dirt
**Persona:** Sam · **Goal:** Contribute stories in under 2 minutes · **Entry point:** Link from WhatsApp

| Step | User Action | System Response | Notes |
|------|------------|-----------------|-------|
| 1 | Opens link on phone | Intro: "Help us grill Dave. He'll never know who said what." | Anonymity up front — it unlocks better stories |
| 2 | Answers structured prompts | Prompts like "Tell us about a time Dave embarrassed himself", "One word that describes Dave", "A fact about Dave most people don't know", "Finish: 'Dave would never…'" | Skippable; any subset is fine |
| 3 | Submits | Thank-you screen + "add another story" option | Multiple submissions welcome |

**Success state:** Confirmation; submission appears (anonymously) in Olivia's moderation queue.
**Failure states:** Event already locked for game night → friendly "quiz has closed" screen. Empty submission → prompt to fill at least one field.

### Journey: Build & moderate the quiz
**Persona:** Olivia · **Goal:** A quiz she trusts in front of the grandmas · **Entry point:** Organiser dashboard

| Step | User Action | System Response | Notes |
|------|------------|-----------------|-------|
| 1 | Clicks "Build my quiz" | Engine generates questions from approved submissions, grouped into rounds | Regenerable any time before game night |
| 2 | Reviews each question | Approve / edit text / bin, per question | Edits stick through regeneration |
| 3 | Adjusts tone dial if needed | Question templates re-skinned to match tone | Gentle → Full Roast wording |
| 4 | Clicks "Ready to play" | Game code created; host screen link shown | Locks new submissions |

**Success state:** ≥15 approved questions across ≥3 formats; big friendly game code.
**Failure states:** Too few submissions (<5) → engine explains what's missing and suggests chasing; generates what it can. All questions binned in a round → round dropped gracefully.

### Journey: Game night
**Personas:** Olivia (host) + Priya (player) · **Goal:** 30–45 minutes of chaos with a winner · **Entry point:** Host opens host-screen link on TV/laptop; players go to site and enter code

| Step | User Action | System Response | Notes |
|------|------------|-----------------|-------|
| 1 | Players enter 4-letter code + nickname | Lobby on host screen fills with names | Duplicate nicknames get a suffix |
| 2 | Host clicks Start | Round intro → question on TV; answer options on phones | Phones show options only, never the question — eyes up |
| 3 | Players answer before timer ends | Lock-in confirmation; host screen shows answer count | Speed bonus for fast correct answers |
| 4 | Timer ends | Reveal on host screen incl. the source story; scores update; leaderboard between rounds | The reveal IS the entertainment — give it room |
| 5 | Final round ends | Podium: top 3 + "biggest betrayal" style superlatives; "Make one for your next do" screen | The viral hook, built in |

**Success state:** Winner crowned; nobody had to install anything; game survived phone locks and refreshes.
**Failure states:** Player disconnects → rejoin with same code+nickname restores score. Host refreshes → game resumes at current question. Nobody answers → timer proceeds, question scores zero all round.

## Feature Breakdown

### F1. Event creation & organiser dashboard
**Priority:** Must
**User story:** As Olivia, I want to create an event and get shareable links in minutes so that setup never feels like work.
**Acceptance criteria:**
- [ ] Event created with name, occasion, tone; no email/password required
- [ ] Distinct secret organiser URL and public submission URL generated
- [ ] Dashboard shows submission count and quiz status
- [ ] One-tap copy of submission link with pre-written share message
**Edge cases:** organiser link shared by accident (regenerate option); event name with emoji/long names (clamped display).
**Out of scope:** link recovery by email; multiple organisers.

### F2. Story submission flow
**Priority:** Must
**User story:** As Sam, I want prompted, anonymous submission on my phone so that contributing takes two minutes.
**Acceptance criteria:**
- [ ] Mobile-first form with 4+ structured prompts, all optional but ≥1 required to submit
- [ ] No identity captured or displayed anywhere
- [ ] Multiple submissions per person allowed
- [ ] Submissions blocked after quiz is locked, with friendly messaging
**Edge cases:** 5,000-word war-and-peace story (length cap with counter); offensive content (organiser moderation is the filter).
**Out of scope:** photo/audio uploads.

### F3. Template question engine
**Priority:** Must
**User story:** As Olivia, I want the app to turn raw stories into quiz questions so that I never open PowerPoint again.
**Acceptance criteria:**
- [ ] Generates from submissions with zero external API calls
- [ ] ≥4 formats: Whose Story Is This?, Two Truths and a Lie, Finish the Sentence, How Well Do You Know Them?
- [ ] Tone dial (Gentle/Medium/Full Roast) changes question framing text
- [ ] Produces ≥15 questions from 5 submissions when material allows; degrades gracefully below that
- [ ] Wrong-answer options ("distractors") drawn from other submissions or curated decoy banks, never obviously fake
**Edge cases:** near-duplicate submissions (dedupe by similarity); one prolific submitter (cap per-source usage so it isn't all one voice).
**Out of scope:** LLM-generated prose; auto-difficulty.

### F4. Moderation & editing
**Priority:** Must
**User story:** As Olivia, I want to approve, edit, or bin every question so that nothing lands wrong in front of the family.
**Acceptance criteria:**
- [ ] Every generated question is reviewable before game night
- [ ] Inline text editing of question and answers; edits survive regeneration
- [ ] Binned questions never reappear
- [ ] "Ready to play" requires ≥10 approved questions
**Edge cases:** binning enough to empty a round (round drops out cleanly).
**Out of scope:** automated profanity filtering.

### F5. Live game — host screen & phone play
**Priority:** Must
**User story:** As Priya, I want to join with a code and play from my phone so that the game starts in seconds.
**Acceptance criteria:**
- [ ] 4-letter join code; lobby shows joined nicknames on host screen in realtime
- [ ] Question + options on host screen; options only on phones; configurable timer (default 20s)
- [ ] Scoring: correct = 100 + speed bonus up to 50; live leaderboard between rounds
- [ ] Reveal shows correct answer and the source story text
- [ ] Podium + superlatives + "Make one for your next do" end screen
- [ ] Player reconnect (same nickname) restores score; host refresh resumes game state
**Edge cases:** two devices, same nickname (second gets suffix); player joins mid-game (joins from next question, score from zero); zero players at start (host blocked from starting with <2 players).
**Out of scope:** spectator mode; music; per-round themes.

### F6. Landing page
**Priority:** Should
**User story:** As Olivia, I want to instantly understand what this is so that I trust it with the biggest night of my best mate's year.
**Acceptance criteria:**
- [ ] Explains concept in one screen with a "Create a quiz" and a "Join a game" entry
- [ ] Join-a-game path asks only for the 4-letter code
**Out of scope:** SEO content pages, testimonials.

### F7. Demo event
**Priority:** Should
**User story:** As a curious visitor, I want to try a pre-filled example quiz so that I get the joke before asking my mates to submit.
**Acceptance criteria:**
- [ ] One-click demo event with fictional guest of honour and pre-seeded submissions, playable solo or multi-phone
**Out of scope:** none.

### F8. Superlatives end screen
**Priority:** Could
**User story:** As Priya, I want daft awards ("Fastest finger", "Knows Dave suspiciously well") so that the ending feels like a ceremony.
**Acceptance criteria:**
- [ ] ≥3 superlatives computed from answer data shown before final podium

### F9. Featherweight accounts (magic link)
**Priority:** Must (v2)
**User story:** As Olivia, I want to find my events again by email — without ever setting a password — so that losing a browser tab doesn't lose the quiz.
**Acceptance criteria:**
- [ ] Sign in by entering an email; a magic link is sent (console-logged in dev via a provider-agnostic mail adapter); clicking it starts a session (httpOnly cookie)
- [ ] Guest event creation still works with no account — event lives at its capability URL
- [ ] Dashboard offers "claim this event by email": verifying the emailed link attaches the event to that account
- [ ] `/account` lists the signed-in user's events with links to each dashboard
- [ ] Players and submitters never see a sign-in prompt anywhere
**Edge cases:** magic link reused or expired (>15 min) → friendly error, offer to resend; claiming an already-claimed event → only same account may re-claim; email normalised (trim/lowercase).
**Out of scope:** passwords, OAuth, teams, email change.

### F10. Pricing — Full Grilling (£19/event)
**Priority:** Must (v2)
**User story:** As Olivia, I want to pay £19 once for the big night — no subscription — so that the price feels like a round of drinks, not software.
**Acceptance criteria:**
- [ ] Every event starts on the Free plan: play with up to 15 approved questions, no superlatives round
- [ ] Full Grilling (£19 one-off per event) unlocks unlimited questions and superlatives
- [ ] Stripe Checkout behind a `PAYMENTS_ENABLED` config flag; with it off, the whole app runs locally and a clearly-labelled dev unlock button appears instead
- [ ] Payment confirmed via Stripe webhook (signature verified); dashboard reflects plan without manual refresh drama
- [ ] Free events with >15 approved questions can still go Ready — the game simply uses the first 15 (dashboard says so plainly)
**Edge cases:** webhook arrives before redirect (idempotent); duplicate webhook delivery (idempotent); checkout for an already-full event (409).
**Out of scope:** refunds UI, VAT invoicing, subscriptions, coupons.

### F13. Roast & Toast — the speech (£50/event)
**Priority:** Must (v3)
**User story:** As Olivia (or the best man), I want the quiz material turned into a ready-to-deliver party speech so that the scariest five minutes of the do writes itself.
**Acceptance criteria:**
- [ ] £50 one-off per event, includes everything in Full Grilling; purchasable from Free or Full
- [ ] Template speech engine (no AI APIs): builds a structured 3–5 minute speech from the submissions — opener, one-word portraits, story beats quoting submissions verbatim, "would never" bit, catchphrase bit, toast — honouring the roast dial
- [ ] If the game has been played, the speech weaves in results (winner, who knew them suspiciously well)
- [ ] Speech is editable in the dashboard, savable, copyable; regenerating never destroys a saved edit without warning
- [ ] Degrades gracefully with few submissions; works even before the game is played (game callbacks simply absent)
**Edge cases:** hostile submission text (stays inert text everywhere); enormous edits (length cap).
**Out of scope:** AI prose, PDF export, teleprompter mode.

### F11. Marketing pages
**Priority:** Should (v2)
**User story:** As a visitor from the group chat, I want to get the joke in one screen so that I trust it with the biggest night of the year.
**Acceptance criteria:**
- [ ] Landing explains the product in one screen — cheeky British tone, never corporate — with "Try the demo" opening a pre-seeded playable example
- [ ] `/pricing` page: Free vs Full Grilling (£19/event), honest and simple
- [ ] `/how-it-works` page: the 4-step story (secret link → the dirt → moderate → game night)
- [ ] 30-day auto-delete stated as a trust feature on landing, submit form and dashboard
**Out of scope:** SEO blog, testimonials, analytics pixels.

### F12. Deployability
**Priority:** Must (v2)
**Acceptance criteria:**
- [ ] `render.yaml` deploys the app to Render with a persistent disk for SQLite and websockets working
- [ ] `DEPLOY.md` walks through deploy + env vars (Stripe keys, mail provider, BASE_URL)
- [ ] `npm install && npm start` remains the entire local setup, payments off by default

### Won't have (this release)
AI generation, photo/audio rounds, printable keepsakes, white-label, analytics dashboards for users, passwords, subscriptions, refund tooling.

## Information Architecture
- `/` — landing (Create / Join / Try the demo)
- `/pricing` — Free vs Full Grilling
- `/how-it-works` — the 4-step story
- `/new` — event creation
- `/account` — sign in (magic link) + your events
- `/auth/verify?token=…` — magic-link landing (session start / event claim)
- `/o/{organiserKey}` — organiser dashboard (submissions, build, moderate, claim, upgrade, start game)
- `/s/{submissionKey}` — public submission form
- `/host/{organiserKey}` — host screen (lobby → rounds → podium)
- `/play` — join code entry → player screen

## Analytics Events
(Anonymous, first-party, success-criteria aligned): event_created, submission_completed, quiz_built, question_approved/binned (ratio → criterion 2), game_started, game_completed, players_per_game, end_screen_cta_clicked.

## Open Questions
1. Free-tier realtime hosting choice — Head of Eng to decide (constraint: £0/month, websocket-friendly).
2. Data retention: auto-delete events after N days? (Recommend 30 — supports "no accounts" trust story.)
3. Should the demo event double as the landing-page hero? (CPO lean: yes, show don't tell.)

## CPO Log
- 2026-08-10 — Initial spec from VISION.md. 5 Must features, 2 Should, 1 Could. All MVP-scope items covered.
- 2026-08-10 (v2) — Monetisation extension per VISION v2: F9 accounts (magic link + claim), F10 pricing (£19 Full Grilling behind config flag), F11 marketing pages, F12 deployability. Free-tier rule settled: cap enforced at game time (first 15 approved questions) rather than blocking Ready — never brick the party. Superlatives are the Full-plan sweetener because they're the shareable moment.
