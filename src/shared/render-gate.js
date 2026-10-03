/**
 * L4 RenderGate — demand-triggered, tick-coalescing, priority-routed commit.
 *
 * Until this module exists, a media edge writes `--pf-media-paused` inline
 * from the event handler: `play` then `pause` in one tick is two `setProperty`
 * calls and two style invalidations, and the priority of the write was fixed
 * by whichever handler happened to run first. The gate makes a commit a *task*
 * with a priority instead of an extension of the event that caused it.
 *
 * The whole mechanism is one coalescing guard:
 *
 *   request() → if nothing is pending, schedule one one-shot task → the task
 *   runs the commit and clears the guard.
 *
 * Properties, each of which is a §5 invariant rather than an optimisation:
 *
 *   One commit per tick. N requests before the task runs are one commit; the
 *   counter below is what §5 means by "count `RenderGate.#commit`".
 *
 *   Never self-rearming (Trap 1). `#pending` is still true *while* the commit
 *   runs and is only cleared after it, so a `request()` raised from inside the
 *   commit is dropped rather than scheduling another task. That is deliberate:
 *   scheduler.js measured a 40-deep self-rearming postTask chain draining with
 *   zero rAF callbacks between them, i.e. starved paint. A separate `#running`
 *   flag guards the case the priority logic below would otherwise open: a
 *   *higher*-priority request raised mid-commit must not take the re-raise
 *   branch and abort the handle it is standing on. Anything genuinely
 *   re-armed must be re-armed from an observer callback or a timer, both of
 *   which run after this task settles, when `#pending` is already false.
 *
 *   Priority is a routing hint, not a second gate. A higher-priority request
 *   arriving while a lower one is pending *replaces* it (abort + reschedule at
 *   the new priority) so input is never queued behind a background task; a
 *   same-or-lower one is dropped, because the pending task already outranks it.
 *   Either way there is still exactly one commit this tick.
 *
 *   Aborted with its owner. The controller is a child of the session scope, so
 *   `pagehide` / kernel teardown / SPA re-injection leaves no task to fire into
 *   a dead DOM.
 *
 * The commit reads *current state*, not a delta. That is what makes dropping a
 * request raised mid-commit safe for the one producer registered so far: the
 * writes are two `style.setProperty` calls, which cannot synchronously emit a
 * media event, and every other observer (MutationObserver, rAF, timer) runs
 * after this task and re-requests normally.
 *
 * Not used for frame-dependent measurement: §2.6 notes no render fence exists
 * to await, so that samples the next refresh tick via a one-shot rAF instead.
 */

import { postTask } from "./scheduler.js";

/** The three priorities scheduler.postTask understands, ordered low → high. */
const RANK = Object.freeze({ background: 0, "user-visible": 1, "user-blocking": 2 });

const DEFAULT_PRIORITY = "user-visible";

/** Unknown or absent priority normalises to the default rather than reaching
 *  the host as a string the Task Scheduling API would reject. */
function canonical(priority) {
  return Object.hasOwn(RANK, priority) ? priority : DEFAULT_PRIORITY;
}

export class RenderGate {
  #commit;
  #controller = new AbortController();
  #pending = false;
  #priority = DEFAULT_PRIORITY;
  #handle = null;
  #commits = 0;
  #running = false;
  #disposed = false;

  /**
   * @param {{ commit: () => void, signal?: AbortSignal }} opts `signal` is the
   *   owner scope's; aborting it disposes the gate and cancels a pending commit.
   */
  constructor({ commit, signal } = {}) {
    if (typeof commit !== "function") {
      throw new TypeError("RenderGate requires a commit function");
    }
    this.#commit = commit;
    if (signal) {
      if (signal.aborted) {
        this.dispose();
      } else {
        signal.addEventListener("abort", () => this.dispose(), { once: true });
      }
    }
  }

  /** Commits that have run, including one whose commit threw. §5's counter. */
  get commits() {
    return this.#commits;
  }

  /** True from `request()` until the scheduled commit has finished. */
  get pending() {
    return this.#pending;
  }

  /** The priority the pending commit will run at, or null when idle. */
  get priority() {
    return this.#pending ? this.#priority : null;
  }

  get disposed() {
    return this.#disposed;
  }

  /**
   * Ask for one commit this tick.
   *
   * @param {string} priority `background` | `user-visible` | `user-blocking`
   * @returns {boolean} true if this call (re)scheduled the task, false if an
   *   equal-or-higher priority task was already pending or the gate is disposed.
   */
  request(priority = DEFAULT_PRIORITY) {
    if (this.#disposed) {
      return false;
    }
    // Trap 1, checked before the priority comparison rather than as part of
    // it: while the commit is on the stack, `#pending` is true, so a *higher*
    // priority would otherwise take the re-raise branch below, abort the
    // running handle and schedule a fresh task - a self-rearming chain wearing
    // a priority label. Nothing may re-arm from inside the commit, at any
    // priority; the producer re-requests from a later edge or observer.
    if (this.#running) {
      return false;
    }
    const next = canonical(priority);
    if (this.#pending) {
      if (RANK[next] <= RANK[this.#priority]) {
        return false;
      }
      this.#handle?.abort();
      this.#handle = null;
    }
    this.#pending = true;
    this.#priority = next;
    this.#handle = postTask(() => this.#run(), {
      priority: next,
      signal: this.#controller.signal
    });
    return true;
  }

  #run() {
    this.#running = true;
    try {
      this.#commits += 1;
      this.#commit();
    } finally {
      // Cleared after the commit, not before: see Trap 1 in the header. The
      // handle is cleared in the same place so a request that lands after this
      // task but before the microtask checkpoint cannot abort a dead handle.
      this.#running = false;
      this.#pending = false;
      this.#priority = DEFAULT_PRIORITY;
      this.#handle = null;
    }
  }

  /** Cancel a pending commit and refuse further requests. Idempotent. */
  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#pending = false;
    this.#priority = DEFAULT_PRIORITY;
    this.#handle?.abort();
    this.#handle = null;
    this.#controller.abort();
  }
}
