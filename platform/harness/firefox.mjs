/**
 * FirefoxDriver lifecycle manager.
 *
 * Launches a headless Firefox instance via Selenium WebDriver, connects
 * through geckodriver (WebDriver BiDi-capable protocol), and exposes
 * helpers for script injection, page navigation, and pointer event dispatch.
 *
 * Usage:
 *   const driver = await FirefoxDriver.launch();
 *   const server = new TestServer(); await server.start();
 *   await driver.navigate(createTestPage(server));
 *   await driver.injectScript(readFileSync("dist/playerforge.user.js", "utf8"));
 *   const hasHud = await driver.eval(() => !!document.querySelector(".pf-hud-layer"));
 *   await driver.destroy();
 */
import { Builder } from "selenium-webdriver";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { ControlServer, buildExtension } from "./native.mjs";
import { resolveFirefoxTarget } from "./target.mjs";

/** Promise-based sleep. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");

/**
 * Build the geckodriver service. A geckodriver already on disk is preferred:
 * Selenium Manager's resolve-and-download runs synchronously on the main
 * thread and can stall on restricted networks. GECKODRIVER_PATH overrides
 * the probe; without any local driver we fall back to the manager.
 */
function buildService(firefox) {
  const candidates = [
    process.env.GECKODRIVER_PATH,
    "/opt/homebrew/bin/geckodriver",
    "/usr/local/bin/geckodriver",
  ];
  const local = candidates.find((p) => p && existsSync(p));
  return new firefox.ServiceBuilder(local || undefined);
}

/**
 * Read the built userscript bundle. Builds it on-the-fly if missing.
 */
function readBundle() {
  const bundle = join(PROJECT_ROOT, "dist", "playerforge.user.js");
  if (!existsSync(bundle)) {
    throw new Error(
      `Bundle not found at ${bundle}. Run "npm run build" first.`
    );
  }
  return readFileSync(bundle, "utf8");
}

/**
 * Live sessions, so an interrupted run cannot orphan a browser.
 *
 * geckodriver is a separate process: when the node process dies without
 * quitting the session, the Firefox it started outlives it. That is how a
 * cancelled integration run leaves a headless Firefox and its geckodriver
 * behind. `test.after` teardown only covers the paths that get to run, so the
 * process itself is the backstop - it owns the sessions no matter how the
 * process ends.
 */
const liveDrivers = new Set();
let processGuardsInstalled = false;

function installProcessGuards() {
  if (processGuardsInstalled) {
    return;
  }
  processGuardsInstalled = true;

  const shutdown = async () => {
    const sessions = [...liveDrivers];
    liveDrivers.clear();
    await Promise.allSettled(sessions.map((d) => d.destroy()));
  };

  // Ctrl-C / kill: quit the browsers, then exit with the signal's own code so
  // the shell still reports the run as interrupted. A second signal gives up
  // on the graceful path - a wedged quit() must not make an interrupted run
  // look like a hung one.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    let signalled = false;
    process.on(signal, () => {
      if (signalled) {
        process.exit(code);
      }
      signalled = true;
      shutdown().finally(() => process.exit(code));
    });
  }
  // A crash outside the test runner (a throwing hook, an unhandled rejection)
  // ends the loop without running `test.after`, but it is still async-capable.
  for (const [event, code] of [["uncaughtException", 1], ["unhandledRejection", 1]]) {
    process.on(event, (err) => {
      console.error(`[harness] ${event} - shutting down live sessions before exit:`, err);
      shutdown().finally(() => process.exit(code));
    });
  }
  // Normal end of the run, including one that ended in a failing test.
  process.on("beforeExit", () => {
    if (liveDrivers.size > 0) {
      shutdown();
    }
  });
  // `exit` runs no async work, and ServiceBuilder.kill() is a promise, so the
  // last resort has to be synchronous. Walk the process tree this node process
  // owns - geckodriver is spawned by selenium as a direct child of node, and
  // the headless Firefox as a child of geckodriver, so both are descendants
  // and neither is reachable from the driver object. Deepest first: killing a
  // parent does not reap its children.
  //
  // Scoping to descendants of THIS pid is what keeps this away from the user's
  // own browser, which is emphatically not ours to kill.
  process.on("exit", () => {
    if (liveDrivers.size === 0) {
      return;
    }
    const childrenOf = (pid) => {
      try {
        return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
          .split("\n")
          .filter(Boolean)
          .map(Number);
      } catch {
        return []; // No children, or pgrep is unavailable.
      }
    };
    const tree = [];
    const collect = (pid, depth) => {
      if (depth > 4) {
        return; // Firefox does not nest this deep; refuse to guess further.
      }
      for (const child of childrenOf(pid)) {
        collect(child, depth + 1);
        tree.push(child);
      }
    };
    collect(process.pid, 0);
    for (const pid of tree) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
}

export class FirefoxDriver {
  /** @type {import('selenium-webdriver').WebDriver} */
  #driver;
  /** Native userScripts control channel; see native.mjs. */
  #control = null;
  #nativeAddon = null;
  /** Bundle currently registered with the add-on. */
  #registeredBody = null;
  /** Store contents the next page load should start from. */
  #pendingSeed = null;
  /** Diagnostic count at the last navigate(), see injectScript(). */
  #realmMark = 0;
  /** Store contents the startup registration is built with. */
  #initialStorage = {};
  /** @type {boolean} */
  #destroyed = false;

  constructor(driver) {
    this.#driver = driver;
    liveDrivers.add(this);
    installProcessGuards();
  }

  /**
   * Launch a headless Firefox (157+) instance.
   *
   * privacy.reduceTimerPrecision is OFF for every launch. Firefox clamps
   * performance.now() to 1ms by default to blunt timing attacks, and that
   * clamp is not a detail for a benchmark harness - it is the whole
   * measurement. Under it a synchronous op (a classList toggle plus a forced
   * layout flush is ~0.5us) reads as exactly 0, and a burst of 2000 of them
   * lands inside a single tick, so every sub-millisecond row collapses to
   * 0.00 and a recorded baseline of 0 can never be compared. Turning the
   * clamp off restores a 20us clock, which is fine for a local test browser
   * and is the only reason the micro rows below mean anything.
   *
   * @param {object} [options]
   * @param {boolean} [options.headless=true] - Run headless.
   * @param {Record<string, any>} [options.preferences] - Extra profile prefs.
   * @param {Record<string, any>} [options.storage] - Initial GM store contents.
   *   Inlined into the startup registration, because GM_getValue is
   *   synchronous and a document_start script cannot wait on the add-on. It is
   *   therefore fixed for the whole session: a test that needs a specific store
   *   has to launch its own driver with it.
   * @param {string} [options.bundle] - Bundle source, defaults to dist/.
   * @returns {Promise<FirefoxDriver>}
   */
  static async launch(options = {}) {
    const { headless = true, preferences = {}, args: extraArgs = [] } = options;

    const firefox = await import("selenium-webdriver/firefox.js");
    const args = [];
    if (headless) {
      args.push("-headless");
    }
    args.push(...extraArgs);

    // geckodriver mints a fresh temp profile per session, so no manual
    // profile isolation is needed. TLS errors stay accepted for any https
    // test page.
    const ffOptions = new firefox.Options()
      .set("acceptInsecureCerts", true)
      .setPreference("browser.shell.checkDefaultBrowser", false)
      .setPreference("datareporting.policy.dataSubmissionEnabled", false)
      .setPreference("toolkit.telemetry.reportingpolicy.firstRun", false)
      .setPreference("privacy.reduceTimerPrecision", false)
      // The userScripts API is off unless a profile opts in, and with it off
      // register() resolves but never injects - the failure looks exactly like
      // a broken harness rather than a disabled feature.
      .setPreference("extensions.userScripts.enabled", true)
      .addArguments(...args);
    for (const [key, value] of Object.entries(preferences)) {
      ffOptions.setPreference(key, value);
    }
    const target = resolveFirefoxTarget();
    if (target.binary !== null) {
      ffOptions.setBinary(target.binary);
    }

    const driver = await new Builder()
      .forBrowser("firefox")
      .setFirefoxOptions(ffOptions)
      .setFirefoxService(buildService(firefox))
      .build();

    const session = new FirefoxDriver(driver);
    // The bundle must run in the isolated userScript realm, which WebDriver's
    // executeScript cannot reach, so every session gets a temporary add-on
    // that registers it through browser.userScripts.
    await session.#installNativeExtension(options.bundle || readBundle(), options.storage);
    return session;
  }

  /**
   * Install the native userScripts add-on for this session and start its
   * control channel. Called once from launch().
   */
  async #installNativeExtension(bundle, storage) {
    this.#control = await new ControlServer().start();
    this.#initialStorage = storage || {};
    // Published before the add-on is installed, so the extension's startup
    // fetch always finds both the body and the store to inline into it.
    this.#control.setBundle(bundle, this.#initialStorage);
    this.#registeredBody = bundle;
    // launch() must not hand back a browser that cannot run the script yet:
    // the add-on registers on startup, and a page loaded before that lands
    // gets nothing, which surfaces as an unexplained missing shell.
    const startup = new Promise((resolve, reject) => {
      const off = this.#control.onDiagnostic((d) => {
        if (!d) return;
        if (d.ev === "startup-registered") { off(); resolve(); }
        if (d.ev === "startup-failed") { off(); reject(new Error(d.msg)); }
      });
    });

    const bytes = buildExtension(this.#control.port);
    // installAddon writes the archive to a temp file itself; selenium's
    // signature wants a path, so hand it a stable one under the OS temp dir.
    const xpiPath = join(tmpdir(), `pf-harness-${process.pid}-${this.#control.port}.xpi`);
    writeFileSync(xpiPath, bytes);
    const addonId = await this.#driver.installAddon(xpiPath, true);
    this.#nativeAddon = { xpiPath, addonId };
    await Promise.race([
      startup,
      delay(15000).then(() => { throw new Error("the harness add-on never registered"); })
    ]);

    // Registering in the parent process is not the same as the content process
    // knowing about it, and the very first document a session loads is created
    // immediately, so it can win that race and get no script at all. One
    // throwaway load, waited on until the userscript reports, closes the gap.
    const probeMark = this.#control.diagnosticCount();
    const probeUrl = `http://127.0.0.1:${this.#control.port}/probe-page`;
    await this.#driver.get(probeUrl);
    await this.#control.waitForRealm(probeMark, 20000);
  }

  /** Raw Selenium WebDriver access (for advanced use). */
  get raw() {
    return this.#driver;
  }

  /**
   * Navigate to a URL. Returns after the page loads.
   * @param {string} url
   */
  async navigate(url) {
    // Everything reported from here on belongs to this document, so a report
    // still in flight from the previous one cannot be mistaken for it.
    this.#realmMark = this.#control.diagnosticCount();
    await this.#loadUrl(url);
  }

  /**
   * Execute a function in the page context and return the result.
   * The function is serialized via `toString()` and evaluated by the
   * driver (Selenium's executeScript).
   *
   * @template T
   * @param {(...args: any[]) => T} fn
   * @param {...any} args - Serializable arguments.
   * @returns {Promise<T>}
   */
  async eval(fn, ...args) {
    return this.#driver.executeScript(fn, ...args);
  }

  /**
   * Measure a sub-clock-tick op by running it until a wall-clock budget is
   * spent, then dividing.
   *
   * Even with privacy.reduceTimerPrecision off the page clock ticks every
   * ~20us, so an op that costs less than that (a classList toggle plus a
   * forced layout flush is ~0.5us) reads as a flat 0 no matter how many
   * samples you take - the samples are not noisy, they are all identically
   * zero. Running the op N times inside ONE timed region and dividing by N
   * buys back resolution: 25ms of budget at 0.5us/op is ~50k iterations, so
   * the per-op figure lands two orders of magnitude above the tick.
   *
   * `op` MUST be idempotent - it runs tens of thousands of times, so it has
   * to leave the page in the state it found (toggling a class twice, adding
   * and removing the same sheet). Anything with a one-shot side effect does
   * not belong here; measure it per-op and accept the tick, or restructure
   * the bench so the unit is large enough to see.
   *
   * `setup` runs once, untimed, before the loop. Use it for anything the op
   * would otherwise re-do per iteration (element lookups and node
   * construction in particular - both cost more than the op being measured
   * and would dominate the result). It communicates with `op` through page
   * state, since a DOM node cannot cross the WebDriver boundary. `args` are
   * JSON-serializable and forwarded to both `setup` and `op`; the idiomatic
   * use is to pass a per-sample value (a sample index) to `setup` and leave
   * it on page state for `op` to read.
   *
   * @param {((...args: any[]) => void)|null} setup - Untimed, once per call.
   * @param {(...args: any[]) => void} op - Idempotent; serialized into the page.
   * @param {object} [options]
   * @param {number} [options.budgetMs=25] - Wall-clock target for one sample.
   * @param {any[]} [options.args=[]] - Serializable args for setup and op.
   * @returns {Promise<{perOp: number, ops: number, elapsed: number}>}
   */
  async amplifiedEval(setup, op, { budgetMs = 25, args = [] } = {}) {
    const source = `
      const __args = ${JSON.stringify(args)};
      ${setup ? `(${setup.toString()})(...__args);` : ""}
      const budget = ${budgetMs};
      const op = ${op.toString()};
      const t0 = performance.now();
      let ops = 0;
      let elapsed = 0;
      do {
        op(...__args);
        ops += 1;
        elapsed = performance.now() - t0;
      } while (elapsed < budget);
      return { perOp: elapsed / ops, ops, elapsed };
    `;
    return this.eval(source);
  }

  /**
   * Execute async function in the page context.
   * The function receives a `resolve` callback as its last argument.
   *
   * @template T
   * @param {(resolve: (value: T) => void) => void} fn
   * @returns {Promise<T>}
   */
  async evalAsync(fn) {
    return this.#driver.executeAsyncScript(fn);
  }

  /**
   * Confirm the userscript ran on the current document and wake its players.
   *
   * There is nothing to inject: the add-on registered the bundle at startup, so
   * the document that navigate() loaded already ran it at document-start, in
   * the manager's own realm. Navigating again here would race the load that is
   * already in flight and can leave the session on about:blank.
   *
   * @param {string} [script] - Script source. Reads from dist/ if omitted.
   */
  async injectScript(script, options = {}) {
    if (script) {
      // A caller-supplied bundle cannot be registered after startup (see
      // native-extension/content/background.js), so say so plainly instead of
      // silently running the registered one.
      throw new Error(
        "injectScript(script) is not supported by the native harness: the " +
        "userscript is registered once at startup and cannot be replaced"
      );
    }
    await this.#control.waitForRealm(this.#realmMark);
    await this.wakePlayers();
  }

  /**
   * Seed the userscript's storage before injectScript().
   *
   * The GM layer itself now lives in the add-on's api-gm.js, inside the
   * userScript realm, with FireMonkey's semantics (see native-extension/).
   * What remains configurable per test is only the initial store contents.
   *
   * @param {object} [options]
   * @param {Record<string, any>} [options.storage] - Initial storage backing.
   */
  async injectGMStubs(options = {}) {
    // The userscript's store is inlined when the add-on registers at startup,
    // so this cannot change it for a document that already loaded. What it can
    // still do is reset the add-on's copy, which is what the script writes
    // through, so tests that assert on it start from a known state.
    await this.#control.send({ op: "storage", storage: options.storage ?? {} });
  }

  /**
   * Load a URL and wait until the document has really committed.
   *
   * `get()` returns while the top-level browsing context is still the previous
   * about:blank - on the very first navigation of a session it sometimes never
   * leaves it at all. Reading the URL straight afterwards then reports the old
   * document, which is indistinguishable from a userscript that never ran, so
   * the wait is on the committed URL rather than on `get()` returning.
   */
  async #loadUrl(url) {
    await this.#driver.get(url);
    const target = url.split("?")[0];
    const deadline = Date.now() + 10000;
    for (;;) {
      const href = await this.#driver.getCurrentUrl().catch(() => "");
      // A stale about:blank cannot match here: the target is the real URL, so
      // startsWith is already false. The extra guard used to reject it would
      // also reject a real navigation *to* about:blank, which is how a test
      // disposes the shell and flushes the store.
      if (href.startsWith(target)) {
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`navigation to ${url} never committed (still at ${href})`);
      }
      await delay(100);
    }
  }


  /**
   * Read the userscript's GM store.
   *
   * The store lives in the add-on, not the page, so assertions about what
   * PlayerForge persisted cannot go through `window` any more.
   *
   * @returns {Promise<Record<string, any>>}
   */
  async gmStorage() {
    const { storage } = await this.#control.send({ op: "storage.get" });
    return storage;
  }

  /**
   * Write to the GM store as if from another browsing context.
   *
   * Seeding at launch cannot express "another tab saved a new position while
   * this page was open", which is the only thing that exercises
   * GM_addValueChangeListener delivery. This goes through extension storage
   * rather than the page realm's GM_setValue, so the realm's absorbed view goes
   * stale and the harness's pump sees a genuine remote change - the same shape
   * of event a real second tab produces.
   *
   * @param {Record<string, any>} patch Keys to write.
   * @returns {Promise<Record<string, any>>} The store as it stands afterwards.
   */
  async gmRemoteWrite(patch) {
    const { storage } = await this.#control.send({ op: "storage.write", patch });
    return storage;
  }

  /**
   * Delete a key as if from another browsing context.
   *
   * A deleted key must arrive at listeners as `undefined` rather than as a
   * silent no-op, so this exists alongside gmRemoteWrite rather than being
   * folded into it as a null.
   *
   * @param {string} key
   * @returns {Promise<Record<string, any>>}
   */
  async gmRemoteDelete(key) {
    const { storage } = await this.#control.send({ op: "storage.delete", key });
    return storage;
  }

  /**
   * Observe diagnostics reported from inside the userScript realm.
   *
   * WebDriver only sees the page world, so a kernel that throws in the
   * userScript realm looks identical to one that never ran. These reports are
   * the harness's only window into that realm.
   *
   * @param {(payload: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onNativeDiagnostic(listener) {
    return this.#control.onDiagnostic(listener);
  }

  /**
   * Dispatch a mouse event at the given coordinates (simpler than pointer).
   *
   * @param {"mousedown"|"mousemove"|"mouseup"|"click"} type
   * @param {number} x
   * @param {number} y
   * @param {object} [opts]
   */
  async dispatchMouse(type, x, y, opts = {}) {
    await this.#driver.executeScript(
      `document.elementFromPoint(${x}, ${y})?.dispatchEvent(
        new MouseEvent(${JSON.stringify(type)}, {
          bubbles: true,
          cancelable: true,
          clientX: ${x},
          clientY: ${y},
          button: ${opts.button ?? 0},
          view: window
        })
      )`
    );
  }

  /**
   * Wait for a condition in the page context.
   *
   * `args` are forwarded to every evaluate, because a page function cannot
   * close over a Node-side value: the source is serialized and re-parsed in
   * the page, so anything it needs from the test must arrive as an argument.
   *
   * @param {(...args: any[]) => any} conditionFn
   * @param {number} [timeoutMs=5000]
   * @param {number} [intervalMs=50]
   * @param {...any} args - Serializable arguments for the condition.
   * @throws {Error} if the condition is still falsy at the deadline.
   * @returns {Promise<any>} the first truthy value the condition returned.
   */
  async waitFor(conditionFn, timeoutMs = 5000, intervalMs = 50, ...args) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.#driver.executeScript(conditionFn, ...args);
      if (result) return result;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  /**
   * Get the current page URL.
   */
  async getUrl() {
    return this.#driver.getCurrentUrl();
  }

  /**
   * Switch to a frame by index or name, execute a function, then switch back.
   * @param {number|string} frameId - Frame index (0-based) or name attribute.
   * @param {() => T} fn
   * @returns {Promise<T>}
   */
  async evalInFrame(frameId, fn, ...args) {
    return this.evalInFramePath([frameId], fn, ...args);
  }

  /**
   * Read from a frame that is N levels down. Same chain-walking reason as
   * injectScriptInFramePath(): frame ids resolve relative to the current
   * context, so a nested read needs the whole path.
   *
   * @param {(string|number)[]} frameIds Chain, outermost first.
   */
  async evalInFramePath(frameIds, fn, ...args) {
    const ctx = this.#driver.switchTo();
    for (const id of frameIds) await ctx.frame(id);
    try {
      return await this.#driver.executeScript(fn, ...args);
    } finally {
      await this.#driver.switchTo().defaultContent();
    }
  }

  /**
   * Wait for a condition inside a specific frame.
   * @param {number|string} frameId - Frame index or name.
   * @param {() => boolean} conditionFn
   * @param {number} [timeoutMs=10000]
   * @param {number} [intervalMs=100]
   */
  async waitForInFrame(frameId, conditionFn, timeoutMs = 10000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.#driver.switchTo().frame(frameId);
      let result;
      try {
        result = await this.#driver.executeScript(conditionFn);
      } finally {
        await this.#driver.switchTo().defaultContent();
      }
      if (result) return result;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`waitForInFrame(${frameId}) timed out after ${timeoutMs}ms`);
  }

  /**
   * Inject GM stubs + userscript into a specific frame.
   * Simulates the manager's per-frame injection.
   * @param {number|string} frameId - Frame index or name.
   * @param {object} [gmOptions] - Passed to injectGMStubs.
   */
  async injectScriptInFrame(frameId, gmOptions = {}) {
    return this.injectScriptInFramePath([frameId], gmOptions);
  }

  /**
   * Wake a frame that is N levels down, not just a direct child.
   *
   * switchTo().frame() resolves against the CURRENT context, so a one-id call
   * only ever reaches a direct child. A nested fixture therefore needs the
   * whole chain walked one hop at a time - and a test that forgets to does not
   * fail, it hangs until a NoSuchElementError arrives from the wrong context.
   * Taking the whole path in one call makes the depth explicit at the call site
   * and keeps the restore in one place.
   *
   * @param {(string|number)[]} frameIds Chain, outermost first.
   */
  async injectScriptInFramePath(frameIds, gmOptions = {}) {
    if (gmOptions.storage !== undefined) {
      await this.injectGMStubs({ storage: gmOptions.storage });
    }
    // allFrames is the honest equivalent of the banner's @allFrames true, and
    // it is set on the startup registration, so a frame needs no injection of
    // its own - only the same wake-up the top document gets.
    await this.injectScript();
    const ctx = this.#driver.switchTo();
    for (const id of frameIds) await ctx.frame(id);
    try {
      await this.wakePlayers();
    } finally {
      await this.#driver.switchTo().defaultContent();
    }
  }

  /**
   * Nudge videos that were added after the kernel booted.
   *
   * The script runs at document-start, before a test can inject a <video>, so
   * the shell's detection pass has already been and gone by the time the
   * element exists. A loadeddata event is the closest thing to the real thing
   * that a test-created element can be told.
   */
  async wakePlayers() {
    await this.#driver.executeScript(`
      for (const v of document.querySelectorAll("video")) {
        v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
      }
    `);
  }

  /**
   * Take a screenshot (useful for debugging).
   * @param {string} [path] - File path. Returns base64 if omitted.
   */
  async screenshot(path) {
    const base64 = await this.#driver.takeScreenshot();
    if (path) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, base64, "base64");
    }
    return base64;
  }

  /**
   * Destroy the driver and kill the browser process.
   */
  async destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    liveDrivers.delete(this);
    try {
      await this.#driver.quit();
    } catch {
      // Already dead.
    }
    // The add-on dies with the session, but its control socket and packed
    // archive are this process's to release.
    await this.#control?.stop().catch(() => {});
    if (this.#nativeAddon !== null) {
      rmSync(this.#nativeAddon.xpiPath, { force: true });
      this.#nativeAddon = null;
    }
    // geckodriver owns its per-session temp profile and removes it on quit.
  }
}

/**
 * Minimal HTTP test server for integration tests.
 * Serves test pages on localhost so `shouldSkipUrl()` doesn't reject them.
 */
/**
 * Serve a real, playable media file and return its URL.
 *
 * A test cannot fake `video.duration` by defining the property: the userscript
 * runs in its own realm, where `duration` is read through the native accessor
 * and a page-world override is invisible. Anything that needs a real duration
 * or a real seek therefore needs real media, so this synthesises a silent WAV
 * of the requested length - no binary assets, no encoder dependency.
 *
 * @param {TestServer} server
 * @param {number} [seconds=60] - Duration; must exceed any seek under test.
 * @returns {string} URL to use as a `<video>` src.
 */
export function createTestMedia(server, seconds = 60) {
  const sampleRate = 8000;
  const sampleCount = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(sampleCount, 128); // 8-bit unsigned, 128 is silence
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);            // PCM fmt chunk size
  header.writeUInt16LE(1, 20);             // format: PCM
  header.writeUInt16LE(1, 22);             // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);    // byte rate
  header.writeUInt16LE(1, 32);             // block align
  header.writeUInt16LE(8, 34);             // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  const path = `/test-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`;
  server.addPageWithHeaders(path, Buffer.concat([header, data]), {
    "Content-Type": "audio/wav",
    "Content-Length": String(44 + data.length),
    "Accept-Ranges": "bytes"
  });
  return `${server.url}${path}`;
}

export class TestServer {
  #server;
  #port;
  #pages = new Map();

  constructor() {
    this.#server = createHttpServer((req, res) => {
      // Route by pathname: a query string is part of the document identity for
      // caching, not a different page, and tests rely on being able to bust the
      // cache without losing the page.
      const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
      const entry = this.#pages.get(path);
      if (entry) {
        const headers = { "Content-Type": "text/html; charset=utf-8", ...entry.headers };
        res.writeHead(200, headers);
        res.end(entry.html);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  }

  /** @returns {Promise<number>} The port the server is listening on. */
  async start() {
    return new Promise((resolve) => {
      this.#server.listen(0, "127.0.0.1", () => {
        this.#port = this.#server.address().port;
        resolve(this.#port);
      });
    });
  }

  /** Register an HTML page at a given path. */
  addPage(path, html) {
    this.#pages.set(path, { html, headers: {} });
  }

  /** Register an HTML page with custom response headers. */
  addPageWithHeaders(path, html, headers = {}) {
    this.#pages.set(path, { html, headers });
  }

  /** @returns {string} Base URL for this server. */
  get url() {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** Stop the server. */
  async stop() {
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
  }
}

/**
 * Build a standard test page HTML.
 */
function buildTestPageHtml(options = {}) {
  const {
    videoSrc = "",
    width = 1280,
    height = 720,
    // >1 renders that many independently-anchored Plyr players in ONE document.
    // Separate frames would not do: each frame gets its own userScript realm and
    // its own GM listener table, so their subscriptions could never collide. The
    // same-key multi-subscriber case only exists with several players sharing a
    // realm, which is what a page with a main player plus an embed actually is.
    players = 1,
  } = options;

  const videoAttrs = videoSrc ? `src="${videoSrc}"` : "";

  // Use a Plyr-style player tree so findSdkForVideo() recognizes the video.
  // A bare <video> is intentionally rejected by the kernel (no SDK anchor).
  return `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=${width},initial-scale=1">
  <title>PlayerForge Test Page</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; width: ${width}px; height: ${height}px; }
    .plyr { position: relative; width: 100%; height: 100%; }
    video { width: 100%; height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  ${Array.from({ length: players }, (_, i) => `
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video${i === 0 ? "" : `-${i}`}" ${videoAttrs} preload="metadata"></video>
    </div>
  </div>`).join("")}
</body>
</html>`;
}

/**
 * Create a test page URL. Uses the provided TestServer instance.
 *
 * @param {TestServer} server
 * @param {object} [options]
 * @returns {string} HTTP URL to the test page.
 */
export function createTestPage(server, options = {}) {
  const html = buildTestPageHtml(options);
  const path = `/test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Create a Plyr-style test page URL.
 *
 * @param {TestServer} server
 * @returns {string} HTTP URL to the Plyr test page.
 */
export function createPlyrPage(server) {
  const html = `<!DOCTYPE html>
<html>
<head><title>Plyr Test</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video"></video>
    </div>
  </div>
</body>
</html>`;
  const path = `/plyr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Create a blank page URL (for dynamic video insertion tests).
 *
 * @param {TestServer} server
 * @returns {string} HTTP URL to a blank page.
 */
export function createBlankPage(server) {
  const html = `<!DOCTYPE html><html><body></body></html>`;
  const path = `/blank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Build an iframe child page with a Plyr-style video.
 * @param {TestServer} server
 * @param {object} [options]
 * @param {string} [options.title]
 * @returns {string} URL to the child page.
 */
export function createIframeChildPage(server, options = {}) {
  // videoSrc must be an absolute URL: the child is usually served from a
  // DIFFERENT TestServer than the one that hosts the media, so a bare path would
  // resolve against the child's own origin and 404. Pass
  // createTestMedia(childServer, seconds) for the server that actually renders.
  const { title = "Iframe Video", videoSrc = "", id = "test-video" } = options;
  const videoAttrs = videoSrc ? `src="${videoSrc}"` : "";
  const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="${id}" ${videoAttrs} preload="metadata"></video>
    </div>
  </div>
</body>
</html>`;
  const path = `/iframe-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Build a parent page containing an iframe pointing to childUrl.
 * @param {TestServer} server
 * @param {string} childUrl - Full URL of the child page.
 * @param {object} [options]
 * @param {string} [options.title]
 * @param {string} [options.iframeId]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {string} URL to the parent page.
 */
export function createIframeParentPage(server, childUrl, options = {}) {
  const {
    title = "Parent Page",
    iframeId = "child-frame",
    width = 1280,
    height = 720,
    // Extra frames beyond the first, as {id, url}. A frame with no url is a
    // PLACEHOLDER: a same-shaped <iframe> with no src, which is what a page
    // holds between embeds. PF must find no video there, so the fixture can
    // assert the negative case rather than only the happy path.
    frames = [],
  } = options;

  const frameHtml = [{ id: iframeId, url: childUrl }, ...frames]
    .map((f) => {
      const src = f.url ? ` src="${f.url}"` : "";
      return `  <iframe id="${f.id}"${src} width="${width}" height="${height}" allowfullscreen></iframe>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #111; }
    iframe { border: none; width: ${width}px; height: ${height}px; }
  </style>
</head>
<body>
${frameHtml}
</body>
</html>`;
  const path = `/iframe-parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Build a nested iframe hierarchy: parent → cross-origin iframe → same-origin iframe → video.
 *
 * @param {TestServer} parentServer - Parent page origin.
 * @param {TestServer} iframeServer - Cross-origin iframe origin (different port).
 * @param {object} [options]
 * @param {2|3} [options.depth=3] - 2: parent -> video. 3: parent -> relay -> video.
 * @param {string} [options.videoSrc] - ABSOLUTE media URL for the video frame.
 * @param {string} [options.parentFrameId] - Id of the parent's iframe.
 * @param {string} [options.relayFrameId] - Id of the relay's iframe.
 * @param {string} [options.title] - Video frame title.
 * @returns {{ parentUrl: string, outerIframeUrl: string, innerIframeUrl: string }}
 */
export function createNestedIframePages(parentServer, iframeServer, options = {}) {
  // The shape is parent(parentServer) -> outer(iframeServer) -> inner(iframeServer).
  // The inner frame is SAME-ORIGIN with the outer, so this covers the one case
  // the bridge must handle without postMessage: an ancestor reachable by direct
  // property read, behind a cross-origin hop that is not.
  //
  //   depth 2 (default)  parent -> video          parentServer, iframeServer
  //   depth 3             parent -> relay -> video
  //
  // With depth 3 the video still lives on iframeServer, so media and identity
  // behaviour stay comparable between the two; only the number of hops changes.
  const {
    depth = 3,
    videoSrc = "",
    parentFrameId = "outer-frame",
    relayFrameId = "inner-frame",
    title = "Nested Iframe Video",
  } = options;
  if (depth < 2 || depth > 3) {
    throw new Error(`createNestedIframePages: depth must be 2 or 3, got ${depth}`);
  }

  const uniq = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // The innermost frame always holds the video, on iframeServer.
  const videoAttrs = videoSrc ? `src="${videoSrc}"` : "";
  const innerHtml = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video" ${videoAttrs} preload="metadata"></video>
    </div>
  </div>
</body>
</html>`;
  const innerPath = uniq("/nested-inner") + ".html";
  iframeServer.addPage(innerPath, innerHtml);
  const innerIframeUrl = `${iframeServer.url}${innerPath}`;

  let embedUrl = innerIframeUrl;
  let embedId = relayFrameId;

  if (depth === 3) {
    // Relay: cross-origin relative to the parent, embeds the video frame.
    const outerHtml = `<!DOCTYPE html>
<html>
<head><title>Cross-Origin Relay Frame</title></head>
<body style="margin:0;padding:0">
  <iframe id="${relayFrameId}" src="${innerIframeUrl}" width="1280" height="720" allowfullscreen></iframe>
</body>
</html>`;
    const outerPath = uniq("/nested-outer") + ".html";
    iframeServer.addPage(outerPath, outerHtml);
    embedUrl = `${iframeServer.url}${outerPath}`;
    embedId = parentFrameId;
  } else {
    embedId = parentFrameId;
  }

  const parentHtml = `<!DOCTYPE html>
<html>
<head>
  <title>Nested Iframe Parent</title>
  <style>
    * { margin: 0; padding: 0; }
    body { background: #111; }
    iframe { border: none; width: 1280px; height: 720px; }
  </style>
</head>
<body>
  <iframe id="${embedId}" src="${embedUrl}" width="1280" height="720" allowfullscreen></iframe>
</body>
</html>`;
  const parentPath = uniq("/nested-parent") + ".html";
  parentServer.addPage(parentPath, parentHtml);
  const parentUrl = `${parentServer.url}${parentPath}`;

  return { parentUrl, outerIframeUrl: embedUrl, innerIframeUrl };
}

/**
 * Create two TestServer instances on different ports (different origins).
 * @returns {Promise<{ serverA: TestServer, serverB: TestServer }>}
 */
export async function createMultiOriginServers() {
  const serverA = new TestServer();
  const serverB = new TestServer();
  await serverA.start();
  await serverB.start();
  return { serverA, serverB };
}

/**
 * Create N TestServer instances on different ports (all different origins).
 * @param {number} count
 * @returns {Promise<TestServer[]>}
 */
export async function createMultiOriginServersN(count) {
  const servers = [];
  for (let i = 0; i < count; i++) {
    const s = new TestServer();
    await s.start();
    servers.push(s);
  }
  return servers;
}

/**
 * Build a Plyr-style child page for switchboard embedding.
 * @param {TestServer} server
 * @param {object} [options]
 * @param {string} [options.name] - Server display name.
 * @param {string} [options.videoSrc] - ABSOLUTE media URL. Give each card its
 *   own video id: a shared #test-video across cards makes "the new card loaded"
 *   and "the old card never went away" indistinguishable.
 * @param {string} [options.id] - Video element id.
 * @returns {string} URL to the child page.
 */
export function createSwitchboardChildPage(server, options = {}) {
  // Each card needs a DISTINCT video id: the switchboard asserts per-card
  // identity after a switch, and two cards both calling it #test-video is
  // indistinguishable from one card reusing itself.
  const { name = "Server", videoSrc = "", id = "test-video" } = options;
  const videoAttrs = videoSrc ? `src="${videoSrc}"` : "";
  const html = `<!DOCTYPE html>
<html>
<head><title>${name}</title></head>
<body style="margin:0;padding:0">
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="${id}" ${videoAttrs} preload="metadata"></video>
    </div>
  </div>
</body>
</html>`;
  const path = `/sb-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  server.addPage(path, html);
  return `${server.url}${path}`;
}

/**
 * Build a nested switchboard child: a relay page on relayServer that embeds
 * videoServer's video page. Creates a 3-deep hierarchy:
 *   parent → relay (relayServer) → video (videoServer)
 *
 * @param {TestServer} relayServer - Server hosting the relay page.
 * @param {TestServer} videoServer - Server hosting the video page.
 * @param {object} [options]
 * @param {string} [options.name] - Display name for the relay page.
 * @param {string} [options.videoSrc] - ABSOLUTE media URL. It is served by
 *   videoServer, since that is the origin whose document loads the media.
 * @param {string} [options.id] - Video element id in the innermost frame.
 * @returns {string} URL to the relay page (the entry point for the switchboard).
 */
export function createNestedSwitchboardChildPage(relayServer, videoServer, options = {}) {
  // videoSrc is served by videoServer, since that is the origin whose document
  // actually loads the media.
  const { name = "Nested", videoSrc = "", id = "test-video" } = options;
  const videoUrl = createSwitchboardChildPage(videoServer, {
    name: `${name} (video)`,
    videoSrc,
    id,
  });
  const html = `<!DOCTYPE html>
<html>
<head><title>${name} relay</title></head>
<body style="margin:0;padding:0;overflow:hidden">
  <iframe id="inner-frame" src="${videoUrl}" style="width:100%;height:100%;border:none" allowfullscreen></iframe>
</body>
</html>`;
  const path = `/sb-nested-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  relayServer.addPage(path, html);
  return `${relayServer.url}${path}`;
}

/**
 * Build a switchboard parent page with dynamic iframe loading/unloading controls.
 *
 * The page includes:
 * - A server list UI with placeholder cards
 * - JavaScript controls: __loadIframe(i), __unloadIframe(), __switchTo(i), __rapidCycle(n, ms)
 * - State tracking: __getActiveIndex(), __getLoadedCount(), __waitForIframeLoad(i, timeoutMs)
 *
 * @param {TestServer} parentServer - Parent page server.
 * @param {Array<{ name: string, url: string }>} childServers - Child server entries.
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {string} URL to the parent page.
 */
export function createSwitchboardPage(parentServer, childServers, options = {}) {
  // Two placeholder strategies, because they are different tests:
  //
  //   swap    (default) one shared #iframe-slot, and activating a card appends a
  //           NEW iframe while the previous one is .remove()d. Nothing dormant
  //           survives a switch, so this measures teardown: when a card unloads,
  //           its realm, listener, shell and bridge ports all die with the frame.
  //   parked  every card owns a PERMANENT src-less <iframe> placeholder, and
  //           activation assigns src to that same element rather than creating
  //           one. The frames hold their box across switches, which is the shape
  //           a real page has between embeds.
  //
  // The realm is destroyed either way - a src assignment is a navigation, so
  // both modes tear down the document, the GM listener, the shell and the bridge
  // ports. What parked mode changes is which state CAN survive: anything hung
  // off the ELEMENT rather than the realm. A shadow host, an attached
  // MutationObserver, a leftover child node - all of those outlive an unload in
  // parked mode and are gone in swap mode, because swap throws the element away.
  // That is the stranding risk this mode exists to expose, and it is a real
  // difference in what the kernel has to clean up, not a difference in the
  // frame's lifetime.
  //
  // parked mode also asserts something swap structurally cannot: that PF builds
  // NO shell for a frame that has never been given a src.
  const { width = 1280, height = 720, placeholderMode = "swap" } = options;
  if (!["swap", "parked"].includes(placeholderMode)) {
    throw new Error(`createSwitchboardPage: placeholderMode must be swap|parked, got ${placeholderMode}`);
  }
  const serversJson = JSON.stringify(childServers);
  const isParked = placeholderMode === "parked";

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Switchboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #111; color: #eee; font-family: system-ui; }
    #server-list { display: flex; gap: 8px; padding: 12px; flex-wrap: wrap; }
    .server-card {
      cursor: pointer; border: 1px solid #333; border-radius: 6px;
      padding: 10px 16px; min-width: 120px; text-align: center;
      transition: border-color 0.15s, opacity 0.15s;
    }
    .server-card:hover { border-color: #666; }
    .server-card.active { border-color: #4caf50; opacity: 1; }
    .server-card.placeholder { opacity: 0.5; }
    #iframe-slot {
      width: ${width}px; height: ${height}px; margin: 0 auto;
      background: #000; position: relative;
    }
    #iframe-slot iframe { border: none; width: 100%; height: 100%; }
    /* parked mode: each card holds a real, persistent, src-less frame. */
    .server-card iframe { border: none; width: 100%; height: ${Math.round(height / 2)}px; display: block; }
    .server-card.placeholder iframe { opacity: 0.35; }
  </style>
</head>
<body>
  <div id="server-list"></div>
  <div id="iframe-slot"></div>
  <script>
    const SERVERS = ${serversJson};
    const parkedFrames = [];
    const slot = document.getElementById("iframe-slot");
    const list = document.getElementById("server-list");
    let activeIndex = -1;
    let activeIframe = null;
    let activeLoadPromise = null;

    // Build server cards.
    SERVERS.forEach((srv, i) => {
      const card = document.createElement("div");
      card.className = "server-card placeholder";
      card.textContent = srv.name;
      card.dataset.index = i;
      if (${isParked ? "true" : "false"}) {
        // A real iframe element that simply has no src yet. Not a div, not a
        // detached node: the point is that a frame which never received a src
        // must stay inert, and only a real frame can prove that.
        const parked = document.createElement("iframe");
        parked.id = "parked-frame-" + i;
        parked.setAttribute("frameborder", "0");
        parked.allowFullscreen = true;
        card.appendChild(parked);
        // Register it, or activation cannot find it: parkedFrames is what
        // __loadIframe hands the src to, and an unregistered placeholder means
        // __loadIframe builds a SECOND iframe while this one stays inert. The
        // result looks right - one live frame, three placeholders - and is
        // exactly the case the fixture exists to rule out, so it would pass
        // while testing nothing.
        parkedFrames[i] = parked;
      }
      card.addEventListener("click", () => {
        if (activeIndex === i) {
          window.__unloadIframe();
        } else {
          window.__switchTo(i);
        }
      });
      list.appendChild(card);
    });

    function updateCards() {
      const cards = list.querySelectorAll(".server-card");
      cards.forEach((card, i) => {
        card.className = "server-card " + (i === activeIndex ? "active" : "placeholder");
      });
    }

    window.__loadIframe = (index) => {
      if (activeIframe) return false;
      const srv = SERVERS[index];
      if (!srv) return false;
      const iframe = ${isParked ? `(parkedFrames[index] ||= document.createElement("iframe"))` : 'document.createElement("iframe")'};
      iframe.id = ${isParked ? '"parked-frame-" + index' : '"active-frame"'};
      // Assigning src navigates the existing element rather than replacing it.
      // What that preserves is the ELEMENT and its layout box; what it does NOT
      // preserve is the realm. A navigation creates a new document, so the
      // content window, its realm identity and everything PF registered in it
      // are torn down here exactly as they are in swap mode - a value stamped on
      // window before activation is gone afterwards. Do not read this mode as
      // "the frame survives"; it is "the frame's box survives".
      iframe.src = srv.url;
      iframe.allowFullscreen = true;
      iframe.setAttribute("frameborder", "0");
      if (!iframe.parentNode) slot.appendChild(iframe);
      activeIframe = iframe;
      activeIndex = index;
      // Track the load event.
      activeLoadPromise = new Promise((resolve) => {
        iframe.addEventListener("load", () => resolve(true), { once: true });
        // Fallback: resolve after a short delay if load event doesn't fire.
        setTimeout(() => resolve(true), 3000);
      });
      updateCards();
      return true;
    };

    window.__unloadIframe = () => {
      if (!activeIframe) return false;
      ${isParked ? `
      // Parked frames are NOT removed. Clearing src unloads the document, which
      // is what destroys the realm, but the element itself stays - so a
      // re-activation reuses the same frame the user never actually saw removed.
      activeIframe.removeAttribute("src");
      ` : `activeIframe.remove();`}
      activeIframe = null;
      activeLoadPromise = null;
      activeIndex = -1;
      updateCards();
      return true;
    };

    window.__switchTo = (index) => {
      window.__unloadIframe();
      return window.__loadIframe(index);
    };

    window.__getActiveIndex = () => activeIndex;

    // How many frames currently hold a document. In swap mode that is the
    // activeIframe check; in parked mode it is derived from the DOM, since the
    // elements persist and only their src comes and goes.
    window.__getLoadedCount = () => ${isParked ? `
      Array.from(document.querySelectorAll("#iframe-slot iframe, .server-card iframe"))
        .filter((f) => f.getAttribute("src")).length
    ` : "activeIframe ? 1 : 0"};

    // How many cards are not currently showing a frame. Defined in both modes:
    // leaving it parked-only made a swap-mode caller fail with a ReferenceError
    // rather than a number. In swap mode a placeholder is a card with no iframe
    // at all, so it counts card state; in parked mode the iframe is always there
    // and only its src comes and goes, so it counts src-less frames.
    window.__getPlaceholderCount = () => ${isParked ? `
      Array.from(document.querySelectorAll(".server-card iframe"))
        .filter((f) => !f.getAttribute("src")).length
    ` : `
      Array.from(document.querySelectorAll(".server-card.placeholder")).length
    `};

    window.__waitForIframeLoad = (index, timeoutMs = 10000) => {
      return new Promise((resolve, reject) => {
        if (!activeIframe || activeIndex !== index) {
          reject(new Error("waitForIframeLoad: no active iframe at index " + index));
          return;
        }
        const timer = setTimeout(() => reject(new Error("waitForIframeLoad timed out")), timeoutMs);
        const onLoaded = () => {
          clearTimeout(timer);
          resolve(true);
        };
        // Use the tracked load promise.
        if (activeLoadPromise) {
          activeLoadPromise.then(onLoaded);
        } else {
          // Fallback: just resolve after a short delay.
          setTimeout(onLoaded, 500);
        }
      });
    };

    window.__rapidCycle = async (count, intervalMs) => {
      for (let i = 0; i < count; i++) {
        window.__switchTo(i % SERVERS.length);
        await new Promise(r => setTimeout(r, intervalMs));
      }
    };
  </script>
</body>
</html>`;

  const path = `/sb-parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  parentServer.addPage(path, html);
  return `${parentServer.url}${path}`;
}
