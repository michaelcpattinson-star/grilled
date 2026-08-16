'use strict';
/* Grilled — landing page: rotating grill target + demo button. */
(function () {
  // "Time to grill your ______." — cycle the victim
  var target = G.$('#grill-target');
  if (target) {
    var victims = ['bestie', 'best mate', 'bride-to-be', 'stag', 'birthday boy', 'birthday girl', 'work wife', 'office legend', 'old man'];
    var i = 0;
    setInterval(function () {
      i = (i + 1) % victims.length;
      target.classList.remove('word-swap');
      // restart the CSS animation
      void target.offsetWidth;
      target.textContent = victims[i];
      target.classList.add('word-swap');
    }, 2400);
  }

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
