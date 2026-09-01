import { logger } from "./logger.js";

/** The whole GM storage namespace: every root key lives here. */
export const KEYS = {
  configs: "pf:configs",
  resume: "pf:resume",
  firstRun: "pf:first-run"
};

export function gmGetValue(key, fallback) {
  return GM_getValue(key, fallback);
}

export function gmSetValue(key, value) {
  GM_setValue(key, value);
}

export function gmDeleteValue(key) {
  GM_deleteValue(key);
}

/** Returns a handle for gmUnregisterMenu, or null when unavailable. */
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
 * TM-API policy: a manager API is used only where it uniquely supplies a
 * capability the page cannot - multi-tab manager storage + change
 * notification (configs/resume), CORS-bypassing XHR (@connect * subtitle
 * fetch), manager-cached resource warm-load, TM menu, GM_info. Everything
 * DOM/media/styling-side (MutationObserver, TextTrack/VTTCue,
 * adoptedStyleSheets, fullscreen) stays native; the efficient,
 * reliable implementation wins, and for those domains the native one always
 * does. GM_setClipboard is deliberately NOT granted/used: no feature calls
 * it, so the grant is dead permission surface. Any future clipboard write
 * should go through the native navigator.clipboard path, not the manager.
 */
/**
 * Cross-origin text fetch through the manager - CORS cannot block it.
 * The banner declares @connect * because subtitle URLs are user-supplied
 * from arbitrary hosts; a per-domain consent gate would be friction on the
 * hot subtitle-loading path. Request errors still surface normally, so a
 * dead link fails loudly rather than silently.
 */
export function gmRequestText(url, { timeoutMs = 30000 } = {}) {
  const { promise, resolve, reject } = Promise.withResolvers();
  GM_xmlhttpRequest({
    url,
    method: "GET",
    timeout: timeoutMs,
    onload: (res) => {
      if (res.status >= 200 && res.status < 300) {
        resolve(res);
      } else {
        reject(new Error(`HTTP ${res.status}`));
      }
    },
    onerror: () => reject(new Error("Network error")),
    ontimeout: () => reject(new Error(`Timed out after ${timeoutMs}ms`))
  });
  return promise;
}

/** Read a stored JSON object, or the fallback when missing/corrupt. */
export function loadJsonObject(key, fallback) {
  const raw = gmGetValue(key, null);
  return raw && typeof raw === "object" ? raw : fallback;
}

let configCache = null;

/**
 * The whole configs document, parsed at most once and served from a module
 * cache afterwards. GM storage is a sync localStorage parse per call - the
 * hot read paths (repeated getConfigValue, the cross-tab refresh loop) were
 * re-parsing the entire doc every time. Writers refresh the cache in place;
 * external (cross-tab) writes invalidate it via invalidateConfigCache().
 */
function readConfigDoc() {
  if (configCache == null) {
    configCache = loadJsonObject(KEYS.configs, { version: 1 });
  }
  return configCache;
}

/** Drop the cached configs doc after an external (cross-tab) write. */
export function invalidateConfigCache() {
  configCache = null;
}

function isSafeKeySegment(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

export function getConfigValue(path, fallback) {
  let node = readConfigDoc();
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

export function setConfigValue(path, value) {
  setConfigFields({ [path]: value });
}

/**
 * Apply several dotted config fields (and their values) in one read-modify-
 * write of the configs document. Preset/flush paths that touch many fields at
 * once avoid N serialized gmSetValue round trips (each of which re-reads and
 * re-serializes the whole doc).
 */
export function setConfigFields(fields) {
  // Work on a copy: successful batches commit to cache+storage atomically, a
  // defensive early-return (unsafe segment) never leaks a partial mutation
  // into the live cache the way mutating the cached doc in place would.
  const doc = structuredClone(readConfigDoc());
  for (const [path, value] of Object.entries(fields)) {
    const segments = path.split(".");
    let node = doc;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!isSafeKeySegment(segment)) {
        logger.warn("storage", `Unsafe config path segment "${segment}" in "${path}" — batch dropped`);
        return;
      }
      if (node[segment] == null) {
        node[segment] = {};
      } else if (typeof node[segment] !== "object" || Array.isArray(node[segment])) {
        logger.warn("storage", `Non-object intermediate at "${path}" — batch dropped`);
        return;
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
  try {
    gmSetValue(KEYS.configs, doc);
  } catch (err) {
    logger.error("storage", "Failed to persist config:", err);
    return;
  }
  configCache = doc;
}

/**
 * Remove one dotted field from the configs document (migration sweeps).
 * No-op when any intermediate segment or the leaf itself is missing.
 */
export function deleteConfigField(path) {
  const doc = structuredClone(readConfigDoc());
  const segments = path.split(".");
  let node = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isSafeKeySegment(segment)) {
      return;
    }
    if (node == null || typeof node !== "object") {
      return;
    }
    node = node[segment];
  }
  const last = segments.at(-1);
  if (!isSafeKeySegment(last) || node == null || typeof node !== "object" || !Object.hasOwn(node, last)) {
    return;
  }
  delete node[last];
  try {
    gmSetValue(KEYS.configs, doc);
  } catch (err) {
    logger.error("storage", "Failed to persist config:", err);
    return;
  }
  configCache = doc;
}
