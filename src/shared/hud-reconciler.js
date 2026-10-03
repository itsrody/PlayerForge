/**
 * L5 HudReconciler — snapshot -> desired DOM, diffed against the applied one.
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
    let wrote = false;
    for (const field of this.#fields) {
      const next = snapshot[field];
      // The first apply diffs against undefined, so a field whose first value
      // is itself undefined is skipped: nothing was ever rendered, so there is
      // nothing to un-render. Callers that need a first write normalise to a
      // real value (null, "") rather than leaving the key undefined.
      const before = prev === null ? undefined : prev[field];
      if (Object.is(next, before)) {
        continue;
      }
      this.#bindings[field](next, before, snapshot);
      this.#writes += 1;
      wrote = true;
    }
    // Adopted even when nothing was written: the new object is now the truth,
    // and adopting it is what arms the identity fast path for the next call.
    this.#applied = snapshot;
    return wrote;
  }
}
