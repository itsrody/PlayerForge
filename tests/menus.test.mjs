import test from "node:test";
import assert from "node:assert/strict";

const registered = [];
let nextId = 1;
globalThis.GM_registerMenuCommand = (title, fn) => {
  const handle = { id: nextId++, title, fn };
  registered.push(handle);
  return handle;
};
globalThis.GM_unregisterMenuCommand = (handle) => {
  const i = registered.indexOf(handle);
  if (i >= 0) {
    registered.splice(i, 1);
  }
};

// Storage + logger globals must exist before those modules load.
let stored = {};
globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
globalThis.GM_setValue = (key, value) => { stored[key] = value; };
console.log = () => {};
console.warn = () => {};

const { installMenuCommands } = await import("../src/kernel/menus.js");
const { getConfigValue } = await import("../src/shared/storage.js");
const { logger } = await import("../src/shared/logger.js");

function debugMenu() {
  return registered.find((h) => h.title.includes("Debug Logs"));
}

test("both commands register immediately, without any kernel", () => {
  registered.length = 0;
  const uninstall = installMenuCommands({ getKernel: () => null });
  assert.equal(registered.length, 2);
  assert.ok(registered.some((h) => h.title.includes("Panel")));
  assert.match(debugMenu().title, /Off$/);
  uninstall();
  assert.equal(registered.length, 0);
});

test("debug toggle persists, flips logger, recaptions - all pre-boot", () => {
  registered.length = 0;
  logger.disable();
  const uninstall = installMenuCommands({ getKernel: () => null });

  debugMenu().fn();
  assert.equal(getConfigValue("debug.logs", undefined), true);
  assert.equal(logger.enabled, true);
  assert.match(debugMenu().title, /On$/);

  debugMenu().fn();
  assert.equal(getConfigValue("debug.logs", undefined), false);
  assert.equal(logger.enabled, false);
  assert.match(debugMenu().title, /Off$/);

  // Exactly one debug command exists at any time (re-caption, no dupes).
  assert.equal(registered.filter((h) => h.title.includes("Debug Logs")).length, 1);
  uninstall();
});

test("panel click reaches kernel.togglePanel once a kernel exists", () => {
  registered.length = 0;
  let toggles = 0;
  let live = null;
  const uninstall = installMenuCommands({ getKernel: () => live });

  // Pre-boot: warn path, no throw.
  registered.find((h) => h.title.includes("Panel")).fn();

  live = { togglePanel: () => { toggles++; } };
  registered.find((h) => h.title.includes("Panel")).fn();
  assert.equal(toggles, 1);
  uninstall();
});

test("debug toggle propagates bus state to a live kernel", () => {
  registered.length = 0;
  let busDebug = false;
  const kernel = { bus: { set debug(v) { busDebug = v; } } };
  const uninstall = installMenuCommands({ getKernel: () => kernel });

  debugMenu().fn();
  assert.equal(busDebug, true);
  uninstall();
});
