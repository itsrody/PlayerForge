/**
 * L0 — EngineHost: the single source of truth for engine capability facts.
 *
 * `platform/capabilities.json` is Node-side and cannot be read by the
 * userscript, so every "does this host offer X" question the shipped code
 * needs answered is answered here, once, at construction. Higher layers ask
 * the host instead of feature-detecting, which is what keeps one fact from
 * being re-derived at a dozen call sites with a dozen subtly different
 * guards.
 *
 * Deliberately narrow: only capabilities with live readers live here
 * (scheduler and frame APIs below). Identity facts with no readers - engine
 * brand, Gecko version, manager realm, postTask/yield presence - were cut:
 * recording them made the snapshot look authoritative about things nothing
 * branched on, and a fact nobody reads is a fact nobody keeps honest. Anything
 * that can change while the page runs — document visibility, rAF
 * availability under the test harness, media element state — stays where it
 * is read, because caching it here would freeze a value the caller re-reads
 * live today.
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
 * The frame flags sit on the far side of that line: `canRvfc` and
 * `canMozQuality` are *engine* facts - whether this engine ships the API on
 * `HTMLVideoElement.prototype` - so they are read here and the frame-quality
 * sampler does not re-derive them. Whether a particular element has been
 * upgraded yet is still answered on that element, where it is read.
 *
 * Ownership: the snapshot is taken eagerly at import (the ambient globals at
 * document-start ARE the facts), and entry bootstrap re-probes explicitly via
 * probeEngineHost() before anything reads - so the owner is written down in
 * code, not just in this comment. Re-probing also serves realm transitions
 * (a fresh document under test harnesses): same construction, current
 * globals. The class stays directly constructible for per-case tests.
 */

export class EngineHost {
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

/** The host for this document. Replaced whole by probeEngineHost(); readers
 *  hold the binding, never a copy, so they always see the current snapshot. */
export let engineHost = Object.freeze(new EngineHost());

/**
 * (Re)probe the shared snapshot from the current globals. Entry bootstrap
 * calls this first: import order must never decide what the facts are.
 * Idempotent - same globals, same frozen answers.
 */
export function probeEngineHost() {
  engineHost = Object.freeze(new EngineHost());
  return engineHost;
}
