import { measure } from "../lib.mjs";
import { JSDOM } from "jsdom";
import { register } from "node:module";

// Node has no CSS module support; the esbuild bundle inlines styles.css, but
// forge.js -> inject.js imports it. Short-circuit it the same way tests do.
register("file:///Users/itsrody/Documents/Projects/PlayerForge/tests/css-hook.mjs", import.meta.url);

// jsdom lacks several platform APIs the Gecko-only production code uses
// unconditionally; shim the bare globals the forge's constructor touches.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const { InputForge } = await import("../../src/shell/inputs/forge.js");
const { GESTURE_EVENTS } = await import("../../src/shell/inputs/actions.js");

/**
 * CPU-focused measurement of the forge's per-move scrub dispatch path: the
 * pointer-recognition math in #handlePointerMove/#advanceScrub plus the
 * CustomEvent allocation in #dispatch, on every coalesced pointer move. Runs
 * inside jsdom (no real Gecko), so the absolute numbers are a proxy - but the
 * RELATIVE change before/after a pooled-dispatch or session-latch refactor is
 * the signal the --compare gate keys on.
 */

function makeEnv() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/watch?v=1"
  });
  globalThis.window = dom.window;
  globalThis.location = dom.window.location;
  globalThis.document = dom.window.document;
  // jsdom rejects foreign-realm event objects / AbortSignals.
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.AbortController = dom.window.AbortController;
  Object.defineProperty(dom.window.document, "fullscreenElement", {
    value: { __fullscreen: true }, configurable: true
  });

  const video = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video);
  video.getBoundingClientRect = () => ({
    left: 0, right: 800, top: 0, bottom: 450, width: 800, height: 450
  });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  Object.defineProperty(video, "paused", { value: false, configurable: true });

  const zone = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(zone);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);

  return { dom, video, zone, host };
}

function pointerEvent(win, type, { id = 1, x = 0, y = 0 } = {}) {
  const event = new win.MouseEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
  });
  Object.defineProperty(event, "pointerId", { value: id });
  return event;
}

const MOVES = 30;

export default [
  measure("scrub per-move dispatch (down + 30 moves)", () => {
    const { dom, video, zone, host } = makeEnv();
    const controller = new InputForge(video, zone, host);
    let scrubCount = 0;
    host.addEventListener(GESTURE_EVENTS.scrub, () => { scrubCount++; });

    const down = pointerEvent(dom.window, "pointerdown", { x: 50, y: 200 });
    // Precomputed move stream exceeding SCROLL_START and axis-dominance so the
    // scrub latches on the first move, then stays latched for the remainder.
    const moves = [];
    for (let i = 0; i < MOVES; i++) {
      moves.push(pointerEvent(dom.window, "pointermove", { x: 60 + i * 18, y: 200 }));
    }
    const up = pointerEvent(dom.window, "pointerup", { x: 60 + MOVES * 18, y: 200 });

    return () => {
      scrubCount = 0;
      zone.dispatchEvent(down);
      for (let i = 0; i < moves.length; i++) {
        zone.dispatchEvent(moves[i]);
      }
      zone.dispatchEvent(up);
      // A full stroke: the first move latches the scrub; the remaining MOVES-1
      // each emit one. pointerup ends the session so the stroke is self-contained.
      if (scrubCount !== MOVES - 1) {
        throw new Error(`expected ${MOVES - 1} scrub events, got ${scrubCount}`);
      }
    };
  })
];
