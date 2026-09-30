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
  // Two views of the store, and keeping them apart is the whole trick.
  //
  //   STORAGE  the realm's working view. Seeded SYNCHRONOUSLY by
  //            initUserScript from the payload inlined in the registration, then
  //            by our own GM_setValue/GM_deleteValue, then by whatever pump()
  //            accepts. This is what GM_getValue returns.
  //   BASELINE what the realm believes privileged storage last held, per key.
  //            pump() decides "did this change?" by comparing against THIS, never
  //            against STORAGE.
  //
  // If pump compared against STORAGE it would be defeated by its own reads: a
  // GM_getValue that merged the new value in would leave nothing for pump to
  // notice, and the delivery would be silently swallowed by a page that merely
  // looked at the value. A read must never be able to suppress a change.
  var STORAGE = {};
  var BASELINE = {};
  var META = null;
  var listeners = Object.create(null); // key -> { id -> callback }
  var menuCaptions = [];
  var tick = null;

  // Reads the content script's mirror of extension storage, WITHOUT merging
  // anything. Two separate defects lived in the version this replaced, and both
  // had to be untangled at once:
  //
  //  1. It merged into STORAGE, and pump() then compared fresh[key] against
  //     STORAGE[key] - two values the merge had just made identical. Object.is
  //     was therefore always true, the loop always `continue`d, and cross-context
  //     value changes were NEVER delivered. The whole GM_addValueChangeListener
  //     path was dead code, which is why a listener table that silently displaced
  //     a same-key peer went unnoticed for so long.
  //  2. It was the only thing the old GM_getValue read, and that mirror is
  //     populated by an async browser.storage read in the content script. At
  //     document_start it is still empty, so a first read lost the inlined seed
  //     entirely and the shell created its own entry over the top of it.
  //
  // Callers merge where merging is safe (a read, which cannot suppress a change)
  // and compare against BASELINE where it is not (pump).
  function readPrivileged() {
    return PF_storage();
  }

  // Deliveries happen inside the userScript realm, which WebDriver cannot see:
  // a listener that is never called and a listener that is called twice look
  // identical from the page world. Reporting over the existing PF_report
  // channel is the only way a test can assert what the GM layer actually did.
  function report(payload) {
    try {
      PF_report(payload);
    } catch (e) {
      // Diagnostics must never be able to break the harness.
    }
  }

  // The privileged snapshot arrives as a freshly structured-cloned object on
  // every poll, so identity is always false for object values. Comparing by
  // content is what keeps an unchanged store from re-delivering every 100ms -
  // a spurious delivery would drive PF's resume and config watchers in a loop.
  // The store only ever holds plain JSON-compatible data, so a stable
  // serialization is an adequate equality here.
  function sameValue(a, b) {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch (e) {
      return false;
    }
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
    var fresh = readPrivileged();
    for (var key in listeners) {
      var next = fresh[key];
      if (next === undefined && !Object.hasOwn(BASELINE, key)) continue;
      if (sameValue(next, BASELINE[key])) continue;
      var oldValue = BASELINE[key];
      // Absorb into the working view too, so a read immediately after a delivery
      // agrees with what the subscriber was just told.
      if (next === undefined) {
        delete STORAGE[key];
        delete BASELINE[key];
      } else {
        STORAGE[key] = next;
        BASELINE[key] = next;
      }
      // Every registration under the key hears about the change, and one
      // misbehaving subscriber must not stop the rest - which is exactly the
      // case the removed per-key fan-out used to be responsible for.
      var notified = 0;
      for (var id in listeners[key]) {
        notified++;
        try {
          listeners[key][id](key, oldValue, next, true);
        } catch (e) {
          console.error("[harness] value-change subscriber threw", e);
        }
      }
      report({ ev: "gm:deliver", key: key, notified: notified, remote: true });
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
    report({ ev: "gm:register", key: key, id: id, total: Object.keys(table).length });
    return id;
  }

  // GM_getValue is synchronous in both the target and the harness, so it cannot
  // await a refresh, and it must not read the privileged mirror directly: that
  // mirror is populated by an async browser.storage read in the content script,
  // so at document_start it is still EMPTY and a read from it loses a seeded
  // value outright. The inlined registration payload is the synchronous
  // authority, and that is what STORAGE holds.
  //
  // The mirror is still merged in when it has arrived, so a long-lived document
  // sees writes made after it booted. The merge is deliberately one-way: it adds
  // and overwrites keys the mirror actually has, and never removes one. A key
  // missing from the mirror usually means the mirror has not loaded yet, and
  // treating that as a deletion would erase the seed. Genuine remote deletions are
  // pump()'s job, which can tell "absent" from "not loaded yet" by comparing
  // against BASELINE.
  globalThis.GM_getValue = function (key, fallback) {
    var fresh = readPrivileged();
    for (var k in fresh) STORAGE[k] = fresh[k];
    return Object.hasOwn(STORAGE, key) ? STORAGE[key] : fallback;
  };

  globalThis.GM_setValue = function (key, value) {
    STORAGE[key] = value;
    // Our own write is not a remote change. Recording it in BASELINE is what
    // stops pump() from delivering our own write back to us.
    BASELINE[key] = value;
    PF_setValue(key, value);
  };

  globalThis.GM_deleteValue = function (key) {
    delete STORAGE[key];
    delete BASELINE[key];
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
        var left = Object.keys(listeners[key]).length;
        if (left === 0) delete listeners[key];
        report({ ev: "gm:remove", key: key, id: id, remaining: left });
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
    // GM_getValue is synchronous and already seeded. BASELINE starts identical,
    // because an inlined seed is not a change: nothing has moved since the
    // document was told what the store held.
    STORAGE = { ...(META.storage || {}) };
    BASELINE = { ...(META.storage || {}) };
    delete globalThis.initUserScript;
  };

})();
