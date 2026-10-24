/**
 * Firefox session boot for the check tool (gecko branch).
 *
 * Owns everything between "run the gates" and "real page running the real
 * bundle": device Firefox app discovery, the on-disk geckodriver (installed
 * once — geckodriver serves a wide Firefox span, so unlike a per-major
 * chromedriver ladder there is no version-lock disease to heal), an isolated
 * persistent profile, and the dual-loopback fixture server the kernel's
 * ad-host guard will not skip.
 *
 * Driving walks Marionette (built into release Firefox) through geckodriver —
 * Playwright's firefox driver is not a candidate here: its protocol (juggler)
 * exists only in the patched nightly builds, and this device's stock
 * Firefox.app answers those launches by hanging through the PHI handshake.
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { installGMRealm } from "./gm-realm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const SENTINEL_TIMEOUT_MS = 15000;

/**
 * Device Firefox discovery: env override first, then the standard install
 * roots. Every candidate is probed with --version so a half-installed app
 * never launches.
 */
const BROWSERS = [
  process.env.PF_FIREFOX_PATH,
  "/Applications/Firefox.app/Contents/MacOS/firefox",
  join(homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox")
].filter((p) => p && existsSync(p));

function nativeBinaryVersion(binary) {
  try {
    return execFileSync(binary, ["--version"], { stdio: "pipe", timeout: 30000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

function scanDrivers() {
  return [
    process.env.GECKODRIVER_PATH,
    "/opt/homebrew/bin/geckodriver",
    "/usr/local/bin/geckodriver"
  ].filter((p) => p && existsSync(p));
}

/**
 * Fail-fast launch probe for the runner: the browser binary and the driver
 * binary are read directly here so a missing piece surfaces with its exact
 * name, not as one confusing "session not created" launch error later.
 */
export async function ensureFirefox() {
  const browser = BROWSERS[0];
  if (!browser) {
    throw new Error("no Firefox browser found (set PF_FIREFOX_PATH or install /Applications/Firefox.app)");
  }
  const version = nativeBinaryVersion(browser);
  if (!version) {
    throw new Error(`firefox binary refused to report a version: ${browser}`);
  }
  console.log(`  firefox: ${version} (${browser})`);
  let driver = scanDrivers()[0];
  if (!driver) {
    console.log("  no geckodriver on disk - Selenium Manager resolves one at launch");
    return;
  }
  const driverVersion = nativeBinaryVersion(driver);
  console.log(`  geckodriver: ${driverVersion ?? "unknown version"} (${driver})`);
}

function urlSlice(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return String(u).slice(0, 80);
  }
}

/** Same-document check ignores the noise query (?boot=...) - only scheme,
 *  host and path must agree. */
function sameDocument(requested, landed) {
  return urlSlice(requested) === urlSlice(landed);
}

function classifyDriverFailure(err) {
  const text = String(err?.message ?? err);
  if (/session not created/i.test(text)) return "session refused by geckodriver";
  if (/handshake|connection refused|ECONNREFUSED/i.test(text)) return "driver handshake failed";
  if (/TIMEDOUT|timeout/i.test(text)) return "handshake timed out";
  if (/not executable|cannot be opened|exec/i.test(text)) return "driver binary not runnable";
  return "launch refused";
}

/** Selenium's selector utility, imported lazily once. */
let byRef = null;
async function byCss(selector) {
  byRef ??= (await import("selenium-webdriver")).By;
  return byRef.css(selector);
}

/**
 * Boot a headless, isolated-profile Firefox session with the userscript realm
 * injected. Reused across cases; destroyed once per tool run.
 *
 * The page surface keeps the shape cases already know (`eval`, `navigate`,
 * `raw` for the input layer, `waitFor`), so the case files stay
 * driver-agnostic and portable across engine branches.
 */
export class BrowserSession {
  #driver;
  #profileDir;
  #server;
  #crossServer;
  #fixturePort;
  #fixtureRoutes = new Map();
  /** Session-level GM backing store: what `harvestGm()` last pulled off the
   *  live page. Opt-in persistence for the realm (opt-out stays isolated). */
  #gmHead = new Map();

  static async launch() {
    const browserBinary = BROWSERS[0];
    if (browserBinary === undefined) {
      throw new Error("no Firefox browser found (set PF_FIREFOX_PATH or install /Applications/Firefox.app)");
    }
    console.log(`  browser: Firefox (${nativeBinaryVersion(browserBinary) ?? "unknown version"})`);

    const { Builder } = await import("selenium-webdriver");
    const fireMod = await import("selenium-webdriver/firefox.js");
    const options = new fireMod.Options()
      .setBinary(browserBinary)
      .setAcceptInsecureCerts(true)
      // The fixture's video must start on demand - the discovery probe and the
      // gesture/media rows ride real playback, and Firefox's default autoplay
      // policy would refuse it in a profile nothing is looking at.
      .setPreference("media.autoplay.default", 0)
      .addArguments("-headless")
      // The media container rows drive a real narrow viewport, so the session
      // opens at the fixed 1440x900 the panel family reads.
      .windowSize({ width: 1440, height: 900 })
      // No -profile argument: geckodriver mints its own throwaway profile,
      // which fails to take user prefs (the Options class always sets them)
      // and would collide into "Failed to set preferences" at handshake. The
      // profile path rides back as the moz:profile capability for cleanup.
      ;
    const servicePath = scanDrivers()[0] ?? undefined;
    const service = servicePath ? new fireMod.ServiceBuilder(servicePath) : new fireMod.ServiceBuilder();
    let driver;
    try {
      driver = await new Builder()
        .forBrowser("firefox")
        .setFirefoxOptions(options)
        .setFirefoxService(service)
        .build();
    } catch (err) {
      throw new Error(`geckodriver launch failed: ${classifyDriverFailure(err)} (${String(err.message ?? err).split("\n")[0].slice(0, 140)})`);
    }
    const profileDir = String(await driver.getCapabilities().then((c) => c.get("moz:profile")) ?? "");
    console.log(`  profile: ${profileDir ? profileDir.slice(profileDir.lastIndexOf("/") + 1) : "geckodriver-managed"}`);

    // Wet-window size: the media container rows drive a real narrow viewport;
    // windowSize() above opened at 1440x900, this validates it live.
    const rect = await driver.manage().window().getRect().catch(() => null);
    if (rect && (Math.abs(rect.width - 1440) > 2 || Math.abs(rect.height - 900) > 2)) {
      console.log(`  browser window: ${rect.width}x${rect.height} (expected 1440x900)`);
    }

    // Sentinel: the session must answer script probes before any case lands,
    // else a wedged launch would surface as baffling mid-gate navigation
    // races. Poll - never assume one executeScript() proves responsiveness.
    // The check must be a `return`-ing script body (Selenium string quirk):
    // an expression-only body returns undefined and the sentinel would
    // never observe the flag the assignment just set.
    await driver.get("about:blank");
    await driver.executeScript("window.__checkReady = true");
    const deadline = Date.now() + SENTINEL_TIMEOUT_MS;
    let responsive = false;
    let lastPollError = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      try { responsive = await driver.executeScript("return window.__checkReady === true"); } catch (err) { lastPollError = String(err.message ?? err).split("\n")[0].slice(0, 140); }
      if (responsive) break;
      await driver.executeScript("window.__checkReady = true");
    }
    if (!responsive) {
      const state = await driver.executeScript(function main() {
        return { url: String(location.href), ready: document.readyState, sent: window.__checkReady ?? null };
      }).catch((err) => ({ probeError: String(err.message ?? err).slice(0, 100) }));
      try { await driver.quit(); } catch {}
      await new Promise((r) => setTimeout(r, 200));
      if (profileDir) { rmSync(profileDir, { recursive: true, force: true }); }
      throw new Error(`browser never became responsive after launch (about:blank sentinel) - ${JSON.stringify(state)} lastPollError=${lastPollError}`);
    }

    // Startup-tab hygiene: session restore or a stale profile can answer
    // with more than the driver's about:blank tab; commands would keep
    // talking to whichever tab is current while the fixture boots land
    // somewhere invisible. Everything but the tab the sentinel just
    // validated is closed.
    await new Promise((r) => setTimeout(r, 200));
    const handles = await driver.getAllWindowHandles().catch(() => []);
    if (handles.length > 1) {
      const current = await driver.getWindowHandle();
      for (const h of handles) {
        if (h === current) continue;
        await driver.switchTo().window(h).then(() => driver.close()).catch(() => {});
      }
      await driver.switchTo().window(current);
      console.log(`  tab hygiene: closed ${handles.length - 1} startup tab(s)`);
    }
    return new BrowserSession(driver, profileDir);
  }

  constructor(driver, profileDir) {
    this.#driver = driver;
    this.#profileDir = profileDir;
  }

  /** Raw Selenium WebDriver session for action-layer input (gestures). */
  get raw() {
    return this.#driver;
  }

  eval(fn, ...args) {
    return this.#driver.executeScript(fn, ...args);
  }

  evalAsync(fn, ...args) {
    return this.#driver.executeAsyncScript(fn, ...args);
  }

  async navigate(url) {
    await this.#driver.get(url);
    // Verify the landing: a get() that resolves while the browser stays on
    // the pre-navigation document would otherwise plant every later probe on
    // a page without its fixture.
    let landed = await this.#driver.getCurrentUrl().catch(() => null);
    if (landed !== null && !sameDocument(url, landed)) {
      await new Promise((r) => setTimeout(r, 400));
      await this.#driver.get(url);
      landed = await this.#driver.getCurrentUrl().catch(() => null);
      if (landed !== null && !sameDocument(url, landed)) {
        throw new Error(`navigation did not land: requested ${urlSlice(url)} current ${landed ? urlSlice(landed) : "unknown"}`);
      }
    }
  }

  registerFixture(path, html, headers = {}) {
    this.#fixtureRoutes.set(path, { html, headers, bytes: null });
  }

  registerAsset(path, bytes, contentType) {
    this.#fixtureRoutes.set(path, { html: null, headers: { "Content-Type": contentType }, bytes });
  }

  /** A route that stalls `delayMs` before answering - the GM_xmlhttpRequest
   *  timeout probe needs a server that hangs exactly as long as it claims. */
  registerDelayedRoute(path, { delayMs, body, contentType }) {
    this.#fixtureRoutes.set(path, { html: null, headers: { "Content-Type": contentType }, bytes: Buffer.from(body), delayMs });
  }

  async startFixtureServer() {
    if (this.#server) return this.baseUrl;
    const handler = (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      const route = this.#fixtureRoutes.get(path);
      if (route && route.delayMs) {
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, route.headers);
            res.end(route.bytes);
          }
        }, route.delayMs);
        return;
      }
      if (route && route.bytes) {
        // Byte-range support is not cosmetic: without it the browser treats
        // the stream as non-seekable and silently discards currentTime seeks,
        // which would falsify every media-state probe.
        const total = route.bytes.length;
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
        if (match) {
          let start = match[1] === "" ? Math.max(0, total - Number(match[2])) : Number(match[1]);
          let end = match[1] === "" ? total - 1 : (match[2] === "" ? total - 1 : Math.min(Number(match[2]), total - 1));
          start = Math.min(start, total - 1);
          if (end >= start) {
            const chunk = route.bytes.subarray(start, end + 1);
            res.writeHead(206, {
              ...route.headers,
              "Content-Range": `bytes ${start}-${end}/${total}`,
              "Content-Length": chunk.length,
              "Accept-Ranges": "bytes"
            });
            res.end(chunk);
            return;
          }
        }
        res.writeHead(200, { ...route.headers, "Content-Length": total, "Accept-Ranges": "bytes" });
        res.end(route.bytes);
        return;
      }
      if (route) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...route.headers });
        res.end(route.html);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    };
    this.#server = createServer(handler);
    await new Promise((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#fixturePort = this.#server.address().port;
    // Second loopback listener, same handler: Firefox treats localhost and
    // 127.0.0.1 as distinct origins, so cross-origin frame scenarios ride the
    // same fixture routes without a second server. Same port across address
    // families is no conflict - v4 and v6 binds are independent namespaces -
    // and the v6 bind covers whichever address localhost resolves to first
    // (::1 or the v4 map the main listener owns).
    this.#crossServer = createServer(handler);
    await new Promise((resolve, reject) => {
      this.#crossServer.once("error", reject);
      this.#crossServer.listen(this.#fixturePort, "::1", resolve);
    });
    return this.baseUrl;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.#fixturePort}`;
  }

  /** An origin the browser treats as distinct from baseUrl - same routes,
   *  same server socket family. Frames pointed here are genuinely
   *  cross-origin. */
  get crossBaseUrl() {
    return `http://localhost:${this.#fixturePort}`;
  }

  /** GM realm a fresh page needs before bundle injection. A full surface is
   *  built from `grants` (+ GM_info); `storage` seeds the backing so a reboot
   *  can play out with prior-session state in place. */
  injectGMRealm({ version, storage = {}, grants = null, resources = null, header = null } = {}) {
    return this.eval(installGMRealm, { version, storage, grants, resources, header });
  }

  /** GM realm inside a frame chain - exact manager semantics: every frame
   *  document a userscript manager touches gets the userscript surface. */
  injectGMRealmFrame(path, { version, grants = null, resources = null, header = null } = {}) {
    return this.evalInFrame(path, installGMRealm, { version, grants, resources, header });
  }

  /** Pull the live page's GM backing into the session-level store. */
  async harvestGm() {
    const backing = await this.eval(function main() {
      return { ...(window.__pfBacking ?? {}) };
    }).catch(() => null);
    if (backing) {
      this.#gmHead = new Map(Object.entries(backing));
    }
    return backing;
  }

  gmHeadSnapshot() {
    return Object.fromEntries(this.#gmHead);
  }

  /** Inject a bundled userscript after the GM realm exists. */
  injectBundle(bundleSource) {
    const body = bundleSource.slice(bundleSource.indexOf("==/UserScript==") + 16);
    return this.eval(body);
  }

  /** Wake post-injection so the discovery probe sees already-present videos. */
  async wakeVideos() {
    await this.eval(function main() {
      for (const v of document.querySelectorAll("video")) {
        v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
      }
    });
  }

  async waitFor(checkFn, timeoutMs = 5000, intervalMs = 40) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try { last = await this.#driver.executeScript(checkFn); if (last) return last; }
      catch (err) { last = err.message; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`timeout after ${timeoutMs}ms - last=${JSON.stringify(last)}`);
  }

  /** Enter a chain of <iframe> elements from the default content by index path
   *  ([0, 1] = first iframe of the top document -> its second iframe).
   *  switchTo re-aims the script target even across out-of-process frames. */
  async #enterFrames(path) {
    await this.#driver.switchTo().defaultContent();
    for (let depth = 0; depth < path.length; depth++) {
      const frames = await this.#driver.findElements(await byCss("iframe"));
      const idx = path[depth];
      if (idx < 0 || idx >= frames.length) {
        throw new Error(`frame path [${path.join(",")}] broke: depth ${depth} has ${frames.length} iframe(s), index ${idx} wanted`);
      }
      await this.#driver.switchTo().frame(frames[idx]);
    }
  }

  /** Execute a script inside a frame chain (indices, top-first). Restores the
   *  driver to the default content afterward, even on script failure, so one
   *  frame excursion cannot poison later probes. */
  async evalInFrame(path, fn, ...args) {
    await this.#enterFrames(path);
    try {
      return await this.#driver.executeScript(fn, ...args);
    } finally {
      await this.#driver.switchTo().defaultContent();
    }
  }

  /** waitFor() inside a frame chain. Each poll re-enters the frames - a frame
   *  whose document navigated resets the script target anyway, and rebooting
   *  the chain per poll also absorbs partial loads. */
  async waitForFrame(path, checkFn, timeoutMs = 5000, intervalMs = 40) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        await this.#enterFrames(path);
        last = await this.#driver.executeScript(checkFn);
        if (last) {
          await this.#driver.switchTo().defaultContent();
          return last;
        }
      } catch (err) {
        last = err.message;
      }
      await this.#driver.switchTo().defaultContent();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`frame timeout after ${timeoutMs}ms (path [${path.join(",")}]) - last=${JSON.stringify(last)}`);
  }

  /** Frame-scoped failure forensics: what the deep frame actually looks like
   *  when a row failed - mirrors snapshot()'s page-state dump. */
  async snapshotFrameState(path) {
    try {
      return await this.evalInFrame(path, function main() {
        return {
          url: String(location.href),
          errors: [...(window.__pfErrors ?? [])].slice(0, 5),
          shells: document.querySelectorAll(".pf-shell").length,
          videos: document.querySelectorAll("video").length,
          version: window.PlayerForge?.version ?? null
        };
      });
    } catch {
      return null;
    }
  }

  /** Failure forensics: screenshot + page-state dump into check/.tmp/ for the
   * report note. Best effort - never let capture itself fail the gate. */
  async snapshot(label) {
    try {
      const outDir = join(ROOT, "check", ".tmp");
      mkdirSync(outDir, { recursive: true });
      const png = await this.#driver.takeScreenshot();
      writeFileSync(join(outDir, "last-failure.png"), Buffer.from(png, "base64"));
      const state = await this.#driver.executeScript(function main() {
        return {
          url: String(location.href),
          errors: window.__pfErrors ?? [],
          console: (window.__pfConsole ?? []).slice(-5),
          videos: document.querySelectorAll("video").length,
          shells: document.querySelectorAll(".pf-shell").length,
          version: window.PlayerForge?.version ?? null
        };
      });
      writeFileSync(join(outDir, "last-failure.json"), JSON.stringify({ label, at: new Date().toISOString(), ...state }, null, 2));
      return "check/.tmp/last-failure.png + last-failure.json";
    } catch {
      return null;
    }
  }

  async destroy() {
    try { await this.#server?.close(); } catch {}
    try { this.#crossServer?.removeAllListeners(); await this.#crossServer?.close(); } catch {}
    try { await this.#driver?.quit(); } catch {}
    if (this.#profileDir) { try { rmSync(this.#profileDir, { recursive: true, force: true }); } catch {} }
  }
}
