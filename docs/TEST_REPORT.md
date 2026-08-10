# Grilled — QA Test Report

## Summary
- **Date:** 2026-08-10
- **QA lead:** Adversarial QA (6-layer pipeline)
- **Scope:** Full product — question engine, REST API, live game (Socket.IO), frontend (all pages), security, performance, accessibility. Tested against `docs/SPEC.md` acceptance criteria and `docs/CONTRACTS.md` interface shapes.
- **Build under test:** `server/**`, `public/**` as of 2026-08-10.
- **Verdict:** **PASS WITH ISSUES**
- **Severity counts:** Critical **0**, High **0**, Medium **1**, Low **3**
- **Headline:** No data-loss, security, or core-flow defects. Every REST endpoint and the Socket.IO `state` payload match `CONTRACTS.md` exactly — **no contract mismatches found**. XSS is neutralised everywhere (all rendering via `textContent`), SQL injection is structurally impossible (parameterised statements throughout), auth is sound, and a full 4-player game runs to podium including host reload, player rejoin, duplicate nicknames and mid-game join. Remaining issues are cosmetic/polish.

---

## Test Results by Layer

### Layer 1 — Unit / edge cases
- **Existing suite:** 36/36 pass. **New file `test/qa.test.js`:** 11 new tests, all pass. **Combined: 47/47 pass** via `DB_PATH=/tmp/qa.db node --test 'test/*.test.js'`.
- New edge-case coverage added (engine + gameManager gaps):
  - 500-char submission accepted / 501 rejected (boundary).
  - Emoji + unicode + apostrophe guest names survive creation and prompt rendering.
  - HTML / `<script>` / `<img onerror>` submissions survive into options as **intact text** (not stripped, not mangled) — engine preserves markup; rendering escapes it.
  - Invalid tone falls back to `medium` in engine; API rejects invalid tone (400).
  - All three tones yield distinct framing but identical fingerprints (tone changes wording only).
  - Rebuild preserves an organiser edit + re-approval by fingerprint (API round-trip).
  - Timer boundary: answer exactly at `timerEndsAt` counts (clamps to 100); +1ms is rejected.
  - 8-player game plays through to podium; 8 players on scoreboard, ≥3 superlatives.
  - Checkpoint resume mid-round restores phase/index/scores/stats; players resume disconnected.
  - Mid-question joiner blocked from current question, can answer the next.
  - Leaderboard ties share a rank.
- **Findings:** none (behaviour matches spec).

### Layer 2 — Integration (live server, REST)
Booted `DB_PATH=/tmp/qa-live.db PORT=3499 node server/index.js` and drove every endpoint.
- **Contract-shape verification (every endpoint) — ALL MATCH:**
  - `POST /api/events` → `{organiserKey, submissionKey}` ✓
  - `GET /api/events/:key` → exact keys `{name, occasion, tone, status, submissionCount, questionCounts:{pending,approved,binned}, gameCode, submissionUrl, hostUrl}` ✓
  - `POST /api/events/:key/build` → `{built, questionCount}`; 409 when locked ✓
  - `GET /api/events/:key/questions` → `{questions:[{id, roundKey, format, questionText, options, correctIndex, sourceText, status}]}` ✓
  - `PATCH /api/questions/:id` → `{ok:true}` ✓
  - `POST /api/events/:key/ready` → `{gameCode}`, idempotent, 400 when <10 approved ✓
  - `GET /api/submit/:key` → `{guestName, occasion, open, prompts:[{key,label,placeholder}]}` ✓
  - `POST /api/submit/:key` → `{ok:true}`; 403 `{error:'closed'}` when locked ✓
  - `POST /api/demo` → `{organiserKey}` (only key; built + fully approved + unlocked) ✓
- **Rate limit:** 30 POST/min/IP token bucket enforced (429 after budget), GET/PATCH not limited ✓.
- **Auth / bypass attempts (all correctly rejected 403):** wrong-event `organiserKey`, `submissionKey` used as organiser key, and missing key on `PATCH /api/questions/:id`. Non-integer question id → 400. Unknown keys → 404.
- **Findings:** none.

### Layer 3 — E2E (Playwright, headless chromium)
Scripted the real browser journeys against the live server (`/tmp/e2e.js`). Screenshots in `qa-screens/`.
- Create event → submit story from a **second browser context** (submit form) → build via dashboard → moderate (**edited** one question, **binned** one) → approve → **Ready to play** ✓
- Host page + **3 phone contexts** joined by code; lobby filled in realtime (chips on host) ✓
- **Duplicate nickname** → auto-suffixed `Alice-2` ✓
- Phones show **options only** — no question text leaked (verified DOM) ✓
- **Host reload mid-question** → game resumes to the question phase ✓
- **Player closes page mid-round and rejoins same nickname** → score restored ✓ (score value preserved across rejoin; non-zero restore also covered by unit test)
- Full game played **to podium** with leaderboard between rounds; superlatives rendered ✓
- **Submit-form closed state** shown after lock; **demo flow** from landing redirects to `/o/{key}` ✓
- Screenshots captured & visually reviewed: `lobby`, `question-host`, `question-phone`, `reveal`, `podium`, `dashboard`, `submit-form` (+ `leaderboard`, `landing`, `submit-closed`). Layout, contrast and content all sound; big TV type on host, big touch targets on phone. See Layer 6 for the one contrast nit and the title-overflow nit (Issues #2/#4).
- **Findings:** one cosmetic (long-name title overflow, Issue #2).

### Layer 4 — Security
- **XSS:** Submitted `<script>alert(1)</script>`, `<img src=x onerror=…>` in stories, guest name and nickname. Verified via Playwright (dialog listeners + `window.__xss*` sentinels) that **nothing executed** on dashboard moderation, host reveal `sourceText`, lobby, leaderboard nicknames, or podium. All content rendered as literal text (frontend builds DOM exclusively via `el()`→`textContent`; `NEVER innerHTML` rule upheld). ✓
- **SQL injection:** Payloads on key params and submission text — parameterised prepared statements (`?` placeholders) everywhere; keys returned clean 404, injected submission stored literally, `events` table intact. ✓
- **Authorization:** `submissionKey` cannot unlock organiser endpoints (403). `organiserKey` never present in any submit/player-facing REST response or socket payload to players (host/player `state` payloads contain no organiser key). ✓
- **`npm audit`:** 0 vulnerabilities. **Secrets scan:** none (only a decoy string containing the word "secret"). ✓
- **Socket abuse:** player emitting `host:start`/`host:next` rejected ("only the host"); 10kb nickname rejected; garbage payloads (`{index:'💣'}`, `null`, `{}`, arrays, strings, out-of-range index) handled without crashing; answering twice keeps the first answer. **Process stayed up (HTTP 200) after the full abuse barrage.** ✓
- **Findings:** none critical; one Low robustness note (Issue #3, null `player:answer` payload).

### Layer 5 — Performance
- `POST /build` with **100 submissions: 5.5 ms** (dedupe collapses near-identical submissions as designed → 8 questions from the pathological duplicate set).
- `GET /api/events` (the 10s dashboard poll) x200 on one process: **p50 0.97 ms, p95 1.73 ms, p99 3.78 ms, max 5.75 ms**. `GET …/questions` x100: p95 3.39 ms.
- **No N+1** in the polling endpoint: `GET /api/events/:key` runs exactly 3 queries (event lookup, `COUNT` submissions, `GROUP BY status` on questions) — counts are aggregated in-DB, no per-row loops.
- **Page weight:** HTML 1.2–6.2 KB/page, CSS 24 KB, per-page JS 6–14 KB (app code ~45 KB for the play page). Heaviest asset is the standard `socket.io.js` client (156 KB, cached). All well within the "tiny page on bad wifi" requirement.
- **Findings:** none.

### Layer 6 — Accessibility
- **Contrast (computed on actual hex tokens, WCAG 2.1):** main text chalk/bg 16.7:1, muted/bg 8.8:1, flame/bg 6.6:1, ember/bg 10.6:1, button ink-on-flame 6.4:1, good/bg 11.9:1, bad/bg 6.8:1 — all pass AA. Only marginal pair: **`--faint` #8f7f71 on `--card` #201a16 = 4.46:1**, a hair under the 4.5 AA threshold for small text (Issue #1). The orange-on-black theme otherwise passes AA comfortably.
- **Semantics / keyboard:** real `<button>` answer buttons with `:focus-visible` outline; `<label for>` on every input; `<main>`, `<h1>` heading order; `aria-live` on the play stage and connection bar; `role="alert"` on the connection banner. Host "next" control is a button plus a Space/Enter global handler that correctly ignores form fields. ✓
- **Touch targets:** `.answer-btn min-height: 4.2rem` (~67px), full-width — comfortably above the 44px guideline. ✓
- **Findings:** Issue #1 (marginal contrast), Issue #2 (long-name title overflow — spec F1 asks for "clamped display").

---

## Issue Tracker

| # | Severity | Layer | Description | File | Status |
|---|----------|-------|-------------|------|--------|
| 1 | Medium | 6 Accessibility | `--faint` (#8f7f71) on `--card` (#201a16) = 4.46:1 — just under WCAG AA 4.5 for small text (char counters, hints). Nudge the token ~one step lighter. | public/css/grilled.css:19 | Fixed 2026-08-10 (→ #9a8a7c, 5.16:1) |
| 2 | Low | 3/6 E2E/UI | Long / unbroken guest names overflow page titles horizontally instead of wrapping or clamping. `.display` has no `overflow-wrap`/`word-break`; SPEC F1 edge case asks for "clamped display". Normal names with spaces wrap fine; affects very long or no-space names. | public/css/grilled.css:54 (`.display`; used by `#dash-title`, `#intro-title`) | Fixed 2026-08-10 (overflow-wrap: anywhere) |
| 3 | Low | 4 Security | `player:answer` with a `null` payload coerces to `Number(null) === 0` and records answer "A" instead of being ignored as garbage. Not a crash and only affects the sender; other malformed payloads (`{}`, arrays) are correctly rejected. | server/game/sockets.js:121 | Fixed 2026-08-10 (integer 0–3 guard) |
| 4 | Low | 2 Integration | Rate limit is per-IP for POST: friends behind one NAT (shared home/office wifi) submitting in a burst could 429 each other. Documented MVP trade-off in ARCHITECTURE; consider a gentler cap or per-key bucket for `/api/submit`. | server/routes/api.js:33 | Fixed 2026-08-10 (burst cap 60, refill 30/min) |

---

## Recommendations (prioritised)
1. **(Medium, Issue #1)** Lighten `--faint` slightly (e.g. toward `#9a8a7b`+) so all small text clears 4.5:1 on cards. One-line token change, no layout impact.
2. **(Low, Issue #2)** Add `overflow-wrap: anywhere` (and/or a hard `max-width`) to `.display` used by `#dash-title`/`#intro-title` so pathological long names clamp rather than run off-screen — closes the SPEC F1 "clamped display" gap.
3. **(Low, Issue #3)** In `sockets.js`, guard `player:answer` so a missing/non-object payload is rejected rather than defaulting to index 0 (e.g. require `payload && Number.isInteger(payload.index)` before calling `answer`).
4. **(Low, Issue #4)** Consider a dedicated, more forgiving bucket for `/api/submit` (or per-submissionKey limiting) so shared-NAT guests aren't throttled by each other during a submission burst.
5. **Post-launch:** none blocking. Ship candidate — the core loops (create → submit → build → moderate → play → podium), contracts, security posture and performance are all solid.

---

## QA Log
- 2026-08-10 — Read SPEC/ARCHITECTURE/VISION/CONTRACTS; reviewed all server + public source.
- 2026-08-10 — Confirmed baseline 36/36 existing tests pass.
- 2026-08-10 — Layer 1: probed engine with adversarial inputs (XSS/HTML survival, unicode); wrote `test/qa.test.js` (11 tests). Full suite 47/47 pass.
- 2026-08-10 — Layer 2: booted live server on :3499; verified every REST contract shape, rate limit, auth bypass attempts, wrong/expired keys.
- 2026-08-10 — Layer 3: installed Playwright (chromium at `/opt/pw-browsers/chromium`); scripted full organiser + 3-phone journey to podium incl. host reload, rejoin, duplicate nickname, closed-state, demo flow; captured & reviewed screenshots in `qa-screens/`.
- 2026-08-10 — Layer 4: XSS (verified non-execution + text rendering across all surfaces), SQLi probes, authorization checks, `npm audit` (0), secrets scan, socket abuse barrage (server survived).
- 2026-08-10 — Layer 5: timed build@100 subs (5.5ms), API p95 over 200 reqs (1.73ms), confirmed no N+1, measured page weights.
- 2026-08-10 — Layer 6: computed contrast ratios for the actual theme hex values, reviewed semantics/keyboard/touch targets.
- 2026-08-10 — Killed the live server; cleaned temp DBs. Report written.
