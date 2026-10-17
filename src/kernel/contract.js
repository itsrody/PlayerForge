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
 *   - GESTURES           - the gesture-family vocabulary: the single source
 *                          every layer derives from. Each family id maps to its
 *                          semantic event, its configs-doc setting gate, and its
 *                          settings-panel label - so input bindings, the
 *                          settings schema, the pointer-intent list and the
 *                          haptic table all reference one key instead of
 *                          re-spelling the strings.
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

/**
 * The gesture families, one key each. `event` is the CustomEvent the shell
 * dispatches, `setting` is the configs-doc gate (`<setting>` under the settings
 * subtree), `label` is the settings-panel text. Every other module derives its
 * gesture strings from here - never re-declares them.
 */
export const GESTURES = Object.freeze({
  hold: { event: "pf:gesture-hold", setting: "gestures.hold", label: "Speed Up Hold" },
  scrub: { event: "pf:gesture-scrub", setting: "gestures.scrub", label: "Scrub Seeking" },
  swipe: { event: "pf:gesture-swipe", setting: "gestures.swipe", label: "Swiping" },
  dbltap: { event: "pf:gesture-dbltap", setting: "gestures.dbltap", label: "Double-tap Skip" },
  pinch: { event: "pf:gesture-pinch", setting: "gestures.pinch", label: "Pinch to Fill" }
});

/** Gesture-family ids in declaration order (the canonical vocabulary). */
export const GESTURE_IDS = Object.freeze(Object.keys(GESTURES));

/**
 * Semantic CustomEvents the shell honors on its host (inputs + panel). The five
 * family events are folded in from GESTURES; the rest are one-shot action
 * events that have no settings gate of their own.
 */
export const GESTURE_EVENTS = Object.freeze({
  release: "pf:gesture-release",
  scrubEnd: "pf:gesture-scrub-end",
  swipeStart: "pf:gesture-swipe-start",
  skip: "pf:gesture-skip",
  volume: "pf:gesture-volume",
  mute: "pf:gesture-mute",
  pip: "pf:gesture-pip",
  panel: "pf:gesture-panel",
  ...Object.fromEntries(GESTURE_IDS.map((id) => [id, GESTURES[id].event]))
});

/** Framework-owned calibration (the removal-watch grace delay). */
export const FRAMEWORK_TUNING = {
  removalGraceMs: 500
};
