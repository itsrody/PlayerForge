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

/**
 * The browserAction command channel: the popup (dist/popup.js) is pure
 * chrome - it owns no storage and gestures at nothing - it sends one
 * message type and the top frame's receiver (kernel.js TabCommands)
 * answers. The names are command nouns distinct from the gesture event
 * vocabulary (pf:gesture-*): the receiver maps reset commands onto
 * GESTURE_EVENTS dispatches, the debug pair through the debug gate, and
 * the diag write through the pf:diag echo. Derived nouns, one table -
 * the message type is spelled once here and imported by both surfaces.
 */
export const TAB_COMMAND = "pf:command";

export const COMMANDS = Object.freeze({
  debugToggle: "debug-toggle",
  debugQuery: "debug-query",
  diag: "diag",
  filterReset: "filter-reset",
  syncReset: "sync-reset"
});

/** The hash tag that flips debug mode for one page load (never persisted).
 *  An explicit menu "Off" wins over it. */
export const DEBUG_HASH_TAG = "pf-debug";

/**
 * The ad-host skip vocabulary, the planes' shared source table: an
 * ad/track/captcha frame hosts no players, so every plane that controls a
 * surface refuses it. Hostname-anchored on purpose: an ad domain may appear
 * only in a path or query on a legitimate video page (`/doubleclick-interview/`,
 * `?ref=taboola.com`), and substring-matching the whole href would silently
 * skip a real player. Suffix match covers subdomains; captcha widget frames
 * live on their own domains (hcaptcha.com, recaptcha.net).
 *
 * The vocabulary's moved story (user direction 2026-11): the eval-time gate
 * was the userscript-era compensation - injected in every frame with no
 * control, the content script refused by hostname at boot. The extension
 * plane splits the control by plane: the content script keeps the boot gate
 * (content_scripts inject manifest-matched, document_start - no webRequest
 * classification can reach an eval that fast), while the Reforge background
 * classifies FRAMES by network identity and refuses them at its witness
 * floor (ledger.js). One source table - a second spelling site would fork
 * the vocabulary, the exact same shape the census pins on SETTING_KEYS.
 */
export const AD_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
  "hcaptcha.com",
  "googletagmanager.com",
  "recaptcha.net",
  "facebook.net"
];
/** Prefix families: adservice.google and its subdomains. */
export const AD_HOST_PREFIXES = ["adservice.google."];

/**
 * The compiled alternation twin: derived from the two source tables above
 * and built once at module init, so the scan rides the C++ RegExp engine
 * instead of a 10-iteration JS walk (24.5ns/host vs the loop's 90.5 on the
 * delegation probe; per-request in the background, the same shape). The
 * end anchor is the loop's own equality/endsWith semantics: a
 * trailing-suffix trap like `doubleclick.net.evil.com` must not match, and
 * an un-anchored form would have accepted it. Dots are escaped because a
 * suffix's literal dots must not become wildcards; hostnames from
 * `new URL().hostname` are spec-lowercase, so no flag.
 */
const AD_HOST_RE = new RegExp(
  "(?:^|\\.)(" +
    AD_HOST_SUFFIXES.map((suffix) => suffix.replace(/\./g, "\\.")).join("|") +
  ")$|^(?:" +
    AD_HOST_PREFIXES.map((prefix) => prefix.replace(/\./g, "\\.")).join("|") +
  ")"
);

/** The one consumer verb: a declined hostname skips the surface. */
export function isAdHost(hostname) {
  return AD_HOST_RE.test(hostname);
}

/**
 * The command-relay channel: content -> backgrounds, one message per command
 * the debug console handle's pfCommand arm forwards. The background answers
 * with the exact browserAction-popup hop - browser.tabs.sendMessage onto the
 * active tab's top document, where kernel.js TabCommands receives - because
 * an extension can only deliver tabs.sendMessage to its OWN content scripts
 * (a second addon's companion/popup channel structurally never reaches this
 * package's receiver; the browser isolates runtime.onMessage per extension).
 * This is the one door the debug-mode surface opens into the popup's real
 * machinery: the arm relays, the receiver stays the single command owner,
 * and nothing new bypasses the top-frame-only posture. */
export const COMMAND_RELAY = "pf:command-relay";

/**
 * The background's network hint channel: background -> content, one message
 * per (tab, frame) that media-shaped traffic (video/audio content-type) was
 * seen flowing through. A HINT, never a verdict - the content kernel answers
 * by replaying the same boot its discovery probe would have run, and the
 * DOM-truth pipeline (resolveAdoptionHome, presence gates, the SDK registry)
 * still decides. A false hint is a free no-op (seen-pin + scope law refuse);
 * a missed hint (cache hits, bundled CDNs, no-request players) costs nothing
 * because the seed walk + media tap were already the whole detection story.
 * The background imports this vocabulary; the content receiver spells it
 * through the same table. */
export const NET_HINT = "pf:net-media";

/**
 * The Reforge plane's DRM latch channel: content -> background, one
 * message per realm whose document fed an EME-protected stream (the
 * passive `encrypted` listener sees it, no verb anywhere). The background
 * flips the frame's roster verdicts and refuses new ones for the frame:
 * the request plane's witness has no per-request "this stream is CDM-fed"
 * signal - the `encrypted` event is the ONLY reliable one - so the latch
 * message carries the veto. Unknown-verdict records go presumed-protected;
 * body-evidence verdicts (the ingest read the manifest text) outrank the
 * page context. The host page's vocabulary; the background receiver
 * spells it through the same table. */
export const DRM_LATCH = "pf:drm-latch";

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
