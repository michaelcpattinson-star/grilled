'use strict';
/* Grilled — account page (/account): magic-link sign-in + your events. */
(function () {
  var $ = G.$;
  var el = G.el;

  var loadingEl = $('#loading');
  var signinEl = $('#signin');
  var signedinEl = $('#signedin');

  // Arrived via a dud/expired magic link?
  var params = new URLSearchParams(location.search);
  if (params.get('authError')) {
    G.toast('That link has expired or was already used — request a fresh one.', 'bad');
  }
  if (params.get('claimError')) {
    G.toast('That quiz is already claimed by a different email.', 'bad');
  }
  if (params.get('authError') || params.get('claimError')) {
    history.replaceState(null, '', '/account');
  }

  function showSignin() {
    loadingEl.classList.add('hidden');
    signedinEl.classList.add('hidden');
    signinEl.classList.remove('hidden');
  }

  function showSignedIn(me) {
    loadingEl.classList.add('hidden');
    signinEl.classList.add('hidden');
    signedinEl.classList.remove('hidden');
    $('#whoami').textContent = 'Signed in as ' + me.email;

    var zone = $('#events-zone');
    zone.replaceChildren();
    if (!me.events || !me.events.length) {
      zone.appendChild(el('div', { class: 'card' },
        el('p', { class: 'muted', text: 'No quizzes on your account yet. Start one, or open an existing dashboard and hit “Claim this quiz”.' })
      ));
      return;
    }
    me.events.forEach(function (ev) {
      var statusLine = (ev.status === 'collecting' ? 'Collecting the dirt' : 'Locked & loaded') +
        ' · ' + (ev.plan === 'full' ? 'Full Grilling 🔥' : 'Free plan') +
        ' · created ' + String(ev.createdAt).slice(0, 10);
      var card = el('div', { class: 'card card-tight' },
        el('h2', { text: 'Grilling ' + ev.name }),
        el('p', { class: 'muted small', text: ev.occasion + ' · ' + statusLine }),
        el('a', { class: 'btn btn-primary btn-small', href: ev.organiserUrl, text: 'Open dashboard' })
      );
      zone.appendChild(card);
    });
  }

  G.api('/api/me')
    .then(showSignedIn)
    .catch(function () { showSignin(); });

  $('#signin-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('#email-input').value.trim();
    if (!email) { G.toast('Pop your email in first.', 'bad'); return; }
    var btn = $('#send-link-btn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    G.api('/api/auth/request-link', { method: 'POST', body: { email: email } })
      .then(function () {
        $('#signin-form').classList.add('hidden');
        $('#link-sent').classList.remove('hidden');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Email me a magic link ✨';
        G.toast(err.message, 'bad');
      });
  });

  $('#logout-btn').addEventListener('click', function () {
    G.api('/api/auth/logout', { method: 'POST' })
      .then(function () { location.reload(); })
      .catch(function (err) { G.toast(err.message, 'bad'); });
  });
})();
