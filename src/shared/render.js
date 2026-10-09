/**
 * Commit pipeline: the render gate (L4 — when a commit may run) and the HUD
 * reconciler (L5 — what a commit may touch). One module because every commit
 * is both: no producer ever schedules without diffing or diffs without
 * scheduling, so splitting them bought an import line per surface for a
 * boundary nothing crosses. The layer split is preserved inside — the gate
 * never touches the DOM and the reconciler never schedules — and each
 * section keeps its own header below.
 */

import { postTask } from "./scheduler.js";

/* ── L4 RenderGate ───────────────────────────────────────────────────────
 *
 * Demand-triggered, tick-coalescing, priority-routed commit.
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
  #task = () => this.#run();
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
    this.#handle = postTask(this.#task, {
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

/* ── L5 HudReconciler ────────────────────────────────────────────────────
 *
 * Snapshot -> desired DOM, diffed against the applied one.
 *
 * L4 decides *when* a commit is allowed to run. This decides *what it is
 * allowed to touch*. The two stack rather than overlap: a gate that hands a
 * writer a fresh task every time still performs every write the writer asks
 * for, and a writer that compares before writing still does so at whichever
 * moment it was called from.
 *
 * PlayerForge needs this hand-written precisely because it has no template
 * layer (§4 cross-reference): Media Chrome gets value-diffing free from
 * `lit-html`'s `TemplateInstance.update()`, and a frozen hand-written HUD has
 * nothing underneath to absorb the mistake. uBO is explicitly *not* a
 * precedent here (§3.1) — `attr()` writes unconditionally — so the discipline
 * below is this codebase's own, and §5 asks for it to be *measured*.
 *
 * The whole mechanism is one table:
 *
 *   bindings = { field: (next, prev, snapshot) => void }   // the only writer
 *   apply(s)  → for each field, if Object.is(next, prev) skips the binding
 *
 * Properties:
 *
 *   Derived field set, one table (§3.2). `Object.keys(bindings)` is computed
 *   once at construction and is the *only* thing `apply()` iterates, so a key
 *   present on a snapshot but absent from the table is inert rather than
 *   half-applied. Adding a rendered field means adding one table entry; there
 *   is no second list to keep in sync.
 *
 *   Compare before write, keyed on `Object.is`, so `0`/`1`, `""`/`null` and
 *   two equal strings all compare the way producers expect. The honest
 *   rationale is the §4/§2.2 one: interning is content-addressed, so a no-op
 *   write does not by itself break tiles — the win is upstream style
 *   invalidation and notification batching, whose no-op behaviour Gecko
 *   documents as an open question. Cheap insurance, worth measuring (hence
 *   `writes`), not proven disaster-avoidance.
 *
 *   `textContent` is the expensive case and is gated like every other field —
 *   text runs participate in the most interning and re-raster work, so a text
 *   binding must be the *last* thing to fire on a transition, never the
 *   unconditional one. Note that the bindings themselves stay dumb: gating
 *   lives in `apply()`, not in thirty copies of `if (value !== current)`.
 *
 *   Identity fast path. Re-applying the exact object that is already applied
 *   is one pointer compare. **This is a contract, not a courtesy:** a caller
 *   that mutates a snapshot in place and re-applies it will be skipped, so
 *   snapshots must be treated as immutable once handed over. The toast producer
 *   in `shell/chrome/toast.js` re-uses and mutates one object per scrub tick,
 *   so it *builds* a fresh snapshot per `show()` for exactly this reason.
 *
 *   Readiness drop guard (§3.2). Media Chrome gets its "not ready yet" gate
 *   from `lit-html` plus a `MutationObserver` readiness check; a hand-rolled
 *   reconciler needs its own, so a nullish snapshot is dropped rather than
 *   throwing. Call sites already reach it through `?.`.
 *
 *   `writes` is §5's instrumentation hook ("instrument reconciler writes, diff
 *   against applied snapshot"). It counts binding invocations — writes this
 *   reconciler decided were necessary — not DOM mutations, because the binding
 *   is where the decision is made.
 *
 * What it deliberately does *not* do: schedule. There is no rAF, no postTask
 * and no queue here; a caller that needs a commit deferred asks L4. It also
 * does not do occlusion — dropping `display: none` when the HUD is hidden is
 * Phase 5's gate, not this layer's.
 */

export class HudReconciler {
  /** Field names, in table order. Computed once; see the header. */
  #fields;
  #bindings;
  /** The last snapshot handed to `apply()`, or null before the first one. */
  #applied = null;
  #writes = 0;

  /**
   * @param {{ bindings: Record<string, (next: any, prev: any, snapshot: object) => void> }} opts
   *   `bindings` is the single source of truth for which fields are rendered
   *   and how each one reaches the DOM.
   */
  constructor({ bindings } = {}) {
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
      throw new TypeError("HudReconciler requires a bindings table");
    }
    const fields = Object.keys(bindings);
    for (const field of fields) {
      if (typeof bindings[field] !== "function") {
        throw new TypeError(`HudReconciler binding "${field}" is not a function`);
      }
    }
    this.#fields = fields;
    this.#bindings = bindings;
  }

  /** The snapshot currently reflected in the DOM, or null before the first. */
  get applied() {
    return this.#applied;
  }

  /** Binding invocations this reconciler has issued. §5's counter. */
  get writes() {
    return this.#writes;
  }

  /**
   * Make the DOM match `snapshot`, touching only what actually changed.
   *
   * @param {object | null | undefined} snapshot the desired end state
   * @returns {boolean} true if at least one binding ran
   */
  apply(snapshot) {
    if (snapshot == null) {
      return false;
    }
    if (typeof snapshot !== "object") {
      throw new TypeError("HudReconciler.apply expects a snapshot object");
    }
    if (snapshot === this.#applied) {
      return false;
    }
    const prev = this.#applied;
    const fields = this.#fields;
    const bindings = this.#bindings;
    let wrote = false;
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const next = snapshot[field];
      // The first apply diffs against undefined, so a field whose first value
      // is itself undefined is skipped: nothing was ever rendered, so there is
      // nothing to un-render. Callers that need a first write normalise to a
      // real value (null, "") rather than leaving the key undefined.
      const before = prev === null ? undefined : prev[field];
      if (Object.is(next, before)) {
        continue;
      }
      bindings[field](next, before, snapshot);
      this.#writes += 1;
      wrote = true;
    }
    // Adopted even when nothing was written: the new object is now the truth,
    // and adopting it is what arms the identity fast path for the next call.
    this.#applied = snapshot;
    return wrote;
  }
}
