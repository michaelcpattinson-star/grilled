'use strict';
/* Grilled — shared helpers. No frameworks, no storage APIs.
   Exposes a single global: window.G */
(function () {
  /** querySelector shorthand */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  /**
   * Safe DOM builder. NEVER pass user content through innerHTML —
   * all text lands via textContent/createTextNode.
   * el('div', { class: 'card', text: userText }, child1, 'plain text', ...)
   */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (c instanceof Node) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    }
    return node;
  }

  function humanStatusMessage(status) {
    if (status === 0) return "Couldn't reach the kitchen — check your connection and try again.";
    if (status === 404) return "We couldn't find that — the link might be wrong or the event has been deleted.";
    if (status === 429) return 'Whoa, easy — too many requests. Give it a minute and try again.';
    if (status >= 500) return 'Something went wrong on our end. Give it a moment and try again.';
    return 'Something went wrong. Please try again.';
  }

  /**
   * fetch JSON wrapper. Throws Error with a human .message and .status.
   * api('/api/events', { method: 'POST', body: {...} })
   */
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(
      function (res) {
        return res
          .json()
          .catch(function () { return null; })
          .then(function (data) {
            if (!res.ok) {
              var msg = (data && data.error) ? data.error : humanStatusMessage(res.status);
              var err = new Error(msg);
              err.status = res.status;
              err.data = data;
              throw err;
            }
            return data;
          });
      },
      function () {
        var err = new Error(humanStatusMessage(0));
        err.status = 0;
        throw err;
      }
    );
  }

  /** Toast a short human message. kind: 'ok' (default) | 'bad' */
  function toast(message, kind) {
    var zone = document.getElementById('toast-zone');
    if (!zone) {
      zone = el('div', { id: 'toast-zone', 'aria-live': 'polite' });
      document.body.appendChild(zone);
    }
    var t = el('div', { class: 'toast' + (kind === 'bad' ? ' toast-bad' : ''), role: 'status', text: message });
    zone.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 4000);
  }

  /** Parse a key out of a path like /o/KEY, /host/KEY, /s/KEY */
  function pathKey(prefix) {
    var parts = location.pathname.split('/').filter(function (p) { return p.length > 0; });
    if (parts.length >= 2 && parts[0] === prefix) {
      try { return decodeURIComponent(parts[1]); } catch (e) { return parts[1]; }
    }
    return null;
  }

  /** Make a possibly-relative URL absolute against this origin */
  function absUrl(u) {
    if (!u) return '';
    try { return new URL(u, location.origin).href; } catch (e) { return u; }
  }

  /** Copy text to clipboard; resolves true/false. No storage APIs involved. */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return copyFallback(text); }
      );
    }
    return Promise.resolve(copyFallback(text));
  }

  function copyFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /** Wire a copy button: flashes "Copied ✓" on success. */
  function wireCopy(btn, getText) {
    var original = btn.textContent;
    btn.addEventListener('click', function () {
      copyText(typeof getText === 'function' ? getText() : getText).then(function (ok) {
        if (ok) {
          btn.textContent = 'Copied ✓';
          setTimeout(function () { btn.textContent = original; }, 1800);
        } else {
          toast("Couldn't copy — long-press / select it yourself.", 'bad');
        }
      });
    });
  }

  /** Attach a live character counter under an input/textarea (max chars). */
  function charCounter(input, max) {
    var counter = el('div', { class: 'char-count', 'aria-hidden': 'true' });
    var update = function () {
      counter.textContent = input.value.length + '/' + max;
      counter.classList.toggle('warn', input.value.length >= max - 40);
    };
    input.setAttribute('maxlength', String(max));
    input.addEventListener('input', update);
    update();
    input.insertAdjacentElement('afterend', counter);
    return counter;
  }

  /** Friendly display titles for round keys (fallback: the key itself). */
  var ROUND_TITLES = {
    warmup: 'Round 1 — The Warm-Up',
    stories: 'Round 2 — Whose Story Is This?',
    liedetector: 'Round 3 — The Lie Detector'
  };
  function roundTitle(roundKey) {
    return ROUND_TITLES[roundKey] || roundKey;
  }

  var LETTERS = ['A', 'B', 'C', 'D'];

  window.G = {
    $: $,
    el: el,
    api: api,
    toast: toast,
    pathKey: pathKey,
    absUrl: absUrl,
    copyText: copyText,
    wireCopy: wireCopy,
    charCounter: charCounter,
    roundTitle: roundTitle,
    LETTERS: LETTERS
  };
})();
