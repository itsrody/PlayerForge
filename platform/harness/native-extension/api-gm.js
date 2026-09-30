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
// match Violentmonkey 2.49.0, not the older lenient stubs, so the suite
// validates the code that actually ships:
//
//   GM_registerMenuCommand       -> returns options.id || caption
//   GM_unregisterMenuCommand     -> takes that key
//   GM_addValueChangeListener    -> fresh id per call, many per key
//   GM_removeValueChangeListener -> takes that id
//   value changes                -> other-context writes only, remote === true
//   GM_getValue / GM_getResourceText -> synchronous
//
// Modelling the real manager matters most for the listener table. An earlier
// version of this file held one callback per key and returned the key, which is
// FireMonkey's shape; under that model a second shell subscribing to the same
// key silently displaced the first and the suite still passed, because nothing
// here covered two shells on one key. VM instead mints a fresh id per call
// (`s || (s = x("VMvc"), n[s] = cb)`) into a per-key table and delivers to every
// registration, so the harness now does the same and dispatch iterates a list.
(function () {
  var STORAGE = {};
  var META = null;
  var listeners = Object.create(null); // key -> { id -> callback }
  var menuCaptions = [];
  var tick = null;

  function sync() {
    var fresh = PF_storage();
    for (var k in fresh) STORAGE[k] = fresh[k];
    return fresh;
  }

  // The harness delivers only cross-context writes and always reports
  // remote === true, which is the conservative direction: a listener that
  // mishandles a same-context echo fails to react, rather than one that
  // mishandles a genuine remote change acting on a value the user did not move
  // here. VM's callback carries a `remote` flag precisely to separate the two.
  // There is no second tab to write from, so cross-context writes are simulated
  // by re-reading the privileged snapshot and firing a listener for any key that
  // moved.
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
      // Every registration under the key hears about the change, and one
      // misbehaving subscriber must not stop the rest - which is exactly the
      // case the removed per-key fan-out used to be responsible for.
      for (var id in listeners[key]) {
        try {
          listeners[key][id](key, oldValue, next, true);
        } catch (e) {
          console.error("[harness] value-change subscriber threw", e);
        }
      }
    }
    tick = setTimeout(pump, 100);
  }

  var nextListenerId = 0;

  function watch(key, callback) {
    var table = listeners[key];
    if (!table) table = listeners[key] = Object.create(null);
    var id = "VMvc" + ++nextListenerId; // VM's own id prefix
    table[id] = callback;
    if (tick === null) tick = setTimeout(pump, 100);
    return id;
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
    return watch(key, callback);
  };

  globalThis.GM_removeValueChangeListener = function (id) {
    // VM walks the keys looking for the id rather than indexing by it, so a
    // stale or foreign handle is a no-op instead of a crash.
    for (var key in listeners) {
      if (id in listeners[key]) {
        delete listeners[key][id];
        if (Object.keys(listeners[key]).length === 0) delete listeners[key];
        return;
      }
    }
  };

  // VM clones the options object, keys the entry on options.id || caption and
  // returns that key, so the handle is always usable - unlike the manager this
  // file used to model, which returned undefined and forced the caller to invent
  // a handle from the caption.
  globalThis.GM_registerMenuCommand = function (caption, onClick, options) {
    var key = (options && options.id) || caption;
    menuCaptions.push({ caption: caption, key: key, onClick: onClick, options: options });
    return key;
  };

  globalThis.GM_unregisterMenuCommand = function (key) {
    for (var i = 0; i < menuCaptions.length; i++) {
      if (menuCaptions[i].key === key) {
        menuCaptions.splice(i, 1);
        return;
      }
    }
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
