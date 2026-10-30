/**
 * The full GM (manager) realm - a mirror of Violentmonkey, the shipping
 * manager, whose released source is the spec this file imitates:
 *
 * Everything between "run the gates" and "the kernel can trust manager
 * storage" lives here instead of in driver.mjs:
 *   - parseUserScriptHeader: the field-set the bundle actually shipped
 *     (@grant/@resource/@match...), which scopes the realm and drives
 *     GM_info at runtime.
 *   - installGMRealm: the in-page realm the session evaluates per document.
 *     Surface = exactly the granted APIs (+ GM_info) - an ungranted call
 *     stays `undefined` like real VM, so the runtime call surface cannot
 *     drift from the header without a static check at the bundle gate.
 *     Backing changes dispatch the VM echo contract (read from VM's
 *     gm-values.js): own-instance writes flag `remote === false`, foreign
 *     -instance writes (the __gmTest hook) flag true - the kernel's
 *     cross-instance consumers filter on precisely that flag.
 *   - GM_xmlhttpRequest is a real fetch against the session's fixture
 *     server, including timeout -> ontimeout, not a silent no-op.
 */
const TM_SYNC_APIS = [
  "getValue",
  "setValue",
  "deleteValue",
  "listValues",
  "addValueChangeListener",
  "removeValueChangeListener",
  "registerMenuCommand",
  "unregisterMenuCommand",
  "getResourceText",
  "xmlhttpRequest"
];

const FULL_GRANT_SURFACE = TM_SYNC_APIS.map((name) => "GM_" + name);

/** Pull the ==UserScript== block the bundle actually shipped. */
export function parseUserScriptHeader(source) {
  const cut = source.indexOf("==/UserScript==");
  const block = cut >= 0 ? source.slice(0, cut + 15) : "";
  const lines = block.split("\n").map((l) => l.trim());
  const pick = (needle) => {
    const values = [];
    for (const line of lines) {
      const m = new RegExp(`^//\\s*${needle}\\s+(.+)$`).exec(line);
      if (m) values.push(m[1].trim());
    }
    return values;
  };
  const resources = {};
  for (const res of pick("@resource")) {
    const [name, ...url] = res.split(/\s+/);
    if (name) resources[name] = url.join(" ");
  }
  return {
    name: pick("@name")[0] ?? "",
    version: pick("@version")[0] ?? "",
    description: pick("@description")[0] ?? "",
    grants: pick("@grant"),
    matches: pick("@match"),
    connect: pick("@connect"),
    resources,
    meta: block
  };
}

/**
 * Realm installer, evaluated per document. `config` arrives JSON-serializable
 * via executeScript args {version, grants, resources, storage}.
 */
/* eslint-disable */
export function installGMRealm({ version, grants, resources, storage, header }) {
  // Self-contained: this function is serialized into the page via
  // executeScript, so no module-scope references survive the trip.
  const FULL_SURFACE = [
    "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues",
    "GM_addValueChangeListener", "GM_removeValueChangeListener",
    "GM_registerMenuCommand", "GM_unregisterMenuCommand",
    "GM_getResourceText", "GM_xmlhttpRequest"
  ];
  const backing = Object.assign({}, storage ?? {});
  const listeners = [];
  let listenerId = 0;
  const menus = [];
  let menuId = 0;
  const used = { echoDeliveries: 0, remoteWrites: 0 };

  const touch = (api) => { used[api] = (used[api] ?? 0) + 1; };

  function dispatch(key, oldValue, newValue, remote) {
    used.echoDeliveries++;
    queueMicrotask(() => {
      for (const listener of listeners.slice()) {
        if (listener.key === key) {
          listener.cb(key, oldValue, newValue, remote);
        }
      }
    });
  }

  const rebuildMenus = () => {
    const map = {};
    for (const entry of menus) {
      map["menu:" + entry.title] = entry.fn;
    }
    window.__pfMenu = map;
  };

  const gm = {
    getValue(key, fallback) {
      touch("GM_getValue");
      return Object.hasOwn(backing, key) ? backing[key] : fallback;
    },
    setValue(key, value) {
      touch("GM_setValue");
      const prior = backing[key];
      backing[key] = value;
      dispatch(key, prior, value, false);
    },
    deleteValue(key) {
      touch("GM_deleteValue");
      const prior = backing[key];
      delete backing[key];
      dispatch(key, prior, undefined, false);
    },
    listValues() {
      touch("GM_listValues");
      return Object.keys(backing);
    },
    addValueChangeListener(key, cb) {
      touch("GM_addValueChangeListener");
      const id = "listener-" + String(++listenerId);
      listeners.push({ id, key: String(key), cb });
      return id;
    },
    removeValueChangeListener(id) {
      touch("GM_removeValueChangeListener");
      const i = listeners.findIndex((l) => l.id === id);
      if (i >= 0) listeners.splice(i, 1);
    },
    registerMenuCommand(title, fn, options) {
      touch("GM_registerMenuCommand");
      // VM 2.15.9+ semantics: an options.id matching a live entry updates it
      // in place instead of creating a second item (kernel.js relies on it
      // for the debug caption flip).
      const id = options?.id != null ? options.id : ++menuId;
      const i = menus.findIndex((entry) => entry.id === id);
      if (i >= 0) {
        menus[i] = { id, title: String(title), fn, options: options ?? null };
      } else {
        menus.push({ id, title: String(title), fn, options: options ?? null });
      }
      rebuildMenus();
      return id;
    },
    unregisterMenuCommand(id) {
      touch("GM_unregisterMenuCommand");
      const i = menus.findIndex((entry) => entry.id === id);
      if (i >= 0) menus.splice(i, 1);
      rebuildMenus();
    },
    getResourceText(name) {
      touch("GM_getResourceText");
      return Object.hasOwn(resources ?? {}, name) ? String(resources[name]) : "";
    },
    xmlhttpRequest(details) {
      touch("GM_xmlhttpRequest");
      let settled = false;
      let timer = null;
      const controller = typeof AbortController === "function" && details.timeout > 0
        ? new AbortController()
        : null;
      if (controller) {
        timer = setTimeout(() => {
          settled = true;
          clearTimeout(timer);
          controller.abort();
          if (typeof details.ontimeout === "function") details.ontimeout();
        }, details.timeout);
      }
      fetch(details.url, { method: details.method ?? "GET", signal: controller?.signal })
        .then(async (res) => {
          const text = await res.text();
          const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\r\n");
          if (!settled && typeof details.onload === "function") {
            details.onload({ status: res.status, statusText: res.statusText, responseText: text, response: text, responseHeaders: headers });
          }
        })
        .catch(() => {
          if (!settled && typeof details.onerror === "function") details.onerror();
        })
        .finally(() => {
          if (timer !== null) clearTimeout(timer);
          settled = true;
        });
    }
  };

  for (const grant of grants ?? FULL_SURFACE) {
    const api = grant.slice("GM_".length);
    if (typeof gm[api] === "function") {
      window["GM_" + api] = gm[api];
    }
  }
  window.GM_info = {
    script: {
      name: header?.name ?? "",
      description: header?.description ?? "",
      version,
      grant: [...(grants ?? FULL_SURFACE)],
      matches: [...(header?.matches ?? [])],
      resources: Object.entries(header?.resources ?? {}).map(([name, url]) => ({ name, url }))
    },
    scriptMetaStr: header?.meta ?? "",
    scriptHandler: "Violentmonkey",
    injectInto: "auto",
    isIncognito: false,
    version: "2.50.0"
  };
  window.__pfBacking = backing;
  rebuildMenus();

  // Test hooks (not part of the GM surface): the remote-write hook is a
  // foreign-INSTANCE write - another tab, or another frame of this tab - exactly
  // what a second browser tab's kernel or the top-frame menu toggle would do.
  window.__gmTest = {
    remoteWrite(key, value) {
      used.remoteWrites++;
      const prior = backing[key];
      backing[key] = value;
      dispatch(key, prior, value, true);
    },
    usage: () => ({ ...used }),
    aliveMenuIds: () => menus.map((entry) => entry.id),
    resources: () => ({ ...(resources ?? {}) })
  };

  // Forensics hooks (same contract the browser stage reads).
  window.__pfErrors = [];
  window.__pfConsole = [];
  // Debug-mode chatter (kernel logger) rides console.log - the frames case
  // reads `Shell registered: <sdk>` lines from here to prove which SDK record
  // adopted the video without touching kernel internals.
  window.__pfConsoleLog = [];
  window.addEventListener("error", (e) => {
    if (e instanceof ErrorEvent && e.message) window.__pfErrors.push(String(e.message).slice(0, 200));
  });
  window.addEventListener("unhandledrejection", (e) => {
    window.__pfErrors.push("rejection: " + String(e.reason).slice(0, 200));
  });
  const origError = console.error;
  console.error = (...parts) => {
    window.__pfConsole.push(parts.map((p) => String(p?.message ?? p)).join(" ").slice(0, 200));
    origError.apply(console, parts);
  };
  const origLog = console.log;
  console.log = (...parts) => {
    // Capped: debug chatter can be voluminous and only the most recent lines
    // ever matter for SDK attribution.
    if (window.__pfConsoleLog.length >= 80) window.__pfConsoleLog.shift();
    window.__pfConsoleLog.push(parts.map((p) => String(p?.message ?? p)).join(" ").slice(0, 160));
    origLog.apply(console, parts);
  };
}
