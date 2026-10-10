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
 * Deliberately narrow: the one capability with live readers. Frame facts
 * used to live here too, read off `HTMLVideoElement.prototype` - but every
 * consumer already probes the element itself (resume.js always did), and a
 * built-in element is never un-upgraded, so the prototype read bought a
 * second answer to a question the element answers better. Anything
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
 * snapshot would pick a branch that no longer matches the host.
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

  constructor() {
    // nextTask()'s first choice: MessageChannel tasks are not timer-throttled
    // on Gecko, so a hidden tab still makes progress. Present in every host we
    // run on, but it was probed independently in two modules before this.
    this.#canMessageChannel = typeof MessageChannel === "function";
  }

  get canMessageChannel() {
    return this.#canMessageChannel;
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
