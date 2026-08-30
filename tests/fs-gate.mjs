import { initFullscreenGate } from "../src/shared/shadow.js";

/**
 * Test wiring for the shared `fs` gate (shadow.js). The gate is built on the
 * native fullscreenchange event and is the sole fullscreen boolean across the
 * codebase, so tests drive it through the real mechanism:
 *   initFsGate(dom)           - wire the gate to this environment's document
 *                               (must run before constructing the forge/shell)
 *   setFullscreen(dom, value) - set document.fullscreenElement and fire the
 *                               native event so `fs` latches like production
 */
export function initFsGate(dom) {
  initFullscreenGate(dom.window.document);
}

export function setFullscreen(dom, value) {
  Object.defineProperty(dom.window.document, "fullscreenElement", {
    value, configurable: true
  });
  dom.window.document.dispatchEvent(new dom.window.Event("fullscreenchange"));
}
