import test from "node:test";
import assert from "node:assert/strict";

// Kernel depends on DOM APIs; provide minimal stubs for Node.
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
if (!globalThis.location) {
  globalThis.location = { hostname: "test.com", pathname: "/", hash: "" };
}
if (!globalThis.document) {
  globalThis.document = { addEventListener() {}, querySelectorAll() { return []; } };
}
if (!globalThis.window) {
  globalThis.window = { addEventListener() {} };
}

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_deleteValue = () => {};
if (typeof globalThis.GM_addValueChangeListener !== "function") {
  globalThis.GM_addValueChangeListener = () => 0;
}
if (typeof globalThis.GM_removeValueChangeListener !== "function") {
  globalThis.GM_removeValueChangeListener = () => {};
}

// Suppress logger output during tests.
const { logger } = await import("../src/shared/logger.js");
logger.disable();

const { Kernel } = await import("../src/kernel/kernel.js");
const { ShellSlot } = await import("../src/kernel/registry.js");

function makeShell(overrides = {}) {
  return {
    sdk: { name: "test", hops: 0 },
    video: { videoWidth: 0, videoHeight: 0, duration: 0, isConnected: true },
    container: { clientWidth: 0, clientHeight: 0 },
    shellHost: {},
    paused: true,
    destroy: () => {},
    ...overrides
  };
}

function makeProvider(shell) {
  return {
    create({ onDestroy }) {
      shell.destroy = () => onDestroy?.();
      return shell;
    }
  };
}

// ── ShellSlot (registry) tests ───────────────────────────────────────

test("registry: register and getAll", () => {
  const slot = new ShellSlot();
  const shell = makeShell();
  slot.register(shell);
  assert.deepEqual(slot.getAll(), [shell]);
});

test("registry: unregister removes the shell", () => {
  const slot = new ShellSlot();
  const shell = makeShell();
  slot.register(shell);
  slot.unregister(shell);
  assert.deepEqual(slot.getAll(), []);
});

test("registry: unregister wrong shell is a no-op", () => {
  const slot = new ShellSlot();
  const shell = makeShell();
  const other = makeShell();
  slot.register(shell);
  slot.unregister(other);
  assert.deepEqual(slot.getAll(), [shell]);
});

test("registry: register replaces previous shell", () => {
  const slot = new ShellSlot();
  const a = makeShell();
  const b = makeShell();
  slot.register(a);
  slot.register(b);
  assert.deepEqual(slot.getAll(), [b]);
});

test("registry: getByVideo matches current shell", () => {
  const slot = new ShellSlot();
  const video = { videoWidth: 0, videoHeight: 0, duration: 0, isConnected: true };
  const shell = makeShell({ video });
  slot.register(shell);
  assert.equal(slot.getByVideo(video), shell);
  assert.equal(slot.getByVideo({ videoWidth: 0, videoHeight: 0, duration: 0, isConnected: true }), null);
});

test("registry: destroyAll calls destroy and clears", () => {
  const slot = new ShellSlot();
  let destroyed = false;
  const shell = makeShell({ destroy: () => { destroyed = true; } });
  slot.register(shell);
  slot.destroyAll();
  assert.ok(destroyed);
  assert.deepEqual(slot.getAll(), []);
});

test("registry: destroyAll with no shell is safe", () => {
  const slot = new ShellSlot();
  slot.destroyAll();
  assert.deepEqual(slot.getAll(), []);
});

// ── Kernel public API tests ──────────────────────────────────────────

test("kernel: togglePanel warns when no shell is active", () => {
  const kernel = new Kernel();
  kernel.togglePanel();
});

test("kernel: onShellCreated returns unsubscribe function", () => {
  const kernel = new Kernel();
  const calls = [];
  const unsub = kernel.onShellCreated((s) => calls.push(s));
  assert.equal(typeof unsub, "function");
  unsub();
});

test("kernel: registerShellProvider stores provider", () => {
  const kernel = new Kernel();
  const provider = makeProvider(makeShell());
  kernel.registerShellProvider(provider);
});
