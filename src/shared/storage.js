import { logger } from "./diagnostics.js";

/**
 * Manager-API policy: a manager API is used only where it uniquely supplies a
 * capability the page cannot - multi-tab manager storage + change
 * notification (configs/resume), CORS-bypassing XHR (@connect * subtitle
 * fetch), manager-cached resource warm-load, manager menu, GM_info. Everything
 * DOM/media/styling-side (MutationObserver, TextTrack/VTTCue,
 * adoptedStyleSheets, fullscreen) stays native; the efficient,
 * reliable implementation wins, and for those domains the native one always
 * does. GM_setClipboard is deliberately NOT granted/used: no feature calls
 * it, so the grant is dead permission surface. Any future clipboard write
 * should go through the native navigator.clipboard path, not the manager.
 */

/** The whole GM storage namespace: every root key lives here. */
export const KEYS = {
  configs: "pf:configs",
  resume: "pf:resume",
  firstRun: "pf:first-run"
};

/**
 * Synchronous manager read with a fallback, never a throw: without the grant
 * (or outside a userscript context) there is no stored value to return, so
 * the fallback is the honest answer rather than a ReferenceError into boot.
 */
function gmGetValue(key, fallback) {
  if (typeof GM_getValue !== "function") {
    return fallback;
  }
  try {
    return GM_getValue(key, fallback);
  } catch {
    return fallback;
  }
}

/**
 * Synchronous manager write reporting success. False when the grant is
 * missing or the manager rejects the write (quota) - callers that cannot
 * proceed on a lost write check it; #persist rolls the cache back on it.
 */
export function gmSetValue(key, value) {
  if (typeof GM_setValue !== "function") {
    return false;
  }
  try {
    GM_setValue(key, value);
  } catch {
    return false;
  }
  return true;
}

/**
 * Returns a handle for gmUnregisterMenu, or null when unavailable.
 *
 * The options object is forwarded as-is. Violentmonkey 2.49.0's
 * injected-web.js clones the third argument, sets `opts.text` from the
 * caption and keys the entry on `opts.id || caption`, so an options object is
 * the correct type there - and it returns that key, so the handle is always
 * usable.
 */
export function gmRegisterMenu(title, onClick, options) {
  if (typeof GM_registerMenuCommand !== "function") {
    return null;
  }
  return GM_registerMenuCommand(title, onClick, options);
}

/** Takes the handle returned by gmRegisterMenu. */
export function gmUnregisterMenu(handle) {
  if (handle == null || typeof GM_unregisterMenuCommand !== "function") {
    return;
  }
  GM_unregisterMenuCommand(handle);
}

/**
 * Subscribes to a key's changes and returns an opaque handle for removal.
 *
 * Violentmonkey 2.49.0 mints a fresh id per call and delivers to every
 * registration, so the manager handle is passed straight through:
 * injected-web.js does `s || (s = x("VMvc"), n[s] = cb)` per key, and
 * GM_removeValueChangeListener walks the keys looking for that id. PlayerForge
 * has more than one live subscriber per key - every shell owns a ResumeStore -
 * and that is fine here precisely because nothing is shared or overwritten.
 */
export function gmAddValueChangeListener(key, callback) {
  if (typeof GM_addValueChangeListener !== "function") {
    return null;
  }
  return GM_addValueChangeListener(key, callback);
}

export function gmRemoveValueChangeListener(handle) {
  if (handle == null || typeof GM_removeValueChangeListener !== "function") {
    return;
  }
  GM_removeValueChangeListener(handle);
}

export function gmGetResourceText(name) {
  if (typeof GM_getResourceText !== "function") {
    return null;
  }
  return GM_getResourceText(name);
}

/**
 * Cross-origin text fetch through the manager - CORS cannot block it.
 * The banner declares @connect * because subtitle URLs are user-supplied
 * from arbitrary hosts; a per-domain consent gate would be friction on the
 * hot subtitle-loading path. Request errors still surface normally, so a
 * dead link fails loudly rather than silently.
 *
 * Never throws synchronously: without the grant there is no fetch to run,
 * so a rejection carries that instead. An aborted request (own `signal` or
 * the manager's `onabort`) rejects rather than pending forever.
 */
export function gmRequestText(url, { timeoutMs = 30000, signal } = {}) {
  if (typeof GM_xmlhttpRequest !== "function") {
    return Promise.reject(new Error("GM_xmlhttpRequest unavailable"));
  }
  const { promise, resolve, reject } = Promise.withResolvers();
  if (signal?.aborted) {
    reject(new Error("Aborted"));
    return promise;
  }
  let req = null;
  signal?.addEventListener("abort", () => {
    try {
      req?.abort?.();
    } catch {}
    reject(new Error("Aborted"));
  }, { once: true });
  req = GM_xmlhttpRequest({
    url,
    method: "GET",
    timeout: timeoutMs,
    onload: (res) => {
      const status = res?.status ?? 0;
      if (status >= 200 && status < 300) {
        resolve(res);
      } else {
        reject(new Error(`HTTP ${status}`));
      }
    },
    onerror: () => reject(new Error("Network error")),
    ontimeout: () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
    onabort: () => reject(new Error("Aborted"))
  });
  return promise;
}

/**
 * Read a stored JSON object, or the fallback when missing/corrupt. Plain
 * objects only: a stored array (hand edit, cross-version write) is not a
 * document and must not pass as one - `adopt()` already refuses it, so the
 * read path refusing it too keeps both doors the same shape. Corruption is
 * warned, not silent: a fallback served without a trace is how a wiped
 * config reads as user intent.
 */
export function loadJsonObject(key, fallback) {
  const raw = gmGetValue(key, null);
  if (isPlainObject(raw)) {
    return raw;
  }
  if (raw != null) {
    logger.warn("storage", `Stored ${key} is not an object - falling back`);
  }
  return fallback;
}

function isSafeKeySegment(key) {
  // Empty segments are nonsense keys ("".split(".") is [""], "a..b" hides
  // one in the middle): reject them with the prototype guards rather than
  // persisting nodes no reader can address.
  return key !== "" && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Dotted LEAF paths whose value differs between two documents, collected into
 * `out`. Subscribers filter on exact leaf paths, so the report has to land on
 * the paths they actually read:
 *
 * - branch vs branch: descend, so unchanged siblings stay unreported
 * - absent/leaf vs branch (a subtree ARRIVED): descend into the new branch, so
 *   the leaves a subscriber reads are the ones announced
 * - branch vs absent/leaf (a subtree COLLAPSED): report both the collapsing
 *   path and the leaves it held. The leaves are gone - their subscribers must
 *   re-read and fall back to defaults - and the new value at the collapsing
 *   path belongs to no descendant, so it has to be announced in its own right
 * - leaf vs leaf: compare directly
 *
 * Both roots are normalized to plain objects before the call, so the walk
 * always descends at the top and `out` is non-empty whenever it reports a
 * change: a subscriber can treat "no paths" as a genuine no-op.
 */
function collectChangedPaths(previous, next, prefix, out) {
  const previousIsBranch = isPlainObject(previous);
  const nextIsBranch = isPlainObject(next);
  if (!previousIsBranch && !nextIsBranch) {
    if (previous !== next && prefix) {
      out.add(prefix);
    }
    return previous !== next;
  }
  if (previousIsBranch && nextIsBranch) {
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    let changed = false;
    // Fast path for the case that actually dominates: both branches hold the
    // SAME keys and only a leaf value moved. That is every local settings
    // write, and the first level of any remote adopt too. The general path
    // below unions the two key sets into a fresh Set per branch, so a stable
    // shape was paying for that Set on every level of the walk - measured in
    // Gecko 157 at 3.79us -> 3.19us for a same-shape write (and 4.06 -> 3.42us
    // when a subtree arrives, where the fast path still applies at depth).
    // The check is two passes over the key arrays and allocates nothing.
    if (previousKeys.length === nextKeys.length && nextKeys.every((segment) => Object.hasOwn(previous, segment))) {
      for (const segment of nextKeys) {
        const path = prefix ? `${prefix}.${segment}` : segment;
        if (collectChangedPaths(previous[segment], next[segment], path, out)) {
          changed = true;
        }
      }
      return changed;
    }
    for (const segment of new Set([...previousKeys, ...nextKeys])) {
      const path = prefix ? `${prefix}.${segment}` : segment;
      if (collectChangedPaths(previous[segment], next[segment], path, out)) {
        changed = true;
      }
    }
    return changed;
  }
  if (!previousIsBranch) {
    // A subtree ARRIVED: descend and announce the leaves a subscriber reads.
    // No need for the branch path itself - nothing reads it.
    for (const segment of Object.keys(next)) {
      collectChangedPaths(undefined, next[segment], `${prefix}.${segment}`, out);
    }
    return true;
  }
  // A subtree COLLAPSED into a leaf or was removed outright. Announce the
  // collapsing path - that is where the new value lives, and it belongs to no
  // descendant - plus the leaves it held, whose subscribers must re-read and
  // fall back to their defaults.
  if (prefix) {
    out.add(prefix);
  }
  for (const segment of Object.keys(previous)) {
    collectChangedPaths(previous[segment], undefined, `${prefix}.${segment}`, out);
  }
  return true;
}

/**
 * The configs document, owned by one object.
 *
 * The previous shape was two module globals coupled by an imperative
 * protocol: storage.js cached the parsed doc and exported
 * invalidateConfigCache(), and the settings module called it from its
 * GM_addValueChangeListener callback - discarding the new value the
 * callback had just been handed, re-reading pf:configs from manager
 * storage, and re-coercing every setting to find out what changed. So
 * every local settings write cost a cache drop, a full re-parse and N
 * path walks, and every cross-tab write cost the same.
 *
 * GM_addValueChangeListener(name, (name, oldValue, newValue, remote))
 * already delivers the replaced document. The store adopts that value
 * instead of re-fetching it, diffs it against the doc it already holds,
 * and publishes the changed paths. Nothing polls, nothing re-reads, and
 * the diff is the subscription filter: a write to settings.gestures.hold
 * no longer re-coerces the other seven settings.
 *
 * Writes notify from the paths they know they touched, so the manager's
 * own echo of a local write diffs to nothing and stays a no-op - the
 * double-fire guard is now a property of the diff, not a hand-maintained
 * "changed 0" counter.
 */
export class ConfigStore {
  #doc = null;
  #listeners = new Set();
  #watched = false;
  /** GM listener handle for the configs key, kept so it can be removed. */
  #watchHandle = null;
  /** An unwatch window could have missed remote writes; re-read before serving. */
  #stale = false;

  /** The configs document, parsed at most once per adoption. */
  doc() {
    if (this.#stale || this.#doc == null) {
      this.#doc = loadJsonObject(KEYS.configs, { version: 1 });
      this.#stale = false;
    }
    return this.#doc;
  }

  /** Read a dotted path out of the owned document. */
  get(path, fallback) {
    let node = this.doc();
    for (const segment of path.split(".")) {
      // Same segment guard as writes - a hostile stored doc must not turn a
      // read path into prototype traversal either.
      if (!isSafeKeySegment(segment)) {
        return fallback;
      }
      if (node == null || typeof node !== "object") {
        return fallback;
      }
      node = node[segment];
    }
    return node === undefined ? fallback : node;
  }

  /**
   * Apply several dotted config fields (and their values) in one read-modify-
   * write of the configs document. Preset/flush paths that touch many fields at
   * once avoid N serialized gmSetValue round trips (each of which re-reads and
   * re-serializes the whole doc).
   *
   * Clone discipline: COPY-ON-WRITE along the touched paths instead of a full
   * `structuredClone` of the document. The whole-doc clone was the dominant CPU
   * cost of one write, and a stepper persists a single short path per step - so
   * only the nodes on those paths are minted fresh and every untouched branch is
   * shared with the cached doc. Sharing is safe because a shared branch is never
   * written through: each branch is replaced by its own copy before the walk
   * descends into it, and leaf writes land on those copies. A defensive
   * early-return therefore still cannot leak a partial mutation into the live
   * cache - `doc` (and every node it uniquely owns) is simply discarded.
   */
  set(fields) {
    const entries = Object.entries(fields);
    // Vacuous success, not a write: no paths, no storage round trip, no emit.
    if (entries.length === 0) {
      return true;
    }
    // Base the write on truth, not the cache: a cross-tab write may have
    // landed since the last adoption, and building on the stale cache would
    // clobber its disjoint paths. The rebase publishes through adopt(), so
    // remote subscribers hear about the racing write exactly as if its
    // delivery had arrived first; same-path races stay last-write-wins.
    this.#rebase();
    const previous = this.doc();
    const doc = { ...previous };
    const written = [];
    for (const [path, value] of entries) {
      const segments = path.split(".");
      let node = doc;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!isSafeKeySegment(segment)) {
          logger.warn("storage", `Unsafe config path segment "${segment}" in "${path}" — batch dropped`);
          return false;
        }
        const child = node[segment];
        if (child == null) {
          node[segment] = {};
        } else if (typeof child !== "object" || Array.isArray(child)) {
          logger.warn("storage", `Non-object intermediate at "${path}" — batch dropped`);
          return false;
        } else {
          // Re-parent a fresh copy before descending, so the write below can
          // never reach the sub-object the cached doc still references.
          node[segment] = { ...child };
        }
        node = node[segment];
      }
      const last = segments.at(-1);
      if (!isSafeKeySegment(last)) {
        logger.warn("storage", `Unsafe config leaf segment "${last}" in "${path}" — batch dropped`);
        return false;
      }
      node[last] = value;
      written.push(path);
    }
    return this.#persist(doc, previous, written);
  }

  /**
   * Remove one dotted field from the configs document (migration sweeps).
   * No-op when any intermediate segment or the leaf itself is missing.
   */
  remove(path) {
    // Operate on truth for the same reason set() rebases: a removal computed
    // against a stale cache can no-op on a path that exists in storage, or
    // persist a document that drops a racing cross-tab write.
    this.#rebase();
    const previous = this.doc();
    const doc = { ...previous };
    const segments = path.split(".");
    let node = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!isSafeKeySegment(segment)) {
        return false;
      }
      const child = node == null || typeof node !== "object" ? null : node[segment];
      if (child == null || typeof child !== "object" || Array.isArray(child)) {
        return false;
      }
      // Copy-on-write: the delete below must never reach the cached sub-doc.
      node[segment] = { ...child };
      node = node[segment];
    }
    const last = segments.at(-1);
    if (!isSafeKeySegment(last) || node == null || typeof node !== "object" || !Object.hasOwn(node, last)) {
      return false;
    }
    delete node[last];
    return this.#persist(doc, previous, [path]);
  }

  /**
   * Refresh the cache from storage without a write. Adoption publishes any
   * cross-tab write that landed since the last delivery; an identical read
   * diffs to nothing and stays quiet. Corrupt or absent storage is skipped,
   * never installed - the cache keeps serving what it holds.
   */
  #rebase() {
    const fresh = loadJsonObject(KEYS.configs, null);
    if (isPlainObject(fresh)) {
      this.adopt(fresh, { remote: true });
    }
  }

  /**
   * Install a document that came from somewhere other than this store (a
   * cross-tab write, a manager reset, a test) and publish what moved.
   * This is the production path for external changes - the GM listener
   * hands the value straight in, so adoption never touches storage.
   */
  adopt(value, { remote = false } = {}) {
    const previous = this.#doc;
    const next = isPlainObject(value) ? value : { version: 1 };
    if (previous == null) {
      // Cold store: the first read is not a change anything can react to.
      this.#doc = next;
      return [];
    }
    const paths = new Set();
    if (!collectChangedPaths(previous, next, "", paths)) {
      return [];
    }
    this.#doc = next;
    this.#emit(paths, remote);
    return paths;
  }

  /**
   * Subscribe to config changes. The listener receives the changed leaf
   * paths, so it can re-read exactly those; the document already reflects
   * them when it runs. Returns an unsubscribe; `signal` detaches it with
   * the caller's lifecycle. Subscribing is also what starts the manager
   * change listener - a frame that never reads settings never pays for
   * the notification.
   */
  onChange(listener, { signal } = {}) {
    this.#listeners.add(listener);
    this.#watch();
    const off = () => {
      if (!this.#listeners.delete(listener)) {
        return;
      }
      // Last consumer gone, so drop the manager listener with it. The GM
      // subscription outlives the subscribers that justified it otherwise,
      // and a frame that has torn its shell down keeps adopting every remote
      // write for a document nobody reads.
      if (this.#listeners.size === 0) {
        this.#unwatch();
      }
    };
    if (signal) {
      signal.addEventListener("abort", off, { once: true });
    }
    return off;
  }

  #watch() {
    if (this.#watched) {
      return;
    }
    this.#watched = true;
    // Keep the handle: without it the subscription can never be removed, which
    // is the whole point of tying the GM listener's life to #listeners.
    this.#watchHandle = gmAddValueChangeListener(KEYS.configs, (_name, _previous, value, remote) => {
      // A delivered plain object IS the new document - adopt it rather than
      // re-reading what we were just told. Anything else (a key deleted by
      // another tab arrives as undefined) means the delivered value cannot
      // describe the new state, so fall back to what storage holds now.
      const next = isPlainObject(value) ? value : loadJsonObject(KEYS.configs, { version: 1 });
      this.adopt(next, { remote: remote === true });
    });
  }

  #unwatch() {
    if (!this.#watched) {
      return;
    }
    this.#watched = false;
    gmRemoveValueChangeListener(this.#watchHandle);
    this.#watchHandle = null;
    // With the GM listener gone there is nothing to hear a remote write, and
    // nothing polls, so the cached document can silently fall behind. The doc
    // is only as fresh as the stream behind it; mark it so the next reader
    // re-reads instead of serving a document it cannot know is stale.
    this.#stale = true;
  }

  #emit(paths, remote) {
    // Same dispatch-isolation rule the mutation feed applies: one throwing
    // listener must not strand its peers, and must not escape into the caller.
    // This matters more here than elsewhere because #emit runs *after* the
    // value is durably stored - a listener that throws would otherwise make
    // set() throw for a write that already succeeded, and report a failure
    // that did not happen.
    for (const listener of [...this.#listeners]) {
      try {
        listener({ paths, remote, doc: this.#doc });
      } catch (err) {
        logger.error("storage", "Config change listener threw during dispatch", err);
      }
    }
  }

  /**
   * Publish the write, then hand the doc to the manager. The doc is
   * installed BEFORE gmSetValue so a manager that echoes local writes
   * synchronously diffs against the new value and stays quiet; a failed
   * write rolls the cache back.
   */
  #persist(doc, previous, written) {
    this.#doc = doc;
    // The guarded wrapper reports quota/grant failure as false rather than
    // throwing, so check it: emitting success for a write that never landed
    // would leave every tab converged on a document storage never saw.
    if (!gmSetValue(KEYS.configs, doc)) {
      logger.error("storage", "Failed to persist config");
      this.#doc = previous;
      return false;
    }
    this.#emit(new Set(written), false);
    return true;
  }
}

export const configStore = new ConfigStore();

/** Read a dotted config path, or `fallback` when unset/unreadable. */
export function getConfigValue(path, fallback) {
  return configStore.get(path, fallback);
}

/**
 * Write one dotted field, reporting success. The boolean is the failure
 * surface quota/grant loss reports on - callers that cannot proceed on a
 * lost write check it instead of assuming the cache write-through.
 */
export function setConfigValue(path, value) {
  return configStore.set({ [path]: value });
}

/** Apply many dotted config fields in one read-modify-write. */
export function setConfigFields(fields) {
  return configStore.set(fields);
}

/** Remove one dotted config field (migration sweeps). */
export function deleteConfigField(path) {
  return configStore.remove(path);
}
