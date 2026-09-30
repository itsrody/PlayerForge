// ---------- privileged api_script (runs in the extension world) ----------
//
// This mirrors the split FireMonkey itself uses (src/content/api.js): the
// privileged side does NOT define GM_*. It only bridges values across the Xray
// boundary into the userScript world; the GM functions are defined by
// api-gm.js, which runs as a `file` entry inside the userScript world so that
// its `globalThis` is the script's own isolated global.
//
// Every non-primitive handed to the userScript must go through script.export(),
// or Firefox throws "Return value not accessible to the userScript". That is
// the same rule FireMonkey's API.prepare() applies.

const CONTROL_BASE = `http://127.0.0.1:${__PF_CONTROL_PORT__}`;

/** Authoritative store for the session, mirrored into extension storage. */
let snapshot = {};

function load() {
  return browser.storage.local.get(null)
    .then((s) => { snapshot = s; })
    .catch(() => {});
}

load();

browser.storage.onChanged.addListener((changes) => {
  for (const [key, change] of Object.entries(changes)) {
    snapshot[key] = change.newValue;
  }
});

browser.userScripts.onBeforeScript.addListener((script) => {
  const prepare = (value) =>
    value !== null && ["object", "function"].includes(typeof(value))
      ? script.export(value)
      : value;

  script.defineGlobals({
    // FireMonkey makes GM_getValue synchronous by preloading the whole store
    // before any user code runs (src/content/api-gm.js), so the harness hands
    // over a snapshot object rather than a promise.
    PF_storage: () => prepare(snapshot),
    PF_setValue: (key, value) => {
      snapshot[key] = value;
      browser.storage.local.set({ [key]: value }).catch(() => {});
    },
    // Diagnostics from inside the userScript realm. A userScript exception is
    // invisible to WebDriver (it runs in another world), so the harness gets
    // told directly instead of inferring failure from a missing DOM node.
    PF_report: (payload) => {
      fetch(`${CONTROL_BASE}/diagnostic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => {});
    },
    PF_deleteValue: (key) => {
      delete snapshot[key];
      browser.storage.local.remove(key).catch(() => {});
    },
  });
});
