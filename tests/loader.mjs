import { register } from "node:module";
register("./css-hook.mjs", import.meta.url);

/**
 * jsdom 29 lacks several platform APIs the production code (targeting Firefox
 * 155+) uses unconditionally. Rather than scatter feature-detects through src/
 * to appease a headless test host, the absence is shimmed here - in the ONE
 * place the harness bootstraps - so production code stays idiomatic for the
 * real browser. These shims are no-ops; they exist only so constructor/import
 * paths don't throw.
 *
 * Only BARE-GLOBAL identifiers are shimmed (src/ resolves them via globalThis
 * in Node ESM). Instance-prototype APIs that tests never exercise (Element
 * .animate, canvas, etc.) are deliberately not faked - faking them here would
 * be ineffective for jsdom-created elements anyway.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  // Minimal no-op shim so the on-screen gate in resume.js is reachable in
  // tests; it keeps `onScreen` true (the safe default) since it never fires a
  // callback, matching the real browser before the first observation lands.
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}
if (typeof globalThis.scheduler === "undefined") {
  // Minimal cooperative scheduler shim so parseSubtitlesAsync's yield branch
  // is reachable under Node. yield() resolves on a microtask, matching the
  // Firefox hand-back without needing a real task-dispatch scheduler.
  globalThis.scheduler = {
    yield: () => Promise.resolve()
  };
}
if (typeof globalThis.MediaMetadata === "undefined") {
  globalThis.MediaMetadata = class MediaMetadata {};
}
// Firefox's Vibration API - absent on Node. Stubbed so gestureHaptic's
// feature-detect is true and tests can assert the haptic pulse pattern; the
// stub records the last pattern for inspection.
if (typeof globalThis.navigator?.vibrate !== "function") {
  globalThis.navigator.vibrate = (pattern) => {
    globalThis.__lastHapticPattern = pattern;
    return true;
  };
}
