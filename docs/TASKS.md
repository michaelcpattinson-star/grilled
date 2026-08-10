# Project Tasks — Grilled

## Status Summary
- **Total tasks:** 28
- **Completed:** 18
- **In progress:** 0
- **Blocked:** 0
- **Remaining effort:** ~2 engineer-days equivalent
- **Last updated:** 2026-08-10

## Phase 0: Foundation
- [x] T1. Scaffold project: package.json (express, socket.io, better-sqlite3, supertest, socket.io-client as dev), server/index.js serving public/, db.js with schema migration `[effort: S]` `[feature: setup]`
- [x] T2. db.js: events/submissions/questions/game_checkpoints tables + key generation (crypto.randomBytes) + 30-day cleanup sweep on boot `[effort: S]` `[feature: setup]`
  - Depends on: T1

## Phase 1: Core MVP
- [x] T3. REST: POST /api/events, GET /api/events/:organiserKey (counts + status) `[effort: S]` `[feature: F1]`
  - Depends on: T2
- [x] T4. REST: GET+POST /api/submit/:submissionKey with prompts, ≥1-field validation, length caps, lock behaviour `[effort: S]` `[feature: F2]`
  - Depends on: T2
- [x] T5. Engine: prompt bank + decoy banks (decoys.js) — curated wrong-answer pools per prompt type, tone-variant framing text `[effort: M]` `[feature: F3]`
- [x] T6. Engine: generateQuiz(submissions, tone, organiserFacts) → rounds with 4 formats (WhoseStory, TwoTruths, FinishSentence, HowWell); dedupe, per-source caps, graceful degradation <5 submissions `[effort: L→split: formats 2+2]` `[feature: F3]`
  - Depends on: T5
- [x] T7. REST: build endpoint (runs engine, persists pending questions, preserves prior edits/bins), PATCH /api/questions/:id (approve/edit/bin, organiserKey auth), ready endpoint (≥10 approved gate, game code, lock) `[effort: M]` `[feature: F3,F4]`
  - Depends on: T6
- [x] T8. gameManager: in-memory game state machine (lobby→question→reveal→leaderboard→podium), scoring (100 + speed bonus ≤50), checkpoint to SQLite each phase change, resume on boot `[effort: L→split: state machine / scoring+resume]` `[feature: F5]`
  - Depends on: T7
- [x] T9. Socket.IO layer: host:join, player:join (code+nickname, duplicate suffix, rejoin restores score, mid-game join), host:start (≥2 players), host:next, player:answer; single authoritative `state` broadcast `[effort: M]` `[feature: F5]`
  - Depends on: T8
- [x] T10. Frontend: index.html (landing: create/join), new.html (event form) `[effort: S]` `[feature: F6,F1]`
- [x] T11. Frontend: dashboard.html (links+copy+share message, submission count, build, moderation list with approve/edit/bin, tone dial, ready) `[effort: M]` `[feature: F1,F4]`
  - Depends on: T7
- [x] T12. Frontend: submit.html (mobile-first prompted form, anonymity messaging, closed state) `[effort: S]` `[feature: F2]`
  - Depends on: T4
- [x] T13. Frontend: host.html (lobby, question+timer, reveal incl. source story, leaderboard, podium+superlatives+CTA) `[effort: M]` `[feature: F5,F8]`
  - Depends on: T9
- [x] T14. Frontend: play.html (code+nickname join, options-only answering, lock-in state, reconnect) `[effort: M]` `[feature: F5]`
  - Depends on: T9

## Phase 2: Polish
- [x] T15. Demo event: seeded fictional guest of honour ("Gary"), one-click create-and-play from landing `[effort: S]` `[feature: F7]`
  - Depends on: T13, T14
- [x] T16. Rate limiting (token bucket on POST endpoints), XSS audit (no innerHTML with user content), error pages `[effort: S]` `[feature: security]`
  - Depends on: T14

## Phase 3: Launch
- [x] T17. Test suite: engine unit tests (formats, tone, degradation, dedupe), API tests (supertest), game-flow integration test (socket.io-client: 3 players full game incl. disconnect/rejoin) `[effort: M]` `[feature: QA]`
  - Depends on: T16
- [x] T18. README with run/deploy instructions (Render walkthrough), .gitignore, final doc pass `[effort: S]` `[feature: launch]`
  - Depends on: T17

## Phase 4: Accounts + Payments + Marketing (v2)
- [ ] T19. config.js (env-driven, safe local defaults) + db migration: users/magic_tokens/sessions tables, events.plan/paidAt/stripeSessionId/userId columns `[effort: S]` `[feature: F9,F10]`
- [ ] T20. mail/mailer.js: provider-agnostic adapter (console default, resend via fetch), test-injectable transport `[effort: S]` `[feature: F9]`
  - Depends on: T19
- [ ] T21. routes/auth.js: request-link, /auth/verify (session cookie + optional event claim), logout, /api/me, claim endpoint; wire into index.js `[effort: M]` `[feature: F9]`
  - Depends on: T20
- [ ] T22. payments/stripe.js: checkout-session create via fetch, webhook HMAC verify, verify-by-session fallback; routes: checkout, webhook (raw body), dev-unlock (payments-off only) `[effort: M]` `[feature: F10]`
  - Depends on: T19
- [ ] T23. Free-plan game-time enforcement: gameManager uses first 15 approved questions + no superlatives when plan='free' `[effort: S]` `[feature: F10]`
  - Depends on: T22
- [ ] T24. Frontend: account.html (sign-in + your events), dashboard claim card + plan/upgrade card + free-cap notice, auth-aware header `[effort: M]` `[feature: F9,F10]`
  - Depends on: T21, T22
- [ ] T25. Marketing: pricing.html, how.html, landing refresh (demo CTA, 30-day trust line, nav) `[effort: S]` `[feature: F11]`

## Phase 5: Launch v2
- [ ] T26. render.yaml + DEPLOY.md + README refresh `[effort: S]` `[feature: F12]`
- [ ] T27. Tests: auth flow (magic link via capture transport, claim, expiry, no-enumeration), payments (flag off/on, webhook signature good/bad/replay, idempotency, free-cap game enforcement) `[effort: M]` `[feature: QA]`
  - Depends on: T24
- [ ] T28. Full test-and-fix pass: whole suite + boot + E2E walkthrough (create → submit incl. XSS payload → build → moderate → ready → host + 2 players → podium) + TEST_REPORT v2 `[effort: M]` `[feature: QA]`
  - Depends on: T26, T27

## Blocked / Needs Decision
(none — hosting decision deferred by design; app is host-agnostic)

## Completed
(none yet)

## PM Log
- 2026-08-10 — Initial breakdown from SPEC v1 + ARCHITECTURE v1. Two L tasks (T6, T8) pre-split internally. Critical path: T1→T2→T5/T6→T7→T8→T9→T13/T14→T17. Frontend pages T10/T12 parallelisable early.
