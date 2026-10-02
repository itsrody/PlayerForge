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

/**
 * ScriptCat's worker synthesizes `<group>.<key>` as `stored ?? declared
 * default` and ships the whole map to the script, so a manager reports every
 * schema key even when nobody ever opened the manager UI. These helpers build
 * that synthesized view.
 */
const synthesize = (stored = {}) => ({
  ...Object.fromEntries(POWER_SCHEMA.map((field) => [`power.${field.id}`, stored[field.id] ?? field.default])),
  ...stored
});

test("first contact records the snapshot and adopts nothing", () => {
  // The upgrade case: the panel already holds the person's choices, and the
  // manager's synthesized schema defaults must not revert them.
  stored = {
    [KEYS.configs]: { subtitles: { style: { size: 2.5 } } },
    ...synthesize()
  };

  assert.equal(importManagerConfig(), 0);
  assert.equal(configAt("subtitles.style.size"), 2.5);
  // Snapshot of the schema defaults is written, so the NEXT edit is detectable.
  assert.deepEqual(configAt("power.imported"), {
    debugLogs: false,
    captionSize: 1.2,
    captionColor: "#ffffff",
    captionShadow: 40,
    captionSync: 0
  });
});

test("a manager edit after first contact lands in the field the framework reads", () => {
  stored = { [KEYS.configs]: {}, ...synthesize() };
  importManagerConfig();

  stored["power.captionSize"] = 1.8;
  stored["power.debugLogs"] = true;
  assert.equal(importManagerConfig(), 2);
  assert.equal(configAt("subtitles.style.size"), 1.8);
  assert.equal(configAt("debug.logs"), true);
});

test("the snapshot keeps a re-boot from re-adopting, and a second edit still lands", () => {
  stored = { [KEYS.configs]: {}, ...synthesize() };
  importManagerConfig();
  stored["power.captionSize"] = 1.8;
  importManagerConfig();

  // Unchanged manager value: nothing new, and crucially no clobber of a later
  // HUD-panel edit.
  stored[KEYS.configs].subtitles.style.size = 2.9;
  assert.equal(importManagerConfig(), 0);
  assert.equal(configAt("subtitles.style.size"), 2.9);

  // A real manager-side change is adopted even after the panel moved the value.
  stored["power.captionSize"] = 1.4;
  assert.equal(importManagerConfig(), 1);
  assert.equal(configAt("subtitles.style.size"), 1.4);
});

test("editing a field back to its declared default is a real change", () => {
  // Why the snapshot is compared against rather than the schema default: after
  // a real edit, a revert to the default must still be adopted.
  stored = { [KEYS.configs]: {}, ...synthesize() };
  importManagerConfig();
  stored["power.captionSize"] = 2.0;
  importManagerConfig();
  assert.equal(configAt("subtitles.style.size"), 2.0);

  stored["power.captionSize"] = 1.2;
  assert.equal(importManagerConfig(), 1);
  assert.equal(configAt("subtitles.style.size"), 1.2);
});

test("out-of-schema manager values are ignored rather than smuggled through", () => {
  stored = { [KEYS.configs]: {}, ...synthesize() };
  importManagerConfig();

  stored["power.captionSize"] = "huge";
  stored["power.debugLogs"] = "yes";
  assert.equal(importManagerConfig(), 0);
  // Neither a string nor a non-boolean ever reaches a field that trusts its
  // type, so both fields are still untouched.
  assert.equal(configAt("subtitles.style.size"), undefined);
  assert.equal(configAt("debug.logs"), undefined);
  // The snapshot keeps the last GOOD value rather than recording the rejected
  // one, so correcting the value in the manager is still detected as a change.
  assert.equal(configAt("power.imported.captionSize"), 1.2);
  stored["power.captionSize"] = 1.8;
  assert.equal(importManagerConfig(), 1);
  assert.equal(configAt("subtitles.style.size"), 1.8);
});

test("numbers are clamped to the schema range instead of rejected", () => {
  stored = { [KEYS.configs]: {}, ...synthesize() };
  importManagerConfig();

  stored["power.captionSize"] = 99;
  stored["power.captionSync"] = -400;
  assert.equal(importManagerConfig(), 2);
  assert.equal(configAt("subtitles.style.size"), 3);
  assert.equal(configAt("subtitles.sync.offset"), -20);
});

test("a manager that never materializes defaults is left alone entirely", () => {
  // No `power.*` keys at all: nothing to record, nothing to adopt, and the
  // configs doc is not even touched.
  stored = { [KEYS.configs]: { subtitles: { style: { size: 2.5 } } } };

  assert.equal(importManagerConfig(), 0);
  assert.deepEqual(stored[KEYS.configs], { subtitles: { style: { size: 2.5 } } });
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