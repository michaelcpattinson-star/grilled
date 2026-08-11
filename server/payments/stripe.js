'use strict';
// Minimal Stripe adapter — raw REST via fetch + webhook HMAC verification via
// node:crypto. Deliberately no stripe npm dependency: we use exactly two
// endpoints (create Checkout Session, retrieve Checkout Session) and the
// documented signature scheme. Tests inject a fake fetch.
const crypto = require('crypto');
const config = require('../config');

let testFetch = null;
function setFetchForTests(fn) {
  testFetch = fn;
}
function doFetch(...args) {
  return (testFetch || fetch)(...args);
}

function formEncode(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function stripeRequest(method, path, params) {
  const res = await doFetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? formEncode(params) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Stripe error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/** Create a one-off GBP Checkout Session for an event. → {id, url} */
function createCheckoutSession({ eventName, organiserKey, tier = 'full', pricePence, productLabel }) {
  return stripeRequest('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': String(pricePence || config.FULL_PRICE_PENCE),
    'line_items[0][price_data][product_data][name]': productLabel || `Full Grilling — quiz about ${eventName}`,
    // Tax classification — required when Stripe Managed Payments is enabled
    // (default on newer accounts); harmless otherwise. Grilled is an
    // electronically supplied service.
    'line_items[0][price_data][product_data][tax_code]': config.STRIPE_TAX_CODE,
    'line_items[0][quantity]': '1',
    'metadata[organiserKey]': organiserKey,
    'metadata[tier]': tier,
    success_url: `${config.BASE_URL}/o/${organiserKey}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.BASE_URL}/o/${organiserKey}`,
  });
}

/** Retrieve a Checkout Session (payment_status, metadata). */
function retrieveCheckoutSession(sessionId) {
  return stripeRequest('GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

/**
 * Verify a Stripe webhook signature (t=…,v1=… header, HMAC-SHA256 of
 * "<t>.<rawBody>"). Returns the parsed event or throws.
 */
function verifyWebhook(rawBody, signatureHeader, toleranceSeconds = 300) {
  if (typeof signatureHeader !== 'string' || !signatureHeader) {
    throw new Error('Missing Stripe-Signature header.');
  }
  const parts = {};
  for (const piece of signatureHeader.split(',')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    if (k === 'v1' && parts.v1) continue; // first v1 wins
    parts[k] = v;
  }
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || !parts.v1) throw new Error('Malformed Stripe-Signature header.');
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    throw new Error('Stripe signature timestamp outside tolerance.');
  }

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const expected = crypto
    .createHmac('sha256', config.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const given = parts.v1;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Stripe signature mismatch.');
  }
  return JSON.parse(body);
}

/** Test helper: produce a valid Stripe-Signature header for a payload. */
function signPayloadForTests(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

module.exports = {
  createCheckoutSession,
  retrieveCheckoutSession,
  verifyWebhook,
  setFetchForTests,
  signPayloadForTests,
};
