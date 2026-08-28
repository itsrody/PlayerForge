import { register } from "node:module";
register("./css-hook.mjs", import.meta.url);

/**
 * jsdom 29 lacks several platform APIs the Gecko-only production code uses
 * unconditionally. Rather than scatter feature-detects through src/ to appease
 * a headless test host, the absence is shimmed here - in the ONE place the
 * harness bootstraps - so production code stays pure Firefox 154. These shims
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
if (typeof globalThis.MediaMetadata === "undefined") {
  globalThis.MediaMetadata = class MediaMetadata {};
}
