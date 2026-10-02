import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

let stored = {};
globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
globalThis.GM_setValue = (key, value) => { stored[key] = value; };

const { KEYS, invalidateConfigCache } = await import("../src/shared/storage.js");
const { importManagerConfig } = await import("../src/shared/power-config.js");
const { POWER_SCHEMA } = await import("../src/shared/power-schema.js");

/** Read a dotted path out of the configs doc. */
const configAt = (path) => {
  let node = stored[KEYS.configs];
  for (const segment of path.split(".")) {
    node = node?.[segment];
  }
  return node;
};

beforeEach(() => {
  stored = {};
  invalidateConfigCache();
});

test("an untouched manager has no power-config values and adopts nothing", () => {
  // The decisive case: the ==UserConfig== block declares defaults, but the
  // manager only STORES a value once a person edits it. So a fresh install
  // must not have PF's own defaults overwritten by declared defaults.
  stored = { [KEYS.configs]: { subtitles: { style: { size: 2.5 } }, debug: { logs: true } } };

  assert.equal(importManagerConfig(), 0);
  assert.equal(configAt("subtitles.style.size"), 2.5);
  assert.equal(configAt("debug.logs"), true);
  assert.equal(configAt("power.imported"), undefined);
});

test("a manager edit lands in the field the framework reads", () => {
  stored = { [KEYS.configs]: {}, "power.captionSize": 1.8, "power.debugLogs": true };

  assert.equal(importManagerConfig(), 2);
  assert.equal(configAt("subtitles.style.size"), 1.8);
  assert.equal(configAt("debug.logs"), true);
  assert.deepEqual(configAt("power.imported"), { captionSize: 1.8, debugLogs: true });
});

test("the snapshot keeps a re-boot from re-adopting, and a second edit still lands", () => {
  stored = { [KEYS.configs]: {}, "power.captionSize": 1.8 };
  importManagerConfig();

  // Same manager value: nothing new, and crucially no clobber of a later
  // HUD-panel edit.
  stored[KEYS.configs].subtitles.style.size = 2.9;
  assert.equal(importManagerConfig(), 0);
  assert.equal(configAt("subtitles.style.size"), 2.9);

  // A real manager-side change is adopted even after the panel moved the value.
  stored["power.captionSize"] = 1.4;
  assert.equal(importManagerConfig(), 1);
  assert.equal(configAt("subtitles.style.size"), 1.4);
});

test("out-of-schema manager values are ignored rather than smuggled through", () => {
  stored = { [KEYS.configs]: { subtitles: { style: { size: 1.2 } } }, "power.captionSize": "huge", "power.debugLogs": "yes" };

  assert.equal(importManagerConfig(), 0);
  assert.equal(configAt("subtitles.style.size"), 1.2);
  assert.equal(configAt("debug.logs"), undefined);
});

test("numbers are clamped to the schema range instead of rejected", () => {
  stored = { [KEYS.configs]: {}, "power.captionSize": 99, "power.captionSync": -400 };

  assert.equal(importManagerConfig(), 2);
  assert.equal(configAt("subtitles.style.size"), 3);
  assert.equal(configAt("subtitles.sync.offset"), -20);
});

test("every schema field is bound to a key, a default and a manager id", () => {
  const ids = POWER_SCHEMA.map((field) => field.id);
  assert.equal(new Set(ids).size, ids.length, "manager ids must be unique");
  for (const field of POWER_SCHEMA) {
    assert.match(field.id, /^[A-Za-z][A-Za-z0-9]*$/, "id must be a bare YAML key");
    assert.ok(field.key.startsWith("subtitles.") || field.key.startsWith("debug."), field.key);
    assert.ok(["checkbox", "number", "text"].includes(field.type), field.type);
    if (field.type === "number") {
      assert.ok(field.min <= field.default && field.default <= field.max, field.id);
    }
  }
});