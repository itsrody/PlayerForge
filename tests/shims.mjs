/**
 * jsdom 29 (and bare Node) lack several platform APIs the Chromium-only
 * production code uses unconditionally. Rather than scatter feature-detects
 * through src/ to appease a headless host, the absence is shimmed here - in
 * the ONE place the harness bootstraps - so production code stays pure
 * Chromium 155. These shims are no-ops (or faithful stand-ins) that exist so
 * import paths and constructor calls don't throw in tests AND bench cases;
 * the bench cases need the same semantics as the tests, or they would end up
 * benchmarking a page that crashes on real paths, measuring fallbacks.
 *
 * Only BARE-GLOBAL identifiers are shimmed (src/ resolves them via globalThis
 * in Node ESM). Instance-prototype APIs the harness never exercises (Element
 * .animate, canvas, etc.) are deliberately not faked - faking them here would
 * be ineffective for jsdom-created elements anyway.
 */
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.IntersectionObserver === "undefined") {
  // Minimal no-op shim so the on-screen gate in resume.js is reachable in
  // tests; it keeps `onScreen` true (the safe default) since it never fires a
  // callback, matching the real browser before the first observation lands.
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}
if (typeof globalThis.scheduler === "undefined") {
  // The harness scheduler: a real implementation of the scheduler.postTask /
  // scheduler.yield contract production composes (Chromium 129+ everywhere on
  // the floor). postTask honors priority/delay/signal exactly like the native
  // backend - per-task AbortController, abort cancels the pending timer, task
  // promise rejects (callers' façade catches) - so tests exercise the same
  // semantics as a real Chromium tab instead of a duplicated fallback arm
  // that production no longer carries. yield() hands back on the microtask
  // queue: cooperative, no event-loop cross-phase dependency.
  class HarnessScheduler {
    postTask(fn, { delay = 0, signal } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("task aborted", "AbortError"));
          return;
        }
        const id = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve(fn());
        }, delay);
        const onAbort = () => {
          clearTimeout(id);
          reject(new DOMException("task aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    yield() {
      // Microtask hand-back. A raw setImmediate/macrotask would lose the
      // ordering race against the tick helpers' own setTimeout(0) (jsdom's
      // MutationObserver checkpoint lands in between), where the microtask
      // matches what the tests were built against; production never runs
      // this shim - it composes the real scheduler.yield() on Chromium.
      return Promise.resolve();
    }
  }
  globalThis.scheduler = new HarnessScheduler();
}
if (typeof globalThis.navigation === "undefined") {
  // The harness Navigation API: a duck-typed event target that accepts any
  // realm's { signal } (jsdom or Node - each signal is itself an EventTarget
  // in its own world), so tests dispatch real `currententrychange` events
  // the way a Chromium tab delivers them and the same teardown question is
  // exercised as production. Production's onNavigate subscribes here
  // exactly as it does natively, and jsdom's history/pushState stays silent
  // (the popstate/hashchange fallback production dropped), so a route
  // change is always an explicit event the test itself dispatches.
  class HarnessNavigation {
    #listeners = new Map();
    #entriesFor(type) {
      let entries = this.#listeners.get(type);
      if (!entries) {
        entries = [];
        this.#listeners.set(type, entries);
      }
      return entries;
    }
    addEventListener(type, listener, { signal } = {}) {
      if (typeof listener !== "function" || signal?.aborted) {
        return;
      }
      const entry = {
        listener,
        onAbort: () => this.removeEventListener(type, listener)
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.#entriesFor(type).push(entry);
    }
    removeEventListener(type, listener) {
      const entries = this.#listeners.get(type);
      if (!entries) {
        return;
      }
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].listener === listener) {
          entries.splice(i, 1);
        }
      }
    }
    dispatchEvent(event) {
      for (const { listener } of this.#entriesFor(event.type)) {
        listener.call(this, event);
      }
    }
  }
  globalThis.navigation = new HarnessNavigation();
}
if (typeof globalThis.MediaMetadata === "undefined") {
  globalThis.MediaMetadata = class MediaMetadata {};
}
if (typeof globalThis.matchMedia !== "function") {
  // jsdom has no viewport/media-query engine. A static no-op keeps the
  // shell's compact-mode auto-detect and its matchMedia change listener
  // constructible in tests; matches stays false so the narrow-touch
  // breakpoint never toggles into compact mode under the harness, and
  // addEventListener/removeEventListener are no-ops since no test drives a
  // viewport crossing.
  globalThis.matchMedia = () => ({
    get matches() {
      return false;
    },
    addEventListener() {},
    removeEventListener() {}
  });
}
// Chromium's Vibration API - absent on Node. Stubbed so gestureHaptic's
// feature-detect is true and tests can assert the haptic pulse pattern; the
// stub records the last pattern for inspection.
if (typeof globalThis.navigator?.vibrate !== "function") {
  globalThis.navigator.vibrate = (pattern) => {
    globalThis.__lastHapticPattern = pattern;
    return true;
  };
}
