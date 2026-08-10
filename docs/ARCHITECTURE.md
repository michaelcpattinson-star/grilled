# Architecture — Grilled

## System Overview
One Node.js process does everything: serves the static frontend, exposes a small REST API for event/submission/moderation flows, and runs a Socket.IO layer for the live game. State persists in a single SQLite file. No build step, no external services, no API keys. Runs locally with `npm start`; deploys unchanged to any free Node host.

## Tech Stack

### Backend
**Choice:** Node.js + Express + Socket.IO
**Rationale:** The live game is the hard part and it's a realtime fan-out problem (one host screen, N phones) — exactly what Socket.IO does well, including its built-in reconnection handling, which our spec leans on (players rejoining on party wifi). One language across the whole stack for a one-person team.
**Considered:** Python/FastAPI + websockets — fine, but Socket.IO's room/reconnect ergonomics save real code. Phoenix/Elixir — best-in-class realtime, unjustifiable learning curve here.
**Reversibility:** Medium.

### Frontend
**Choice:** Vanilla HTML/CSS/JS (no framework, no build step), served statically by Express
**Rationale:** Five screens, none of them complex enough to earn React. No build step means zero toolchain maintenance and instant iteration. Phones load a tiny page fast on bad wifi — a product requirement, not just taste.
**Considered:** React/Vite — better for a big app, but adds a build pipeline for five screens. Svelte — same story.
**Reversibility:** Medium (screens are cleanly separated; any one can be rewritten in a framework later).

### Database
**Choice:** SQLite via better-sqlite3
**Rationale:** Single file, zero config, synchronous API that's actually a *feature* at this scale (no async ceremony, no connection pools). An event's whole life is a few hundred rows. Live game state is held in memory and checkpointed to SQLite so a server restart mid-game recovers.
**Considered:** Postgres — the right call the day we outgrow one box, pure overhead today. JSON files — no queries, corruption risk under concurrent writes.
**Reversibility:** Easy (thin storage layer; schema is boring).

### Question Engine
**Choice:** Pure in-process TypeScript-free JS module — template bank + submission slotting + curated decoy banks
**Rationale:** Deterministic, unit-testable, free, instant. Tone dial = wording variants per template. This is the company's core IP and it's just code.
**Considered:** LLM API — explicitly ruled out by the founder (cost). On-device model — heavy, slow, unnecessary.
**Reversibility:** Easy (engine is a pure function: submissions + tone → questions; an AI version can implement the same interface later).

### Hosting (when you're ready — nothing to do today)
**Choice:** Render free tier (or any free Node host; Fly.io also fits)
**Rationale:** Free, supports websockets and a persistent disk for SQLite. Known trade-off: free instances sleep after idle and cold-start in ~30–60s — acceptable for MVP validation (organisers open the dashboard before guests arrive).
**Considered:** Vercel/Netlify — serverless, hostile to Socket.IO's long-lived connections. A VPS — £, and the constraint is £0.
**Reversibility:** Easy.

### Testing
**Choice:** Node's built-in `node:test` runner + supertest for API + socket.io-client for game-flow integration tests
**Rationale:** Zero extra test framework dependencies; the engine (pure functions) gets dense unit coverage; the game loop gets scripted multi-client integration tests.

## System Architecture

### Component Diagram
```
 Organiser phone/laptop      Friends' phones          Party: TV + phones
 ┌─────────────────┐      ┌─────────────────┐      ┌─────────┐ ┌─────────┐
 │ dashboard.html  │      │ submit.html     │      │host.html│ │play.html│
 └────────┬────────┘      └────────┬────────┘      └────┬────┘ └────┬────┘
          │ REST                   │ REST                │ Socket.IO │
 ┌────────┴───────────────────────┴────────────────────┴───────────┴────┐
 │                        Express + Socket.IO (one process)              │
 │  routes/api.js   │  engine/questions.js  │  game/gameManager.js       │
 │  (events, subs,  │  (pure: subs+tone →   │  (in-memory live games,    │
 │   moderation)    │   rounds/questions)   │   rooms, scoring, resume)  │
 └───────────────────────────┬───────────────────────────────────────────┘
                             │ better-sqlite3
                        ┌────┴────┐
                        │ grilled.db │  (events, submissions, questions,
                        └─────────┘    game checkpoints)
```

### Data Flow (core journey)
1. `POST /api/events` → event row + two random keys (organiserKey 16 chars, submissionKey 10 chars).
2. Friends `POST /api/submit/{submissionKey}` → submission rows (no identity stored).
3. Organiser `POST /api/events/{organiserKey}/build` → engine runs → question rows (status: pending).
4. Moderation `PATCH` per question (approve/edit/bin).
5. "Ready to play" → generates 4-letter game code, locks submissions.
6. Host opens host screen → socket joins room as host; players join room by code; gameManager advances phases (lobby → question → reveal → leaderboard → podium), checkpointing state after every phase change.

### Data Model
- **events** — id, name (guest of honour), occasion, tone, organiserKey, submissionKey, gameCode, status (collecting|locked|played), createdAt
- **submissions** — id, eventId, promptKey, text, createdAt (nothing identifying)
- **questions** — id, eventId, roundKey, format, questionText, options(JSON), correctIndex, sourceSubmissionId, status (pending|approved|binned), edited(JSON overrides)
- **game_checkpoints** — eventId, state(JSON: phase, questionIdx, players[nickname→score], answers), updatedAt

## API Design
- `POST /api/events` · `GET /api/events/:organiserKey` · `POST /api/events/:organiserKey/build` · `POST /api/events/:organiserKey/ready`
- `GET /api/submit/:submissionKey` (prompts + event display info) · `POST /api/submit/:submissionKey`
- `PATCH /api/questions/:id` (auth: organiserKey in body)
- Socket.IO events: `host:join`, `player:join{code,nickname}`, `host:start`, `host:next`, `player:answer{idx}`, server → `state` (single authoritative state event; clients render whatever state says — this makes reconnect trivial: reconnect = resend state)

## AI Integration
None in MVP, by design. The engine interface (`generateQuiz(submissions, tone) → rounds[]`) is the seam where an LLM backend could be swapped in later.

## Infrastructure & Deployment
Local: `npm install && npm start` → http://localhost:3000. Deploy: push to any free Node host with a disk; `PORT` env var respected; SQLite path configurable via `DB_PATH`. No CI/CD in MVP — test suite runs locally/pre-deploy.

## Security Considerations
- Capability URLs (unguessable keys) are the auth model — appropriate for the threat model (party pranks, not banking). Keys generated with crypto.randomBytes.
- Organiser key never appears in any player/submitter-facing response.
- Input length caps everywhere; all rendering escapes HTML (no innerHTML with user content) — submissions are hostile-adjacent by definition (drunk mates).
- Rate limiting on submission and event-creation endpoints (simple in-memory token bucket).
- Auto-delete events 30 days after creation (trust story + free-tier disk hygiene).

## Engineering Standards
### Project Structure
```
grilled/
  server/        index.js, routes/api.js, engine/questions.js, engine/decoys.js,
                 game/gameManager.js, db.js
  public/        index.html, new.html, dashboard.html, submit.html,
                 host.html, play.html, css/grilled.css, js/*.js (one per page)
  test/          engine.test.js, api.test.js, game.test.js
  docs/          VISION.md, SPEC.md, ARCHITECTURE.md, TASKS.md, TEST_REPORT.md
```
### Conventions
camelCase JS; REST errors as `{error: "human message"}` with correct status codes; server logs one line per request (no bodies — submissions are private); no dependency added without a reason written in TASKS.md.
### Environment Setup
Node ≥ 20. `npm install && npm start`. Tests: `npm test`. That's the whole setup.

## Technical Debt & Future Considerations
Accepted MVP shortcuts: in-memory rate limiting (resets on restart), no CI, single-process scaling ceiling (~dozens of concurrent games — fine), free-tier cold starts. First post-validation investments: payments (Stripe), custom domain, CI, and the LLM engine variant behind the same interface.

## v2 Additions — Accounts, Payments, Marketing (2026-08-10)

### Config (server/config.js)
Single env-driven module, all defaults safe for local dev with zero setup:
`PORT`, `DB_PATH`, `BASE_URL` (default `http://localhost:PORT`), `PAYMENTS_ENABLED` (default false), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FULL_PRICE_PENCE` (1900), `FREE_QUESTION_LIMIT` (15), `MAIL_MODE` (`console` default | `resend`), `RESEND_API_KEY`, `MAIL_FROM`.

### Mail (server/mail/mailer.js)
Provider-agnostic adapter: `sendMail({to, subject, text}) → Promise`. `console` mode logs the full message (the magic link is clickable straight from the terminal in dev); `resend` mode is one `fetch` to Resend's REST API. Adding a provider = one new function; nothing else changes. Tests inject a capture adapter via `setTransportForTests`.

### Auth (server/routes/auth.js)
Magic-link only, no passwords, sessions as httpOnly cookies:
- Tables: `users` (id, email unique, createdAt), `magic_tokens` (token, email, eventId nullable — set when the link is a claim link, expiresAt 15 min, usedAt), `sessions` (token, userId, expiresAt 90 days). Tokens/session ids via crypto.randomBytes; magic tokens single-use.
- `POST /api/auth/request-link {email}` → send link (always 200, no account enumeration). `GET /auth/verify?token=` → create user if new, set session cookie, claim event if token carries one, redirect. `POST /api/auth/logout`. `GET /api/me` → `{email, events:[…]}` or 401.
- `POST /api/events/:organiserKey/claim {email}` → sends a claim-flavoured magic link. Organiser capability URL remains the primary auth for event ops — accounts are a recovery/directory layer on top, so nothing existing breaks.

### Payments (server/payments/stripe.js)
Raw Stripe REST via `fetch` + webhook signature check via `crypto` HMAC-SHA256 — deliberately **no stripe npm dependency** (keeps install lean; we use exactly two endpoints). `events` gains `plan` ('free'|'full'), `paidAt`, `stripeSessionId`.
- `POST /api/events/:organiserKey/checkout` → creates a Checkout Session (GBP 1900, one-off), returns `{url}`; 409 if already full; when `PAYMENTS_ENABLED=false` returns `{paymentsEnabled:false}` and the dashboard shows a labelled dev-unlock button hitting `POST …/dev-unlock` (only exists with payments off).
- `POST /api/stripe/webhook` (raw body, signature verified, timestamp tolerance 5 min) on `checkout.session.completed` → `plan='full'`, idempotent. Success redirect also triggers a verify-by-session-id fallback so a slow webhook never strands the buyer.
- Free-plan enforcement at game time: gameManager takes the first `FREE_QUESTION_LIMIT` approved questions and skips superlatives when `plan='free'`. Ready is never blocked — never brick the party.

### Marketing
`pricing.html`, `how.html` (+ landing refresh) — static pages, same no-build frontend, copy tone: cheeky British.

### Deploy
`render.yaml` (web service, persistent disk mounted at `/data`, `DB_PATH=/data/grilled.db`) + `DEPLOY.md`. Free tier note: Render free instances have no persistent disk — DEPLOY.md says so and recommends the $7 starter for real events.

## Architecture Decision Records
- 2026-08-10 — ADR-1: Single Node process, no microservices. ADR-2: Socket.IO with single authoritative `state` event (reconnect = resend state). ADR-3: SQLite + in-memory live state with checkpointing. ADR-4: No-build vanilla frontend. ADR-5: Capability-URL auth, no accounts.
- 2026-08-10 (v2) — ADR-6: Accounts are a *layer over* capability URLs, not a replacement — organiserKey still authorises every event op. ADR-7: Stripe via raw REST + HMAC verify, no SDK dependency. ADR-8: Free-tier cap enforced at game time, not at Ready. ADR-9: Provider-agnostic mail adapter, console transport in dev.
