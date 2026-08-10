'use strict';
/* Grilled — landing page: demo button. */
(function () {
  var demoBtn = G.$('#demo-btn');
  if (!demoBtn) return;

  demoBtn.addEventListener('click', function () {
    var original = demoBtn.textContent;
    demoBtn.disabled = true;
    demoBtn.textContent = 'Firing up the demo…';
    G.api('/api/demo', { method: 'POST' })
      .then(function (data) {
        if (data && data.organiserKey) {
          location.href = '/o/' + encodeURIComponent(data.organiserKey);
        } else {
          throw new Error('The demo came back half-baked. Try again in a moment.');
        }
      })
      .catch(function (err) {
        demoBtn.disabled = false;
        demoBtn.textContent = original;
        G.toast(err.message, 'bad');
      });
  });
})();
