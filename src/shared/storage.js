import { logger } from "./logger.js";

const CONFIG_DOC_KEY = "pf:configs";

export function gmGetValue(key, fallback) {
  return GM_getValue(key, fallback);
}

export function gmSetValue(key, value) {
  GM_setValue(key, value);
}

export function gmRegisterMenu(title, onClick, options) {
  return GM_registerMenuCommand(title, onClick, options);
}

function readConfigDoc() {
  const doc = gmGetValue(CONFIG_DOC_KEY, { version: 1 });
  return doc && typeof doc === "object" ? doc : { version: 1 };
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
    gmSetValue(CONFIG_DOC_KEY, doc);
  } catch (err) {
    logger.error("config", "Failed to persist config:", err);
  }
}
