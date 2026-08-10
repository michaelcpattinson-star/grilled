'use strict';
// Featherweight accounts: email magic links, httpOnly cookie sessions.
// Accounts are a recovery/directory layer OVER capability URLs — the
// organiserKey still authorises every event operation. Players and
// submitters never touch any of this.
const express = require('express');
const { db, randomKey } = require('../db');
const config = require('../config');
const { sendMail } = require('../mail/mailer');

const router = express.Router();

const SESSION_COOKIE = 'grilled_session';
const MAX_EMAIL_CHARS = 254;

// --- rate limit: mail-sending endpoints are an abuse channel — stricter ------
const MAIL_CAP = 10; // burst
const MAIL_PER_MIN = 5; // refill
const buckets = new Map(); // ip → {tokens, last}

function mailRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: MAIL_CAP, last: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(MAIL_CAP, b.tokens + ((now - b.last) * MAIL_PER_MIN) / 60000);
  b.last = now;
  if (b.tokens < 1) {
    return res.status(429).json({ error: 'Too many email requests — give it a minute.' });
  }
  b.tokens -= 1;
  next();
}
// test hook (not a public API)
router.__resetRateLimit = () => buckets.clear();

// --- helpers -----------------------------------------------------------------
function normaliseEmail(raw) {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_CHARS) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const secure = config.BASE_URL.startsWith('https') ? '; Secure' : '';
  const maxAge = config.SESSION_DAYS * 24 * 60 * 60;
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Session cookie → user row, or null. */
function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.userId
         WHERE sessions.token = ? AND sessions.expiresAt > datetime('now')`
      )
      .get(token) || null
  );
}

function createMagicToken(email, eventId) {
  const token = randomKey(24);
  db.prepare(
    `INSERT INTO magic_tokens (token, email, eventId, expiresAt)
     VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))`
  ).run(token, email, eventId || null, config.MAGIC_TOKEN_MINUTES);
  return token;
}

function magicLinkUrl(token) {
  return `${config.BASE_URL}/auth/verify?token=${token}`;
}

// --- POST /api/auth/request-link ----------------------------------------------
// Always 200 with the same body — no account enumeration.
router.post('/auth/request-link', mailRateLimit, (req, res) => {
  const email = normaliseEmail((req.body || {}).email);
  if (!email) return res.status(400).json({ error: 'That email address doesn’t look right.' });

  const token = createMagicToken(email, null);
  sendMail({
    to: email,
    subject: 'Your Grilled sign-in link 🔥',
    text:
      `Tap this to sign in to Grilled — it works once and expires in ${config.MAGIC_TOKEN_MINUTES} minutes:\n\n` +
      `${magicLinkUrl(token)}\n\n` +
      `Didn't ask for this? Ignore it and it self-destructs. No passwords, ever.`,
  }).catch((e) => console.error('mail send failed:', e.message));

  res.json({ ok: true, message: 'Check your inbox — the link is on its way.' });
});

// --- POST /api/events/:organiserKey/claim ---------------------------------------
// Sends a claim-flavoured magic link. Verifying it signs the user in AND
// attaches the event to their account.
router.post('/events/:organiserKey/claim', mailRateLimit, (req, res) => {
  const event = db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(req.params.organiserKey);
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const email = normaliseEmail((req.body || {}).email);
  if (!email) return res.status(400).json({ error: 'That email address doesn’t look right.' });

  if (event.userId) {
    const owner = db.prepare(`SELECT email FROM users WHERE id = ?`).get(event.userId);
    if (!owner || owner.email !== email) {
      return res.status(409).json({ error: 'This quiz is already claimed by a different email.' });
    }
  }

  const token = createMagicToken(email, event.id);
  sendMail({
    to: email,
    subject: `Claim your quiz about ${event.name} 🔥`,
    text:
      `Tap this to attach your Grilled quiz ("${event.name}") to ${email} — ` +
      `then you can always find it again from /account:\n\n` +
      `${magicLinkUrl(token)}\n\n` +
      `The link works once and expires in ${config.MAGIC_TOKEN_MINUTES} minutes.`,
  }).catch((e) => console.error('mail send failed:', e.message));

  res.json({ ok: true, message: 'Check your inbox — claim link sent.' });
});

// --- GET /auth/verify?token=… (page route, registered by index.js) --------------
function verifyHandler(req, res) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const row = token
    ? db
        .prepare(
          `SELECT * FROM magic_tokens WHERE token = ? AND usedAt IS NULL AND expiresAt > datetime('now')`
        )
        .get(token)
    : null;
  if (!row) return res.redirect('/account?authError=1');

  const claim = db.transaction(() => {
    db.prepare(`UPDATE magic_tokens SET usedAt = datetime('now') WHERE token = ?`).run(token);

    let user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(row.email);
    if (!user) {
      const info = db.prepare(`INSERT INTO users (email) VALUES (?)`).run(row.email);
      user = { id: info.lastInsertRowid, email: row.email };
    }

    let redirectTo = '/account';
    if (row.eventId) {
      const event = db.prepare(`SELECT * FROM events WHERE id = ?`).get(row.eventId);
      if (event) {
        if (event.userId && event.userId !== user.id) {
          redirectTo = '/account?claimError=1';
        } else {
          db.prepare(`UPDATE events SET userId = ? WHERE id = ?`).run(user.id, event.id);
          redirectTo = `/o/${event.organiserKey}?claimed=1`;
        }
      }
    }

    const sessionToken = randomKey(24);
    db.prepare(
      `INSERT INTO sessions (token, userId, expiresAt)
       VALUES (?, ?, datetime('now', '+' || ? || ' days'))`
    ).run(sessionToken, user.id, config.SESSION_DAYS);

    return { sessionToken, redirectTo };
  })();

  setSessionCookie(res, claim.sessionToken);
  res.redirect(claim.redirectTo);
}

// --- POST /api/auth/logout ------------------------------------------------------
router.post('/auth/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- GET /api/me ----------------------------------------------------------------
router.get('/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const events = db
    .prepare(
      `SELECT name, occasion, status, plan, organiserKey, createdAt
       FROM events WHERE userId = ? ORDER BY createdAt DESC, id DESC`
    )
    .all(user.id)
    .map((e) => ({
      name: e.name,
      occasion: e.occasion,
      status: e.status,
      plan: e.plan,
      organiserUrl: `/o/${e.organiserKey}`,
      createdAt: e.createdAt,
    }));

  res.json({ email: user.email, events });
});

module.exports = { router, verifyHandler, getSessionUser };
