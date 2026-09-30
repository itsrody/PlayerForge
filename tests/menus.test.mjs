import test from "node:test";
import assert from "node:assert/strict";

const registered = [];
let nextId = 1;
// Record the FULL argument list, not just (title, fn): the point of the third
// position is that the two target managers disagree about its type (TM wants an
// options object, Violentmonkey's legacy signature wants an accessKey string),
// so a stub that only captures two params cannot enforce anything about it.
const calls = [];
globalThis.GM_registerMenuCommand = (...args) => {
  calls.push(args);
  const handle = { id: nextId++, title: args[0], fn: args[1] };
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
const { logger } = await import("../src/shared/diagnostics.js");

function debugMenu() {
  return registered.find((h) => h.title.includes("Debug Logs"));
}

test("debug command registers immediately, without any kernel", () => {
  registered.length = 0;
  const uninstall = installMenuCommands();
  assert.equal(registered.length, 1);
  assert.match(debugMenu().title, /Off$/);
  uninstall();
  assert.equal(registered.length, 0);
});

test("debug toggle persists, flips logger, recaptions - all pre-boot", () => {
  registered.length = 0;
  logger.disable();
  const uninstall = installMenuCommands();

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

test("register forwards the options object as the third argument", () => {
  calls.length = 0;
  const uninstall = installMenuCommands();
  assert.ok(calls.length > 0, "the debug command registered");
  for (const args of calls) {
    // Violentmonkey MV2 2.49.0 reads `opts.id` / `opts.text` off an
    // Object.assign({}, opts) clone, and its background RegisterMenu handler
    // stores the object verbatim - so an object is the correct type there and
    // autoClose is inert, not a type error. This test pins that contract so a
    // future "fix" does not strip the options argument on a false premise.
    assert.equal(args.length, 3, "register is called with (title, fn, options)");
    assert.deepEqual(args[2], { autoClose: true });
  }
  uninstall();
});

test("a manager that returns no handle still keeps exactly one live command", () => {
  // FireMonkey v3's registerMenuCommand is `command[text] = onclick` with no
  // return value, and its unregister takes the caption. The debug caption
  // carries its own state, so if the undefined return were taken at face
  // value the `debugId != null` guard would skip every unregister and each
  // toggle would strand the previous caption in the menu for the page's life.
  const live = new Map();
  const realRegister = globalThis.GM_registerMenuCommand;
  const realUnregister = globalThis.GM_unregisterMenuCommand;
  globalThis.GM_registerMenuCommand = (title, fn) => {
    live.set(title, fn);
  };
  globalThis.GM_unregisterMenuCommand = (name) => {
    live.delete(name);
  };
  try {
    const uninstall = installMenuCommands();
    assert.equal(live.size, 1, "one command registered");
    for (let i = 0; i < 4; i++) {
      [...live.values()][0]();
    }
    assert.equal(live.size, 1, "toggling recaptions in place instead of accumulating");
    uninstall();
    assert.equal(live.size, 0, "uninstall removed the remaining command");
  } finally {
    globalThis.GM_registerMenuCommand = realRegister;
    globalThis.GM_unregisterMenuCommand = realUnregister;
  }
});
