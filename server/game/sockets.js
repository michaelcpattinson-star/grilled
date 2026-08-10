'use strict';
// Socket.IO layer for Grilled live games. Protocol pinned by docs/CONTRACTS.md:
// client → 'host:join' | 'player:join' | 'host:start' | 'host:next' | 'player:answer'
// server → single authoritative 'state' event (per-socket 'you' enrichment),
//          errors to a socket as 'errorMsg' {message}.
const { db } = require('../db');
const { createOrResumeGame } = require('./gameManager');

const games = new Map(); // gameCode → { game, hostSocketId }

function getOrLoadGameByCode(code) {
  let entry = games.get(code);
  if (entry) return entry;
  const event = db
    .prepare(`SELECT * FROM events WHERE gameCode = ? AND status = 'locked'`)
    .get(code);
  if (!event) return null;
  entry = { game: createOrResumeGame(event.id), hostSocketId: null };
  games.set(code, entry);
  return entry;
}

function fail(socket, message) {
  socket.emit('errorMsg', { message });
}

async function broadcast(io, code) {
  const entry = games.get(code);
  if (!entry) return;
  const sockets = await io.in(code).fetchSockets();
  for (const s of sockets) {
    const nickname = s.data && s.data.role === 'player' ? s.data.nickname : null;
    s.emit('state', entry.game.buildStatePayload(nickname));
  }
}

function attachSockets(io) {
  io.on('connection', (socket) => {
    socket.on('host:join', (payload) => {
      const organiserKey = payload && typeof payload.organiserKey === 'string' ? payload.organiserKey.trim() : '';
      const event = organiserKey
        ? db.prepare(`SELECT * FROM events WHERE organiserKey = ?`).get(organiserKey)
        : null;
      if (!event) return fail(socket, 'Unknown organiser key.');
      if (event.status !== 'locked' || !event.gameCode) {
        return fail(socket, "This quiz isn't locked yet — press \"Ready to play\" on your dashboard first.");
      }

      let entry = games.get(event.gameCode);
      if (!entry) {
        try {
          entry = { game: createOrResumeGame(event.id), hostSocketId: null };
        } catch (e) {
          return fail(socket, e.message);
        }
        games.set(event.gameCode, entry);
      }
      entry.hostSocketId = socket.id; // host refresh/reconnect takes over
      socket.data.role = 'host';
      socket.data.code = event.gameCode;
      socket.join(event.gameCode);
      broadcast(io, event.gameCode);
    });

    socket.on('player:join', (payload) => {
      const code = payload && typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : '';
      const nickname = payload && typeof payload.nickname === 'string' ? payload.nickname.trim() : '';
      if (!code) return fail(socket, 'Enter a game code.');
      if (!nickname) return fail(socket, 'Pick a nickname.');
      if (nickname.length > 20) return fail(socket, 'Nickname must be 20 characters or fewer.');

      let entry;
      try {
        entry = getOrLoadGameByCode(code);
      } catch (e) {
        return fail(socket, e.message);
      }
      if (!entry) return fail(socket, "That game code doesn't exist (or the quiz isn't ready yet).");

      let assigned;
      try {
        assigned = entry.game.addPlayer(nickname); // dup → '-2'; rejoin restores score
      } catch (e) {
        return fail(socket, e.message);
      }
      socket.data.role = 'player';
      socket.data.code = code;
      socket.data.nickname = assigned;
      socket.join(code);
      broadcast(io, code);
    });

    socket.on('host:start', () => {
      const entry = socket.data.code ? games.get(socket.data.code) : null;
      if (!entry || entry.hostSocketId !== socket.id) return fail(socket, 'Only the host can start the game.');
      try {
        entry.game.start();
      } catch (e) {
        return fail(socket, e.message);
      }
      broadcast(io, socket.data.code);
    });

    socket.on('host:next', () => {
      const entry = socket.data.code ? games.get(socket.data.code) : null;
      if (!entry || entry.hostSocketId !== socket.id) return fail(socket, 'Only the host can advance the game.');
      try {
        entry.game.next();
      } catch (e) {
        return fail(socket, e.message);
      }
      broadcast(io, socket.data.code);
    });

    socket.on('player:answer', (payload) => {
      if (socket.data.role !== 'player') return fail(socket, 'Join as a player first.');
      const entry = games.get(socket.data.code);
      if (!entry) return fail(socket, 'Game not found.');
      const idx = payload && Number(payload.index);
      if (!Number.isInteger(idx) || idx < 0 || idx > 3) return; // ignore malformed answers silently
      let recorded;
      try {
        recorded = entry.game.answer(socket.data.nickname, idx, Date.now());
      } catch (e) {
        return fail(socket, e.message);
      }
      if (recorded) broadcast(io, socket.data.code); // answer counts update live
    });

    socket.on('disconnect', () => {
      const { role, code, nickname } = socket.data || {};
      if (!code) return;
      const entry = games.get(code);
      if (!entry) return;
      if (role === 'player' && nickname) {
        entry.game.markDisconnected(nickname); // stays on scoreboard; rejoin restores
        broadcast(io, code);
      } else if (role === 'host' && entry.hostSocketId === socket.id) {
        entry.hostSocketId = null; // game lives on; host can rejoin via organiserKey
      }
    });
  });
}

module.exports = { attachSockets };
