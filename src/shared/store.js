/* - 1. Extension API - */
/**
 * Storage data plane.
 *
 * One module for everything that persists or crosses script instances:
 *   1. Extension API - the browser.storage / runtime wrappers
 *   2. Configs doc    - the whole pf:configs doc, cached in the value map
 *   3. Cross-instance watch - watchStorageKey (the owned echo contract)
 *   4. Cross-origin text fetch - requestText through the background relay
 *
 * Extension-API policy: a browser API is used only where it uniquely
 * supplies a page-impossible capability (multi-realm storage + change
 * notification, CORS-bypassing fetch via the background host permission) -
 * see the policy block inside.
 */
import { logger } from "./runtime.js";

/** The whole storage namespace: every root key lives here. */
export const KEYS = {
  configs: "pf:configs",
  resume: "pf:resume",
  // The frame-diagnostics trigger - NOT a persisted state. A command
  // writes it; every realm's echo listener answers with its own one-line
  // state dump and that is the whole protocol. Values are fresh randomUUIDs
  // per tap (a wall-clock stamp would add a Date.now read the census would
  // have to carry for a value nothing ever reads), so a no-value-read key
  // accrues no cleanup deadline - a reboot finds nothing to act on by
  // construction and stale residue is inert.
  diag: "pf:diag"
};

/**
 * Own-write dedup identity. storage.onChanged delivers OUR OWN writes back
 * to this realm exactly as it delivers foreign ones - the API carries no
 * writer identity (the userscript plane's GM_addValueChangeListener had an
 * explicit `remote` 4th arg; browser.storage has none) - so every write
 * carries its realm's clientId in an envelope and the echo is matched
 * against it. clientId is minted per realm at module eval (per document for
 * content scripts, per page-load for the popup/background), which is
 * precisely the granularity the userscript contract defined an "instance"
 * at: another tab, another frame, and now the extension's own popup page
 * all hear each other, while a writer never hears itself.
 */
const CLIENT_ID = crypto.randomUUID();

/** The envelope: value + writer identity. storage.onChanged exposes
 *  old/new as whole envelope objects, so the plane unwraps on delivery. */
function box(value) {
  return { v: value, from: CLIENT_ID };
}

/** Unwrap one envelope, null-safe (a warm boot may see no old value). */
function unbox(envelope) {
  // The shape check is belt, not trust: storage is our namespace (per-
  // extension), but a user could theoretically inspect/modify it through
  // devtools; a malformed record degrades to a foreign delivery with the
  // payload it carries rather than a crash.
  return envelope && typeof envelope === "object" && "from" in envelope
    ? { from: envelope.from, value: envelope.v }
    : { from: null, value: envelope };
}

/**
 * The value map: the module's one cache, owned here so every sync read
 * stays a Map lookup. Populated wholesale at warm (one storage.local.get
 * round trip at boot) and updated by every write we make and every
 * foreign delivery the echo brings - nothing else ever re-reads storage.
 * This replaces the userscript-plane's ConfigStore parse-once cache AND
 * its invalidate-on-echom mechanism: the echo now carries the new VALUE
 * (storage.onChanged ships oldValue/newValue), so a foreign write lands
 * its payload directly in the map and a subsequent sync read serves it.
 * The invalidateConfigCache verb died with that seam - there is no second
 * cache to drop.
 */
const values = new Map();

/**
 * Extension-API policy: only page-impossible capabilities ride the APIs -
 * multi-realm storage + change notification (configs/resume), CORS-bypassing
 * fetch (subtitle ingest from arbitrary user-supplied hosts, backgrounds's
 * host permission), and the browserAction command surface. Everything
 * DOM/media/styling-side (MutationObserver, TextTrack/VTTCue,
 * adoptedStyleSheets, fullscreen) stays native; the efficient, reliable
 * implementation wins, and for those domains the native one always does.
 * No clipboard, no tabs beyond the popup's command targeting, no webRequest,
 * no alarms: no feature calls them, so they are dead permission surface.
 *
 * Storage: browser.storage.local, async IPC under the hood - the plane
 * hides that behind warm() + the write-behind map, so consumers keep the
 * sync read shape they had on the userscript plane (GM_getValue was sync).
 *
 * Fetch relay: content-script fetch follows the page's CORS; the
 * background page's fetch with the manifest's <all_urls> host permission
 * does not - so cross-origin subtitle ingest relays through runtime
 * messages to background.js. Firefox keeps MV2 event pages' event-page
 * termination out of the picture by shipping this build persistent: the
 * single-flight, user-triggered relay (one subtitle URL load at a time)
 * gets a plain await fetch with AbortSignal.timeout and no re-wake logic.
 */
export async function warmStorage() {
  // One wholesale boot read. onMessage/onChanged handlers below this point
  // keep the map authoritative.
  const stored = await browser.storage.local.get(null);
  for (const key of Object.keys(KEYS)) {
    const envelope = stored[KEYS[key]];
    values.set(KEYS[key], envelope == null ? null : unbox(envelope).value);
  }
}

/** Read one stored object from the map, or the fallback when missing/corrupt. */
export function loadJsonObject(key, fallback) {
  const raw = values.get(key);
  return raw && typeof raw === "object" ? raw : fallback;
}

/**
 * Write one key. Memory-first, disk write-behind: the value map is
 * updated synchronously (so subsequent reads see the write immediately)
 * and the storage IPC resolves in the background - a failed write leaves
 * memory ahead of disk and lands on the log-then-continue belt (the next
 * foreign echo re-serves the disk doc, the same posture the userscript
 * plane's #persist carried). The envelope rides the stored bytes.
 */
export function setValue(key, value) {
  values.set(key, value);
  browser.storage.local.set({ [key]: box(value) }).catch((err) => {
    logger.error("storage", "Failed to persist:", key, err);
  });
}

let echoWatchers = null;

/**
 * Subscribe to foreign-realm writes of one storage key (owned here so
 * both cache consumers share one explanation of the echo contract instead
 * of each restating it). storage.onChanged fires for our own writes too -
 * the envelope's `from` matches this realm's CLIENT_ID exactly once, so
 * the echo is filtered by identity, not by timing: a second callback
 * registered by the same realm still never sees its own writes, and a
 * foreign delivery always lands, the contract the userscript plane
 * documented (own instance silent, everything else delivered). The new
 * value is passed unwrapped - a consumer whose state derives from the
 * DELIVERED doc (resume cross-tab merges) must not re-read storage, both
 * to save the IPC and because an older tab's echo may race its read.
 * Returns `{ stop() }`, safe to call on a failed install or twice.
 */
export function watchStorageKey(key, handler) {
  if (!echoWatchers) {
    echoWatchers = new Map();
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      for (const key of echoWatchers.keys()) {
        if (!Object.hasOwn(changes, key)) {
          continue;
        }
        const { from, value } = unbox(changes[key].newValue);
        if (from === CLIENT_ID) {
          continue;
        }
        // Foreign delivery lands its value in the map (below) BEFORE the
        // watchers run, so a sync read inside a watcher serves the fresh
        // doc for free.
        if (values.has(key)) {
          values.set(key, value);
        }
        const watchers = echoWatchers.get(key);
        if (watchers) {
          for (const watcher of watchers) {
            try {
              watcher(key, null, value);
            } catch (err) {
              logger.error("storage", "storage watch handler failed", err);
            }
          }
        }
      }
    });
  }
  let watchers = echoWatchers.get(key);
  if (!watchers) {
    watchers = new Set();
    echoWatchers.set(key, watchers);
  }
  const watcher = handler;
  watchers.add(watcher);
  return {
    stop() {
      echoWatchers.get(key)?.delete(watcher);
    }
  };
}

/**
 * Cross-origin text fetch through the background relay - CORS cannot block
 * the background page's fetch (the manifest's <all_urls> host permission
 * backs it; a content-script's own fetch follows the page's CORS and dies
 * on exactly the user-supplied hosts the ingest serves). Request errors
 * still surface normally, so a dead link fails loudly rather than
 * silently. The response mirrors the fields the old GM response object
 * exposed (status/ok, finalUrl, responseText) so consumers keep their
 * shape.
 */
/**
 * The sub-crossing vocabulary of the relay: the message type requestText
 * sends and the background relay filters for. Owned here because this file
 * owns the relay's consumer half; the background imports it (a background ->
 * shared edge is the same downward direction every other plane rides), so
 * the two ends of the channel cannot drift apart.
 */
export const TEXT_RELAY = "pf:request-text";

export function requestText(url, { timeoutMs = 30000 } = {}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  // The relay answers every failure as a result object (fetch cannot throw
  // across the message channel) - the contract this export owes its caller
  // is rejection on failure, so the answer is re-thrown here. A null reply
  // means no receiver: the background page is gone (disabled, crashed) -
  // wrapped in the same belt, surfaced as a plain Error.
  browser.runtime.sendMessage({ type: TEXT_RELAY, url, timeoutMs }).then(
    (response) => {
      if (response == null) {
        reject(new Error("Relay unavailable"));
      } else if (response.ok) {
        resolve(response);
      } else {
        reject(new Error(response.error || `HTTP ${response.status}`));
      }
    },
    (err) => reject(err instanceof Error ? err : new Error(String(err)))
  );
  return promise;
}

/** Unsafe-segment guard: a stored doc must never enable prototype traversal. */
function isSafeKeySegment(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * The whole configs-document engine as one class: the map-backed doc read
 * and the copy-on-write read-modify-write are private fields and methods
 * on the one instance. The module singleton wires the exported call
 * surface below. The parse-once cache the userscript plane kept died into
 * the store's value map - every read serves the map (warmed at boot,
 * refreshed by echo deliveries), so this class is pure document walking.
 */
class ConfigStore {
  #readDoc() {
    return loadJsonObject(KEYS.configs, { version: 1 });
  }

  /** Read one dotted path, or the fallback when missing/unsafe. */
  get(path, fallback) {
    let node = this.#readDoc();
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

  #persist(doc) {
    setValue(KEYS.configs, doc);
    return true;
  }

  /**
   * Apply several dotted config fields (and their values) in one read-modify-
   * write of the configs document. Preset/flush paths that touch many fields at
   * once avoid N serialized round trips (each of which re-reads and
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
  setFields(fields) {
    const doc = { ...this.#readDoc() };
    // for-in + hasOwn over Object.entries: the common setConfigValue() call
    // passes a single-field object, and Object.entries allocates a pair array
    // for it on every write (measured ~78 vs ~20 ns/op for a 3-key map).
    for (const path in fields) {
      if (!Object.hasOwn(fields, path)) {
        continue;
      }
      const value = fields[path];
      const segments = path.split(".");
      let node = doc;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i];
        if (!isSafeKeySegment(segment)) {
          logger.warn("storage", `Unsafe config path segment "${segment}" in "${path}" — batch dropped`);
          return;
        }
        const child = node[segment];
        if (child == null) {
          node[segment] = {};
        } else if (typeof child !== "object" || Array.isArray(child)) {
          logger.warn("storage", `Non-object intermediate at "${path}" — batch dropped`);
          return;
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
        return;
      }
      node[last] = value;
    }
    this.#persist(doc);
  }

  /**
   * Remove one dotted field from the configs document (migration sweeps).
   * No-op when any intermediate segment or the leaf itself is missing.
   * The dotted-descent walk is deliberately NOT folded into setFields':
   * the two share the segment loop but diverge on purpose — setFields
   * creates missing intermediates and warns each unsafe shape ("batch
   * dropped": the write must stay visible), deleteField silently no-ops
   * every absent/unsafe shape (a sweep over already-removed keys is the
   * common case) and copy-on-writes the nodes it descends so the delete
   * below never reaches the cached sub-doc. A shared walker would carry
   * four behaviors under one mode flag — a parameterized wheel, not one.
   */
  deleteField(path) {
    const doc = { ...this.#readDoc() };
    const segments = path.split(".");
    let node = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!isSafeKeySegment(segment)) {
        return;
      }
      const child = node == null || typeof node !== "object" ? null : node[segment];
      if (child == null || typeof child !== "object" || Array.isArray(child)) {
        return;
      }
      // Copy-on-write: the delete below must never reach the cached sub-doc.
      node[segment] = { ...child };
      node = node[segment];
    }
    const last = segments.at(-1);
    if (!isSafeKeySegment(last) || node == null || typeof node !== "object" || !Object.hasOwn(node, last)) {
      return;
    }
    delete node[last];
    this.#persist(doc);
  }
}

const configStore = new ConfigStore();

export function getConfigValue(path, fallback) {
  return configStore.get(path, fallback);
}

export function setConfigValue(path, value) {
  configStore.setFields({ [path]: value });
}

export function setConfigFields(fields) {
  configStore.setFields(fields);
}

export function deleteConfigField(path) {
  configStore.deleteField(path);
}
