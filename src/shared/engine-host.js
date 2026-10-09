/**
 * L0 — EngineHost: the single source of truth for environment facts.
 *
 * `platform/capabilities.json` is Node-side and cannot be read by the
 * userscript, so every "does this host have X" question the shipped code needs
 * has to be answered here, once, at construction. Higher layers ask the host
 * instead of feature-detecting, which is what keeps one fact from being
 * re-derived at a dozen call sites with a dozen subtly different guards.
 *
 * Deliberately narrow: only truly static environment facts live here (engine,
 * realm, scheduler, the frame APIs below). Anything that can change while the
 * page runs — document visibility, rAF availability under the test harness,
 * media element state — stays where it is read, because caching it here would
 * freeze a value the caller re-reads live today.
 *
 * Note what is absent, and why:
 *
 * - **No `canRender` / "await paint" flag.** There is no such API to detect, so
 *   claiming one would be a design dependency on an API the Scheduler interface
 *   does not have (ARCHITECTURE §2.6).
 * - **No `canRaf`.** `yield_()` re-reads `requestAnimationFrame` on every call
 *   because the harness installs and removes it per test
 *   (tests/scheduler.test.mjs, tests/perf-diag.test.mjs). A construction-time
 *   snapshot would pick a branch that no longer matches the host.
 *
 * The two frame flags sit on the other side of that line: `canRvfc` and
 * `canMozQuality` are *engine* facts - whether this engine ships the API on
 * `HTMLVideoElement.prototype` - so they are read here and the frame-quality
 * sampler does not re-derive them. Whether a particular element has been
 * upgraded yet is still answered on that element, where it is read.
 *
 * The engine stays realm-agnostic by construction: `realm` is recorded for the
 * about surface and for diagnosis, never consulted to decide whether a page
 * object may be touched. SDK detection reads composed DOM ancestry and never a
 * page-defined global, so no branch on this field can change behaviour.
 */

/**
 * Extract the engine version from a Gecko user agent, prerelease-aware so the
 * channel suffix survives (`158.0b3`, `160.0a1`) rather than flattening every
 * build to its release number.
 *
 * A release build reports `Firefox/158.0`, a beta `Firefox/158.0b3`, a Nightly
 * `Firefox/160.0a1` — the suffix is present in the UA, so nothing outside the
 * userscript realm has to be consulted for it.
 *
 * @param {string} userAgent
 * @returns {string|null} the version, or null when the UA is not a Firefox one
 */
export function parseGeckoVersion(userAgent) {
  const match = /Firefox\/(\d+(?:\.\d+)?(?:[ab]\d+)?)/.exec(userAgent ?? "");
  return match ? match[1] : null;
}

export class EngineHost {
  #engine = "Gecko";
  /** Prerelease-aware, e.g. "158.0b3". Null when the host is not Gecko. */
  #version = null;
  /** 'page' | 'content' | 'auto' as granted by the manager, else null. */
  #realm = null;
  #canPostTask = false;
  #canYield = false;
  #canMessageChannel = false;
  /** Whether the engine ships requestVideoFrameCallback on HTMLVideoElement. */
  #canRvfc = false;
  /**
   * Whether the engine ships the whole quality set: the standard
   * `getVideoPlaybackQuality()` plus Gecko's `mozPresentedFrames` /
   * `mozPaintedFrames` pair. All three or none — Gecko reports
   * `VideoPlaybackQuality.presentedFrames` as null, so the standard half alone
   * cannot produce the "submitted vs painted" number the report is built on.
   */
  #canMozQuality = false;

  constructor() {
    // Optional reads, not `typeof` guards: the manager supplies GM_info in our
    // own realm when it provides one, and an absent navigator is a test host,
    // not a branch worth a feature probe.
    this.#version = parseGeckoVersion(globalThis.navigator?.userAgent ?? "");
    this.#realm = globalThis.GM_info?.injectInto ?? null;
    // postTask ships from Firefox 142 (ARCHITECTURE §2.6), inside the 157
    // floor, and the facade calls it unconditionally. Recording it here is what
    // makes the availability one fact instead of an assumption repeated by
    // every caller.
    this.#canPostTask = typeof globalThis.scheduler?.postTask === "function";
    // Recorded, never driven: scheduler.yield() is architecturally ruled out by
    // Trap 2 (ARCHITECTURE §7), so chunking uses yield_() instead. A future
    // strategy that wants to know what the host offers asks here.
    this.#canYield = typeof globalThis.scheduler?.yield === "function";
    // nextTask()'s first choice: MessageChannel tasks are not timer-throttled
    // on Gecko, so a hidden tab still makes progress. Present in every host we
    // run on, but it was probed independently in two modules before this.
    this.#canMessageChannel = typeof MessageChannel === "function";
    // The coarse presentation edge (§2.5): Gecko ships it from 132, well under
    // the floor, but it is still a stated fact rather than an assumption
    // because a caller must be able to ask without feature-detecting itself -
    // and because the answer has to come from the prototype, not from an
    // element that may not have been upgraded yet.
    this.#canRvfc =
      typeof globalThis.HTMLVideoElement?.prototype?.requestVideoFrameCallback === "function";
    // The quality set that answers "how many frames did we lose" (§2.5, §7),
    // read as one unit for the reason on the field above. `mozPresentedFrames`
    // and `mozPaintedFrames` are data members, so they are probed with `in`
    // rather than a typeof, which would report the value they currently hold
    // instead of whether the engine has them. The typeof on the standard half
    // is what keeps the `in` guards from running when there is no prototype.
    const proto = globalThis.HTMLVideoElement?.prototype;
    this.#canMozQuality =
      typeof globalThis.HTMLVideoElement?.prototype?.getVideoPlaybackQuality === "function" &&
      "mozPresentedFrames" in proto &&
      "mozPaintedFrames" in proto;
  }

  get engine() {
    return this.#engine;
  }

  get version() {
    return this.#version;
  }

  get realm() {
    return this.#realm;
  }

  get canPostTask() {
    return this.#canPostTask;
  }

  get canYield() {
    return this.#canYield;
  }

  get canMessageChannel() {
    return this.#canMessageChannel;
  }

  get canRvfc() {
    return this.#canRvfc;
  }

  get canMozQuality() {
    return this.#canMozQuality;
  }
}

/** The host for this document. Frozen: read-only after construction. */
export const engineHost = Object.freeze(new EngineHost());
