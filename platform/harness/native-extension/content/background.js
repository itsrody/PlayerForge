// ---------- background (extension world) ----------
//
// A manager registers a userscript when the user installs it, and every later
// page load picks it up. The harness does the same: one registration at
// startup, then each test just navigates. Registering per test does work, but
// only after the registration has propagated to the content process, which
// makes every test pay a sleep and race the load; a startup registration has no
// such window.
//
// The harness cannot call into a temporary add-on, so commands arrive over a
// long-poll: each iteration is one blocking HTTP request held until a command
// is dispatched, so the add-on never spins.
//
//   {op:"storage", storage}          seed the store used by the next injection
//   {op:"storage.write", patch}      cross-context write while a document is live
//   {op:"storage.delete", key}       cross-context delete, same distinction
//   {op:"storage.get"}               read the store as it stands now
//   {op:"register", body, allFrames} replace the registration (custom bundle)
//
// Results come back on /result as {id, ok, error?, ...}; anything the
// userScript realm wants to report goes to /diagnostic.

const PORT = __PF_CONTROL_PORT__;
const BASE = `http://127.0.0.1:${PORT}`;

const GM_INFO = {
  script: { name: "PlayerForge", version: "0.7.2-test" },
  scriptHandler: "FireMonkey",
  version: "3.0",
  injectInto: "userScript",
};

/** Split the built bundle into the code body FireMonkey would run. */
function bundleBody(source) {
  const marker = "==/UserScript==";
  const at = source.indexOf(marker);
  return at === -1 ? source : source.slice(at + marker.length);
}

/** Diagnostics channel back to the harness. */
function report(payload) {
  return fetch(`${BASE}/diagnostic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

/**
 * The js array, in the order FireMonkey itself uses
 * (src/content/userscript.js:226-228): the GM layer, then the metadata
 * hand-off, then the user code, then the harness probe.
 */
function scriptEntries(body, store, seq) {
  return [
    { file: "/api-gm.js" },
    { code: `initUserScript(${JSON.stringify({ info: GM_INFO, storage: store })})` },
    // Stamped before the bundle so the realm can prove which registration it
    // is running, instead of the harness guessing whether a late one landed.
    { code: `globalThis.__pfRegSeq = ${seq};` },
    { code: body },
    { file: "/probe.js" },
  ];
}

let registered = null;
let regSeq = 0;
let seedStore = {};

async function register(body, allFrames) {
  const store = seedStore;
  if (registered !== null) {
    await registered.unregister();
    registered = null;
  }
  regSeq += 1;
  registered = await browser.userScripts.register({
    matches: ["<all_urls>"],
    js: scriptEntries(body, store, regSeq),
    allFrames,
    runAt: "document_start",
  });
  return { seq: regSeq, allFrames };
}

async function handle(command) {
  if (command.op === "storage") {
    seedStore = command.storage || {};
    // Written to extension storage and inlined into the next registration's
    // initUserScript payload, so the seed lands in the same synchronous
    // snapshot the script reads from.
    await browser.storage.local.clear();
    await browser.storage.local.set(command.storage || {});
    return { seeded: true };
  }

  if (command.op === "storage.get") {
    return { storage: await browser.storage.local.get(null) };
  }

  // A cross-context write. The seed op above can only run before a document
  // loads, so it cannot express "another tab saved a new position while this
  // page is open" - which is the only way to exercise GM_addValueChangeListener
  // delivery. Writing straight to extension storage is what makes this
  // faithful: it reaches the content script through browser.storage.onChanged,
  // never through the page realm's own GM_setValue, so the realm's absorbed
  // view goes stale and pump() sees a genuine remote change.
  if (command.op === "storage.write") {
    await browser.storage.local.set(command.patch || {});
    return { storage: await browser.storage.local.get(null) };
  }

  // A cross-context delete, the same distinction applied to a removed key.
  if (command.op === "storage.delete") {
    await browser.storage.local.remove(command.key);
    return { storage: await browser.storage.local.get(null) };
  }

  throw new Error(`unknown op: ${command.op}`);
}

async function post(id, payload) {
  try {
    await fetch(`${BASE}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...payload }),
    });
  } catch (e) {
    console.error("[harness] could not deliver result", e);
  }
}

async function pump() {
  for (;;) {
    let response;
    try {
      response = await fetch(`${BASE}/next`);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    if (!response.ok) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const command = await response.json();
    if (!command) continue;
    try {
      const result = await handle(command);
      await post(command.id, { ok: true, ...result });
    } catch (e) {
      await post(command.id, { ok: false, error: String((e && e.message) || e) });
    }
  }
}

// Registration happens once, at startup, which is the only point a
// browser.userScripts registration reliably applies: a registration made after
// a content process already exists does not run in it. The harness publishes
// the bundle before installing this add-on, so the first fetch is served
// without a retry, and per-test state travels in the page URL instead - see
// api-gm.js seedFromLocation().
fetch(`${BASE}/bootstrap`)
  .then((r) => r.json())
  .then(({ bundle, storage }) => {
    seedStore = storage || {};
    return register(bundleBody(bundle), true);
  })
  .then(({ seq }) => report({ ev: "startup-registered", regSeq: seq }))
  .catch((e) => report({ ev: "startup-failed", msg: String((e && e.message) || e) }));

pump();
