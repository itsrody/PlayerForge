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
 * realm, scheduler). Anything that can change while the page runs — document
 * visibility, rAF availability under the test harness, media element state —
 * stays where it is read, because caching it here would freeze a value the
 * caller re-reads live today.
 *
 * Note what is absent, and why:
 *
 * - **No `canRender` / "await paint" flag.** There is no such API to detect, so
 *   claiming one would be a design dependency on an API the Scheduler interface
 *   does not have (ARCHITECTURE-2.0 §2.6).
 * - **No `canRaf`.** `yield_()` re-reads `requestAnimationFrame` on every call
 *   because the harness installs and removes it per test
 *   (tests/scheduler.test.mjs, tests/perf-diag.test.mjs). A construction-time
 *   snapshot would pick a branch that no longer matches the host.
 * - **No `canRvfc` / `canMozQuality` yet.** Those arrive with migration phase 6
 *   (frame quality), alongside the signals that consume them.
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

  constructor() {
    // Optional reads, not `typeof` guards: the manager supplies GM_info in our
    // own realm when it provides one, and an absent navigator is a test host,
    // not a branch worth a feature probe.
    this.#version = parseGeckoVersion(globalThis.navigator?.userAgent ?? "");
    this.#realm = globalThis.GM_info?.injectInto ?? null;
    // postTask ships from Firefox 142 (ARCHITECTURE-2.0 §2.6), inside the 157
    // floor, and the facade calls it unconditionally. Recording it here is what
    // makes the availability one fact instead of an assumption repeated by
    // every caller.
    this.#canPostTask = typeof globalThis.scheduler?.postTask === "function";
    // Recorded, never driven: scheduler.yield() is architecturally ruled out by
    // Trap 2 (ARCHITECTURE-2.0 §7), so chunking uses yield_() instead. A future
    // strategy that wants to know what the host offers asks here.
    this.#canYield = typeof globalThis.scheduler?.yield === "function";
    // nextTask()'s first choice: MessageChannel tasks are not timer-throttled
    // on Gecko, so a hidden tab still makes progress. Present in every host we
    // run on, but it was probed independently in two modules before this.
    this.#canMessageChannel = typeof MessageChannel === "function";
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
}

/** The host for this document. Frozen: read-only after construction. */
export const engineHost = Object.freeze(new EngineHost());
