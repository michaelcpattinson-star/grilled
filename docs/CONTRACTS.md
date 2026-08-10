# Interface Contracts — pinned before parallel build. Do not deviate; integration depends on these exact shapes.

## Submission prompts (owned by engine, file: server/engine/prompts.js)
```js
// exports: PROMPTS — array of { key, label(guestName), placeholder, kind }
// kinds: 'story' | 'fact' | 'word' | 'never' | 'sentence'
PROMPTS = [
 { key:'story',    kind:'story',    label:n=>`Tell us about a time ${n} embarrassed themselves (or you)…`, placeholder:'The more detail the better…' },
 { key:'fact',     kind:'fact',     label:n=>`A fact about ${n} most people don't know`, placeholder:'They once…' },
 { key:'word',     kind:'word',     label:n=>`One word that describes ${n}`, placeholder:'e.g. chaotic' },
 { key:'never',    kind:'never',    label:n=>`Finish the sentence: "${n} would never…"`, placeholder:'…' },
 { key:'sentence', kind:'sentence', label:n=>`${n}'s catchphrase or most-used sentence`, placeholder:'"…"' },
]
```
Max 500 chars per submission text (API enforces).

## Engine (file: server/engine/questions.js, plus decoys.js)
```js
generateQuiz({ submissions, tone, guestName })
// submissions: [{id, promptKey, text}]  tone: 'gentle'|'medium'|'roast'
// returns { rounds: [ { roundKey, title, questions: [
//   { format, questionText, options,  // exactly 4 strings, shuffled
//     correctIndex, sourceText,       // sourceText: story shown at reveal, may be ''
//     fingerprint }                   // stable across rebuilds for same source+format
// ] } ] }
// formats: 'whoseStory' | 'twoTruths' | 'finishSentence' | 'howWell'
```
Pure module: no db, no io, deterministic given a seeded rng (accept optional `rng` param, default Math.random). Rounds: 'warmup' (howWell/finishSentence), 'stories' (whoseStory), 'liedetector' (twoTruths). Degrade gracefully: skip formats lacking material; aim ≥15 questions from 5+ submissions.

## REST (owned by backend, file: server/routes/api.js) — all JSON; errors {error:'msg'} + 4xx/5xx
- POST /api/events {name, occasion, tone} → {organiserKey, submissionKey}  (400 if name/occasion missing; name ≤ 60 chars)
- GET  /api/events/:organiserKey → {name, occasion, tone, status, submissionCount, questionCounts:{pending,approved,binned}, gameCode, submissionUrl, hostUrl}
- POST /api/events/:organiserKey/build {tone?} → {built:true, questionCount} (regenerates; preserves edits/bins by fingerprint; 409 if status='locked')
- GET  /api/events/:organiserKey/questions → {questions:[{id, roundKey, format, questionText, options, correctIndex, sourceText, status}]}
- PATCH /api/questions/:id {organiserKey, status?|questionText?|options?} → {ok:true}
- POST /api/events/:organiserKey/ready → {gameCode} (400 {error} if approved<10; sets status='locked')
- GET  /api/submit/:submissionKey → {guestName, occasion, open, prompts:[{key,label,placeholder}]} (labels pre-rendered strings)
- POST /api/submit/:submissionKey {entries:[{promptKey,text}]} → {ok:true} (400 if 0 non-empty entries or any text>500; 403 {error:'closed'} if locked)
- POST /api/demo → {organiserKey} (creates pre-seeded demo event for guest 'Gary', already built, ready to moderate/play)
Rate limit: 30 POSTs/min/IP (in-memory bucket) → 429 {error}.

## Game state machine (owned by backend, files: server/game/gameManager.js, sockets.js)
Phases: 'lobby' → ('question' → 'reveal')×N with 'leaderboard' inserted between rounds → 'podium'.
Scoring: correct = 100 + round(50 × timeLeft/timerSeconds). timerSeconds = 20.
Checkpoint JSON to game_checkpoints after every phase change; on process boot, games resume from checkpoint when host reconnects.

## Socket.IO protocol (server → client is ONE event: 'state')
Client → server:
- 'host:join'   {organiserKey}
- 'player:join' {code, nickname}   (nickname ≤ 20 chars; duplicate gets '-2' suffix; rejoin with same nickname+code restores score)
- 'host:start'  {}                 (rejected while <2 players)
- 'host:next'   {}                 (advances phase)
- 'player:answer' {index}          (first answer per question counts)
Server → client 'state' payload (broadcast to room on every change; also sent on join):
```js
{ phase, code, guestName,
  players: [{nickname, score, answeredThisQuestion}],
  round: {roundKey, title, number, total} | null,
  question: {number, totalInRound, questionText, options, timerEndsAt} | null,  // options ALWAYS present in question phase
  reveal: {correctIndex, sourceText, perPlayer:[{nickname, correct, gained}]} | null,
  leaderboard: [{nickname, score, rank}] | null,
  podium: {top:[{nickname,score,rank}], superlatives:[{title, nickname, detail}]} | null,
  you: {nickname, score, lockedAnswer} | null   // per-socket enrichment for players
}
```
Host screen shows questionText + options + timer; phones render options as big buttons (no questionText), lock after answer. Errors to a socket: 'errorMsg' {message}.

## v2 — Accounts & payments (files: server/routes/auth.js, server/routes/billing.js, server/payments/stripe.js, server/mail/mailer.js)
GET /api/events/:organiserKey gains additive fields: `plan` ('free'|'full'), `freeQuestionLimit`, `paymentsEnabled`, `claimed`, `claimedByYou`.
- POST /api/auth/request-link {email} → {ok:true, message} (400 invalid email; always ok for valid — no enumeration; 429 mail-limiter)
- GET  /auth/verify?token= → 302: session cookie + redirect (/account | /o/KEY?claimed=1 | /account?authError=1 | /account?claimError=1)
- POST /api/auth/logout → {ok:true} (clears cookie + deletes session)
- GET  /api/me → {email, events:[{name, occasion, status, plan, organiserUrl, createdAt}]} | 401
- POST /api/events/:organiserKey/claim {email} → {ok:true, message} (409 claimed by different email; sends claim magic link)
- POST /api/events/:organiserKey/checkout → {url} | {paymentsEnabled:false} | 409 already full
- POST /api/events/:organiserKey/confirm-payment {sessionId} → {plan} (redirect-landing fallback; verifies with Stripe)
- POST /api/events/:organiserKey/dev-unlock → {plan:'full'} (404 when PAYMENTS_ENABLED)
- POST /api/stripe/webhook (raw body; Stripe-Signature verified, 5-min tolerance) → {received:true} | 400 bad signature
Session cookie: `grilled_session`, httpOnly, SameSite=Lax, 90 days. Magic tokens single-use, 15-min expiry.
Free plan: game plays first FREE_QUESTION_LIMIT (15) approved questions, superlatives []. Demo events are plan 'full'.
Mailer: sendMail({to,subject,text}); transports 'console' (dev default) | 'resend'; test hook setTransportForTests(fn).

## Frontend (owned by frontend, files: public/*)
Pages: index.html (landing: Create → /new, Join → /play, Try the demo → POST /api/demo then redirect /o/{key}), new.html, dashboard.html, submit.html, host.html, play.html, 404.html, css/grilled.css, js one file per page + js/shared.js.
Path parsing: dashboard/host/submit read their key from location.pathname (/o/KEY, /host/KEY, /s/KEY). Socket.IO client from '/socket.io/socket.io.js'.
Brand: "Grilled" — chargrill orange/black flame theme, playful pub-chalkboard energy, mobile-first for submit/play, TV-first (big type) for host. NEVER use innerHTML with user-supplied content — use textContent.
