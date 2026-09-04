import { register } from "node:module";
register("./css-hook.mjs", import.meta.url);

/**
 * jsdom 29 lacks several platform APIs the production code (targeting Firefox
 * 155+) uses unconditionally. Rather than scatter feature-detects through src/
 * to appease a headless test host, the absence is shimmed here - in the ONE
 * place the harness bootstraps - so production code stays idiomatic for the
 * real browser. These shims are no-ops; they exist only so constructor/import
 * paths don't throw.
 *
 * Only BARE-GLOBAL identifiers are shimmed (src/ resolves them via globalThis
 * in Node ESM). Instance-prototype APIs that tests never exercise (Element
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
  // Minimal cooperative scheduler shim: yield() resolves on a microtask for the
  // shell's prioritized DOM-injection continuation (shell.js), matching the
  // Firefox hand-back without needing a real task-dispatch scheduler.
  globalThis.scheduler = {
    yield: () => Promise.resolve()
  };
}
// Firefox's Scheduler.postTask() is used unconditionally by the cold subtitle
// parse path. Node has no scheduler, so run the callback on a microtask and
// honor the caller's AbortSignal (abort rejects with AbortError, mirroring the
// native postTask contract so parseSubtitlesAsync's AbortError handling is
// exercised the same way it runs in the browser).
if (typeof globalThis.scheduler?.postTask !== "function") {
  globalThis.scheduler.postTask = (callback, { signal } = {}) =>
    new Promise((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        fail();
        return;
      }
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", fail, { once: true });
      }
      queueMicrotask(() => {
        signal?.removeEventListener?.("abort", fail);
        resolve(callback());
      });
    });
}
// production context.js uses AbortSignal.any() (FF 124+) and AbortSignal.timeout()
// (FF 100+) to cap the frame-bridge round-trip. Node's statics brand-check their
// inputs, so a jsdom AbortController signal (tests swap globalThis.AbortController
// for the window's) throws inside the native any(). Since this host's elements
// carry jsdom signals, route both through the CURRENT AbortController at call
// time so the derived signal is brand-valid for jsdom addEventListener({signal}).
if (typeof AbortSignal !== "undefined") {
  const nativeTimeout = AbortSignal.timeout;
  const nativeAny = AbortSignal.any;
  // timeout(): prefer the native signal (Node timers + Node brand), else build a
  // jsdom-valid one from the active global AbortController.
  AbortSignal.timeout = (ms) => {
    try {
      return nativeTimeout(ms);
    } catch {
      const ac = new globalThis.AbortController();
      const id = setTimeout(() => ac.abort(), ms);
      ac.signal.addEventListener("abort", () => clearTimeout(id), { once: true });
      return ac.signal;
    }
  };
  // any(): try native first (all-native inputs), else derive a combined signal
  // from the active global AbortController so it passes jsdom's brand check.
  AbortSignal.any = (signals) => {
    try {
      return nativeAny(signals);
    } catch {
      const signalsArr = Array.from(signals);
      const ac = new globalThis.AbortController();
      if (signalsArr.some((s) => s && s.aborted)) {
        ac.abort();
        return ac.signal;
      }
      const fire = () => ac.abort();
      for (const s of signalsArr) {
        if (s && typeof s.addEventListener === "function") {
          s.addEventListener("abort", fire, { once: true });
        }
      }
      return ac.signal;
    }
  };
}
if (typeof globalThis.MediaMetadata === "undefined") {
  // Constructor copies the init fields so tests can assert what the bridge put
  // in OS metadata; the real API materializes them from the init dict too.
  globalThis.MediaMetadata = class MediaMetadata {
    constructor(init) {
      if (init) {
        Object.assign(this, init);
      }
    }
  };
}
// Firefox's Vibration API - absent on Node. Stubbed so gestureHaptic's
// feature-detect is true and tests can assert the haptic pulse pattern; the
// stub records the last pattern for inspection.
if (typeof globalThis.navigator?.vibrate !== "function") {
  globalThis.navigator.vibrate = (pattern) => {
    globalThis.__lastHapticPattern = pattern;
    return true;
  };
}
