'use strict';
// Provider-agnostic mail adapter. A transport is any async function
// ({to, subject, text}) => Promise. Adding a provider = one new function here;
// nothing else in the app changes. Dev default logs to the console so the
// magic link is clickable straight from the terminal.
const config = require('../config');

async function consoleTransport({ to, subject, text }) {
  console.log(
    '\n──────────────────── ✉️  MAIL (console transport) ────────────────────\n' +
      `To:      ${to}\n` +
      `Subject: ${subject}\n\n` +
      `${text}\n` +
      '──────────────────────────────────────────────────────────────────────\n'
  );
}

async function resendTransport({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: config.MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend rejected the email (${res.status}): ${body.slice(0, 200)}`);
  }
}

let testTransport = null;

function pickTransport() {
  if (testTransport) return testTransport;
  if (config.MAIL_MODE === 'resend') return resendTransport;
  return consoleTransport;
}

function sendMail(message) {
  return pickTransport()(message);
}

// test hook (not a public API)
function setTransportForTests(fn) {
  testTransport = fn;
}

module.exports = { sendMail, setTransportForTests };
