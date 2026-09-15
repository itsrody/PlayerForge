/**
 * The framework/shell contract: every cross-cutting constant and interface the
 * kernel (the framework) and the shell (the app that plugs into it) agree on.
 *
 * The kernel DEFINES these; the shell IMPORTS them (a legal downward edge), so
 * neither side reaches into the other's internals. Keeping them in one module
 * also means the two layers can never drift on the strings/values they share.
 *
 * Owned here:
 *   - SHELL_MARKER       - the DOM attribute both layers use to recognize
 *                          video/container/host the shell manages.
 *   - GESTURE_EVENTS     - the semantic event contract: the shell dispatches
 *                          these onto its host; the framework may emit the
 *                          panel one to toggle a shell's panel from outside
 *                          the input stack (GM menu).
 *   - DEBUG_LOGS_KEY     - the configs-doc field behind the debug-log toggle
 *                          (kernel init + GM menu).
 *   - FRAMEWORK_TUNING   - calibration constants that belong to the framework
 *                          (not shell UI), e.g. the removal grace window.
 */
export const SHELL_MARKER = "data-pf-shell";

export const DEBUG_LOGS_KEY = "debug.logs";

/** Semantic CustomEvents the shell honors on its host (inputs + panel).
 *  Frozen at module load to prevent accidental mutation by consumers. */
export const GESTURE_EVENTS = Object.freeze({
  hold: "pf:gesture-hold",
  release: "pf:gesture-release",
  scrub: "pf:gesture-scrub",
  scrubEnd: "pf:gesture-scrub-end",
  swipeStart: "pf:gesture-swipe-start",
  swipe: "pf:gesture-swipe",
  dbltap: "pf:gesture-dbltap",
  skip: "pf:gesture-skip",
  volume: "pf:gesture-volume",
  mute: "pf:gesture-mute",
  pip: "pf:gesture-pip",
  panel: "pf:gesture-panel",
  pinch: "pf:gesture-pinch"
});

/** Framework-owned calibration (the removal-watch grace delay).
 *  Frozen at module load to prevent accidental mutation. */
export const FRAMEWORK_TUNING = Object.freeze({
  removalGraceMs: 500
});
