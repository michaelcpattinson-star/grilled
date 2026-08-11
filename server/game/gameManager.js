'use strict';
// Live game state machine for Grilled. Pure-ish: uses the db for loading
// questions and checkpointing, but knows nothing about socket.io.
// Phases: 'lobby' → ('question' → 'reveal')×N with 'leaderboard' between rounds → 'podium'.
const { db } = require('../db');
const config = require('../config');

const TIMER_SECONDS = 20;

const ROUND_TITLES = {
  warmup: 'Warm-Up: How Well Do You Know Them?',
  stories: 'Whose Story Is This?',
  liedetector: 'Two Truths and a Lie',
};

function roundTitle(roundKey) {
  return ROUND_TITLES[roundKey] || roundKey.charAt(0).toUpperCase() + roundKey.slice(1);
}

class Game {
  constructor(eventId) {
    const event = db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId);
    if (!event) throw new Error('Event not found.');
    this.eventId = eventId;
    this.guestName = event.name;
    this.code = event.gameCode;
    this.plan = event.plan || 'free';
    this.timerSeconds = TIMER_SECONDS;

    // Approved questions, grouped into rounds by first appearance in sortOrder.
    // Free plan plays the first FREE_QUESTION_LIMIT approved questions —
    // enforced here at game time, never by blocking "Ready to play".
    let rows = db
      .prepare(`SELECT id, roundKey, questionText, options, correctIndex, sourceText
                FROM questions WHERE eventId = ? AND status = 'approved' ORDER BY sortOrder, id`)
      .all(eventId);
    this.isPaid = this.plan === 'full' || this.plan === 'speech';
    if (!this.isPaid) rows = rows.slice(0, config.FREE_QUESTION_LIMIT);
    this.rounds = [];
    const byKey = new Map();
    for (const r of rows) {
      let round = byKey.get(r.roundKey);
      if (!round) {
        round = { roundKey: r.roundKey, title: roundTitle(r.roundKey), questions: [] };
        byKey.set(r.roundKey, round);
        this.rounds.push(round);
      }
      round.questions.push({
        id: r.id,
        questionText: r.questionText,
        options: JSON.parse(r.options),
        correctIndex: r.correctIndex,
        sourceText: r.sourceText || '',
      });
    }

    this.phase = 'lobby';
    this.roundIdx = -1;
    this.questionIdx = -1;
    this.qOrdinal = 0; // global question counter, used to block mid-question joiners
    this.timerEndsAt = null;
    this.lastReveal = null;
    this.players = new Map(); // nickname → player record
  }

  // ---- players --------------------------------------------------------------
  // Returns the assigned nickname. Rejoin (same nickname, currently disconnected)
  // restores the existing record; a live duplicate gets '-2', '-3', …
  addPlayer(rawNickname) {
    let base = String(rawNickname == null ? '' : rawNickname).trim().slice(0, 20);
    if (!base) throw new Error('Nickname required.');

    const existing = this.players.get(base);
    if (existing && !existing.connected) {
      existing.connected = true; // rejoin — score and stats intact
      return base;
    }

    let nickname = base;
    if (existing) {
      for (let n = 2; ; n++) {
        const suffix = `-${n}`;
        const candidate = base.slice(0, 20 - suffix.length) + suffix;
        const clash = this.players.get(candidate);
        if (!clash) { nickname = candidate; break; }
        if (!clash.connected) { clash.connected = true; return candidate; }
      }
    }

    this.players.set(nickname, {
      nickname,
      score: 0,
      connected: true,
      currentAnswer: null,
      blockedForOrdinal: this.phase === 'question' ? this.qOrdinal : 0, // mid-question join → wait for next question
      stats: { answered: 0, correct: 0, speedBonus: 0 },
    });
    return nickname;
  }

  markDisconnected(nickname) {
    const p = this.players.get(nickname);
    if (p) p.connected = false; // stays on the scoreboard
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ---- phase machine --------------------------------------------------------
  start() {
    if (this.phase !== 'lobby') throw new Error('Game already started.');
    if (this.connectedCount() < 2) throw new Error('Need at least 2 players to start.');
    if (!this.rounds.length) throw new Error('No approved questions to play.');
    this.next();
  }

  next() {
    switch (this.phase) {
      case 'lobby':
        if (!this.rounds.length) throw new Error('No approved questions to play.');
        this._enterQuestion(0, 0);
        break;
      case 'question':
        this._enterReveal();
        break;
      case 'reveal': {
        const round = this.rounds[this.roundIdx];
        if (this.questionIdx + 1 < round.questions.length) {
          this._enterQuestion(this.roundIdx, this.questionIdx + 1);
        } else if (this.roundIdx + 1 < this.rounds.length) {
          this.phase = 'leaderboard';
        } else {
          this.phase = 'podium';
        }
        break;
      }
      case 'leaderboard':
        this._enterQuestion(this.roundIdx + 1, 0);
        break;
      case 'podium':
        break; // terminal — stay put
      default:
        throw new Error(`Unknown phase: ${this.phase}`);
    }
    this.checkpoint();
  }

  _enterQuestion(roundIdx, questionIdx) {
    this.phase = 'question';
    this.roundIdx = roundIdx;
    this.questionIdx = questionIdx;
    this.qOrdinal += 1;
    this.timerEndsAt = Date.now() + this.timerSeconds * 1000;
    this.lastReveal = null;
    for (const p of this.players.values()) p.currentAnswer = null;
  }

  _enterReveal() {
    const q = this.currentQuestion();
    const perPlayer = [];
    for (const p of this.players.values()) {
      let correct = false;
      let gained = 0;
      if (p.currentAnswer) {
        p.stats.answered += 1;
        if (p.currentAnswer.index === q.correctIndex) {
          correct = true;
          const timeLeftMs = Math.max(0, this.timerEndsAt - p.currentAnswer.atMs);
          gained = 100 + Math.round((50 * timeLeftMs) / (this.timerSeconds * 1000));
          gained = Math.max(100, gained); // correct is never worth less than 100
          p.score += gained;
          p.stats.correct += 1;
          p.stats.speedBonus += gained - 100;
        }
      }
      perPlayer.push({ nickname: p.nickname, correct, gained });
    }
    this.lastReveal = { correctIndex: q.correctIndex, sourceText: q.sourceText, perPlayer };
    this.phase = 'reveal';
  }

  currentQuestion() {
    const round = this.rounds[this.roundIdx];
    return round ? round.questions[this.questionIdx] : null;
  }

  // ---- answering ------------------------------------------------------------
  // Returns true if the answer was recorded, false for silent no-ops
  // (already answered). Throws for real errors the player should hear about.
  answer(nickname, index, atMs) {
    if (this.phase !== 'question') throw new Error('There is no question open right now.');
    const p = this.players.get(nickname);
    if (!p) throw new Error('Player not in game.');
    if (p.blockedForOrdinal === this.qOrdinal) throw new Error('You joined mid-question — you can play from the next one.');
    if (p.currentAnswer) return false; // first answer counts
    const at = Number(atMs);
    if (!Number.isFinite(at) || at > this.timerEndsAt) throw new Error('Too slow — the timer ran out.');
    const q = this.currentQuestion();
    if (!Number.isInteger(index) || index < 0 || index >= q.options.length) {
      throw new Error('Invalid answer.');
    }
    p.currentAnswer = { index, atMs: at };
    return true;
  }

  // ---- derived views --------------------------------------------------------
  leaderboard() {
    const sorted = [...this.players.values()].sort(
      (a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)
    );
    let lastScore = null;
    let lastRank = 0;
    return sorted.map((p, i) => {
      const rank = p.score === lastScore ? lastRank : i + 1;
      lastScore = p.score;
      lastRank = rank;
      return { nickname: p.nickname, score: p.score, rank };
    });
  }

  superlatives() {
    if (!this.isPaid) return []; // the Full Grilling sweetener
    const players = [...this.players.values()];
    if (!players.length) return [];
    const out = [];

    const knowers = players.filter((p) => p.stats.answered > 0);
    if (knowers.length) {
      const best = knowers.reduce((a, b) => {
        const accA = a.stats.correct / a.stats.answered;
        const accB = b.stats.correct / b.stats.answered;
        if (accB > accA) return b;
        if (accB === accA && b.stats.correct > a.stats.correct) return b;
        return a;
      });
      out.push({
        title: `Knows ${this.guestName} suspiciously well`,
        nickname: best.nickname,
        detail: `${best.stats.correct}/${best.stats.answered} correct`,
      });
    }

    const fastest = players.reduce((a, b) => (b.stats.speedBonus > a.stats.speedBonus ? b : a));
    if (fastest.stats.speedBonus > 0) {
      out.push({
        title: 'Fastest Finger',
        nickname: fastest.nickname,
        detail: `+${fastest.stats.speedBonus} points in speed bonuses`,
      });
    }

    const keenest = players.reduce((a, b) => (b.stats.answered > a.stats.answered ? b : a));
    if (keenest.stats.answered > 0 && out.length < 3) {
      out.push({
        title: 'Bravest Guesser',
        nickname: keenest.nickname,
        detail: `${keenest.stats.answered} answers locked in`,
      });
    }

    const board = this.leaderboard();
    if (board.length >= 2) {
      const last = board[board.length - 1];
      out.push({
        title: 'Wooden Spoon',
        nickname: last.nickname,
        detail: `Propping up the table with ${last.score} points`,
      });
    }
    return out;
  }

  // Exact 'state' payload per CONTRACTS.md. forNickname enriches 'you' per socket.
  buildStatePayload(forNickname) {
    const inQuestionish = this.phase === 'question' || this.phase === 'reveal';
    const round = this.rounds[this.roundIdx];

    let question = null;
    if (inQuestionish && round) {
      const q = round.questions[this.questionIdx];
      question = {
        number: this.questionIdx + 1,
        totalInRound: round.questions.length,
        questionText: q.questionText,
        options: q.options,
        timerEndsAt: this.timerEndsAt,
      };
    }

    let you = null;
    if (forNickname && this.players.has(forNickname)) {
      const p = this.players.get(forNickname);
      you = {
        nickname: p.nickname,
        score: p.score,
        lockedAnswer: p.currentAnswer ? p.currentAnswer.index : null,
      };
    }

    return {
      phase: this.phase,
      code: this.code,
      guestName: this.guestName,
      players: [...this.players.values()].map((p) => ({
        nickname: p.nickname,
        score: p.score,
        answeredThisQuestion: this.phase === 'question' && !!p.currentAnswer,
      })),
      round:
        (inQuestionish || this.phase === 'leaderboard') && round
          ? {
              roundKey: round.roundKey,
              title: round.title,
              number: this.roundIdx + 1,
              total: this.rounds.length,
            }
          : null,
      question,
      reveal: this.phase === 'reveal' ? this.lastReveal : null,
      leaderboard: this.phase === 'leaderboard' ? this.leaderboard() : null,
      podium:
        this.phase === 'podium'
          ? { top: this.leaderboard().slice(0, 3), superlatives: this.superlatives() }
          : null,
      you,
    };
  }

  // ---- persistence ----------------------------------------------------------
  checkpoint() {
    const state = {
      phase: this.phase,
      roundIdx: this.roundIdx,
      questionIdx: this.questionIdx,
      qOrdinal: this.qOrdinal,
      timerEndsAt: this.timerEndsAt,
      lastReveal: this.lastReveal,
      players: [...this.players.values()].map((p) => ({
        nickname: p.nickname,
        score: p.score,
        currentAnswer: p.currentAnswer,
        blockedForOrdinal: p.blockedForOrdinal,
        stats: p.stats,
      })),
    };
    db.prepare(
      `INSERT INTO game_checkpoints (eventId, state, updatedAt) VALUES (?, ?, datetime('now'))
       ON CONFLICT(eventId) DO UPDATE SET state = excluded.state, updatedAt = excluded.updatedAt`
    ).run(this.eventId, JSON.stringify(state));
  }

  static resume(eventId) {
    const row = db.prepare(`SELECT state FROM game_checkpoints WHERE eventId = ?`).get(eventId);
    if (!row) return null;
    let saved;
    try {
      saved = JSON.parse(row.state);
    } catch {
      return null;
    }
    const game = new Game(eventId); // questions reload from db (event is locked, so stable)
    game.phase = saved.phase;
    game.roundIdx = saved.roundIdx;
    game.questionIdx = saved.questionIdx;
    game.qOrdinal = saved.qOrdinal || 0;
    game.timerEndsAt = saved.timerEndsAt;
    game.lastReveal = saved.lastReveal || null;
    for (const p of saved.players || []) {
      game.players.set(p.nickname, {
        nickname: p.nickname,
        score: p.score,
        connected: false, // everyone reconnects fresh after a restart
        currentAnswer: p.currentAnswer || null,
        blockedForOrdinal: p.blockedForOrdinal || 0,
        stats: p.stats || { answered: 0, correct: 0, speedBonus: 0 },
      });
    }
    return game;
  }
}

function createOrResumeGame(eventId) {
  return Game.resume(eventId) || new Game(eventId);
}

module.exports = { Game, createOrResumeGame, TIMER_SECONDS };
