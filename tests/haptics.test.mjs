import test from "node:test";
import assert from "node:assert/strict";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = undefined;

// loader.mjs (--import) stubs navigator.vibrate to record into
// globalThis.__lastHapticPattern. Ensure the haptics module can see it.
const { gestureHaptic } = await import("../src/shell/chrome/haptics.js");
const { getSetting, setSetting } = await import("../src/shell/chrome/config.js");

test("gestureHaptic fires a distinct pulse pattern per gesture", () => {
  setSetting("gestures.haptics", true);
  gestureHaptic("hold");
  assert.equal(globalThis.__lastHapticPattern, 12);
  gestureHaptic("scrub");
  assert.deepEqual(globalThis.__lastHapticPattern, [10, 24, 10]);
  gestureHaptic("pinch");
  assert.deepEqual(globalThis.__lastHapticPattern, [8, 14, 8, 14, 8]);
  gestureHaptic("dbltap");
  assert.deepEqual(globalThis.__lastHapticPattern, [14, 40, 14]);
});

test("gestureHaptic is a no-op when the haptics setting is off", () => {
  setSetting("gestures.haptics", false);
  globalThis.__lastHapticPattern = null;
  gestureHaptic("hold");
  assert.equal(globalThis.__lastHapticPattern, null);
  setSetting("gestures.haptics", true);
});

test("gestureHaptic ignores unknown gesture types", () => {
  setSetting("gestures.haptics", true);
  globalThis.__lastHapticPattern = "sentinel";
  gestureHaptic("nope");
  assert.equal(globalThis.__lastHapticPattern, "sentinel");
});
