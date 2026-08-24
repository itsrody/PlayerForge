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

export function gmRegisterMenu(title, onClick, options) {
  return GM_registerMenuCommand(title, onClick, options);
}

/** Read a stored JSON object, or the fallback when missing/corrupt. */
export function loadJsonObject(key, fallback) {
  const raw = gmGetValue(key, null);
  return raw && typeof raw === "object" ? raw : fallback;
}

function readConfigDoc() {
  return loadJsonObject(KEYS.configs, { version: 1 });
}

function isSafeKeySegment(key) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

export function getConfigValue(path, fallback) {
  let node = readConfigDoc();
  for (const segment of path.split(".")) {
    if (node == null || typeof node !== "object") {
      return fallback;
    }
    node = node[segment];
  }
  return node === undefined ? fallback : node;
}

export function setConfigValue(path, value) {
  const doc = readConfigDoc();
  const segments = path.split(".");
  let node = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isSafeKeySegment(segment)) {
      return;
    }
    if (node[segment] == null) {
      node[segment] = {};
    } else if (typeof node[segment] !== "object" || Array.isArray(node[segment])) {
      return;
    }
    node = node[segment];
  }
  const last = segments[segments.length - 1];
  if (!isSafeKeySegment(last)) {
    return;
  }
  node[last] = value;
  try {
    gmSetValue(KEYS.configs, doc);
  } catch (err) {
    logger.error("storage", "Failed to persist config:", err);
  }
}
