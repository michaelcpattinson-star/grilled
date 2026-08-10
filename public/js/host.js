'use strict';
/* Grilled — host (TV) screen (/host/KEY). Socket-driven; renders ONLY
   from the latest 'state' payload. One countdown interval, never stacked. */
(function () {
  var $ = G.$;
  var el = G.el;

  var TIMER_SECONDS = 20; // pinned in CONTRACTS.md
  var organiserKey = G.pathKey('host');

  var stage = $('#stage');
  var nextBtn = $('#next-btn');
  var barHint = $('#bar-hint');
  var connBar = $('#conn-bar');

  var state = null;
  var countdownTimer = null; // single interval handle
  var prevScores = {}; // nickname → last shown score, for leaderboard tweens

  if (!organiserKey) {
    stage.replaceChildren(
      el('div', { class: 'screen-msg' },
        el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, '💀'),
        el('h1', { class: 'display', text: "That host link doesn't look right" }),
        el('p', { class: 'muted', text: 'It should look like /host/yourorganiserkey — grab it from your dashboard.' }))
    );
    return;
  }

  if (typeof io !== 'function') {
    stage.replaceChildren(
      el('div', { class: 'screen-msg' },
        el('h1', { class: 'display', text: "Can't reach the game server" }),
        el('p', { class: 'muted', text: 'Refresh the page to try again.' }))
    );
    return;
  }

  var socket = io();

  socket.on('connect', function () {
    connBar.classList.add('hidden');
    socket.emit('host:join', { organiserKey: organiserKey });
  });
  socket.on('disconnect', function () {
    connBar.classList.remove('hidden');
  });
  socket.on('errorMsg', function (data) {
    G.toast((data && data.message) || 'Something went wrong.', 'bad');
  });
  socket.on('state', function (s) {
    state = s;
    render();
  });

  // ---------- next button ----------

  function nextAction() {
    if (!state) return;
    if (state.phase === 'lobby') {
      socket.emit('host:start', {});
    } else if (state.phase !== 'podium') {
      socket.emit('host:next', {});
    }
  }

  nextBtn.addEventListener('click', nextAction);
  document.addEventListener('keydown', function (e) {
    if (e.code !== 'Space' && e.key !== 'Enter') return;
    if (e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' ||
        e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (!nextBtn.disabled && !nextBtn.classList.contains('hidden')) nextAction();
  });

  function updateBar() {
    var players = state.players || [];
    nextBtn.classList.remove('hidden');
    nextBtn.disabled = false;
    barHint.textContent = 'Space or Enter also works';

    switch (state.phase) {
      case 'lobby':
        nextBtn.textContent = 'Start the grilling';
        if (players.length < 2) {
          nextBtn.disabled = true;
          barHint.textContent = 'Need at least 2 players — get those phones out';
        }
        break;
      case 'question':
        nextBtn.textContent = 'Reveal';
        break;
      case 'reveal': {
        var lastInRound = state.question && state.question.number >= state.question.totalInRound;
        var lastRound = state.round && state.round.number >= state.round.total;
        if (lastInRound && lastRound) nextBtn.textContent = 'Final scores';
        else if (lastInRound) nextBtn.textContent = 'Round scores';
        else nextBtn.textContent = 'Next question';
        break;
      }
      case 'leaderboard':
        nextBtn.textContent = 'Start round';
        break;
      case 'podium':
        nextBtn.classList.add('hidden');
        barHint.textContent = 'That’s the lot. Well grilled.';
        break;
      default:
        nextBtn.textContent = 'Next';
    }
  }

  // ---------- countdown ----------

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  var RING_R = 45;
  var RING_C = 2 * Math.PI * RING_R;

  function buildTimerRing(endsAt) {
    var wrap = el('div', { class: 'timer-wrap', role: 'timer', 'aria-label': 'Time remaining' });
    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    var track = document.createElementNS(svgNS, 'circle');
    track.setAttribute('cx', '50'); track.setAttribute('cy', '50'); track.setAttribute('r', String(RING_R));
    track.setAttribute('class', 'timer-track');
    var arc = document.createElementNS(svgNS, 'circle');
    arc.setAttribute('cx', '50'); arc.setAttribute('cy', '50'); arc.setAttribute('r', String(RING_R));
    arc.setAttribute('class', 'timer-arc');
    arc.setAttribute('stroke-dasharray', String(RING_C));
    svg.appendChild(track);
    svg.appendChild(arc);
    var num = el('div', { class: 'timer-num', text: '' });
    wrap.appendChild(svg);
    wrap.appendChild(num);

    var totalMs = TIMER_SECONDS * 1000;
    function tick() {
      var left = Math.max(0, endsAt - Date.now());
      var frac = Math.min(1, left / totalMs);
      arc.setAttribute('stroke-dashoffset', String(RING_C * (1 - frac)));
      arc.classList.toggle('low', left <= 5000 && left > 0);
      num.textContent = String(Math.ceil(left / 1000));
      if (left <= 0) {
        num.textContent = '0';
        stopCountdown();
      }
    }
    tick();
    stopCountdown();
    countdownTimer = setInterval(tick, 150);
    return wrap;
  }

  // ---------- rendering ----------

  function render() {
    stopCountdown();
    updateBar();
    stage.replaceChildren();
    switch (state.phase) {
      case 'lobby': renderLobby(); break;
      case 'question': renderQuestion(); break;
      case 'reveal': renderReveal(); break;
      case 'leaderboard': renderLeaderboard(); break;
      case 'podium': renderPodium(); break;
      default:
        stage.appendChild(el('p', { class: 'muted', text: 'Waiting for the game…' }));
    }
  }

  function renderLobby() {
    stage.appendChild(el('div', { class: 'tv-kicker', text: 'Join at ' + location.host + '/play with code' }));
    stage.appendChild(el('div', { class: 'tv-code', text: state.code || '????' }));
    var players = state.players || [];
    stage.appendChild(el('p', { class: 'tv-sub' },
      players.length === 0
        ? 'Nobody here yet… phones out, drinks down.'
        : players.length + (players.length === 1 ? ' player in. It takes two to grill.' : ' players in. Ready when you are.')));
    var chips = el('div', { class: 'lobby-players' });
    players.forEach(function (p) {
      chips.appendChild(el('span', { class: 'player-chip', text: p.nickname }));
    });
    stage.appendChild(chips);
  }

  function roundKickerText() {
    var r = state.round;
    if (!r) return '';
    return 'Round ' + r.number + ' of ' + r.total + ' — ' + r.title;
  }

  function renderQuestion() {
    var q = state.question;
    if (!q) return;
    stage.appendChild(el('div', { class: 'tv-kicker', text: roundKickerText() }));
    stage.appendChild(el('p', { class: 'tv-sub', text: 'Question ' + q.number + ' of ' + q.totalInRound }));
    stage.appendChild(el('h1', { class: 'tv-question', text: q.questionText }));

    var grid = el('div', { class: 'opt-grid' });
    (q.options || []).forEach(function (opt, i) {
      grid.appendChild(el('div', { class: 'opt-tile opt-' + i },
        el('span', { class: 'opt-badge', 'aria-hidden': 'true', text: G.LETTERS[i] }),
        el('span', null, opt)));
    });
    stage.appendChild(grid);

    var players = state.players || [];
    var answered = players.filter(function (p) { return p.answeredThisQuestion; }).length;
    var meta = el('div', { class: 'tv-meta', style: 'margin-top: 2vh;' });
    if (q.timerEndsAt) meta.appendChild(buildTimerRing(q.timerEndsAt));
    meta.appendChild(el('span', { class: 'answer-count', text: answered + ' of ' + players.length + ' answered' }));
    stage.appendChild(meta);
  }

  function renderReveal() {
    var q = state.question;
    var rv = state.reveal;
    if (!rv) return;
    stage.appendChild(el('div', { class: 'tv-kicker', text: roundKickerText() }));
    if (q) stage.appendChild(el('h1', { class: 'tv-question', text: q.questionText }));

    var grid = el('div', { class: 'opt-grid' });
    var options = (q && q.options) || [];
    options.forEach(function (opt, i) {
      var win = i === rv.correctIndex;
      grid.appendChild(el('div', { class: 'opt-tile opt-' + i + (win ? ' winner' : ' dimmed') },
        el('span', { class: 'opt-badge', 'aria-hidden': 'true', text: G.LETTERS[i] }),
        el('span', null, opt),
        win ? el('span', { class: 'opt-tick', 'aria-hidden': 'true', text: '✓' }) : null));
    });
    stage.appendChild(grid);

    if (rv.sourceText) {
      stage.appendChild(el('div', { class: 'story-card' },
        el('div', { class: 'story-label', text: 'The actual story 📖' }),
        el('p', { class: 'story-text', text: rv.sourceText })));
    }

    var ticker = el('div', { class: 'reveal-ticker' });
    (rv.perPlayer || []).forEach(function (pp) {
      ticker.appendChild(el('span', { class: 'tick-item' + (pp.correct ? '' : ' tick-wrong') },
        el('span', { class: 'tick-name', text: pp.nickname }),
        el('span', { class: 'tick-gain', text: pp.correct ? '+' + pp.gained : '+0' })));
    });
    stage.appendChild(ticker);
  }

  function renderBoard(rows, big) {
    var board = el('div', { class: 'board' });
    rows.forEach(function (row) {
      var scoreEl = el('span', { class: 'b-score', text: String(row.score) });
      board.appendChild(el('div', { class: 'board-row' + (row.rank === 1 ? ' top-1' : '') },
        el('span', { class: 'rank', text: '#' + row.rank }),
        el('span', { class: 'b-name', text: row.nickname }),
        scoreEl));
      if (big) tweenScore(scoreEl, prevScores[row.nickname] || 0, row.score);
      prevScores[row.nickname] = row.score;
    });
    return board;
  }

  function tweenScore(node, from, to) {
    if (from === to) { node.textContent = String(to); return; }
    var start = null;
    var dur = 700;
    function step(ts) {
      if (start === null) start = ts;
      var t = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(from + (to - from) * eased));
      if (t < 1 && node.isConnected) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function renderLeaderboard() {
    stage.appendChild(el('div', { class: 'tv-kicker', text: 'The state of play' }));
    stage.appendChild(el('h1', { class: 'display', style: 'font-size: clamp(2rem, 7vh, 4rem); margin-bottom: 1vh;', text: 'Leaderboard' }));
    stage.appendChild(renderBoard(state.leaderboard || [], true));
  }

  function renderPodium() {
    var pod = state.podium;
    if (!pod) return;
    stage.appendChild(el('div', { class: 'tv-kicker', text: 'The final reckoning' }));

    var top = pod.top || [];
    var medals = ['🥇', '🥈', '🥉'];
    var grid = el('div', { class: 'podium-grid' });
    // visual order: 2nd, 1st, 3rd
    [1, 0, 2].forEach(function (idx) {
      var p = top[idx];
      if (!p) return;
      grid.appendChild(el('div', { class: 'podium-slot p-' + (idx + 1) },
        el('span', { class: 'medal', 'aria-hidden': 'true', text: medals[idx] || '' }),
        el('div', { class: 'p-name', text: p.nickname }),
        el('div', { class: 'p-score', text: p.score + ' pts' })));
    });
    stage.appendChild(grid);

    var sups = pod.superlatives || [];
    if (sups.length > 0) {
      var supZone = el('div', { class: 'superlatives' });
      sups.forEach(function (s) {
        supZone.appendChild(el('div', { class: 'superlative-card' },
          el('div', { class: 'sup-title', text: s.title }),
          el('div', { class: 'sup-name', text: s.nickname }),
          s.detail ? el('div', { class: 'sup-detail', text: s.detail }) : null));
      });
      stage.appendChild(supZone);
    }

    stage.appendChild(el('div', { class: 'end-cta' },
      el('h2', { class: 'display', text: 'Grilled. 🔥' }),
      el('a', { class: 'btn btn-primary btn-big', href: '/', text: 'Make one for your next do →' })));
  }
})();
