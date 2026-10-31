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
 *                          settings schema and the pointer-intent list all
 *                          reference one key instead of
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

/** The hash tag that flips debug mode for one page load (never persisted).
 *  An explicit menu "Off" wins over it. */
export const DEBUG_HASH_TAG = "pf-debug";

/**
 * The gesture families: ONE hand-written entry per family - the id (the key)
 * and its settings-panel label (the value). Everything machine-facing is
 * formula-derived below, so a new family is a one-line addition: its semantic
 * event becomes `pf:gesture-<id>` and its configs gate becomes `gestures.<id>`.
 */
const GESTURE_LABELS = Object.freeze({
  hold: "Speed Up Hold",
  scrub: "Scrub Seeking",
  swipe: "Swiping",
  dbltap: "Double-tap Skip",
  pinch: "Pinch to Fill"
});

/** Gesture-family ids in registry-declaration order (the canonical vocabulary). */
export const GESTURE_IDS = Object.freeze(Object.keys(GESTURE_LABELS));

export const GESTURES = Object.freeze(Object.fromEntries(
  GESTURE_IDS.map((id) => [id, {
    event: `pf:gesture-${id}`,
    setting: `gestures.${id}`,
    label: GESTURE_LABELS[id]
  }])
));

/** One-shot action event handles: no settings gate of their own, each derived
 *  `pf:gesture-<kebab(handle)>` like the family events (scrubEnd -> -scrub-end). */
const GESTURE_ACTIONS = Object.freeze([
  "release", "scrubEnd", "swipeStart", "skip", "volume", "mute", "pip", "panel",
  "subSync", "syncReset", "filterReset"
]);

const kebab = (id) => id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Semantic CustomEvents the shell honors on its host (inputs + panel). The
 * family events derive from GESTURES; the one-shot actions derive from the
 * formula. The framework may emit the panel one to toggle a shell's panel from
 * outside the input stack (GM menu).
 */
export const GESTURE_EVENTS = Object.freeze(Object.fromEntries([
  ...GESTURE_ACTIONS.map((handle) => [handle, `pf:gesture-${kebab(handle)}`]),
  ...GESTURE_IDS.map((id) => [id, GESTURES[id].event])
]));

/** Framework-owned calibration (the removal-watch grace delay). */
export const FRAMEWORK_TUNING = {
  removalGraceMs: 500
};

/**
 * The adoption identity, the kernel→shell watcher protocol: ONE record per
 * adoption, resolved once at discovery and handed unchanged through every
 * seam that speaks the boot identity - the provider (Shell), the removal
 * watch (its anchored roots derive from video/container/hops), and the
 * destroy-readopt compare (home.container === shell.home.container; a re-wrap
 * resolves a NEW record and the old one stays the boot identity it was -
 * identity is a shell-lifetime fact, read-only for every holder). Each of
 * these seams previously re-invented the shape as a hand-spelled
 * {video, container, sdk} object; the record is the one spelling.
 *
 * Read-only by derivation, not by duplication: the identity fields are
 * getters over the one SDK descriptor the resolution produced (container and
 * hops alias its facts rather than copying them - one fact, one holder), and
 * every identity mutation answer throws in strict mode - the same write
 * seal Object.freeze gave the earlier stored-field shape, without the two
 * homes for the same fact.
 */
export class AdoptionHome {
  #video;
  #sdk;

  constructor({ video, sdk }) {
    this.#video = video;
    this.#sdk = sdk;
  }

  /** The adoption's subject <video>; the removal watch's anchor walk and
   *  the shell's media facet derive from it. */
  get video() {
    return this.#video;
  }

  /** The shell-host container the descriptor resolved - the identity fact
   *  the destroy-readopt compare reads. */
  get container() {
    return this.#sdk.container;
  }

  /** The SDK descriptor (name/container/hops): features reading SDK facts
   *  (name in logs and error prose) read it here rather than through a
   *  re-spelled field. */
  get sdk() {
    return this.#sdk;
  }

  /** The SDK anchor's hop count, the removal watch's depth input. */
  get hops() {
    return this.#sdk.hops;
  }
}
