'use strict';
/* Grilled — player (phone) screen (/play). Socket-driven.
   Join details are kept in memory ONLY (no storage APIs) — a full page
   reload means re-joining with the same nickname, which restores score
   server-side. Socket.IO reconnects re-emit player:join automatically. */
(function () {
  var $ = G.$;
  var el = G.el;

  var joinScreen = $('#join-screen');
  var stage = $('#stage');
  var connBar = $('#conn-bar');
  var meBox = $('#play-me');

  var joined = null; // {code, nickname} — in-memory only
  var pendingJoin = false;
  var state = null;
  var localLock = null; // {qid, index} chosen this question before server confirms
  var timerCheck = null; // single interval watching timerEndsAt

  if (typeof io !== 'function') {
    joinScreen.replaceChildren(
      el('div', { class: 'screen-msg' },
        el('h1', { class: 'display', text: "Can't reach the game" }),
        el('p', { class: 'muted', text: 'Refresh the page and try again.' }))
    );
    return;
  }

  var socket = io();

  socket.on('connect', function () {
    connBar.classList.add('hidden');
    // Reconnect: re-join with the same code + nickname to restore score.
    if (joined) socket.emit('player:join', { code: joined.code, nickname: joined.nickname });
  });
  socket.on('disconnect', function () {
    if (joined) connBar.classList.remove('hidden');
  });
  socket.on('errorMsg', function (data) {
    var msg = (data && data.message) || 'Something went wrong.';
    G.toast(msg, 'bad');
    if (pendingJoin) {
      // Join was rejected — back to the form.
      pendingJoin = false;
      joined = null;
      var btn = $('#join-btn');
      btn.disabled = false;
      btn.textContent = 'Join the game';
    }
  });
  socket.on('state', function (s) {
    state = s;
    if (pendingJoin) {
      pendingJoin = false;
      joinScreen.classList.add('hidden');
      stage.classList.remove('hidden');
    }
    render();
  });

  // ---------- join form ----------

  var codeInput = $('#code-input');
  var nickInput = $('#nick-input');

  codeInput.addEventListener('input', function () {
    var pos = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    try { codeInput.setSelectionRange(pos, pos); } catch (e) { /* ok */ }
    $('#code-error').classList.add('hidden');
  });
  nickInput.addEventListener('input', function () {
    $('#nick-error').classList.add('hidden');
  });

  $('#join-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = codeInput.value.trim().toUpperCase();
    var nickname = nickInput.value.trim();
    var bad = false;
    if (code.length !== 4) { $('#code-error').classList.remove('hidden'); codeInput.focus(); bad = true; }
    if (!nickname) {
      $('#nick-error').classList.remove('hidden');
      if (!bad) nickInput.focus();
      bad = true;
    }
    if (bad) return;

    joined = { code: code, nickname: nickname };
    pendingJoin = true;
    var btn = $('#join-btn');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    if (socket.connected) {
      socket.emit('player:join', { code: code, nickname: nickname });
    }
    // If not connected yet, the 'connect' handler emits the join.
  });

  // ---------- rendering ----------

  function stopTimerCheck() {
    if (timerCheck) {
      clearInterval(timerCheck);
      timerCheck = null;
    }
  }

  function questionId() {
    var r = state.round ? state.round.number : 0;
    var q = state.question ? state.question.number : 0;
    return r + '-' + q;
  }

  function render() {
    stopTimerCheck();
    stage.replaceChildren();

    // Header: nickname + score (server may have suffixed the nickname, trust `you`)
    var you = state.you;
    if (you) {
      meBox.classList.remove('hidden');
      $('#me-name').textContent = you.nickname;
      $('#me-score').textContent = String(you.score || 0);
      if (joined && you.nickname && you.nickname !== joined.nickname) {
        joined.nickname = you.nickname; // keep rejoin identity in sync with suffix
      }
    }

    switch (state.phase) {
      case 'lobby': renderLobby(); break;
      case 'question': renderQuestion(); break;
      case 'reveal': renderReveal(); break;
      case 'leaderboard': renderLeaderboard(); break;
      case 'podium': renderPodium(); break;
      default:
        stage.appendChild(el('p', { class: 'muted center', text: 'Waiting for the game…' }));
    }
  }

  function renderLobby() {
    localLock = null;
    stage.appendChild(el('div', { class: 'screen-msg' },
      el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, '👀'),
      el('h1', { class: 'display', text: "You're in!" }),
      el('p', { class: 'muted', text: 'Eyes on the telly. It starts when the host says so.' })));
  }

  function renderQuestion() {
    var q = state.question;
    if (!q) return;
    var qid = questionId();
    if (localLock && localLock.qid !== qid) localLock = null;

    var you = state.you;
    var lockedIndex = null;
    if (you && you.lockedAnswer !== null && you.lockedAnswer !== undefined) {
      lockedIndex = you.lockedAnswer;
    } else if (localLock && localLock.qid === qid) {
      lockedIndex = localLock.index;
    }
    var timeUp = q.timerEndsAt ? Date.now() > q.timerEndsAt : false;
    var isLocked = lockedIndex !== null;

    stage.appendChild(el('p', { class: 'muted center small', style: 'margin-bottom: 0.6rem;',
      text: 'Question ' + q.number + ' of ' + q.totalInRound + ' — the question’s on the telly 📺' }));

    var stack = el('div', { class: 'answer-stack', role: 'group', 'aria-label': 'Answers' });
    var buttons = [];
    (q.options || []).forEach(function (opt, i) {
      var btn = el('button', {
        type: 'button',
        class: 'answer-btn opt-' + i,
        onclick: function () { answer(i, buttons, note); }
      },
        el('span', { class: 'opt-badge', 'aria-hidden': 'true', text: G.LETTERS[i] }),
        el('span', null, opt));
      buttons.push(btn);
      stack.appendChild(btn);
    });
    stage.appendChild(stack);

    var note = el('p', { class: 'lock-note', 'aria-live': 'polite', text: '' });
    stage.appendChild(note);

    if (isLocked) {
      applyLockUI(buttons, lockedIndex, note);
    } else if (timeUp) {
      applyTimeUpUI(buttons, note);
    }

    // Single interval watching the clock — disables buttons at timerEndsAt.
    if (q.timerEndsAt && !isLocked && !timeUp) {
      timerCheck = setInterval(function () {
        if (Date.now() > q.timerEndsAt) {
          stopTimerCheck();
          if (!localLock || localLock.qid !== qid) applyTimeUpUI(buttons, note);
        }
      }, 250);
    }
  }

  function applyLockUI(buttons, index, note) {
    buttons.forEach(function (b, i) {
      b.disabled = true;
      b.classList.toggle('chosen', i === index);
      b.classList.toggle('not-chosen', i !== index);
    });
    note.textContent = 'Locked in 🔒';
  }

  function applyTimeUpUI(buttons, note) {
    buttons.forEach(function (b) { b.disabled = true; b.classList.add('not-chosen'); });
    note.textContent = 'Time’s up — eyes on the telly 📺';
  }

  function answer(index, buttons, note) {
    var q = state.question;
    if (!q) return;
    if (q.timerEndsAt && Date.now() > q.timerEndsAt) {
      applyTimeUpUI(buttons, note);
      return;
    }
    if (localLock && localLock.qid === questionId()) return; // already answered
    localLock = { qid: questionId(), index: index };
    socket.emit('player:answer', { index: index });
    applyLockUI(buttons, index, note);
  }

  function renderReveal() {
    var rv = state.reveal;
    var you = state.you;
    var mine = null;
    if (rv && you) {
      (rv.perPlayer || []).forEach(function (pp) {
        if (pp.nickname === you.nickname) mine = pp;
      });
    }

    var splash = el('div', { class: 'result-splash' });
    if (mine && mine.correct) {
      splash.classList.add('result-good');
      splash.appendChild(el('div', { class: 'result-big', text: '+' + mine.gained + '! 🔥' }));
      splash.appendChild(el('p', { class: 'muted', text: 'Get in. You know your stuff.' }));
    } else if (mine && !mine.correct) {
      var answered = you && you.lockedAnswer !== null && you.lockedAnswer !== undefined;
      splash.classList.add('result-bad');
      splash.appendChild(el('div', { class: 'result-big', text: answered ? 'Wrong 💀' : 'Too slow 💀' }));
      splash.appendChild(el('p', { class: 'muted', text: answered ? 'The truth hurts. Next one’s yours.' : 'Blink and you miss it. Sharpen up.' }));
    } else {
      splash.appendChild(el('p', { class: 'muted', text: 'The answer’s on the telly 📺' }));
    }
    stage.appendChild(splash);
  }

  function renderLeaderboard() {
    localLock = null;
    var you = state.you;
    stage.appendChild(el('h1', { class: 'display center', style: 'font-size: 2rem; margin-bottom: 0.8rem;', text: 'Leaderboard' }));
    var board = el('div', { class: 'board' });
    (state.leaderboard || []).forEach(function (row) {
      var isMe = you && row.nickname === you.nickname;
      board.appendChild(el('div', { class: 'board-row' + (isMe ? ' me' : '') + (row.rank === 1 ? ' top-1' : '') },
        el('span', { class: 'rank', text: '#' + row.rank }),
        el('span', { class: 'b-name', text: row.nickname + (isMe ? ' (you)' : '') }),
        el('span', { class: 'b-score', text: String(row.score) })));
    });
    stage.appendChild(board);
  }

  function renderPodium() {
    localLock = null;
    var pod = state.podium;
    var you = state.you;
    var top = (pod && pod.top) || [];
    var medals = ['🥇', '🥈', '🥉'];

    var myRank = null;
    top.forEach(function (p) { if (you && p.nickname === you.nickname) myRank = p.rank; });

    var splash = el('div', { class: 'screen-msg', style: 'padding: 1.5rem 0;' });
    if (myRank === 1) {
      splash.appendChild(el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, '👑'));
      splash.appendChild(el('h1', { class: 'display', text: 'Champion!' }));
      splash.appendChild(el('p', { class: 'muted', text: 'You know them scarily well. We have questions.' }));
    } else if (myRank) {
      splash.appendChild(el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, medals[myRank - 1] || '🏅'));
      splash.appendChild(el('h1', { class: 'display', text: 'On the podium!' }));
      splash.appendChild(el('p', { class: 'muted', text: 'Respectable. Very respectable.' }));
    } else {
      splash.appendChild(el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, '🔥'));
      splash.appendChild(el('h1', { class: 'display', text: 'Well grilled.' }));
      splash.appendChild(el('p', { class: 'muted', text: 'No medal, but you brought the vibes.' }));
    }
    stage.appendChild(splash);

    var board = el('div', { class: 'board' });
    top.forEach(function (p) {
      var isMe = you && p.nickname === you.nickname;
      board.appendChild(el('div', { class: 'board-row' + (isMe ? ' me' : '') + (p.rank === 1 ? ' top-1' : '') },
        el('span', { class: 'rank', text: medals[p.rank - 1] || '#' + p.rank }),
        el('span', { class: 'b-name', text: p.nickname + (isMe ? ' (you)' : '') }),
        el('span', { class: 'b-score', text: String(p.score) })));
    });
    stage.appendChild(board);

    stage.appendChild(el('p', { class: 'center', style: 'margin-top: 1.5rem;' },
      el('a', { class: 'btn btn-primary', href: '/', text: 'Make one for your next do 🔥' })));
  }
})();
