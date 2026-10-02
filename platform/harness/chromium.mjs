/**
 * ChromiumDriver lifecycle manager.
 *
 * Launches a headless Helium (or Vivaldi/Brave/Chrome fallback) instance via
 * Selenium WebDriver, connects through the ChromeDriver protocol, and exposes
 * helpers for script injection, page navigation, and pointer event dispatch.
 *
 * Usage:
 *   const driver = await ChromiumDriver.launch();
 *   await driver.navigate("data:text/html,<video></video>");
 *   await driver.injectScript(readFileSync("dist/playerforge.user.js", "utf8"));
 *   const hasHud = await driver.eval(() => !!document.querySelector(".pf-hud-layer"));
 *   await driver.destroy();
 */
import { Builder } from "selenium-webdriver";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");

/**
 * Version the GM stubs report as GM_info.script.version.
 *
 * Read from package.json rather than hardcoded: the stubs previously carried a
 * literal "0.7.1-test" in three places while the project sat at 0.7.2, so a
 * version assertion could pass or fail purely on which injection path the test
 * took. Deriving it keeps the stubs honest across releases.
 */
const STUB_SCRIPT_VERSION = JSON.parse(
  readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")
).version;

export { STUB_SCRIPT_VERSION };

/**
 * Resolve the Chromium-based binary path on macOS.
 * Order: HELIUM_PATH/VIVALDI_PATH/BRAVE_PATH env → known locations (Helium
 * first - the supported desktop target; Titanium shares its Chromium base)
 * → fallback error.
 */
function resolveBinary() {
  const envPath = process.env.HELIUM_PATH || process.env.VIVALDI_PATH || process.env.BRAVE_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const candidates = [
    "/Applications/Helium.app/Contents/MacOS/Helium",
    join(homedir(), "Applications", "Helium.app", "Contents", "MacOS", "Helium"),
    "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
    join(homedir(), "Applications", "Vivaldi.app", "Contents", "MacOS", "Vivaldi"),
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "No Chromium-based browser found. Set HELIUM_PATH or install Helium Browser."
  );
}

/**
 * Build the WebDriver service. A chromedriver already on disk is preferred:
 * Selenium Manager's resolve-and-download runs synchronously on the main
 * thread and can stall for minutes on restricted networks. CHROMEDRIVER_PATH
 * overrides the probe; without any local driver we fall back to the manager.
 */
/**
 * Fork-branded browsers report their own product version (Vivaldi 8.x,
 * Helium 0.18.x) while the embedded Chromium is a different major -
 * chromedriver refuses the handshake unless they match. Wrap the launch: the
 * shim answers --product-version/--version with the embedded Chromium version
 * and execs the real browser for every other invocation. Chrome/Chromium/
 * Brave report honest Chromium versions already and pass through untouched.
 */
const versionCache = new Map();

/**
 * Helium's embedded Chromium version, read from the framework bundle's
 * Versions/ directory (named after the Chromium version, e.g. 154.0.8037.92).
 * Reading the directory beats probing `--version`: a running instance swallows
 * every unknown flag and forwards it to the existing session, so the probe
 * would hang or return nothing exactly when Helium is already open.
 */
function heliumChromiumVersion(binary) {
  if (!/helium/i.test(binary)) return null;
  const appRoot = binary.match(/^(.*)\/Helium\.app\//);
  if (appRoot === null) return null;
  const versions = join(
    appRoot[1], "Helium.app", "Contents", "Frameworks",
    "Helium Framework.framework", "Versions"
  );
  if (!existsSync(versions)) return null;
  try {
    return readdirSync(versions).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Vivaldi's embedded Chromium version: the most frequent `≥100.0.x.y` string
 * in the framework binary. Non-Vivaldi binaries return null untouched.
 */
function vivaldiChromiumVersion(binary) {
  if (!/vivaldi/i.test(binary)) return null;
  const appRoot = binary.match(/^(.*)\/Vivaldi\.app\//);
  const framework = appRoot
    ? join(appRoot[1], "Vivaldi.app", "Contents", "Frameworks",
        "Vivaldi Framework.framework", "Versions", "Current", "Vivaldi Framework")
    : null;
  if (framework === null || !existsSync(framework)) return null;
  try {
    const out = execFileSync(
      "grep",
      ["-aoE", "[0-9]+\\.0\\.[0-9]+\\.[0-9]+", framework],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }
    );
    const tally = new Map();
    for (const line of out.split("\n")) {
      const major = Number(line.slice(0, line.indexOf(".")));
      if (!(major >= 100)) continue;
      tally.set(line, (tally.get(line) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [v, n] of tally) {
      if (n > bestN) { best = v; bestN = n; }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * The embedded Chromium version for a fork-branded binary, memoized. Returns
 * null for binaries that report an honest Chromium version (Chrome/Chromium/
 * Brave), which need no shim and no version-matched driver lookup.
 */
function embeddedChromiumVersion(binary) {
  let version = versionCache.get(binary);
  if (version === undefined) {
    version = heliumChromiumVersion(binary) ?? vivaldiChromiumVersion(binary);
    versionCache.set(binary, version);
  }
  return version;
}

function wrapBrowser(binary, dir) {
  if (!/(vivaldi|helium)/i.test(binary)) return binary;
  const version = embeddedChromiumVersion(binary);
  if (version === null) return binary;
  const wrapper = join(dir, "browser-driver-shim");
  writeFileSync(
    wrapper,
    `#!/bin/sh\n` +
      `# chromedriver handshake shim: answer the embedded Chromium version,\n` +
      `# exec the real browser for everything else.\n` +
      `for a in "$@"; do\n` +
      `  case "$a" in\n` +
      `    --product-version|--version) printf '%s\\n' '${version}'; exit 0;;\n` +
      `  esac\n` +
      `done\n` +
      `exec '${binary}' "$@"\n`
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/**
 * Selenium Manager's cache platform tag, matching the layout it writes under
 * ~/.cache/selenium/chromedriver/<tag>/<version>/chromedriver.
 */
function seleniumPlatform() {
  if (process.platform === "darwin") return process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux64";
  if (process.platform === "win32") return "win64";
  return null;
}

/**
 * Locate a chromedriver in Selenium Manager's cache that matches the browser's
 * embedded Chromium version. A chromedriver only drives the exact major it was
 * built for, and the Homebrew one routinely lags (152 against a 154 Helium),
 * so a version-matched cached download beats the fixed Homebrew path.
 */
function findCachedChromedriver(version) {
  const platform = seleniumPlatform();
  if (!version || platform === null) return null;
  const platformDir = join(homedir(), ".cache", "selenium", "chromedriver", platform);
  if (!existsSync(platformDir)) return null;
  const exact = join(platformDir, version, "chromedriver");
  if (existsSync(exact)) return exact;
  // Fall back to any cached driver sharing the browser's major version.
  const major = version.split(".")[0];
  let match = null;
  try {
    for (const dir of readdirSync(platformDir)) {
      if (dir.split(".")[0] !== major) continue;
      if (match === null || dir > match) match = dir;
    }
  } catch {
    return null;
  }
  if (match === null) return null;
  const p = join(platformDir, match, "chromedriver");
  return existsSync(p) ? p : null;
}

function buildService(chrome, version) {
  const candidates = [
    process.env.CHROMEDRIVER_PATH,
    findCachedChromedriver(version),
    "/opt/homebrew/bin/chromedriver",
    "/usr/local/bin/chromedriver",
  ];
  const local = candidates.find((p) => p && existsSync(p));
  return new chrome.ServiceBuilder(local || undefined);
}

/**
 * Absorb Chromium's pending startup navigation. A fresh ChromeDriver session
 * begins navigating to about:blank, and that navigation can still be in flight
 * when the caller issues its first get(). The race has two faces, both seen on
 * this harness: the caller's page is replaced by about:blank (the get looks
 * like a no-op), or the page loads and is reloaded ~0.7s in (navigation type
 * "reload", a changed performance.timeOrigin). Either way it wipes injected
 * globals mid-test - the css-layout bench's repeated `.pf-shell` lookup hit
 * null after a successful waitForShell. Both reproduce without the userscript,
 * so this is a driver/browser race, not script behavior.
 *
 * A time-based poll is not enough: the startup page is itself a settled
 * about:blank, so origin stability cannot distinguish "race over" from
 * "startup nav still queued". Instead plant a sentinel on the document and
 * check that it survives a window longer than the observed race; a late
 * navigation replaces the document and erases it. Repeat until a window passes
 * intact, leaving the caller's first real get() to land on a quiescent session.
 */
async function settleStartupNavigation(driver) {
  await driver.get("about:blank");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await driver.executeScript(() => {
        window.__pfNavSentinel = true;
      });
    } catch {
      // Mid-navigation: the context was torn down; retry on the fresh document.
    }
    await new Promise((r) => setTimeout(r, 1000));
    let survived = false;
    try {
      survived = await driver.executeScript(() => window.__pfNavSentinel === true);
    } catch {
      survived = false;
    }
    if (survived) return;
  }
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

export class ChromiumDriver {
  /** @type {import('selenium-webdriver').WebDriver} */
  #driver;
  /** Temp profile dir backing this launch (isolated from a live session). */
  #profileDir;
  /** @type {boolean} */
  #destroyed = false;
  /** @type {boolean} */
  #keepProfile = false;
  /** Exposed so a test can inspect what Chrome wrote back to the profile. */
  get profileDir() {
    return this.#profileDir;
  }
  /** CDP execution context of the armed isolated world, or null. @type {number|null} */
  #isolatedWorldId = null;
  /** @type {boolean} */
  #isolatedWorldArmed = false;

  constructor(driver, profileDir = null, keepProfile = false) {
    this.#driver = driver;
    this.#profileDir = profileDir;
    this.#keepProfile = keepProfile;
  }

  /**
   * Launch a headless Helium (Chromium 154) instance.
   * @param {object} [options]
   * @param {boolean} [options.headless=true] - Run headless.
   * @param {number} [options.port=0] - ChromeDriver port (0 = auto).
   * @param {string[]} [options.extensions] - Unpacked extension directories to
   *   load. Loading one implies the real user-script manager instead of the GM
   *   stubs, which is the only way to exercise the manager's own content-script
   *   world, @early-start ordering, and UserConfig synthesis.
   * @param {object} [options.prefs] - Written to the profile's Preferences
   *   file before launch, replacing it wholesale. Note that Chrome may ignore
   *   or overwrite seeded values: on Helium 154 a seeded
   *   extensions.ui.developer_mode of true did not stick, and the
   *   chrome://extensions toggle still read checked=false. Read the toggle
   *   back rather than trusting what was written.
   * @param {string[]} [options.extraArgs] - Additional browser switches.
   * @param {string} [options.profileDir] - Use this profile directory instead
   *   of a fresh temp one, so state persists across launches (an installed
   *   script) or can be inspected afterwards (what Chrome wrote back). Only
   *   safe when no other instance is using it - Chrome's singleton forwards a
   *   launch on an in-use profile to the running instance and the driver then
   *   hangs. A caller-owned directory is never deleted on destroy.
   * @param {boolean} [options.keepProfile=false] - Skip cleanup of the temp
   *   profile on destroy, so it can be inspected.
   * @returns {Promise<ChromiumDriver>}
   */
  static async launch(options = {}) {
    const {
      headless = true,
      port = 0,
      extensions = [],
      prefs = null,
      extraArgs = [],
      profileDir: suppliedProfileDir = null,
      keepProfile = false
    } = options;

    // An isolated profile is mandatory: without it the browser's singleton
    // forwards the launch to an already-running session (whose DevTools port
    // never binds) and the driver waits forever. A caller-supplied directory
    // is caller-owned, so never delete it - only ever remove our own temp one.
    const ownsProfile = suppliedProfileDir === null;
    const profileDir = ownsProfile ? mkdtempSync(join(tmpdir(), "pf-driver-")) : suppliedProfileDir;
    // A supplied directory may not exist yet, and wrapBrowser() writes the
    // chromedriver shim straight into it - so an absent directory fails with a
    // bare ENOENT on the shim rather than anything mentioning the profile.
    if (!ownsProfile) mkdirSync(profileDir, { recursive: true });
    if (prefs !== null) {
      const defaultDir = join(profileDir, "Default");
      mkdirSync(defaultDir, { recursive: true });
      writeFileSync(join(defaultDir, "Preferences"), JSON.stringify(prefs));
    }
    const originalBinary = resolveBinary();
    const embeddedVersion = embeddedChromiumVersion(originalBinary);
    const binary = wrapBrowser(originalBinary, profileDir);
    const args = [
      `--user-data-dir=${profileDir}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--disable-web-security",
    ];
    // --disable-extensions would defeat the point of loading an extension, and
    // --disable-component-extensions-with-background-pages is NOT set because
    // an MV3 service worker (how ScriptCat injects) needs to start. With no
    // extension loaded there is nothing to keep alive, so the flag goes on.
    if (extensions.length > 0) {
      args.push(`--load-extension=${extensions.join(",")}`);
      args.push("--disable-component-extensions-with-background-pages=false");
    } else {
      args.push("--disable-extensions");
    }
    if (headless) {
      args.push("--headless=new");
    }
    args.push(...extraArgs);

    // A real Options instance is required: setChromeOptions ignores plain
    // objects (the binary/args silently never reach chromedriver). TLS
    // errors stay accepted for any https test page.
    const chrome = await import("selenium-webdriver/chrome.js");
    const chromeOptions = new chrome.Options()
      .setChromeBinaryPath(binary)
      .setAcceptInsecureCerts(true)
      .addArguments(...args);

    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(chromeOptions)
      .setChromeService(buildService(chrome, embeddedVersion))
      .build();

    await settleStartupNavigation(driver);

    return new ChromiumDriver(driver, profileDir, keepProfile || !ownsProfile);
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
    await this.#driver.get(url);
    // A fresh document invalidates the old world's execution context, so any
    // armed isolated world must be re-armed for the page it will run on.
    this.#isolatedWorldId = null;
    this.#isolatedWorldArmed = false;
  }

  /**
   * Execute a function in the page context and return the result.
   * The function is serialized via `toString()` and evaluated with
   * `Runtime.evaluate` (via Selenium's executeScript).
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
   * Chromium clamps performance.now() to 100us by default (5us only under
   * cross-origin isolation), and there is no WebDriver-exposed preference to
   * relax it the way Firefox has privacy.reduceTimerPrecision. Under that
   * clamp an op costing less than the tick (a classList toggle plus a forced
   * layout flush is ~0.5us) reads as a flat 0 no matter how many samples are
   * taken - the samples are not noisy, they are all identically zero.
   * Running the op N times inside ONE timed region and dividing by N buys
   * back resolution: 25ms of budget at 0.5us/op is ~50k iterations, so the
   * per-op figure lands orders of magnitude above the tick.
   *
   * `op` MUST be idempotent - it runs tens of thousands of times, so it has
   * to leave the page in the state it found (toggling a property twice, adding
   * and removing the same sheet). Anything with a one-shot side effect does
   * not belong here; measure it per-op and accept the tick, or restructure the
   * bench so the unit is large enough to see.
   *
   * `setup` runs once, untimed, before the loop. Use it for anything the op
   * would otherwise re-do per iteration (element lookups and node construction
   * in particular - both cost more than the op being measured and would
   * dominate the result). It communicates with `op` through page state, since
   * a DOM node cannot cross the WebDriver boundary. `args` are JSON-
   * serializable and forwarded to both `setup` and `op`.
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
   * Async sibling of amplifiedEval for ops that must yield before they are
   * complete - a MutationObserver flush lands on the microtask queue, so a
   * burst of DOM churn cannot be timed synchronously.
   *
   * `op` returns a promise and is awaited once per loop iteration, so the
   * budget loop spends its time on real op+lull work rather than on the
   * WebDriver round-trip (which is outside the timed region). Same idempotency
   * and `setup` contract as amplifiedEval.
   *
   * @param {((...args: any[]) => void)|null} setup - Untimed, once per call.
   * @param {(...args: any[]) => Promise<void>} op - Idempotent async op.
   * @param {object} [options]
   * @param {number} [options.budgetMs=25] - Wall-clock target for one sample.
   * @param {any[]} [options.args=[]] - Serializable args for setup and op.
   * @returns {Promise<{perOp: number, ops: number, elapsed: number}>}
   */
  async amplifiedEvalAsync(setup, op, { budgetMs = 25, args = [] } = {}) {
    const script = function (setupStr, opStr, argsJson, budget, done) {
      const __args = JSON.parse(argsJson);
      if (setupStr) {
        new Function("return (" + setupStr + ")")()(...__args);
      }
      const run = new Function("return (" + opStr + ")")();
      const t0 = performance.now();
      let ops = 0;
      let elapsed = 0;
      (async () => {
        try {
          do {
            await run(...__args);
            ops += 1;
            elapsed = performance.now() - t0;
          } while (elapsed < budget);
          done({ perOp: elapsed / ops, ops, elapsed });
        } catch (err) {
          done({ error: String(err) });
        }
      })();
    };
    return this.#driver.executeAsyncScript(
      script,
      setup ? setup.toString() : "",
      op.toString(),
      JSON.stringify(args),
      budgetMs
    );
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
   * Inject the userscript bundle into the page. Must be called after navigate()
   * and before the video element is added (to simulate document-start timing).
   *
   * Runs in the PAGE world via Selenium's executeScript, which is the historical
   * default this harness was built around. It cannot model `@inject-into
   * content`: there, globals and `window` are per-world, so a page-world
   * injection silently passes everything content mode cares about. Use
   * injectScriptInIsolatedWorld() to exercise that.
   *
   * @param {string} [script] - Script source. Reads from dist/ if omitted.
   */
  async injectScript(script) {
    const source = script || readBundle();
    const body = source.slice(source.indexOf("==/UserScript==") + 16);
    await this.#driver.executeScript(body);
    // In production the script runs at document-start and catches videos via
    // MutationObserver as they're added. Post-load injection misses existing
    // DOM — wake the kernel's discovery tap by firing a media event on every
    // <video> in the page.
    await this.#driver.executeScript(`
      for (const v of document.querySelectorAll("video")) {
        v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
      }
    `);
  }

  /**
   * Inject GM_* stubs and the userscript into a CDP isolated world, the way
   * `@inject-into content` does.
   *
   * Why CDP rather than more Selenium calls: an isolated world is a separate
   * JS realm with its own `window` and globals but a SHARED DOM — precisely
   * the property that makes `@inject-into content` neither page-injectable nor
   * page-observable. `Page.createIsolatedWorld` + `Runtime.evaluate` with an
   * explicit `contextId` is the only WebDriver-exposed route to that realm;
   * executeScript always lands in the page world.
   *
   * Call this AFTER navigate(), matching injectScript(): the world is created
   * for the current document, so arming before navigating would bind the
   * bundle to a context that navigation then discards. As with injectScript,
   * the probe's discovery tap is woken by dispatching a media event on each
   * <video> (done by wakeProbe(), which the tests call).
   *
   * @param {object} [options]
   * @param {string} [options.script] - Script source. Reads from dist/ if omitted.
   * @param {Record<string, any>} [options.storage] - Initial storage backing.
   * @returns {Promise<void>}
   */
  async injectScriptInIsolatedWorld(options = {}) {
    const { script, storage = {} } = options;
    if (this.#isolatedWorldArmed) {
      throw new Error("injectScriptInIsolatedWorld() called twice; navigate() to get a fresh world");
    }
    const source = script || readBundle();
    const body = source.slice(source.indexOf("==/UserScript==") + 16);

    const { frameTree } = await this.#driver.sendAndGetDevToolsCommand("Page.getFrameTree", {});
    const { executionContextId } = await this.#driver.sendAndGetDevToolsCommand("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "pf-content",
      grantUniveralAccess: true
    });

    // Stubs first, then the bundle, in the same world and one eval each: the
    // bundle feature-detects GM.* at eval time and must not run before them.
    await this.#cdpEval(executionContextId, ChromiumDriver.gmStubScript(storage, 6));
    await this.#cdpEval(executionContextId, body);
    this.#isolatedWorldId = executionContextId;
    this.#isolatedWorldArmed = true;
  }

  /**
   * Wake the kernel's discovery tap the way injectScript() does. Needed after
   * isolated-world injection for the same reason: post-load injection misses
   * DOM that already existed.
   */
  async wakeProbe() {
    await this.#driver.executeScript(`
      for (const v of document.querySelectorAll("video")) {
        v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
      }
    `);
  }

  /**
   * Evaluate an expression inside the armed isolated world. Requires
   * injectScriptInIsolatedWorld() on the current document.
   *
   * @param {string} expression
   * @returns {Promise<any>} The result value, or undefined for a statement.
   */
  async evalInIsolatedWorld(expression) {
    if (!this.#isolatedWorldArmed) {
      throw new Error("evalInIsolatedWorld() before injectScriptInIsolatedWorld()");
    }
    const { result, exceptionDetails } = await this.#cdpEval(this.#isolatedWorldId, expression);
    if (exceptionDetails) {
      throw new Error(`isolated-world eval threw: ${exceptionDetails.text ?? exceptionDetails}`);
    }
    // CDP answers with a RemoteObject even under returnByValue; callers want
    // the value, so unwrap here rather than making every caller remember.
    return result?.value;
  }

  /** True while an isolated world is armed for the current document. */
  get hasIsolatedWorld() {
    return this.#isolatedWorldArmed;
  }

  /**
   * Raw DevTools command passthrough, for things the wrapper has no opinion
   * about (enumerating extension targets, reading a service worker's world).
   *
   * @param {string} command
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async cdp(command, params = {}) {
    return this.#driver.sendAndGetDevToolsCommand(command, params);
  }

  /** CDP Runtime.evaluate with an explicit world, returning the raw payload. */
  async #cdpEval(executionContextId, expression) {
    return this.#driver.sendAndGetDevToolsCommand("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true
    });
  }

  /**
   * Build the GM_* stub initializer.
   *
   * One definition, three consumers: the page world (injectGMStubs), each
   * subframe (injectScriptInFrame), and the isolated content world
   * (injectScriptInIsolatedWorld). They differ only in where the script is
   * evaluated, so keeping three hand-copied blocks guaranteed drift - and it
   * had: two copies still advertised GM_info.script.version 0.7.1-test after
   * the project moved to 0.7.2, so a version assertion would have depended on
   * which injection path the test happened to take.
   *
   * @param {Record<string, any>} [storage]
   * @param {number} [indent] - Leading spaces, to keep inline frame scripts readable.
   * @returns {string}
   */
  static gmStubScript(storage = {}, indent = 0) {
    const stubSource = readFileSync(join(HERE, "gm-stubs.mjs"), "utf8");
    const pad = " ".repeat(indent);
    const lines = [
      `${stubSource}`,
      `window.__pfGMStorage = ${JSON.stringify(storage)};`,
      `window.__pfGMListeners = {};`,
      `window.GM_getValue = function(key, fallback) {`,
      `  const s = window.__pfGMStorage;`,
      `  return key in s ? s[key] : fallback;`,
      `};`,
      `window.GM_setValue = function(key, value) {`,
      `  window.__pfGMStorage[key] = value;`,
      `};`,
      `window.GM = {`,
      `  setValue: function(key, value) {`,
      `    window.__pfGMStorage[key] = value;`,
      `    return Promise.resolve();`,
      `  }`,
      `};`,
      `window.GM_deleteValue = function(key) {`,
      `  delete window.__pfGMStorage[key];`,
      `};`,
      `window.GM_registerMenuCommand = function(title, fn) {`,
      `  const id = 'menu_' + title;`,
      `  window.__pfGMListeners[id] = fn;`,
      `  return id;`,
      `};`,
      `window.GM_unregisterMenuCommand = function(id) {`,
      `  delete window.__pfGMListeners[id];`,
      `};`,
      `window.GM_addValueChangeListener = function(key, cb) {`,
      `  const id = ' listener_' + key + '_' + Date.now();`,
      `  window.__pfGMListeners[id] = { key, cb };`,
      `  return id;`,
      `};`,
      `window.GM_removeValueChangeListener = function(id) {`,
      `  delete window.__pfGMListeners[id];`,
      `};`,
      `window.GM_getResourceText = function(name) {`,
      `  return Promise.resolve('');`,
      `};`,
      `window.GM_info = {`,
      `  script: { version: '${STUB_SCRIPT_VERSION}-test' },`,
      `  scriptHandler: 'ScriptCat',`,
      `  version: '1.4.0'`,
      `};`,
      `window.GM_xmlhttpRequest = function() {};`
    ];
    return lines.map((l) => (l ? pad + l : l)).join("\n");
  }

  /**
   * Inject GM_* API stubs into the page context. Must be called before
   * injectScript() so the userscript finds the globals it expects.
   *
   * @param {object} [options]
   * @param {Record<string, any>} [options.storage] - Initial storage backing.
   */
  async injectGMStubs(options = {}) {
    const { storage = {} } = options;
    // Evaluate the stub module as a self-contained script that populates
    // globalThis with all GM_* APIs.
    const initScript = ChromiumDriver.gmStubScript(storage);
    await this.#driver.executeScript(initScript);
  }

  /**
   * Dispatch a pointer event at the given coordinates.
   *
   * @param {"pointerdown"|"pointermove"|"pointerup"} type
   * @param {number} x
   * @param {number} y
   * @param {object} [opts]
   * @param {number} [opts.button=0]
   * @param {number} [opts.pointerId=1]
   */
  async dispatchPointer(type, x, y, opts = {}) {
    const { button = 0, pointerId = 1 } = opts;
    // Use Selenium ActionSequence for pointer events.
    const { Actions } = await import("selenium-webdriver/lib/input.js");
    const actions = this.#driver.actions({ async: true });

    // Map our pointer types to Selenium actions.
    const coords = { x, y, width: 1, height: 1 };
    if (type === "pointerdown") {
      await actions
        .move({ origin: "viewport", x, y })
        .press({ button })
        .perform();
    } else if (type === "pointermove") {
      await actions
        .move({ origin: "viewport", x, y })
        .perform();
    } else if (type === "pointerup") {
      await actions
        .release({ button })
        .perform();
    }
  }

  /**
   * Trusted mouse click at viewport coordinates.
   *
   * Use this rather than element.click() inside executeScript for any React UI:
   * a synthetic click is untrusted, and ScriptCat's install button ignores it -
   * the click appears to land but the install never commits. Actions.click()
   * produces the trusted down/up pair the framework actually listens for.
   *
   * @param {number} x
   * @param {number} y
   */
  async clickAt(x, y) {
    const { Actions } = await import("selenium-webdriver/lib/input.js");
    const actions = this.#driver.actions({ async: true });
    await actions.move({ origin: "viewport", x, y }).click().perform();
  }

  /**
   * Click the first element matching a CSS selector, by trusted mouse click.
   * Falls back to nothing when absent - callers poll for the selector first.
   *
   * @param {string} selector
   * @returns {Promise<boolean>} Whether an element was found and clicked.
   */
  async clickSelector(selector) {
    // Selector travels as an argument, not spliced into a template literal:
    // JSON.stringify's \" escapes get consumed by the enclosing literal and
    // emit a syntactically broken selector.
    const rect = await this.eval(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      },
      selector
    );
    if (!rect) return false;
    await this.clickAt(rect.x, rect.y);
    return true;
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
   * @param {() => boolean} conditionFn
   * @param {number} [timeoutMs=5000]
   * @param {number} [intervalMs=50]
   */
  async waitFor(conditionFn, timeoutMs = 5000, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.#driver.executeScript(conditionFn);
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
    await this.#driver.switchTo().frame(frameId);
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
   * Simulates ScriptCat's per-frame injection.
   * @param {number|string} frameId - Frame index or name.
   * @param {object} [gmOptions] - Passed to injectGMStubs.
   */
  async injectScriptInFrame(frameId, gmOptions = {}) {
    await this.#driver.switchTo().frame(frameId);
    try {
      // GM stubs first.
      const initScript = ChromiumDriver.gmStubScript(gmOptions.storage || {}, 6);
      await this.#driver.executeScript(initScript);

      // Userscript bundle.
      const source = readBundle();
      const body = source.slice(source.indexOf("==/UserScript==") + 16);
      await this.#driver.executeScript(body);

      // Wake probe.
      await this.#driver.executeScript(`
        for (const v of document.querySelectorAll("video")) {
          v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
        }
      `);
    } finally {
      await this.#driver.switchTo().defaultContent();
    }
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
    try {
      await this.#driver.quit();
    } catch {
      // Already dead.
    }
    if (this.#profileDir !== null) {
      if (this.#keepProfile) {
        console.log(`[harness] profile kept at ${this.#profileDir}`);
        return;
      }
      try {
        rmSync(this.#profileDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }
}

/**
 * Minimal HTTP test server for integration tests.
 * Serves test pages on localhost so `shouldSkipUrl()` doesn't reject them.
 */
export class TestServer {
  #server;
  #port;
  #pages = new Map();

  constructor() {
    this.#server = createHttpServer((req, res) => {
      const path = req.url || "/";
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
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video" ${videoAttrs} preload="metadata"></video>
    </div>
  </div>
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
  const { title = "Iframe Video" } = options;
  const html = `<!DOCTYPE html>
<html>
<head><title>${title}</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video" preload="metadata"></video>
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
  const { title = "Parent Page", iframeId = "child-frame", width = 1280, height = 720 } = options;
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
  <iframe id="${iframeId}" src="${childUrl}" width="${width}" height="${height}" allowfullscreen></iframe>
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
 * @returns {{ parentUrl: string, outerIframeUrl: string, innerIframeUrl: string }}
 */
export function createNestedIframePages(parentServer, iframeServer) {
  // Inner iframe: same-origin with iframeServer, contains the video.
  const innerHtml = `<!DOCTYPE html>
<html>
<head><title>Nested Iframe Video</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video" preload="metadata"></video>
    </div>
  </div>
</body>
</html>`;
  const innerPath = `/nested-inner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  iframeServer.addPage(innerPath, innerHtml);
  const innerIframeUrl = `${iframeServer.url}${innerPath}`;

  // Outer iframe: cross-origin (iframeServer), loads the inner iframe.
  const outerHtml = `<!DOCTYPE html>
<html>
<head><title>Cross-Origin Relay Frame</title></head>
<body>
  <iframe id="inner-frame" src="${innerIframeUrl}" width="1280" height="720" allowfullscreen></iframe>
</body>
</html>`;
  const outerPath = `/nested-outer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  iframeServer.addPage(outerPath, outerHtml);
  const outerIframeUrl = `${iframeServer.url}${outerPath}`;

  // Parent page: parentServer origin, loads the outer iframe.
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
  <iframe id="outer-frame" src="${outerIframeUrl}" width="1280" height="720" allowfullscreen></iframe>
</body>
</html>`;
  const parentPath = `/nested-parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`;
  parentServer.addPage(parentPath, parentHtml);
  const parentUrl = `${parentServer.url}${parentPath}`;

  return { parentUrl, outerIframeUrl, innerIframeUrl };
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
 * @returns {string} URL to the child page.
 */
export function createSwitchboardChildPage(server, options = {}) {
  const { name = "Server" } = options;
  const html = `<!DOCTYPE html>
<html>
<head><title>${name}</title></head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="test-video" preload="metadata"></video>
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
 * @returns {string} URL to the relay page (the entry point for the switchboard).
 */
export function createNestedSwitchboardChildPage(relayServer, videoServer, options = {}) {
  const { name = "Nested" } = options;
  const videoUrl = createSwitchboardChildPage(videoServer, { name: `${name} (video)` });
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
  const { width = 1280, height = 720 } = options;
  const serversJson = JSON.stringify(childServers);

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
  </style>
</head>
<body>
  <div id="server-list"></div>
  <div id="iframe-slot"></div>
  <script>
    const SERVERS = ${serversJson};
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
      const iframe = document.createElement("iframe");
      iframe.id = "active-frame";
      iframe.src = srv.url;
      iframe.allowFullscreen = true;
      iframe.setAttribute("frameborder", "0");
      slot.appendChild(iframe);
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
      activeIframe.remove();
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

    window.__getLoadedCount = () => activeIframe ? 1 : 0;

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
