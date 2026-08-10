'use strict';
/* Grilled — event creation form. POST /api/events → /o/{organiserKey} */
(function () {
  var form = G.$('#new-form');
  var nameInput = G.$('#guest-name');
  var occasionInput = G.$('#occasion');
  var nameError = G.$('#name-error');
  var occasionError = G.$('#occasion-error');
  var createBtn = G.$('#create-btn');

  // Quick-pick chips fill the occasion field.
  document.querySelectorAll('.chip[data-occasion]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      occasionInput.value = chip.dataset.occasion;
      occasionError.classList.add('hidden');
      document.querySelectorAll('.chip[data-occasion]').forEach(function (c) {
        c.setAttribute('aria-pressed', c === chip ? 'true' : 'false');
      });
    });
  });

  nameInput.addEventListener('input', function () { nameError.classList.add('hidden'); });
  occasionInput.addEventListener('input', function () { occasionError.classList.add('hidden'); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = nameInput.value.trim();
    var occasion = occasionInput.value.trim();
    var toneEl = form.querySelector('input[name="tone"]:checked');
    var tone = toneEl ? toneEl.value : 'medium';

    var bad = false;
    if (!name) { nameError.classList.remove('hidden'); nameInput.focus(); bad = true; }
    if (!occasion) {
      occasionError.classList.remove('hidden');
      if (!bad) occasionInput.focus();
      bad = true;
    }
    if (bad) return;

    createBtn.disabled = true;
    createBtn.textContent = 'Lighting the coals…';
    G.api('/api/events', { method: 'POST', body: { name: name, occasion: occasion, tone: tone } })
      .then(function (data) {
        if (data && data.organiserKey) {
          location.href = '/o/' + encodeURIComponent(data.organiserKey);
        } else {
          throw new Error('Something went wrong creating the event. Try again.');
        }
      })
      .catch(function (err) {
        createBtn.disabled = false;
        createBtn.textContent = 'Fire up the quiz';
        G.toast(err.message, 'bad');
      });
  });
})();
