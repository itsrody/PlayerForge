import { logger } from "../shared/logger.js";

const AUDIT_WINDOW = 200;

/**
 * Event bus over the platform EventTarget: payloads ride CustomEvent detail,
 * listeners subscribe with addEventListener ({ once, signal } supported),
 * and emits trace when debug mode is on.
 *
 * Debug-mode allocation audit: every emit allocates a fresh CustomEvent plus
 * a { detail } options object - two short-lived young objects. When debug is
 * on, these are tallied per type so a developer can watch allocation churn
 * rather than guess. A rolling summary logs every AUDIT_WINDOW emits (so the
 * console stays readable); auditSummary() exposes the live snapshot for
 * programmatic inspection. The audit adds zero cost when debug is off: the
 * single `bus.debug` boolean gate already short-circuits the whole branch.
 */
export class EventBus extends EventTarget {
  #debug = false;
  /** type -> { count, allocs } for the current audit window. */
  #auditCounts = null;
  #auditTotal = 0;
  #auditEmitCount = 0;

  set debug(value) {
    this.#debug = value;
    if (value) {
      this.#auditCounts = this.#auditCounts ?? new Map();
    } else {
      this.#auditCounts = null;
      this.#auditTotal = 0;
      this.#auditEmitCount = 0;
    }
  }

  emit(type, detail) {
    if (this.#debug) {
      logger.log("bus", `emit: ${type}`, detail);
      this.#audit(type);
    }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #audit(type) {
    let entry = this.#auditCounts.get(type);
    if (!entry) {
      entry = { count: 0, allocs: 0 };
      this.#auditCounts.set(type, entry);
    }
    entry.count++;
    // Two young allocations per emit: the CustomEvent itself and the
    // { detail } options envelope it wraps.
    entry.allocs += 2;
    this.#auditTotal += 2;
    this.#auditEmitCount++;
    if (this.#auditEmitCount >= AUDIT_WINDOW) {
      this.#logAudit();
      this.resetAudit();
    }
  }

  /** Zero the running tallies; the audit stays armed until debug is off. */
  resetAudit() {
    this.#auditCounts?.clear();
    this.#auditTotal = 0;
    this.#auditEmitCount = 0;
  }

  /** Live snapshot: { emits, allocs, byType } for the current window. */
  auditSummary() {
    if (!this.#debug || !this.#auditCounts) {
      return { emits: 0, allocs: 0, byType: {} };
    }
    const byType = {};
    for (const [type, entry] of this.#auditCounts) {
      byType[type] = { emits: entry.count, allocs: entry.allocs };
    }
    return { emits: this.#auditEmitCount, allocs: this.#auditTotal, byType };
  }

  #logAudit() {
    const { emits, allocs } = this.auditSummary();
    logger.log("bus", `allocation audit: ${emits} emits, ~${allocs} young allocs`);
    const top = [...this.#auditCounts.entries()]
      .sort((a, b) => b[1].allocs - a[1].allocs)
      .slice(0, 5)
      .map(([t, e]) => `${t}(${e.allocs})`);
    logger.log("bus", `allocation hot types: ${top.join(", ") || "none"}`);
  }
}
