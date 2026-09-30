// ---------- api-gm.js (runs as a `file` entry INSIDE the userScript world) ----------
//
// Placed exactly where FireMonkey puts its own api-gm.js
// (src/content/userscript.js:226-228):
//
//   js: [{ file: '/content/api-gm.js' },
//        { code: 'initUserScript(<metadata>)' },
//        ...userCode]
//
// Everything below lands on the userScript's own global, so the bundle body
// that runs after this entry sees plain GM_* identifiers. Semantics deliberately
// match FireMonkey v3, not the old lenient TM/VM-shaped stubs, so the suite
// validates the code the migration actually ships:
//
//   GM_registerMenuCommand       -> undefined; the caption is the handle
//   GM_unregisterMenuCommand     -> takes that caption
//   GM_addValueChangeListener    -> returns the key, one callback per key
//   GM_removeValueChangeListener -> takes that key
//   value changes                -> other-context writes only, remote === true
//   GM_getValue / GM_getResourceText -> synchronous
(function () {
  var STORAGE = {};
  var META = null;
  var listeners = Object.create(null); // key -> callback
  var menuCaptions = [];
  var tick = null;

  function sync() {
    var fresh = PF_storage();
    for (var k in fresh) STORAGE[k] = fresh[k];
    return fresh;
  }

  // FireMonkey never delivers a script's own writes back to its change
  // listeners, and always reports remote === true. The harness has no second
  // tab to write from, so cross-context writes are simulated by re-reading the
  // privileged snapshot and firing a listener for any key that moved.
  function pump() {
    if (Object.keys(listeners).length === 0) {
      tick = null;
      return;
    }
    var fresh = sync();
    for (var key in listeners) {
      var next = fresh[key];
      if (next === undefined && STORAGE[key] === undefined) continue;
      if (Object.is(next, STORAGE[key])) continue;
      var oldValue = STORAGE[key];
      STORAGE[key] = next;
      try {
        listeners[key](key, oldValue, next, true);
      } catch (e) {
        // One misbehaving subscriber must not stop the others.
        console.error("[harness] value-change subscriber threw", e);
      }
    }
    tick = setTimeout(pump, 100);
  }

  function watch(key) {
    if (tick === null) tick = setTimeout(pump, 100);
    return key;
  }

  sync();

  globalThis.GM_getValue = function (key, fallback) {
    sync();
    return Object.hasOwn(STORAGE, key) ? STORAGE[key] : fallback;
  };

  globalThis.GM_setValue = function (key, value) {
    STORAGE[key] = value;
    PF_setValue(key, value);
  };

  globalThis.GM_deleteValue = function (key) {
    delete STORAGE[key];
    PF_deleteValue(key);
  };

  globalThis.GM_addValueChangeListener = function (key, callback) {
    listeners[key] = callback; // FireMonkey keeps exactly one per key
    return watch(key);
  };

  globalThis.GM_removeValueChangeListener = function (handle) {
    delete listeners[handle];
  };

  globalThis.GM_registerMenuCommand = function (caption) {
    menuCaptions.push(caption);
    return undefined;
  };

  globalThis.GM_unregisterMenuCommand = function (caption) {
    var i = menuCaptions.indexOf(caption);
    if (i !== -1) menuCaptions.splice(i, 1);
  };

  // Synchronous, as under FireMonkey. The harness deliberately serves an empty
  // body: the bundle adopts its embedded stylesheet synchronously and treats
  // @resource as a background upgrade, so an empty text keeps integration
  // assertions about layout and subtitles independent of remote CSS.
  globalThis.GM_getResourceText = function () {
    return "";
  };

  globalThis.GM_xmlhttpRequest = function () {
    // No test issues a manager XHR; the real @connect path needs a live host.
  };

  globalThis.initUserScript = function (data) {
    META = data || {};
    globalThis.GM_info = META.info || {};
    // The store arrives inlined with the metadata so the very first
    // GM_getValue is synchronous and already seeded.
    STORAGE = { ...(META.storage || {}) };
    delete globalThis.initUserScript;
  };

})();
