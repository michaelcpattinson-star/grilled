# Deploying Grilled

Grilled is one Node process with a SQLite file — it deploys anywhere that gives
you Node ≥ 20, websockets, and a disk that survives restarts. This guide covers
Render (a `render.yaml` blueprint is included); the same env vars apply to any
host (Fly.io, Railway, a VPS…).

## The short version (Render)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, pick the repo. It reads `render.yaml`.
3. Set the env vars marked `sync: false` (at minimum `BASE_URL`).
4. Deploy. Done — the app serves everything (pages, API, websockets) on one port.

> **Free tier warning:** Render's free instances have **no persistent disk** and
> sleep when idle — your events would vanish on every restart, mid-party.
> Use the **starter** instance (the blueprint's default) for real events; it's
> the cost of one Full Grilling a month.

## Environment variables

| Var | Required? | What it does |
|---|---|---|
| `PORT` | set by host | Port to listen on (Render sets this automatically). |
| `DB_PATH` | yes, in prod | Where the SQLite file lives. Point it at the persistent disk: `/data/grilled.db`. |
| `BASE_URL` | yes, in prod | Public origin, e.g. `https://grilled.onrender.com`. Used in magic-link emails and Stripe redirect URLs. |
| `PAYMENTS_ENABLED` | no (default `false`) | Master switch for Stripe. With it off, the app runs fully free and shows a labelled dev-unlock button instead of checkout. |
| `STRIPE_SECRET_KEY` | if payments on | From Stripe dashboard → Developers → API keys (`sk_live_…` / `sk_test_…`). |
| `STRIPE_WEBHOOK_SECRET` | if payments on | From the webhook endpoint you create (below), `whsec_…`. |
| `FULL_PRICE_PENCE` | no (default `1900`) | Price of the Full Grilling in pence. |
| `FREE_QUESTION_LIMIT` | no (default `15`) | How many approved questions a free event plays. |
| `AI_ENABLED` | no (default `false`) | Master switch for the AI layer (bespoke speeches, tailored quiz lies, the organiser assistant). Off = template engines, £0 to run. |
| `ANTHROPIC_API_KEY` | if AI on | From console.anthropic.com. Costs are tiny (a speech ≈ 5p) and capped per event via `AI_CALL_CAP` (default 40 calls). |
| `AI_MODEL` | no (default `claude-opus-5`) | Which Claude model to use. |
| `MAIL_MODE` | no (default `console`) | `console` logs emails to the server log; `resend` sends real email via Resend. |
| `RESEND_API_KEY` | if `MAIL_MODE=resend` | From resend.com (free tier is plenty to start). |
| `MAIL_FROM` | if sending real mail | e.g. `Grilled <hello@yourdomain.com>` — must be a verified sender/domain in Resend. |

## Setting up Stripe (when you're ready to charge)

1. Create a Stripe account; grab the **secret key** into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint: Stripe dashboard → Developers → Webhooks →
   **Add endpoint** → URL `https://YOUR_DOMAIN/api/stripe/webhook`, event
   `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Set `PAYMENTS_ENABLED=true` and redeploy.
4. Test with Stripe test keys first: card `4242 4242 4242 4242`, any future
   expiry, any CVC. The dashboard should flip to "Full Grilling unlocked" on
   return from checkout (there's also a redirect-landing fallback, so a slow
   webhook never strands a buyer).

No product/price objects need creating in Stripe — the price is passed inline
per checkout session.

## Setting up real email (when you want magic links delivered)

1. Sign up at resend.com, verify your sending domain, create an API key.
2. Set `MAIL_MODE=resend`, `RESEND_API_KEY`, `MAIL_FROM`.

Until then, `MAIL_MODE=console` prints every email (including the magic link)
to the server logs — fine for dev, useless for real users.

## Anywhere else

`npm install && npm start`, plus the env vars above. That's the whole thing:
no build step, no migrations to run (the schema self-migrates on boot), no
external services unless you turn them on.

## Operational notes

- **Backups:** the entire state is one file (`DB_PATH`). Copy it, you have a backup.
- **Retention:** events (and everything attached to them) self-delete 30 days
  after creation, on boot sweeps. This is a product promise — don't "fix" it.
- **Scaling:** one process handles dozens of simultaneous games. If you outgrow
  it, you'll know (and you'll be able to afford Postgres).
