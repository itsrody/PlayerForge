/**
 * Native Firefox session boot for the check tool.
 *
 * Owns everything between "run the gates" and "real page running the real
 * bundle": driver discovery (geckodriver from the disk, Selenium Manager
 * cache fallback), the headless isolated-profile Firefox session the GM
 * realm and bundle get injected into, and a same-origin fixture server the
 * kernel's ad-host guard will not skip.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { installGMRealm } from "./gm-realm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const BROWSERS = [
  process.env.FIREFOX_PATH,
  "/Applications/Firefox.app/Contents/MacOS/firefox",
  join(homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox")
].filter((p) => p && existsSync(p));

function majorOf(version) {
  return version === null ? null : String(version).split(".")[0];
}

/** "Mozilla Firefox 159.0" -> "159.0"; null when the binary cannot answer. */
function firefoxBinaryVersion(binary) {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function chmodX(path) { try { chmodSync(path, 0o755); } catch {} }

/** Selenium Manager's on-disk geckodriver cache, newest first. */
function cachedDriver() {
  const plat = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  const platDir = join(homedir(), ".cache", "selenium", "geckodriver", plat);
  if (!existsSync(platDir)) return null;
  let best = null;
  try {
    for (const dir of readdirSync(platDir)) {
      if (best === null || dir > best) best = dir;
    }
  } catch {}
  if (best === null) return null;
  const p = join(platDir, best, "geckodriver");
  if (!existsSync(p)) return null;
  chmodX(p);
  return p;
}

function scanDrivers() {
  return [
    process.env.GECKODRIVER_PATH,
    "/opt/homebrew/bin/geckodriver",
    "/usr/local/bin/geckodriver",
    cachedDriver()
  ].filter((p) => p && existsSync(p));
}

/** Unlike chromedriver, geckodriver majors are cross-version: one 0.37
 *  serves every supported Firefox major, so any runnable disk driver is a
 *  honest candidate and the version read is for the log, not a gate. */
function driverLabel(path) {
  try {
    const out = execFileSync(path, ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const v = out.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1];
    return v ? `${basename(path)} ${v}` : basename(path);
  } catch {
    return `${basename(path)} (unversioned)`;
  }
}

function serviceFor(firefoxMod) {
  const local = scanDrivers()[0] ?? null;
  if (local) {
    console.log(`  driver: ${driverLabel(local)}`);
    return new firefoxMod.ServiceBuilder(local);
  }
  console.log("  driver: Selenium Manager resolves geckodriver");
  return new firefoxMod.ServiceBuilder();
}

function basename(p) { return p.slice(p.lastIndexOf("/") + 1); }

/** Selenium's selector utility, imported lazily once. */
let byRef = null;
async function byCss(selector) {
  byRef ??= (await import("selenium-webdriver")).By;
  return byRef.css(selector);
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

function brewReinstallGeckodriver() {
  console.log("  brew reinstall geckodriver (heal attempt)...");
  try {
    execFileSync("brew", ["reinstall", "geckodriver"], { stdio: "inherit", timeout: 120000 });
  } catch (err) {
    console.log(`  brew reinstall failed: ${err.message}`);
  }
}

/**
 * Launch-failure classifier: a geckodriver session death reads as its raw
 * stack + a protocol blob, so the runner needs the one-line decision out of
 * it. Firefox shapes: a refused binary (wrong product path, quarantine),
 * the marionette handshake (geckodriver started but the browser port never
 * opened - a real Firefox launch failure), and timeouts.
 */
function classifyDriverFailure(err) {
  const text = String(err?.message ?? err);
  if (/session not created/i.test(text)) {
    if (/binary|Failed to start|launcher|not found/i.test(text)) return "geckodriver could not start the browser";
    return "session refused by geckodriver";
  }
  if (/marionette|connection refused|ECONNREFUSED|unexpectedly closed|handshake|Process\b/i.test(text)) return "handshake failed (no marionette port)";
  if (/TIMEDOUT|timeout/i.test(text)) return "handshake timed out";
  if (/not executable|cannot be opened|exec/i.test(text)) return "driver binary not runnable";
  return "launch refused";
}

function serviceLabel(service) {
  const exe = typeof service?.getExecutable === "function" ? service.getExecutable() : null;
  return exe ? basename(String(exe)) : "Selenium Manager (auto)";
}

/**
 * Fail-fast driver probe for the runner: prints what the disk can supply and
 * heals a completely empty disk through brew, but never blocks - geckodriver
 * has no version-matched-major requirement to fail against, so a missing or
 * odd disk honestly delegates to Selenium Manager at launch. Best-effort.
 */
export function ensureFirefoxDriver() {
  const browserBinary = BROWSERS[0];
  const browserVersion = browserBinary ? firefoxBinaryVersion(browserBinary) : null;
  console.log(`  browser probe: ${browserBinary ? `${basename(browserBinary)} (firefox ${browserVersion ?? "unknown"})` : "NO FIREFOX BINARY FOUND"}`);

  let drivers = scanDrivers();
  if (drivers.length === 0) {
    console.log("  no geckodriver on disk - brew reinstalling...");
    brewReinstallGeckodriver();
    drivers = scanDrivers();
  }
  for (const bin of drivers) {
    console.log(`  driver probe: ${driverLabel(bin)}`);
  }
  return drivers[0] ?? null;
}

/**
 * Boot a headless, isolated-profile native Firefox session with the
 * userscript realm injected. Reused across cases; destroyed once per tool
 * run. geckodriver manufactures its own temporary profile when none is
 * given, so per-launch isolation is the driver's default, not an argument
 * the ladder has to thread; the temp dir this class makes is only the
 * owner of teardown bookkeeping for anything else per-run.
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
      throw new Error("no Firefox binary found (set FIREFOX_PATH or install Firefox)");
    }
    const browserVersion = firefoxBinaryVersion(browserBinary);
    if (browserVersion === null) {
      console.log(`  browser: ${basename(browserBinary)} (--version unreadable - continuing)`);
    } else {
      console.log(`  browser: ${basename(browserBinary)} (firefox ${browserVersion})`);
    }

    const profileDir = mkdtempSync(join(tmpdir(), "check-driver-"));
    const { Builder } = await import("selenium-webdriver");
    const firefoxMod = await import("selenium-webdriver/firefox.js");
    const options = new firefoxMod.Options()
      .setBinary(browserBinary)
      .setAcceptInsecureCerts(true)
      .addArguments("-headless");

    // Candidate ladder: the disk's geckodriver first (no major-matching: one
    // recent geckodriver serves every supported Firefox), Selenium Manager
    // always behind it.
    const tried = [];
    const serviceAndAttempt = async (service) => {
      const label = serviceLabel(service);
      try {
        const built = await new Builder()
          .forBrowser("firefox")
          .setFirefoxOptions(options)
          .setFirefoxService(service)
          .build();
        tried.push({ label, ok: true });
        return built;
      } catch (err) {
        tried.push({ label, ok: false, reason: classifyDriverFailure(err), raw: String(err.message ?? err).split("\n")[0].slice(0, 140) });
        throw err;
      }
    };
    const candidates = [];
    const local = scanDrivers()[0] ?? null;
    if (local) {
      console.log(`  driver candidate: ${driverLabel(local)}`);
      candidates.push(new firefoxMod.ServiceBuilder(local));
    } else {
      console.log("  driver: Selenium Manager resolves geckodriver at launch");
    }
    candidates.push(new firefoxMod.ServiceBuilder());

    let driver = null;
    for (const service of candidates) {
      try {
        driver = await serviceAndAttempt(service);
        break;
      } catch {}
    }
    if (driver === null) {
      // The brew heal only helps when the whole ladder died before ever
      // running a local driver (i.e. nothing usable was on disk at all): a
      // reinstall that replays identical bytes cannot fix a refused session.
      const wantsHeal = !tried.some((t) => t.ok === false && t.label === serviceLabel(new firefoxMod.ServiceBuilder(local)))
        && local === null;
      if (wantsHeal) {
        brewReinstallGeckodriver();
        driver = await new Builder()
          .forBrowser("firefox")
          .setFirefoxOptions(options)
          .setFirefoxService(serviceFor(firefoxMod))
          .build()
          .catch((err) => {
            tried.push({ label: "brew heal", ok: false, reason: classifyDriverFailure(err), raw: String(err.message ?? err).split("\n")[0].slice(0, 140) });
            return null;
          });
      }
      if (driver === null) {
        throw new Error(
          `geckodriver launch failed for firefox ${browserVersion ?? "?"}; attempts:\n  ` +
          tried.map((t) => `${t.label} -> ${t.ok ? "ok" : (t.reason ?? "?") + " (" + (t.raw ?? "") + ")"}`).join("\n  ")
        );
      }
    }

    // Wait out the session's own initial about:blank navigation, and fail
    // loudly when the browser never became responsive - a phantom session
    // would surface later as baffling mid-gate navigation races. The window
    // is generous (first boot after a browser update runs cold caches).
    await driver.get("about:blank");
    await driver.executeScript("window.__checkReady = true");
    const deadline = Date.now() + 12000;
    let responsive = false;
    let lastPollError = null;
    while ((Date.now() < deadline)) {
      await new Promise((r) => setTimeout(r, 250));
      // The check must be a `return`-ing script body (Selenium string quirk):
      // an expression-only body returns undefined and the sentinel would
      // never observe the flag the assignment just set.
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
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error(`browser never became responsive after launch (about:blank sentinel) - ${JSON.stringify(state)} lastPollError=${lastPollError}`);
    }

    // Headless carries no --window-size argument across drivers: set the
    // working rect through the window command the geckodriver natively
    // supports. Best-effort - the deferral rows' layout math uses the
    // viewport, not a hard-coded size.
    try {
      await driver.manage().window().setRect({ width: 1440, height: 900 });
    } catch (err) {
      console.log(`  window rect: ${String(err.message ?? err).slice(0, 80)}`);
    }

    // Startup-tab hygiene: Firefox launches with exactly the driver's
    // about:blank tab in a fresh geckodriver profile, but a mid-flight
    // browser update or a session-restore pref can still spawn extras;
    // commands would then keep talking to whichever tab is current while
    // the fixture boots land somewhere invisible. Everything but the tab
    // the sentinel just validated is closed.
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

    const session = new BrowserSession(driver, profileDir);
    return session;
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
    // the pre-navigation document (startup navigation race on a freshly
    // updated browser) would otherwise plant every later probe on a
    // page without its fixture.
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
        // Byte-range support is not cosmetic: without it a seek over the
        // stream reads as non-seekable and silently discards currentTime
        // seeks, which would falsify every media-state probe.
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
    // Second loopback listener, same handler: browsers treat localhost and
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

  /** An origin browsers treat as distinct from baseUrl - same routes, same
   *  server socket family. Frames pointed here are genuinely cross-origin. */
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
   *  ([0, 1] = first iframe of the top document -> its second iframe). Cross-
   *  origin out-of-process frames work at the driver level: switchTo re-aims
   *  the script target even across renderer processes. */
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
