import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let stored = {};
globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
globalThis.GM_setValue = (key, value) => { stored[key] = value; };

const { KEYS, getConfigValue, setConfigValue, setConfigFields, deleteConfigField, invalidateConfigCache } = await import("../src/shared/storage.js");

beforeEach(() => invalidateConfigCache());

test("getConfigValue resolves dotted paths with fallbacks", () => {
  stored = { [KEYS.configs]: { version: 1, ui: { volume: 0.5 } } };
  assert.equal(getConfigValue("ui.volume"), 0.5);
  assert.equal(getConfigValue("ui.missing", "fb"), "fb");
  assert.equal(getConfigValue("nope.deeper", null), null);
});

test("getConfigValue rejects prototype-walking segments like writes do", () => {
  // A hostile doc must not turn a read path into traversal either.
  stored = {};
  assert.equal(getConfigValue("__proto__.polluted", "safe"), "safe");
  assert.equal(getConfigValue("constructor.prototype.x", "safe"), "safe");
  assert.equal(getConfigValue("ok.__proto__.x", "safe"), "safe");
});

test("deleteConfigField removes leaves and tolerates missing paths", () => {
  const doc = { version: 1, firstRun: false, ui: { volume: 1, nested: { deep: 2 } } };
  stored = { [KEYS.configs]: doc };

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
  stored = { [KEYS.configs]: { filter: {} } };

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
  stored = {};
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

test("config reads are cached until invalidated", () => {
  stored = { [KEYS.configs]: { ui: { volume: 0.5 } } };
  invalidateConfigCache();

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

test("invalidateConfigCache forces a fresh read from storage", () => {
  stored = { [KEYS.configs]: { ui: { volume: 0.5 } } };
  invalidateConfigCache();
  getConfigValue("ui.volume"); // warm cache

  // Something (another tab) replaced the doc behind our back.
  stored = { [KEYS.configs]: { ui: { volume: 0.9 } } };
  assert.equal(getConfigValue("ui.volume"), 0.5, "stale cached value before invalidation");

  invalidateConfigCache();
  assert.equal(getConfigValue("ui.volume"), 0.9, "fresh value after invalidation");
});

test("setConfigFields commits the cache in sync with storage", () => {
  stored = { [KEYS.configs]: { filter: { brightness: 100 } } };
  invalidateConfigCache();
  setConfigFields({ "filter.brightness": 150, "filter.contrast": 110 });
  // Reads come from the committed cache - no need to re-read storage.
  assert.equal(getConfigValue("filter.brightness"), 150);
  assert.equal(getConfigValue("filter.contrast"), 110);
  assert.equal(stored[KEYS.configs].filter.brightness, 150);
});
