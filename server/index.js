'use strict';
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const apiRouter = require('./routes/api');
const auth = require('./routes/auth');
const billing = require('./routes/billing');
const { attachSockets } = require('./game/sockets');

const app = express();
// Stripe webhook needs the raw body for signature verification —
// registered BEFORE the JSON parser.
app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '256kb' }), billing.webhookHandler);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', auth.router);
app.use('/api', billing.router);
app.use('/api', apiRouter);

// Pretty routes → static pages (keys handled client-side from the path)
const page = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', file));
app.get('/pricing', page('pricing.html'));
app.get('/how-it-works', page('how.html'));
app.get('/privacy', page('privacy.html'));
app.get('/terms', page('terms.html'));
app.get('/account', page('account.html'));
app.get('/auth/verify', auth.verifyHandler);
app.get('/new', page('new.html'));
app.get('/o/:organiserKey', page('dashboard.html'));
app.get('/s/:submissionKey', page('submit.html'));
app.get('/host/:organiserKey', page('host.html'));
app.get('/play', page('play.html'));

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html')));

const server = http.createServer(app);
const io = new Server(server);
attachSockets(io);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Grilled listening on :${PORT}`));
}

module.exports = { app, server, io };
