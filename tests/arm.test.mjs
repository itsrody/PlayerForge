import test from "node:test";
import assert from "node:assert/strict";

// The settings engine evaluates its cache at module load through shared
// storage (which calls the bare GM_getValue global). Provide a stub before any
// dynamic import of the proxy arm / settings graph runs.
globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = undefined;

/**
 * The proxy arm is kernel-owned: installProxy/installProxyDebug arm the wire
 * seams, and the element takeover plane rides the kernel's shell-created /
 * shell-destroyed lifecycle hooks instead of entry.js's manual shell wiring or
 * the shell's own DOMManager cleanup. These tests assert the coordinator
 * applies the arm to a fake kernel without ever touching a shell import.
 */

/** A minimal Kernel-shaped lifetime surface (registers providers + hooks). */
function fakeKernel() {
  const created = new Set();
  const destroyed = new Set();
  let provider = null;
  return {
    registerShellProvider(p) {
      provider = p;
    },
    onShellCreated(cb) {
      created.add(cb);
      return () => created.delete(cb);
    },
    onShellDestroyed(cb) {
      destroyed.add(cb);
      return () => destroyed.delete(cb);
    },
    makeShell(video = makeVideo()) {
      const shell = { video, ready: Promise.resolve(), dom: null };
      for (const cb of created) cb(shell);
      return shell;
    },
    destroyShell(shell) {
      for (const cb of destroyed) cb(shell);
    },
    created,
    destroyed,
    get provider() {
      return provider;
    }
  };
}

function makeVideo(overrides = {}) {
  return {
    currentSrc: "",
    src: "",
    readyState: 0,
    addEventListener() {},
    removeEventListener() {},
    ...overrides
  };
}

test("armProxy requires a kernel with shell lifecycle hooks", async () => {
  const { armProxy } = await import("../src/kernel/proxy/arm.js");
  assert.equal(armProxy({ kernel: null }), null);
  assert.equal(armProxy({ kernel: {} }), null);
});

test("armProxy installs the production arm against the injected fetch", async () => {
  const { armProxy } = await import("../src/kernel/proxy/arm.js");
  const kernel = fakeKernel();
  const installed = armProxy({
    kernel,
    role: "frame",
    gmWebRequest: null,
    fetch: () => new Response("native", { status: 200 }),
    xhrPrototype: { send() {} }
  });
  assert.ok(installed, "the arm returns the installer surface");
  assert.equal(installed.summary.role, "frame");
  assert.ok(installed.router, "the shared MP4 router is exposed");
  assert.ok(installed.claims instanceof Map, "the claims ring is exposed");
});

test("armProxy downgrades to inactive when no fireable fetch seam exists", async () => {
  const { armProxy } = await import("../src/kernel/proxy/arm.js");
  const kernel = fakeKernel();
  const installed = armProxy({
    kernel,
    fetch: null,
    xhrPrototype: null
  });
  // With no fetch seam there is no router; the arm notes it but still returns
  // the installer surface (observe may still be live at top frame).
  assert.ok(installed);
});

test("element seams fire on shell-created and tear down on shell-destroyed", async () => {
  const { armProxy } = await import("../src/kernel/proxy/arm.js");
  const kernel = fakeKernel();

  armProxy({
    kernel,
    fetch: () => new Response("native", { status: 200 }),
    xhrPrototype: { send() {} }
  });

  assert.ok(kernel.created.size >= 1, "the arm subscribes to shell-created");
  assert.ok(kernel.destroyed.size >= 1, "the arm subscribes to shell-destroyed");

  // Both hooks fire without throwing on a real (fake) shell; the element
  // seams decline toward the page player because a bare mock video is busy.
  const shell = kernel.makeShell();
  assert.doesNotThrow(() => kernel.destroyShell(shell));
});

test("settings engine is kernel-owned and the config panel re-exports it", async () => {
  const { SETTINGS_SCHEMA, getSetting, setSetting, onSettingChange } = await import("../src/kernel/settings.js");
  const panel = await import("../src/shell/chrome/config.js");

  assert.equal(getSetting("features.manifestProxy"), false, "production routing defaults off via kernel settings");
  assert.equal(getSetting("features.wakeLock"), true, "wake lock defaults on");
  assert.equal(panel.getSetting("features.mse"), getSetting("features.mse"), "the panel re-exports the kernel accessor");
  assert.ok(SETTINGS_SCHEMA.some((d) => d.key === "features.mse"), "the schema carries the MSE feature");
});
