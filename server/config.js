'use strict';
// Central config — every value has a safe local-dev default, so
// `npm install && npm start` needs zero environment setup.
// Read properties at call time (not destructured at require time) so tests
// can flip flags on the exported object.

const PORT = Number(process.env.PORT) || 3000;

const config = {
  PORT,
  BASE_URL: process.env.BASE_URL || `http://localhost:${PORT}`,

  // Payments — off by default; the whole app runs with them off.
  PAYMENTS_ENABLED: process.env.PAYMENTS_ENABLED === 'true',
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || '',
  FULL_PRICE_PENCE: Number(process.env.FULL_PRICE_PENCE) || 1900,
  SPEECH_PRICE_PENCE: Number(process.env.SPEECH_PRICE_PENCE) || 5000,
  FREE_QUESTION_LIMIT: Number(process.env.FREE_QUESTION_LIMIT) || 15,

  // Mail — 'console' logs the message (magic link clickable from the
  // terminal in dev); 'resend' sends via Resend's REST API.
  MAIL_MODE: process.env.MAIL_MODE || 'console',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  MAIL_FROM: process.env.MAIL_FROM || 'Grilled <hello@grilled.local>',

  // Auth lifetimes
  MAGIC_TOKEN_MINUTES: 15,
  SESSION_DAYS: 90,
};

module.exports = config;
