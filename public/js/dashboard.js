'use strict';
/* Grilled — organiser dashboard (/o/KEY).
   REST only. Polls GET /api/events/:key every 10s with a single
   setTimeout chain (never stacked timers). */
(function () {
  var $ = G.$;
  var el = G.el;

  var organiserKey = G.pathKey('o');

  var loadingEl = $('#loading');
  var loadErrorEl = $('#load-error');
  var dashEl = $('#dash');

  var event = null; // latest GET /api/events/:key payload
  var questions = null; // latest GET questions payload (array) or null if never loaded
  var pollTimer = null;
  var editingId = null; // question id currently in edit mode
  var readyArmed = false;
  var readyArmTimer = null;
  var readyBusy = false;

  if (!organiserKey) {
    showLoadError("That organiser link doesn't look right — it should look like /o/yourkey.");
    return;
  }

  // ---------- data loading ----------

  function fetchEvent() {
    return G.api('/api/events/' + encodeURIComponent(organiserKey));
  }

  function fetchQuestions() {
    return G.api('/api/events/' + encodeURIComponent(organiserKey) + '/questions')
      .then(function (data) {
        questions = (data && data.questions) || [];
        renderQuestions();
      });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      fetchEvent()
        .then(function (data) {
          event = data;
          renderEvent();
        })
        .catch(function () { /* transient poll failure — try again next tick */ })
        .then(schedulePoll);
    }, 10000);
  }

  function showLoadError(msg) {
    loadingEl.classList.add('hidden');
    dashEl.classList.add('hidden');
    loadErrorEl.classList.remove('hidden');
    if (msg) $('#load-error-msg').textContent = msg;
  }

  // Landed back from Stripe Checkout (?session_id=…) or a claim link (?claimed=1)?
  // Confirm/celebrate, then clean the URL so refreshes stay tidy.
  var landingParams = new URLSearchParams(location.search);
  var checkoutSessionId = landingParams.get('session_id');
  var justClaimed = landingParams.get('claimed');
  if (checkoutSessionId || justClaimed) {
    history.replaceState(null, '', location.pathname);
  }

  function confirmPaymentIfNeeded() {
    if (!checkoutSessionId) return Promise.resolve();
    return G.api('/api/events/' + encodeURIComponent(organiserKey) + '/confirm-payment', {
      method: 'POST',
      body: { sessionId: checkoutSessionId }
    })
      .then(function (data) {
        if (data && data.plan === 'full') G.toast('Full Grilling unlocked. Scorch responsibly 🔥');
      })
      .catch(function () { /* webhook will catch up; the poll will reflect it */ });
  }

  // Initial load
  confirmPaymentIfNeeded()
    .then(fetchEvent)
    .then(function (data) {
      event = data;
      loadingEl.classList.add('hidden');
      dashEl.classList.remove('hidden');
      wireStaticControls();
      if (justClaimed) G.toast('Claimed — this quiz is now on your account ✓');
      renderEvent();
      var counts = event.questionCounts || {};
      var totalQs = (counts.pending || 0) + (counts.approved || 0) + (counts.binned || 0);
      if (totalQs > 0 && !isLocked()) fetchQuestions().catch(function () {});
      schedulePoll();
    })
    .catch(function (err) {
      showLoadError(err.message);
    });

  // ---------- rendering ----------

  function isLocked() {
    return event && event.status && event.status !== 'collecting';
  }

  function whatsappMessage() {
    var url = G.absUrl(event.submissionUrl);
    return "🔥 We're secretly building a quiz about " + event.name +
      "... spill the dirt here, they'll never know it was you: " + url;
  }

  function renderEvent() {
    document.title = 'Grilling ' + event.name + ' — Grilled';
    $('#dash-title').textContent = 'Grilling ' + event.name;
    $('#dash-sub').textContent = event.occasion + ' · tone: ' + toneLabel(event.tone);

    // Stats
    var counts = event.questionCounts || {};
    $('#stat-subs').textContent = String(event.submissionCount || 0);
    $('#stat-approved').textContent = String(counts.approved || 0);
    $('#stat-pending').textContent = String(counts.pending || 0);
    $('#status-hint').textContent = statusHint();

    // Share links
    $('#submit-url').value = G.absUrl(event.submissionUrl);

    // Tone radios reflect current tone (don't fight the user mid-change)
    var checked = document.querySelector('input[name="dash-tone"]:checked');
    if (!checked) {
      var radio = document.querySelector('input[name="dash-tone"][value="' + event.tone + '"]');
      if (radio) radio.checked = true;
    }

    renderPlan();
    renderClaim();
    renderAssistant();
    renderDemoGuide();

    // Locked vs collecting layout (plan + claim cards stay in both states)
    if (isLocked()) {
      $('#share-card').classList.add('hidden');
      $('#build-card').classList.add('hidden');
      $('#ready-card').classList.add('hidden');
      $('#status-card').classList.add('hidden');
      var lockedCard = $('#locked-card');
      lockedCard.classList.remove('hidden');
      $('#game-code').textContent = event.gameCode || '????';
      $('#join-host').textContent = location.host + '/play';
      var hostUrl = G.absUrl(event.hostUrl);
      $('#host-url').value = hostUrl;
      $('#open-host-link').setAttribute('href', hostUrl);
    } else {
      var buildBtn = $('#build-btn');
      var totalQs = (counts.pending || 0) + (counts.approved || 0) + (counts.binned || 0);
      if (!buildBtn.disabled) {
        buildBtn.textContent = totalQs > 0 ? 'Rebuild the quiz' : 'Build my quiz';
      }
      if (!readyBusy) $('#ready-btn').disabled = (counts.approved || 0) < 10;
    }
  }

  function statusHint() {
    var subs = event.submissionCount || 0;
    var counts = event.questionCounts || {};
    var limit = event.freeQuestionLimit || 15;
    if (event.plan !== 'full' && (counts.approved || 0) > limit) {
      return 'Heads up: on the free plan the game plays your first ' + limit +
        ' approved questions. Go Full Grilling below to play all ' + (counts.approved || 0) + '.';
    }
    if (subs === 0) return '0 submissions — chase your mates. The group chat needs a nudge.';
    if (subs < 5) return subs + ' in so far. Five or more makes a much juicier quiz — keep chasing.';
    if ((counts.approved || 0) >= 10) return 'Plenty approved — you can lock it in whenever you like.';
    return 'Nice haul. Build the quiz below, then approve your favourites.';
  }

  function renderPlan() {
    var isPaid = event.plan === 'full' || event.plan === 'speech';
    var badge = $('#plan-badge');
    badge.textContent = event.plan === 'speech' ? 'Roast & Toast 🥂' : (isPaid ? 'Full Grilling 🔥' : 'Free Taster');
    badge.classList.toggle('plan-free', !isPaid);
    $('#plan-free-zone').classList.toggle('hidden', isPaid);
    $('#plan-full-zone').classList.toggle('hidden', !isPaid);
    if (!isPaid) {
      // Payments off (local/dev) → show the labelled dev unlock instead of checkout
      $('#upgrade-btn').classList.toggle('hidden', !event.paymentsEnabled);
      $('#dev-unlock-btn').classList.toggle('hidden', !!event.paymentsEnabled);
    }
    renderSpeech();
  }

  function renderDemoGuide() {
    var card = $('#demo-guide-card');
    card.classList.toggle('hidden', !event.isDemo);
    if (event.isDemo) $('#demo-play-host').textContent = location.host + '/play';
  }

  function renderAssistant() {
    var paid = event.plan === 'full' || event.plan === 'speech';
    $('#assistant-card').classList.toggle('hidden', !(event.aiEnabled && paid));
  }

  var speechLoaded = false;
  function renderSpeech() {
    var unlocked = event.plan === 'speech';
    $('#speech-badge').classList.toggle('plan-free', !unlocked);
    $('#speech-locked-zone').classList.toggle('hidden', unlocked);
    $('#speech-unlocked-zone').classList.toggle('hidden', !unlocked);
    if (!unlocked) {
      $('#speech-buy-btn').classList.toggle('hidden', !event.paymentsEnabled);
      $('#speech-dev-unlock-btn').classList.toggle('hidden', !!event.paymentsEnabled);
      return;
    }
    if (speechLoaded) return;
    speechLoaded = true;
    G.api('/api/events/' + encodeURIComponent(organiserKey) + '/speech')
      .then(function (data) {
        if (data.speech) showSpeechText(data.speech, false);
      })
      .catch(function () { speechLoaded = false; });
  }

  function showSpeechText(text, toastIt) {
    var ta = $('#speech-text');
    ta.value = text;
    ta.classList.remove('hidden');
    $('#speech-save-btn').classList.remove('hidden');
    $('#speech-copy-btn').classList.remove('hidden');
    $('#speech-build-btn').textContent = 'Rebuild from scratch';
    if (toastIt) G.toast('Speech served. Read it out loud once before the night 🥂');
  }

  function renderClaim() {
    var claimed = !!event.claimed;
    $('#claim-form-zone').classList.toggle('hidden', claimed);
    var done = $('#claim-done-msg');
    done.classList.toggle('hidden', !claimed);
    if (claimed && !event.claimedByYou) {
      done.textContent = 'This quiz is claimed to an email account. Sign in at /account to see it listed.';
    }
  }

  function toneLabel(tone) {
    if (tone === 'gentle') return 'Gentle 🔅';
    if (tone === 'roast') return 'Full Roast 🌶️';
    return 'Medium 🔥';
  }

  // ---------- questions list ----------

  function renderQuestions() {
    var zone = $('#questions-zone');
    zone.replaceChildren();
    if (!questions || questions.length === 0) return;

    // Group by roundKey preserving first-seen order
    var order = [];
    var groups = {};
    questions.forEach(function (q) {
      if (!groups[q.roundKey]) { groups[q.roundKey] = []; order.push(q.roundKey); }
      groups[q.roundKey].push(q);
    });

    order.forEach(function (roundKey) {
      zone.appendChild(el('h3', { class: 'round-title', text: G.roundTitle(roundKey) }));
      groups[roundKey].forEach(function (q) {
        zone.appendChild(q.id === editingId ? questionEditCard(q) : questionCard(q));
      });
    });
  }

  function questionCard(q) {
    var card = el('div', { class: 'q-card q-' + q.status });
    card.appendChild(el('span', { class: 'q-status s-' + q.status, text: statusText(q.status) }));
    card.appendChild(el('p', { class: 'q-text', text: q.questionText }));

    var list = el('ul', { class: 'q-opts' });
    (q.options || []).forEach(function (opt, i) {
      var li = el('li', { class: i === q.correctIndex ? 'correct' : null },
        el('span', { class: 'opt-letter', 'aria-hidden': 'true', text: G.LETTERS[i] || '?' }),
        opt,
        i === q.correctIndex ? ' ✓' : null);
      list.appendChild(li);
    });
    card.appendChild(list);

    if (q.sourceText) {
      card.appendChild(el('p', { class: 'small muted', text: 'Source story: ' + q.sourceText }));
    }

    var actions = el('div', { class: 'q-actions' });
    if (q.status !== 'approved') {
      actions.appendChild(el('button', {
        class: 'btn btn-ghost btn-small', type: 'button', text: '✓ Approve',
        onclick: function () { patchQuestion(q, { status: 'approved' }, 'Approved. On the menu.'); }
      }));
    }
    if (q.status !== 'binned') {
      actions.appendChild(el('button', {
        class: 'btn btn-ghost btn-small', type: 'button', text: '✎ Edit',
        onclick: function () { editingId = q.id; renderQuestions(); }
      }));
      actions.appendChild(el('button', {
        class: 'btn btn-danger btn-small', type: 'button', text: '🗑 Bin',
        onclick: function () { patchQuestion(q, { status: 'binned' }, 'Binned. It never happened.'); }
      }));
    } else {
      actions.appendChild(el('button', {
        class: 'btn btn-ghost btn-small', type: 'button', text: '↩ Restore',
        onclick: function () { patchQuestion(q, { status: 'pending' }, 'Back from the bin.'); }
      }));
    }
    card.appendChild(actions);
    return card;
  }

  function questionEditCard(q) {
    var card = el('div', { class: 'q-card q-' + q.status });
    var form = el('form', { class: 'q-edit-form' });

    var qtId = 'edit-qt-' + q.id;
    var qtField = el('div', { class: 'field' });
    qtField.appendChild(el('label', { for: qtId, text: 'Question' }));
    var qtInput = el('textarea', { id: qtId, maxlength: '500' });
    qtInput.value = q.questionText;
    qtField.appendChild(qtInput);
    form.appendChild(qtField);

    var optInputs = [];
    (q.options || []).forEach(function (opt, i) {
      var optId = 'edit-opt-' + q.id + '-' + i;
      var f = el('div', { class: 'field' });
      f.appendChild(el('label', {
        for: optId,
        text: 'Option ' + (G.LETTERS[i] || i + 1) + (i === q.correctIndex ? ' (correct answer)' : '')
      }));
      var input = el('input', { type: 'text', id: optId, maxlength: '200' });
      input.value = opt;
      optInputs.push(input);
      f.appendChild(input);
      form.appendChild(f);
    });

    var saveBtn = el('button', { class: 'btn btn-primary btn-small', type: 'submit', text: 'Save' });
    var cancelBtn = el('button', {
      class: 'btn btn-ghost btn-small', type: 'button', text: 'Cancel',
      onclick: function () { editingId = null; renderQuestions(); }
    });
    form.appendChild(el('div', { class: 'q-actions' }, saveBtn, cancelBtn));

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var newText = qtInput.value.trim();
      var newOptions = optInputs.map(function (inp) { return inp.value.trim(); });
      if (!newText) { G.toast('The question needs some words.', 'bad'); return; }
      if (newOptions.some(function (o) { return !o; })) {
        G.toast('All four options need some words.', 'bad');
        return;
      }
      saveBtn.disabled = true;
      G.api('/api/questions/' + encodeURIComponent(q.id), {
        method: 'PATCH',
        body: { organiserKey: organiserKey, questionText: newText, options: newOptions }
      })
        .then(function () {
          q.questionText = newText;
          q.options = newOptions;
          editingId = null;
          renderQuestions();
          G.toast('Saved. Chef’s kiss.');
        })
        .catch(function (err) {
          saveBtn.disabled = false;
          G.toast(err.message, 'bad');
        });
    });

    card.appendChild(form);
    return card;
  }

  function statusText(status) {
    if (status === 'approved') return 'Approved';
    if (status === 'binned') return 'Binned';
    return 'Needs review';
  }

  function patchQuestion(q, body, okMsg) {
    body.organiserKey = organiserKey;
    G.api('/api/questions/' + encodeURIComponent(q.id), { method: 'PATCH', body: body })
      .then(function () {
        if (body.status) q.status = body.status;
        renderQuestions();
        refreshEventSoon();
        if (okMsg) G.toast(okMsg);
      })
      .catch(function (err) { G.toast(err.message, 'bad'); });
  }

  // Refresh counts shortly after a moderation action (doesn't stack: reuses poll chain)
  function refreshEventSoon() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(function () {
      fetchEvent()
        .then(function (data) { event = data; renderEvent(); })
        .catch(function () {})
        .then(schedulePoll);
    }, 400);
  }

  // ---------- static controls ----------

  function wireStaticControls() {
    // Upgrade → Stripe Checkout
    $('#upgrade-btn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Opening the till…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/checkout', { method: 'POST' })
        .then(function (data) {
          if (data && data.url) {
            location.href = data.url;
            return;
          }
          btn.disabled = false;
          btn.textContent = 'Go Full Grilling — £19 🔥';
          if (data && data.paymentsEnabled === false) {
            G.toast('Payments are switched off on this server.', 'bad');
          }
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Go Full Grilling — £19 🔥';
          G.toast(err.message, 'bad');
        });
    });

    // Dev unlock (payments off only)
    $('#dev-unlock-btn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/dev-unlock', { method: 'POST' })
        .then(function () {
          return fetchEvent().then(function (d) {
            event = d;
            renderEvent();
            G.toast('Full Grilling unlocked (dev mode) 🔥');
          });
        })
        .catch(function (err) {
          btn.disabled = false;
          G.toast(err.message, 'bad');
        });
    });

    // Roast & Toast: buy (checkout tier=speech)
    $('#speech-buy-btn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Opening the till…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/checkout', {
        method: 'POST',
        body: { tier: 'speech' }
      })
        .then(function (data) {
          if (data && data.url) { location.href = data.url; return; }
          btn.disabled = false;
          btn.textContent = 'Get Roast & Toast — £50 🥂';
          if (data && data.paymentsEnabled === false) {
            G.toast('Payments are switched off on this server.', 'bad');
          }
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Get Roast & Toast — £50 🥂';
          G.toast(err.message, 'bad');
        });
    });

    // Roast & Toast: dev unlock (payments off only)
    $('#speech-dev-unlock-btn').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/dev-unlock', {
        method: 'POST',
        body: { tier: 'speech' }
      })
        .then(function () {
          return fetchEvent().then(function (d) {
            event = d;
            renderEvent();
            G.toast('Roast & Toast unlocked (dev mode) 🥂');
          });
        })
        .catch(function (err) {
          btn.disabled = false;
          G.toast(err.message, 'bad');
        });
    });

    // Speech: build/rebuild — two-tap confirm when it would overwrite text
    var speechBuildArmed = false;
    var speechBuildTimer = null;
    $('#speech-build-btn').addEventListener('click', function () {
      var btn = this;
      var hasText = !!$('#speech-text').value.trim();
      if (hasText && !speechBuildArmed) {
        speechBuildArmed = true;
        btn.textContent = 'Sure? This replaces your edits — tap again';
        clearTimeout(speechBuildTimer);
        speechBuildTimer = setTimeout(function () {
          speechBuildArmed = false;
          btn.textContent = 'Rebuild from scratch';
        }, 5000);
        return;
      }
      clearTimeout(speechBuildTimer);
      speechBuildArmed = false;
      btn.disabled = true;
      btn.textContent = 'Writing…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/speech/build', { method: 'POST' })
        .then(function (data) {
          btn.disabled = false;
          showSpeechText(data.speech, false);
          G.toast(data.source === 'ai'
            ? 'Bespoke speech, freshly written 🥂 Read it out loud once before the night.'
            : 'Speech served. Read it out loud once before the night 🥂');
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = hasText ? 'Rebuild from scratch' : 'Write my speech';
          G.toast(err.message, 'bad');
        });
    });

    // Speech: save edits
    $('#speech-save-btn').addEventListener('click', function () {
      var btn = this;
      var text = $('#speech-text').value;
      if (!text.trim()) { G.toast('The speech needs some words.', 'bad'); return; }
      btn.disabled = true;
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/speech', {
        method: 'PATCH',
        body: { text: text }
      })
        .then(function () {
          btn.disabled = false;
          G.toast('Saved. Practise in the mirror.');
        })
        .catch(function (err) {
          btn.disabled = false;
          G.toast(err.message, 'bad');
        });
    });

    G.wireCopy($('#speech-copy-btn'), function () { return $('#speech-text').value; });

    // AI assistant chat (history lives in this page's memory only)
    var assistantHistory = [];
    function assistantBubble(role, text) {
      var log = $('#assistant-log');
      log.appendChild(el('div', { class: 'chat-bubble chat-' + role, text: text }));
      log.scrollTop = log.scrollHeight;
    }
    function sendToAssistant() {
      var input = $('#assistant-input');
      var text = input.value.trim();
      if (!text) return;
      var btn = $('#assistant-send-btn');
      input.value = '';
      assistantBubble('user', text);
      btn.disabled = true;
      input.disabled = true;
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/assistant', {
        method: 'POST',
        body: { message: text, history: assistantHistory }
      })
        .then(function (data) {
          assistantBubble('assistant', data.reply);
          assistantHistory.push({ role: 'user', content: text });
          assistantHistory.push({ role: 'assistant', content: data.reply });
          if (assistantHistory.length > 20) assistantHistory = assistantHistory.slice(-20);
          if (data.actionsTaken && data.actionsTaken.length) {
            // The assistant changed things — refresh the moderation list + counts
            fetchQuestions().catch(function () {});
            refreshEventSoon();
          }
        })
        .catch(function (err) {
          assistantBubble('assistant', 'Ouch — ' + err.message);
        })
        .then(function () {
          btn.disabled = false;
          input.disabled = false;
          input.focus();
        });
    }
    $('#assistant-send-btn').addEventListener('click', sendToAssistant);
    $('#assistant-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); sendToAssistant(); }
    });

    // Claim by email
    $('#claim-btn').addEventListener('click', function () {
      var emailInput = $('#claim-email');
      var email = emailInput.value.trim();
      if (!email) { G.toast('Pop your email in first.', 'bad'); return; }
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/claim', {
        method: 'POST',
        body: { email: email }
      })
        .then(function () {
          btn.textContent = 'Link sent ✓';
          G.toast('Check your inbox — tap the link to finish claiming.');
          setTimeout(function () {
            btn.disabled = false;
            btn.textContent = 'Claim this quiz';
          }, 4000);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Claim this quiz';
          G.toast(err.message, 'bad');
        });
    });

    G.wireCopy($('#copy-link-btn'), function () { return G.absUrl(event.submissionUrl); });
    G.wireCopy($('#copy-whatsapp-btn'), whatsappMessage);
    G.wireCopy($('#copy-host-btn'), function () { return G.absUrl(event.hostUrl); });

    $('#submit-url').addEventListener('focus', function () { this.select(); });
    $('#host-url').addEventListener('focus', function () { this.select(); });

    // Build / rebuild
    $('#build-btn').addEventListener('click', function () {
      var btn = this;
      var toneEl = document.querySelector('input[name="dash-tone"]:checked');
      var body = toneEl ? { tone: toneEl.value } : {};
      btn.disabled = true;
      btn.textContent = 'Cooking…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/build', { method: 'POST', body: body })
        .then(function (data) {
          btn.disabled = false;
          editingId = null;
          G.toast('Done — ' + (data.questionCount || 0) + ' questions on the grill. Review them below.');
          return Promise.all([
            fetchQuestions(),
            fetchEvent().then(function (d) { event = d; renderEvent(); })
          ]);
        })
        .catch(function (err) {
          btn.disabled = false;
          btn.textContent = 'Build my quiz';
          if (err.status === 409) {
            G.toast("The quiz is locked — it can't be rebuilt now.", 'bad');
          } else {
            G.toast(err.message, 'bad');
          }
        });
    });

    // Ready to play — two-tap confirm, no window.confirm
    var readyBtn = $('#ready-btn');
    readyBtn.addEventListener('click', function () {
      if (!readyArmed) {
        readyArmed = true;
        readyBtn.textContent = 'Sure? This closes submissions — tap again';
        clearTimeout(readyArmTimer);
        readyArmTimer = setTimeout(function () {
          readyArmed = false;
          readyBtn.textContent = 'Ready to play';
        }, 5000);
        return;
      }
      clearTimeout(readyArmTimer);
      readyArmed = false;
      readyBusy = true;
      readyBtn.disabled = true;
      readyBtn.textContent = 'Locking it in…';
      G.api('/api/events/' + encodeURIComponent(organiserKey) + '/ready', { method: 'POST' })
        .then(function () {
          return fetchEvent().then(function (d) {
            event = d;
            readyBusy = false;
            renderEvent();
            G.toast('Locked in. See you at the party 🔥');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        })
        .catch(function (err) {
          readyBusy = false;
          readyBtn.disabled = false;
          readyBtn.textContent = 'Ready to play';
          G.toast(err.message, 'bad');
        });
    });
  }
})();
