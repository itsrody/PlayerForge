import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let stored = {};
globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
globalThis.GM_setValue = (key, value) => { stored[key] = value; };

const { KEYS, getConfigValue, setConfigValue, setConfigFields, deleteConfigField, configStore } = await import("../src/shared/storage.js");

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
  configStore.adopt({ ui: { volume: 0.5 } });
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

test("setConfigFields commits the cache in sync with storage", () => {
  seed({ filter: { brightness: 100 } });
  setConfigFields({ "filter.brightness": 150, "filter.contrast": 110 });
  // Reads come from the committed cache - no need to re-read storage.
  assert.equal(getConfigValue("filter.brightness"), 150);
  assert.equal(getConfigValue("filter.contrast"), 110);
  assert.equal(stored[KEYS.configs].filter.brightness, 150);
});
