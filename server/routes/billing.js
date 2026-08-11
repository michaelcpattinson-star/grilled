'use strict';
// Pricing layer: Free (first 15 questions, no superlatives) vs Full Grilling
// (£19 one-off per event). Everything works with PAYMENTS_ENABLED=false —
// the checkout endpoint says so and a clearly-labelled dev unlock appears.
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const stripe = require('../payments/stripe');

const router = express.Router();

function getEventByOrganiserKey(key) {
  if (typeof key !== 'string' || !key) return null;
  return db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(key);
}

// Tiers: 'full' (£19) < 'speech' (£50, includes full). Never downgrade.
const TIERS = {
  full: { rank: 1, price: () => config.FULL_PRICE_PENCE, label: (n) => `Full Grilling — quiz about ${n}` },
  speech: { rank: 2, price: () => config.SPEECH_PRICE_PENCE, label: (n) => `Roast & Toast — quiz + speech about ${n}` },
};
function planRank(plan) {
  return TIERS[plan] ? TIERS[plan].rank : 0;
}

function markPaid(eventId, sessionId, tier) {
  if (!TIERS[tier]) return;
  // Idempotent, upgrade-only: duplicate deliveries and lower tiers are no-ops.
  const event = db.prepare(`SELECT plan FROM events WHERE id = ?`).get(eventId);
  if (!event || planRank(event.plan) >= TIERS[tier].rank) return;
  db.prepare(
    `UPDATE events SET plan = ?, paidAt = COALESCE(paidAt, datetime('now')),
     stripeSessionId = COALESCE(?, stripeSessionId) WHERE id = ?`
  ).run(tier, sessionId || null, eventId);
}

function requestedTier(req) {
  const tier = (req.body || {}).tier;
  return tier === undefined ? 'full' : (TIERS[tier] ? tier : null);
}

// --- POST /api/events/:organiserKey/checkout -----------------------------------
router.post('/events/:organiserKey/checkout', async (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const tier = requestedTier(req);
  if (!tier) return res.status(400).json({ error: 'Unknown tier.' });
  if (planRank(event.plan) >= TIERS[tier].rank) {
    return res.status(409).json({ error: 'This quiz already has that (or better). Enjoy.' });
  }
  if (!config.PAYMENTS_ENABLED) {
    return res.json({ paymentsEnabled: false });
  }
  try {
    const session = await stripe.createCheckoutSession({
      eventName: event.name,
      organiserKey: event.organiserKey,
      tier,
      pricePence: TIERS[tier].price(),
      productLabel: TIERS[tier].label(event.name),
    });
    db.prepare(`UPDATE events SET stripeSessionId = ? WHERE id = ?`).run(session.id, event.id);
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe checkout failed:', e.message);
    res.status(502).json({ error: 'Could not reach the till — try again in a moment.' });
  }
});

// --- POST /api/events/:organiserKey/confirm-payment ------------------------------
// Redirect-landing fallback so a slow webhook never strands the buyer:
// the dashboard posts the session_id from the success URL and we verify
// directly with Stripe.
router.post('/events/:organiserKey/confirm-payment', async (req, res) => {
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  if (event.plan === 'speech') return res.json({ plan: 'speech' }); // already top tier
  if (!config.PAYMENTS_ENABLED) return res.json({ plan: event.plan });

  const sessionId = typeof (req.body || {}).sessionId === 'string' ? req.body.sessionId : '';
  if (!sessionId || sessionId !== event.stripeSessionId) {
    return res.status(400).json({ error: 'Unknown checkout session.' });
  }
  try {
    const session = await stripe.retrieveCheckoutSession(sessionId);
    if (
      session &&
      session.payment_status === 'paid' &&
      session.metadata &&
      session.metadata.organiserKey === event.organiserKey
    ) {
      const tier = TIERS[session.metadata.tier] ? session.metadata.tier : 'full';
      markPaid(event.id, sessionId, tier);
      return res.json({ plan: db.prepare(`SELECT plan FROM events WHERE id = ?`).get(event.id).plan });
    }
    res.json({ plan: event.plan });
  } catch (e) {
    console.error('stripe confirm failed:', e.message);
    res.status(502).json({ error: 'Could not confirm the payment — try refreshing in a moment.' });
  }
});

// --- POST /api/events/:organiserKey/dev-unlock -----------------------------------
// Only exists with payments off — a labelled stand-in for checkout in local dev.
router.post('/events/:organiserKey/dev-unlock', (req, res) => {
  if (config.PAYMENTS_ENABLED) return res.status(404).json({ error: 'Not found.' });
  const event = getEventByOrganiserKey(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const tier = requestedTier(req);
  if (!tier) return res.status(400).json({ error: 'Unknown tier.' });
  markPaid(event.id, null, tier);
  res.json({ plan: db.prepare(`SELECT plan FROM events WHERE id = ?`).get(event.id).plan });
});

// --- webhook handler (registered by index.js with a raw body parser) -------------
function webhookHandler(req, res) {
  if (!config.PAYMENTS_ENABLED) return res.status(404).json({ error: 'Not found.' });
  let stripeEvent;
  try {
    stripeEvent = stripe.verifyWebhook(req.body, req.headers['stripe-signature']);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  if (stripeEvent && stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data && stripeEvent.data.object;
    const organiserKey = session && session.metadata && session.metadata.organiserKey;
    const event = organiserKey ? getEventByOrganiserKey(organiserKey) : null;
    if (event && session.payment_status === 'paid') {
      const tier = session.metadata && TIERS[session.metadata.tier] ? session.metadata.tier : 'full';
      markPaid(event.id, session.id, tier); // duplicate deliveries are no-ops
    }
  }
  res.json({ received: true });
}

module.exports = { router, webhookHandler };
