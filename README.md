# Grilled 🔥

Live party quizzes about the guest of honour, built from stories their mates secretly submit. Hen dos, stag dos, big birthdays, leaving dos. No AI APIs, no player accounts, free to run.

How it works: create an event → share the secret submission link in the group chat → friends anonymously spill the dirt → the template engine turns it into a pub-quiz (Whose Story Is This?, Two Truths and a Lie, Finish the Sentence, How Well Do You Know Them?) → you approve/edit/bin every question → on the night, the host screen goes on the TV and everyone plays from their phones with a 4-letter code.

## Run it

Requires Node 20+. No env setup needed — payments are off and emails log to the console by default.

```
npm install
npm start          # → http://localhost:3000
npm test           # engine, API, auth, payments, game (incl. multi-client socket game)
```

Try it instantly: open the site and hit **Try the demo** — a pre-seeded event for a fictional guest ("Gary") that's ready to moderate and play. To feel the real thing, open the host link on a laptop and join from a couple of phones on the same network using the game code.

## The product layers

- **Organisers** get a dashboard at a secret capability URL — that link is the auth. Optionally they **claim the event by email** (magic link, no passwords) and can find all their events at `/account`.
- **Submitters and players** never sign in. Ever.
- **Pricing:** every event starts free (plays the first 15 approved questions, no superlatives). The **Full Grilling** — £19 one-off per event via Stripe Checkout — unlocks unlimited questions and the superlatives finale. The whole app runs with payments off (`PAYMENTS_ENABLED=false`, the default); a labelled dev-unlock button stands in for checkout locally.
- **AI (optional):** with `AI_ENABLED=true` + an Anthropic API key, the Roast & Toast speech is written bespoke by Claude (template engine remains the fallback), quiz lies get tailored to the guest, and paid organisers get a dashboard assistant ("bin anything about the ex"). With AI off — the default — everything runs on the pure template engines at £0.
- **Trust:** submissions are anonymous by design (identity is never captured), and every event self-destructs 30 days after creation.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** — a `render.yaml` blueprint is included (one web service, persistent disk for SQLite, websockets). All the env vars (Stripe keys, mail provider, `BASE_URL`) are documented there. Local dev needs none of them.

## The company docs

The `docs/` folder is the paper trail of the multi-agent build: `VISION.md` (CEO), `SPEC.md` (CPO), `ARCHITECTURE.md` (Head of Eng), `CONTRACTS.md` (interface contracts the parallel engineers built against), `TASKS.md` (PM), `TEST_REPORT.md` (QA — verdict, issue tracker, all findings fixed).

## Notes

- The organiser link is a capability URL — treat it like a key. Claiming by email is the recovery story.
- Magic-link email goes through a provider-agnostic adapter: `console` (default) logs the link to the terminal; `resend` sends real mail. Adding a provider is one function in `server/mail/mailer.js`.
- Stripe is integrated via raw REST + webhook HMAC verification (`server/payments/stripe.js`) — no SDK dependency.
- Everything renders user content via `textContent` — never `innerHTML`. Keep it that way; submissions are written by drunk mates and should be treated as hostile input with a sense of humour.
