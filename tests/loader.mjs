import { register } from "node:module";
register("./css-hook.mjs", import.meta.url);

/**
 * jsdom 29 lacks several platform APIs the Chromium-only production code uses
 * unconditionally. Rather than scatter feature-detects through src/ to appease
 * a headless test host, the absence is shimmed here - in the ONE place the
 * harness bootstraps - so production code stays pure Chromium 152. These shims
 * are no-ops; they exist only so constructor/import paths don't throw.
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
  // Minimal cooperative scheduler shim so scheduler.yield() callers are
  // testable under Node. yield() resolves on a microtask, matching the
  // real browser task-dispatch scheduler.
  globalThis.scheduler = {
    yield: () => Promise.resolve()
  };
}
if (typeof globalThis.MediaMetadata === "undefined") {
  globalThis.MediaMetadata = class MediaMetadata {};
}
if (typeof globalThis.matchMedia !== "function") {
  // jsdom has no viewport/media-query engine. A static no-op keeps the
  // shell's compact-mode auto-detect and its matchMedia change listener
  // constructible in tests; matches stays false so the narrow-touch
  // breakpoint never toggles into compact mode under the harness, and
  // addEventListener/removeEventListener are no-ops since no test drives a
  // viewport crossing.
  globalThis.matchMedia = () => ({
    get matches() {
      return false;
    },
    addEventListener() {},
    removeEventListener() {}
  });
}
