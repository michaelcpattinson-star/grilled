'use strict';
/* Grilled — anonymous submission form (/s/KEY). Mobile-first. */
(function () {
  var $ = G.$;
  var el = G.el;

  var submissionKey = G.pathKey('s');
  var MAX_CHARS = 500;

  var fields = []; // [{promptKey, input}]

  function show(id) {
    ['loading', 'load-error', 'closed', 'form-screen', 'thanks'].forEach(function (s) {
      $('#' + s).classList.toggle('hidden', s !== id);
    });
  }

  if (!submissionKey) {
    show('load-error');
    return;
  }

  G.api('/api/submit/' + encodeURIComponent(submissionKey))
    .then(function (data) {
      if (!data.open) {
        show('closed');
        return;
      }
      buildForm(data);
      show('form-screen');
    })
    .catch(function (err) {
      if (err.status === 403) {
        show('closed');
      } else {
        $('#load-error-msg').textContent = err.message;
        show('load-error');
      }
    });

  function buildForm(data) {
    var name = data.guestName || 'them';
    document.title = 'Spill the dirt on ' + name + ' — Grilled';
    $('#intro-title').textContent = 'Help us grill ' + name;
    $('#intro-sub').textContent =
      "They'll never know who said what. Answer as many or as few as you like — one is enough.";

    var zone = $('#prompts-zone');
    zone.replaceChildren();
    fields = [];

    (data.prompts || []).forEach(function (prompt, i) {
      var field = el('div', { class: 'field' });
      var inputId = 'prompt-' + i;
      field.appendChild(el('label', { for: inputId, text: prompt.label }));

      // Contract gap: GET /api/submit doesn't include `kind`; the 'word'
      // prompt (short answer) is identified by its stable key.
      var input;
      if (prompt.key === 'word') {
        input = el('input', { type: 'text', id: inputId, autocomplete: 'off' });
      } else {
        input = el('textarea', { id: inputId });
      }
      if (prompt.placeholder) input.setAttribute('placeholder', prompt.placeholder);
      field.appendChild(input);
      zone.appendChild(field);
      G.charCounter(input, MAX_CHARS);

      fields.push({ promptKey: prompt.key, input: input });
    });
  }

  $('#dirt-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var entries = fields
      .map(function (f) { return { promptKey: f.promptKey, text: f.input.value.trim() }; })
      .filter(function (entry) { return entry.text.length > 0; });

    if (entries.length === 0) {
      G.toast('Give us at least one morsel — anything at all.', 'bad');
      return;
    }
    if (entries.some(function (entry) { return entry.text.length > MAX_CHARS; })) {
      G.toast('One of your answers is over ' + MAX_CHARS + ' characters — trim it down a touch.', 'bad');
      return;
    }

    var btn = $('#dish-btn');
    btn.disabled = true;
    btn.textContent = 'Dishing…';
    G.api('/api/submit/' + encodeURIComponent(submissionKey), { method: 'POST', body: { entries: entries } })
      .then(function () {
        btn.disabled = false;
        btn.textContent = 'Dish the dirt 🔥';
        show('thanks');
        window.scrollTo(0, 0);
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Dish the dirt 🔥';
        if (err.status === 403) {
          show('closed');
        } else {
          G.toast(err.message, 'bad');
        }
      });
  });

  $('#again-btn').addEventListener('click', function () {
    fields.forEach(function (f) {
      f.input.value = '';
      f.input.dispatchEvent(new Event('input')); // reset counters
    });
    show('form-screen');
    window.scrollTo(0, 0);
    if (fields[0]) fields[0].input.focus();
  });
})();
