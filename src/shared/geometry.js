/**
 * PlayerForge geometry rule — single owner. The contextual reference is the
 * physical screen in fullscreen (the `:fullscreen` rule stretches the
 * container to the screen) and the shell host's own box inline.
 *
 * This used to live in two places that had already drifted apart:
 * `shell.referenceBox` read a bare `screen.width`, which throws
 * ReferenceError on a host with no `screen` global at all (headless/jsdom —
 * the loader shims matchMedia, observers and scheduler, but deliberately not
 * screen), while forge's `#zoneForPoint` guarded the same read with
 * `typeof` and fell back to `window.innerWidth`. Unifying here keeps the
 * fs-vs-inline decision and the guarded screen read in exactly one module;
 * the per-site fallbacks stay at the call sites because they answer
 * different questions (see below).
 */

import { fs } from "./shadow.js";

/**
 * Guarded screen size. `{ width: 0, height: 0 }` when the host has no screen
 * global or reports a zeroed one — the safe direction, since every consumer
 * treats zero as "unknown" and falls back rather than throwing. A fresh
 * object per call: this runs once per gesture, not per move, so sharing the
 * allocation discipline of the pooled box below would buy nothing.
 */
export function screenSize() {
  // `typeof` guard, not truthiness: a missing `screen` global throws on a
  // bare read, and a present-but-zeroed screen (headless) reports presence
  // without geometry. Both mean "no screen to measure against".
  if (typeof screen !== "undefined" && screen?.width > 0 && screen?.height > 0) {
    return { width: screen.width, height: screen.height };
  }
  return { width: 0, height: 0 };
}

/**
 * Write the contextual reference box into `box` and return it. The pooled
 * write form exists so `shell.referenceBox` keeps its zero-alloc getter:
 * values are rewritten on every read, never retained.
 *
 * Inline keeps the raw container size with no `innerWidth` fallback — that
 * fallback lives downstream on purpose. The scrub gain uses `|| 640` and
 * `computeCoverScale` returns 0 for an unknown reference, so a zero here
 * resolves to "skip" rather than to a viewport-width guess that would
 * silently renormalize the gesture. Widening this to guess would change
 * scrub normalization, not just fill a gap.
 */
export function writeReferenceBox(container, box) {
  const scr = screenSize();
  if (fs && scr.width > 0) {
    box.width = scr.width;
    box.height = scr.height;
  } else {
    box.width = container.clientWidth;
    box.height = container.clientHeight;
  }
  return box;
}

/**
 * Width-only form for forge's edge-zone steering. Same rule as
 * `writeReferenceBox`, but a zero container width falls back to
 * `window.innerWidth`: edge zones need a live pixel count to steer against,
 * and `innerWidth` sidesteps the scrollbar-inclusive quirk the container
 * would include. The `window` guard is for headless hosts only — there the
 * fallback is 0, which collapses both edge zones into "screen" instead of
 * throwing mid-gesture.
 */
export function referenceWidth(clientWidth) {
  const scr = screenSize();
  if (fs && scr.width > 0) {
    return scr.width;
  }
  if (clientWidth) {
    return clientWidth;
  }
  return typeof window !== "undefined" ? window.innerWidth : 0;
}
