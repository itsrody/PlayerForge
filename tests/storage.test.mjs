import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let stored = {};
globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
globalThis.GM_setValue = (key, value) => { stored[key] = value; };

const { KEYS, getConfigValue, setConfigValue, setConfigFields, deleteConfigField, configStore, loadJsonObject, gmSetValue, gmRequestText } = await import("../src/shared/storage.js");

// The store owns the configs document, so seeding `stored` is no longer enough
// on its own: a store that already owns a document never re-reads storage.
// Every case seeds through here, which both writes manager storage and adopts
// it - exactly what a cold page load or a cross-tab write does.
function seed(doc) {
  stored = { [KEYS.configs]: doc };
  configStore.adopt(doc);
}

beforeEach(() => seed({ version: 1 }));

test("getConfigValue resolves dotted paths with fallbacks", () => {
  seed({ version: 1, ui: { volume: 0.5 } });
  assert.equal(getConfigValue("ui.volume"), 0.5);
  assert.equal(getConfigValue("ui.missing", "fb"), "fb");
  assert.equal(getConfigValue("nope.deeper", null), null);
});

test("getConfigValue rejects prototype-walking segments like writes do", () => {
  // A hostile doc must not turn a read path into traversal either.
  seed({});
  assert.equal(getConfigValue("__proto__.polluted", "safe"), "safe");
  assert.equal(getConfigValue("constructor.prototype.x", "safe"), "safe");
  assert.equal(getConfigValue("ok.__proto__.x", "safe"), "safe");
});

test("deleteConfigField removes leaves and tolerates missing paths", () => {
  seed({ version: 1, firstRun: false, ui: { volume: 1, nested: { deep: 2 } } });

  deleteConfigField("firstRun");
  assert.ok(!("firstRun" in stored[KEYS.configs]));
  assert.equal(stored[KEYS.configs].version, 1);

  deleteConfigField("ui.nested.deep");
  assert.deepEqual(stored[KEYS.configs].ui.nested, {});

  const before = JSON.stringify(stored[KEYS.configs]);
  deleteConfigField("ui.nope.deep");
  deleteConfigField("__proto__.x");
  deleteConfigField("");
  assert.equal(JSON.stringify(stored[KEYS.configs]), before);
});

test("setConfigFields applies many fields in one write", () => {
  let setCalls = 0;
  const realSet = globalThis.GM_setValue;
  globalThis.GM_setValue = (key, value) => {
    setCalls += 1;
    stored[key] = value;
  };
  seed({ filter: {} });

  setConfigFields({
    "filter.brightness": 150,
    "filter.contrast": 110,
    "filter.saturation": 90,
    "ui.gestures": false
  });

  globalThis.GM_setValue = realSet;
  assert.equal(setCalls, 1, "single write for the whole batch");
  assert.equal(stored[KEYS.configs].filter.brightness, 150);
  assert.equal(stored[KEYS.configs].filter.contrast, 110);
  assert.equal(stored[KEYS.configs].filter.saturation, 90);
  assert.equal(stored[KEYS.configs].ui.gestures, false);
});

test("setConfigValue delegates to setConfigFields (single write)", () => {
  seed({});
  let setCalls = 0;
  const realSet = globalThis.GM_setValue;
  globalThis.GM_setValue = (key, value) => {
    setCalls += 1;
    stored[key] = value;
  };

  setConfigValue("ui.volume", 0.8);

  globalThis.GM_setValue = realSet;
  assert.equal(setCalls, 1);
  assert.equal(stored[KEYS.configs].ui.volume, 0.8);
});

test("config reads are cached until the document is replaced", () => {
  seed({ ui: { volume: 0.5 } });

  let reads = 0;
  const realGet = globalThis.GM_getValue;
  globalThis.GM_getValue = (key, fallback) => {
    reads += 1;
    return realGet(key, fallback);
  };
  try {
    assert.equal(getConfigValue("ui.volume"), 0.5);
    const afterWarm = reads;
    getConfigValue("ui.volume");
    getConfigValue("ui.missing", -1);
    assert.equal(reads, afterWarm, "further reads served from cache, no GM re-read");
  } finally {
    globalThis.GM_getValue = realGet;
  }
});

test("adopting a replacement document makes its values readable at once", () => {
  seed({ ui: { volume: 0.5 } });
  getConfigValue("ui.volume"); // warm cache

  // Another tab replaced the doc and the manager delivered the new value.
  assert.equal(getConfigValue("ui.volume"), 0.5, "unchanged until the write is announced");

  configStore.adopt({ ui: { volume: 0.9 } });
  assert.equal(getConfigValue("ui.volume"), 0.9, "fresh as soon as it is adopted");
});

test("adopting a document never re-reads storage", () => {
  configStore.adopt({ ui: { volume: 0.5 } });
  let reads = 0;
  const realGet = globalThis.GM_getValue;
  globalThis.GM_getValue = (key, fallback) => {
    reads += 1;
    return realGet(key, fallback);
  };
  try {
    // The manager handed us the document; taking it must not re-fetch it.
    configStore.adopt({ ui: { volume: 0.9 }, extra: { deep: 1 } });
    assert.equal(getConfigValue("ui.volume"), 0.9);
    assert.equal(getConfigValue("extra.deep"), 1);
    assert.equal(reads, 0, "the delivered value was used, not re-read");
  } finally {
    globalThis.GM_getValue = realGet;
  }
});

test("adopt reports only the paths that actually moved", () => {
  configStore.adopt({ ui: { volume: 0.5, compact: false }, gestures: { hold: true } });
  const paths = configStore.adopt({ ui: { volume: 0.5, compact: true }, gestures: { hold: true } });
  assert.deepEqual([...paths], ["ui.compact"], "unchanged siblings are not reported");
});

test("adopt reports a removed leaf as changed", () => {
  configStore.adopt({ ui: { volume: 0.5, legacy: 1 } });
  const paths = configStore.adopt({ ui: { volume: 0.5 } });
  assert.deepEqual([...paths], ["ui.legacy"], "a deleted leaf still counts as a change");
});

test("adopt descends into a subtree that arrives or leaves wholesale", () => {
  // A subscriber filters on exact leaf paths, so a branch that appears in one
  // write must report the leaves inside it - not the branch name.
  configStore.adopt({ version: 1 });
  const added = configStore.adopt({
    version: 1,
    settings: { controller: { stepSeek: 15 }, gestures: { hotkeys: false } }
  });
  assert.deepEqual(
    [...added].sort(),
    ["settings.controller.stepSeek", "settings.gestures.hotkeys"],
    "an added branch reports its leaves"
  );

  const removed = configStore.adopt({ version: 1 });
  assert.deepEqual(
    [...removed].sort(),
    [
      "settings",
      "settings.controller",
      "settings.controller.stepSeek",
      "settings.gestures",
      "settings.gestures.hotkeys"
    ],
    "a removed branch reports the emptied branches and the leaves they held"
  );
});

test("a leaf replacing a branch announces both the new value and the lost leaves", () => {
  configStore.adopt({ ui: { volume: 0.5 } });
  const paths = configStore.adopt({ ui: 7 });
  assert.deepEqual(
    [...paths].sort(),
    ["ui", "ui.volume"],
    "the collapsing path carries the new value, the old leaf must be re-read"
  );
});

test("a removed branch announces the leaves its subscribers read", () => {
  configStore.adopt({ ui: { volume: 0.5, compact: true } });
  const paths = configStore.adopt({});
  assert.deepEqual(
    [...paths].sort(),
    ["ui", "ui.compact", "ui.volume"],
    "both leaves and the emptied branch are reported"
  );
});

test("subscribers learn the changed paths and remote origin", () => {
  seed({ version: 1 });
  const events = [];
  const off = configStore.onChange((event) => events.push(event));
  configStore.adopt({ version: 1, ui: { volume: 0.9 } }, { remote: true });
  off();
  configStore.adopt({ version: 1, ui: { volume: 0.1 } });
  assert.equal(events.length, 1, "no notifications after unsubscribe");
  assert.deepEqual([...events[0].paths], ["ui.volume"]);
  assert.equal(events[0].remote, true, "origin survives adoption");
  assert.equal(events[0].doc.ui.volume, 0.9, "the document already reflects the change");
});

test("a local write notifies once, and the manager echo stays a no-op", () => {
  const events = [];
  configStore.onChange((event) => events.push(event));
  setConfigValue("ui.volume", 0.7);
  // A manager that fires its change listener for own-tab writes too, with the
  // document it was just handed.
  configStore.adopt(stored[KEYS.configs], { remote: false });
  assert.equal(events.length, 1, "the echo must not double-fire");
  assert.deepEqual([...events[0].paths], ["ui.volume"]);
  assert.equal(events[0].remote, false, "a local write reports remote: false");
});

test("a failed write rolls the cache back", () => {
  const realSet = globalThis.GM_setValue;
  // Seed through storage, not adopt-alone: adopting a document storage does
  // not hold creates the exact divergence the write-time rebase exists to
  // heal, so the rollback would restore a document that was never the truth.
  seed({ ui: { volume: 0.5 } });
  globalThis.GM_setValue = () => {
    throw new Error("quota");
  };
  try {
    assert.equal(configStore.set({ "ui.volume": 0.9 }), false);
  } finally {
    globalThis.GM_setValue = realSet;
  }
  assert.equal(getConfigValue("ui.volume"), 0.5, "the rolled-back document is the one that survived");
});

test("onChange detaches with an AbortSignal", () => {
  const ac = new AbortController();
  let calls = 0;
  configStore.onChange(() => { calls += 1; }, { signal: ac.signal });
  configStore.adopt({ a: 1 });
  ac.abort();
  configStore.adopt({ a: 2 });
  assert.equal(calls, 1, "the signal-detached listener stopped receiving");
});

test("the configs GM listener is removed when the last subscriber goes away", async () => {
  const { ConfigStore } = await import("../src/shared/storage.js");
  const added = [];
  const removed = [];
  const realAdd = globalThis.GM_addValueChangeListener;
  const realRemove = globalThis.GM_removeValueChangeListener;
  globalThis.GM_addValueChangeListener = (key, cb) => {
    added.push({ key, cb });
    return added.length;
  };
  globalThis.GM_removeValueChangeListener = (handle) => {
    removed.push(handle);
  };
  try {
    const store = new ConfigStore();
    store.adopt({ version: 1 });
    const offA = store.onChange(() => {});
    const offB = store.onChange(() => {});
    assert.equal(added.length, 1, "subscribing starts the manager listener");
    assert.equal(added[0].key, KEYS.configs);

    offA();
    assert.deepEqual(removed, [], "another consumer is still listening");

    // The handle used to be dropped on the floor, so the GM subscription
    // outlived every subscriber and each remote write kept being adopted into
    // a document nobody read.
    offB();
    assert.deepEqual(removed, [1], "the last unsubscribe removed the GM listener");
  } finally {
    globalThis.GM_addValueChangeListener = realAdd;
    globalThis.GM_removeValueChangeListener = realRemove;
  }
});

test("two shells on one key each keep an independent subscription", async () => {
  // Violentmonkey 2.49.0's shape: injected-web.js mints a fresh id per call
  // (`s || (s = x("VMvc"), n[s] = cb)`) into a per-key table and delivers to
  // every registration, so the handle is the manager's own and passes straight
  // through. PlayerForge has more than one live subscriber per key - every
  // shell owns a ResumeStore - so this pins that neither shadows nor silences
  // the other.
  const { gmAddValueChangeListener, gmRemoveValueChangeListener } = await import("../src/shared/storage.js");
  const KEY = "pf:test:multi-subscriber";
  const added = [];
  const removed = [];
  const live = new Map();
  const realAdd = globalThis.GM_addValueChangeListener;
  const realRemove = globalThis.GM_removeValueChangeListener;
  let next = 0;
  globalThis.GM_addValueChangeListener = (key, cb) => {
    const id = `VMvc${++next}`;
    added.push([key, id]);
    live.set(id, cb);
    return id;
  };
  globalThis.GM_removeValueChangeListener = (id) => {
    removed.push(id);
    live.delete(id);
  };
  try {
    const seenA = [];
    const seenB = [];
    const handleA = gmAddValueChangeListener(KEY, (...args) => seenA.push(args));
    const handleB = gmAddValueChangeListener(KEY, (...args) => seenB.push(args));

    assert.equal(added.length, 2, "the manager sees one subscription per caller");
    assert.notEqual(handleA, handleB, "each caller gets a distinct manager id");

    for (const cb of live.values()) cb(KEY, 1, 2, true);
    assert.equal(seenA.length, 1, "first subscriber delivered to");
    assert.equal(seenB.length, 1, "second subscriber delivered to, not dropped");

    // A teardown must remove only its own subscription: every shell owns a
    // ResumeStore, so removing the wrong id would kill cross-tab resume on
    // every younger shell.
    gmRemoveValueChangeListener(handleA);
    assert.deepEqual(removed, [handleA], "only the removed shell's id is unregistered");
    live.get(handleB)(KEY, 2, 3, true);
    assert.equal(seenA.length, 1, "the removed subscriber stopped receiving");
    assert.equal(seenB.length, 2, "the surviving subscriber still receives");

    gmRemoveValueChangeListener(handleB);
    assert.deepEqual(removed, [handleA, handleB], "both removals forwarded");
    assert.equal(live.size, 0, "nothing left registered");
  } finally {
    globalThis.GM_addValueChangeListener = realAdd;
    globalThis.GM_removeValueChangeListener = realRemove;
  }
});

test("a throwing value-change subscriber does not starve its peers", async () => {
  const { gmAddValueChangeListener, gmRemoveValueChangeListener } = await import("../src/shared/storage.js");
  const KEY = "pf:test:fanout-throw";
  let fire;
  const realError = console.error;
  globalThis.GM_addValueChangeListener = (key, cb) => {
    fire = cb;
    return key;
  };
  globalThis.GM_removeValueChangeListener = () => {};
  console.error = () => {};
  try {
    const seen = [];
    const handleA = gmAddValueChangeListener(KEY, () => {
      throw new Error("subscriber blew up");
    });
    const handleB = gmAddValueChangeListener(KEY, (...args) => seen.push(args));
    // Independent manager listeners never shared a dispatch loop, so fanning
    // out locally must not let one bad subscriber skip the rest.
    fire(KEY, 1, 2, true);
    assert.equal(seen.length, 1, "the healthy subscriber still received the event");
    gmRemoveValueChangeListener(handleA);
    gmRemoveValueChangeListener(handleB);
  } finally {
    console.error = realError;
    delete globalThis.GM_addValueChangeListener;
    delete globalThis.GM_removeValueChangeListener;
  }
});

test("re-subscribing after an unwatch window re-arms and re-reads", async () => {
  const { ConfigStore } = await import("../src/shared/storage.js");
  const realAdd = globalThis.GM_addValueChangeListener;
  const realRemove = globalThis.GM_removeValueChangeListener;
  let added = 0;
  globalThis.GM_addValueChangeListener = () => ++added;
  globalThis.GM_removeValueChangeListener = () => {};
  try {
    stored = { [KEYS.configs]: { version: 1, ui: { volume: 0.2 } } };
    const store = new ConfigStore();
    const off = store.onChange(() => {});
    off();

    // A cross-tab write lands while nothing is subscribed: with the listener
    // gone there is no notification, so the cached doc is now a document the
    // store has no way to know is stale.
    stored[KEYS.configs] = { version: 1, ui: { volume: 0.8 } };

    store.onChange(() => {});
    assert.equal(added, 2, "a new subscriber re-armed the GM listener");
    assert.equal(store.doc().ui.volume, 0.8, "the re-armed store did not serve a stale document");
  } finally {
    globalThis.GM_addValueChangeListener = realAdd;
    globalThis.GM_removeValueChangeListener = realRemove;
  }
});

test("setConfigFields commits the cache in sync with storage", () => {
  seed({ filter: { brightness: 100 } });
  setConfigFields({ "filter.brightness": 150, "filter.contrast": 110 });
  // Reads come from the committed cache - no need to re-read storage.
  assert.equal(getConfigValue("filter.brightness"), 150);
  assert.equal(getConfigValue("filter.contrast"), 110);
  assert.equal(stored[KEYS.configs].filter.brightness, 150);
});

/* - Key-set fast path (collectChangedPaths) - */

/**
 * The diff takes a same-shape fast path when both branches hold the same keys,
 * which is every ordinary settings write. These cases pin the boundary of that
 * shortcut: two branches of EQUAL LENGTH but different key sets must still
 * take the general path, or a rename would report nothing at all.
 */
test("equal-length branches with different keys still report both sides", () => {
  configStore.adopt({ ui: { volume: 0.5, compact: false } });
  // Same key count, one key RENAMED: a length-only check would call this a
  // same-shape write and drop the change entirely.
  const renamed = configStore.adopt({ ui: { volume: 0.5, dense: false } });
  assert.deepEqual([...renamed].sort(), ["ui.compact", "ui.dense"], "a renamed key is both lost and gained");

  // Same again at the top level, where the check runs on the root branch.
  configStore.adopt({ alpha: 1, beta: 2 });
  const swapped = configStore.adopt({ alpha: 1, gamma: 2 });
  assert.deepEqual([...swapped].sort(), ["beta", "gamma"], "a top-level rename is reported on both keys");
});

test("a same-shape write reports only the leaf that moved", () => {
  configStore.adopt({
    version: 1,
    settings: { controller: { stepSeek: 5 }, gestures: { hold: true, scrub: true } }
  });
  const paths = configStore.adopt({
    version: 1,
    settings: { controller: { stepSeek: 10 }, gestures: { hold: true, scrub: true } }
  });
  assert.deepEqual([...paths], ["settings.controller.stepSeek"], "the fast path still walks every leaf");
});

test("a same-shape write into a branch that also changed shape reports both", () => {
  configStore.adopt({ settings: { gestures: { hold: true, scrub: true }, ui: { compact: false } } });
  // settings changes shape (a leaf is removed) AND keeps two same-shape
  // branches: the removed leaf must not be lost by the shortcut.
  const paths = configStore.adopt({ settings: { gestures: { hold: false, scrub: true } } });
  assert.deepEqual([...paths].sort(), ["settings.gestures.hold", "settings.ui", "settings.ui.compact"]);
});

test("one throwing change listener does not strand the others", () => {
  const seen = [];
  const ac = new AbortController();
  configStore.onChange(() => {
    throw new Error("listener blew up");
  }, { signal: ac.signal });
  configStore.onChange(() => seen.push("second"), { signal: ac.signal });
  configStore.onChange(() => seen.push("third"), { signal: ac.signal });

  // Must not throw out of the write: the value is already durably stored by
  // this point, so an escaping listener error would report a failed write that
  // actually succeeded.
  setConfigValue("ui.volume", 0.4);

  assert.deepEqual(seen, ["second", "third"], "a throwing listener skipped its peers");
  assert.equal(getConfigValue("ui.volume", 0), 0.4, "the write itself still landed");
  ac.abort();
});

test("a throwing listener cannot break adoption or roll back the document", () => {
  seed({ version: 1 });
  const ac = new AbortController();
  configStore.onChange(() => {
    throw new Error("listener blew up");
  }, { signal: ac.signal });

  configStore.adopt({ version: 1, ui: { volume: 0.9 } });

  assert.equal(getConfigValue("ui.volume", 0), 0.9, "adopted document was rolled back");
  assert.equal(configStore.doc().ui.volume, 0.9, "the store stopped serving the adopted doc");
  ac.abort();
});

test("unsubscribing from inside a change listener still notifies the peers", () => {
  // #emit snapshots the listener set, so a listener that tears down a peer
  // (or itself) mid-dispatch must not silently cancel that peer's delivery.
  const seen = [];
  const ac = new AbortController();
  let offSecond;
  configStore.onChange(() => seen.push("first"), { signal: ac.signal });
  offSecond = configStore.onChange(() => {
    seen.push("second");
    offSecond();
  }, { signal: ac.signal });
  configStore.onChange(() => seen.push("third"), { signal: ac.signal });

  setConfigValue("ui.volume", 0.6);

  assert.deepEqual(seen, ["first", "second", "third"]);
  seen.length = 0;
  setConfigValue("ui.volume", 0.65);
  assert.deepEqual(seen, ["first", "third"], "the self-unsubscribed listener kept firing");
  ac.abort();
});

/* - Grant-less and corrupt-host hardening - */

function withoutGrants(fn) {
  const saved = {
    get: globalThis.GM_getValue,
    set: globalThis.GM_setValue,
    xhr: globalThis.GM_xmlhttpRequest
  };
  delete globalThis.GM_getValue;
  delete globalThis.GM_setValue;
  delete globalThis.GM_xmlhttpRequest;
  try {
    return fn();
  } finally {
    globalThis.GM_getValue = saved.get;
    globalThis.GM_setValue = saved.set;
    if (saved.xhr !== undefined) {
      globalThis.GM_xmlhttpRequest = saved.xhr;
    }
  }
}

test("a missing GM grant degrades reads to fallbacks instead of throwing", () => {
  withoutGrants(() => {
    assert.equal(loadJsonObject(KEYS.configs, "fb"), "fb", "no grant means no stored value");
    assert.equal(getConfigValue("ui.volume", 0.25), 0.25, "boot reads survive a grant-less host");
  });
});

test("a missing GM grant reports writes as failed instead of throwing", () => {
  withoutGrants(() => {
    assert.equal(gmSetValue(KEYS.configs, { version: 1 }), false);
    assert.equal(setConfigFields({ "ui.volume": 0.5 }), false, "the failure is reported, not thrown");
  });
});

test("a stored array is not a document", () => {
  stored[KEYS.configs] = [1, 2, 3];
  assert.deepEqual(loadJsonObject(KEYS.configs, "fb"), "fb", "arrays fall back like any corrupt doc");
  // And the store never installs one as its document either.
  configStore.adopt([1, 2, 3]);
  assert.deepEqual(configStore.doc(), { version: 1 });
});

test("a cross-tab write landing mid-batch survives the local write", () => {
  // Two tabs, disjoint paths: the remote write lands in manager storage
  // after our last adoption but before our persist. Without a rebase the
  // whole-document write clobbers it.
  seed({ version: 1, a: 1 });
  stored[KEYS.configs] = { version: 1, a: 1, b: 2 };
  setConfigValue("c", 3);
  assert.deepEqual(
    stored[KEYS.configs],
    { version: 1, a: 1, b: 2, c: 3 },
    "disjoint remote paths survive a local write"
  );
});

test("a removal applies against storage truth, not a stale cache", () => {
  seed({ version: 1, a: 1 });
  stored[KEYS.configs] = { version: 1, a: 1, b: 2 };
  deleteConfigField("a");
  assert.deepEqual(stored[KEYS.configs], { version: 1, b: 2 });
});

test("an empty batch writes nothing and reports success", () => {
  seed({ version: 1, a: 1 });
  let writes = 0;
  const realSet = globalThis.GM_setValue;
  globalThis.GM_setValue = (key, value) => {
    writes += 1;
    stored[key] = value;
  };
  try {
    assert.equal(setConfigFields({}), true, "vacuous success, not a failure");
    assert.equal(writes, 0, "no storage round trip for no paths");
    assert.deepEqual(stored[KEYS.configs], { version: 1, a: 1 });
  } finally {
    globalThis.GM_setValue = realSet;
  }
});

test("empty path segments are rejected like prototype segments", () => {
  seed({ version: 1, a: 1 });
  const before = JSON.stringify(stored[KEYS.configs]);
  assert.equal(setConfigFields({ "": 1 }), false);
  assert.equal(setConfigFields({ "a..b": 1 }), false);
  assert.equal(JSON.stringify(stored[KEYS.configs]), before, "no partial write escaped");
});

test("gmRequestText without the grant rejects instead of throwing", async () => {
  await assert.rejects(
    withoutGrants(() => gmRequestText("https://example.com/subs.vtt")),
    /unavailable/,
    "no grant means no fetch, carried as a rejection"
  );
});

test("gmRequestText surfaces HTTP errors and honors abort", async () => {
  const seen = [];
  globalThis.GM_xmlhttpRequest = (opts) => {
    seen.push(opts);
    const handle = {
      abort() {
        opts.onabort?.();
      }
    };
    if (opts.url.includes("ok.vtt")) {
      opts.onload({ status: 200, responseText: "WEBVTT", finalUrl: opts.url });
    } else if (opts.url.includes("missing.vtt")) {
      opts.onload({ status: 404, responseText: "" });
    }
    return handle;
  };
  try {
    const ok = await gmRequestText("https://example.com/ok.vtt");
    assert.equal(ok.responseText, "WEBVTT");
    await assert.rejects(gmRequestText("https://example.com/missing.vtt"), /HTTP 404/);

    const ac = new AbortController();
    const pending = gmRequestText("https://example.com/slow.vtt", { signal: ac.signal });
    ac.abort();
    await assert.rejects(pending, /bort/, "abort rejects instead of pending forever");
  } finally {
    delete globalThis.GM_xmlhttpRequest;
  }
});
