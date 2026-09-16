/**
 * Standardized debounced writer with auto-flush on destroy.
 *
 * Replaces the 3 identical debounce-write-flush patterns across the codebase:
 * - VideoFilter.#schedulePersist (filter.js)
 * - SubtitlesSection.#scheduleSyncOffset (section.js)
 * - SubtitlesSection.#stylePersist Map (section.js)
 *
 * Each instance wraps a write function with trailing-edge debouncing and
 * exposes `.call()` (schedule a write), `.flush()` (land a pending write
 * immediately), and `.cancel()` (drop a pending write). On AbortSignal
 * abort, a pending write is flushed automatically — the last value is
 * never lost.
 *
 * A `DestroyableWriter` collection manages a group of writers and flushes
 * them all on destroy, replacing the manual for-of-flush-clear pattern.
 *
 * @example
 * const writer = new DebouncedWriter(fields => setConfigFields(fields), 150, signal);
 * writer.call({ "filter.brightness": 110 });
 * // ... later, on destroy:
 * writer.flush(); // or auto-flushed by signal abort
 */
export class DebouncedWriter {
  #fn;
  #ms;
  #cancel = null;
  #pendingArgs = null;
  #destroyed = false;

  /**
   * @param {Function} fn - The write function to debounce.
   * @param {number} ms - Debounce interval in ms.
   * @param {AbortSignal} [signal] - Optional lifecycle signal; flush on abort.
   */
  constructor(fn, ms, signal) {
    this.#fn = fn;
    this.#ms = ms;
    if (signal) {
      signal.addEventListener("abort", () => this.flush(), { once: true });
      signal.addEventListener("abort", () => { this.#destroyed = true; }, { once: true });
    }
  }

  /** Schedule a debounced write. Arguments are forwarded to the write function. */
  call(...args) {
    if (this.#destroyed) return;
    this.#pendingArgs = args;
    this.#cancel?.();
    const id = setTimeout(() => {
      this.#cancel = null;
      this.#fn(...this.#pendingArgs);
      this.#pendingArgs = null;
    }, this.#ms);
    this.#cancel = () => clearTimeout(id);
  }

  /** Land a pending write immediately. No-op when nothing is pending. */
  flush() {
    if (!this.#cancel) return;
    this.#cancel();
    this.#cancel = null;
    this.#fn(...this.#pendingArgs);
    this.#pendingArgs = null;
  }

  /** Drop a pending write without executing it. */
  cancel() {
    this.#cancel?.();
    this.#cancel = null;
    this.#pendingArgs = null;
  }
}

/**
 * A collection of named DebouncedWriters with batch flush/cancel.
 *
 * Replaces the manual `Map<key, debounce()> + for-of-flush + clear` pattern
 * in SubtitlesSection and the single-writer flush-on-destroy in VideoFilter.
 *
 * @example
 * const writers = new DestroyableWriter(signal);
 * const sizeWriter = writers.add("size", fn, 150);
 * const colorWriter = writers.add("color", fn, 150);
 * // on destroy: all are flushed automatically via signal
 */
export class DestroyableWriter {
  /** @type {Map<string, DebouncedWriter>} */
  #writers = new Map();

  /**
   * @param {AbortSignal} signal - Lifecycle signal; all writers flush on abort.
   */
  constructor(signal) {
    signal.addEventListener("abort", () => this.flush(), { once: true });
  }

  /**
   * Register a named writer.
   * @param {string} name
   * @param {Function} fn
   * @param {number} ms
   * @returns {DebouncedWriter}
   */
  add(name, fn, ms) {
    const writer = new DebouncedWriter(fn, ms);
    this.#writers.set(name, writer);
    return writer;
  }

  /** Get a registered writer by name. */
  get(name) {
    return this.#writers.get(name);
  }

  /** Flush all writers (land pending writes). */
  flush() {
    for (const writer of this.#writers.values()) {
      writer.flush();
    }
  }

  /** Cancel all writers (drop pending writes). */
  cancel() {
    for (const writer of this.#writers.values()) {
      writer.cancel();
    }
  }

  /** Remove all writers. */
  clear() {
    this.#writers.clear();
  }
}
