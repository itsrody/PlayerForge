/**
 * Chromium session boot for the check tool.
 *
 * Owns everything between "run the gates" and "real page running the real
 * bundle": driver discovery (brew chromedriver, healed via brew reinstall on
 * handshake failure, Selenium Manager cache fallback), a fork-branded browser
 * version shim so chromedriver accepts Helium's fork product string, an
 * isolated profile, and a same-origin fixture server the kernel's ad-host
 * guard will not skip.
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
  process.env.HELIUM_PATH,
  join(homedir(), "Applications", "Helium.app", "Contents", "MacOS", "Helium"),
  "/Applications/Helium.app/Contents/MacOS/Helium",
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  join(homedir(), "Applications", "Vivaldi.app", "Contents", "MacOS", "Vivaldi"),
  "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
].filter((p) => p && existsSync(p));

function embeddedChromiumVersion(binary) {
  const appRoot = binary.match(/^(.*\/)(Helium|Vivaldi)\.app\//);
  if (appRoot === null) return null;
  const versions = join(
    appRoot[1] + appRoot[2] + ".app", "Contents", "Frameworks",
    `${appRoot[2]} Framework.framework`, "Versions"
  );
  if (existsSync(versions)) {
    try {
      const dotQuad = readdirSync(versions).find((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d));
      if (dotQuad) return dotQuad;
    } catch {}
  }
  return null;
}

function majorOf(version) {
  return version === null ? null : String(version).split(".")[0];
}

function nativeBinaryVersion(binary) {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

function shimBrowser(binary, dir) {
  const version = embeddedChromiumVersion(binary);
  if (version === null) return binary;
  const shim = join(dir, "driver-browser-shim");
  writeFileSync(
    shim,
    "#!/bin/sh\n" +
      "# fork product strings (Helium 0.x / Vivaldi 8.x) are not chromedriver's\n" +
      "# product; answer with the embedded Chromium version, exec otherwise.\n" +
      'for a in "$@"; do case "$a" in --product-version|--version) printf \'%s\\n\' \'' + version + '\'; exit 0 ;; esac done\n' +
      "exec '" + binary + "' \"$@\"\n",
    { mode: 0o755 }
  );
  chmodSync(shim, 0o755);
  return shim;
}

function chmodX(path) { try { chmodSync(path, 0o755); } catch {} }

function cachedDriver(version) {
  const plat = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  const platDir = join(homedir(), ".cache", "selenium", "chromedriver", plat);
  if (!existsSync(platDir)) return null;
  const major = majorOf(version);
  const exact = join(platDir, version, "chromedriver");
  if (existsSync(exact)) { chmodX(exact); return exact; }
  let best = null;
  try {
    for (const dir of readdirSync(platDir)) {
      if (majorOf(dir) !== major) continue;
      if (best === null || dir > best) best = dir;
    }
  } catch {}
  if (best === null) return null;
  const p = join(platDir, best, "chromedriver");
  if (!existsSync(p)) return null;
  chmodX(p);
  return p;
}

function scanDrivers() {
  return [
    process.env.CHROMEDRIVER_PATH,
    "/opt/homebrew/bin/chromedriver",
    "/usr/local/bin/chromedriver"
  ].filter((p) => p && existsSync(p));
}

function localDriverFor(browserVersion) {
  const cached = cachedDriver(browserVersion);
  if (cached) return cached;
  const major = majorOf(browserVersion);
  return scanDrivers().find((path) => majorOf(nativeBinaryVersion(path)) === major) ?? null;
}

function serviceFor(chromeMod, browserVersion) {
  const local = localDriverFor(browserVersion);
  if (local) {
    console.log(`  driver: ${basename(local)} (major match)`);
    return new chromeMod.ServiceBuilder(local);
  }
  console.log("  driver: Selenium Manager resolves a version-matched chromedriver");
  return new chromeMod.ServiceBuilder();
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

function brewReinstallChromedriver() {
  console.log("  brew reinstall chromedriver (heal attempt)...");
  try {
    execFileSync("brew", ["reinstall", "chromedriver"], { stdio: "inherit", timeout: 120000 });
  } catch (err) {
    console.log(`  brew reinstall failed: ${err.message}`);
  }
}

/**
 * Launch-failure classifier: a chromedriver session death reads as its raw
 * stack + a protocol blob, so the runner needs the one-line decision out of
 * it. Version refusals get their exact shape (the single most common boot
 * failure after a fork-browser update); handshake failures / port collisions
 * so on - anything else stays "refused session".
 */
function classifyDriverFailure(err) {
  const text = String(err?.message ?? err);
  if (/session not created/i.test(text)) {
    if (/version|only supports/i.test(text)) return "chromedriver/browser version mismatch";
    return "session refused by chromedriver";
  }
  if (/DevToolsActivePort|refused to connect|ECONNREFUSED/i.test(text)) return "handshake failed (no DevTools port)";
  if (/TIMEDOUT|timeout/i.test(text)) return "handshake timed out";
  if (/not executable|cannot be opened|exec/i.test(text)) return "driver binary not runnable";
  return "launch refused";
}

function serviceLabel(service) {
  const exe = typeof service?.getExecutable === "function" ? service.getExecutable() : null;
  return exe ? basename(String(exe)) : "Selenium Manager (auto)";
}

/**
 * Order the launch candidates and keep them honest: a local disk driver is
 * only a candidate while its major matches the browser (a stale brew driver
 * 154 in front of Chromium 156 would guarantee a session refusal); the Selenium
 * Manager candidate always trails so a whole-ladder failure needs something
 * new on disk before any retry could matter.
 */
function serviceCandidates(chromeMod, browserVersion) {
  const list = [];
  const local = localDriverFor(browserVersion);
  if (local) {
    console.log(`  driver candidate: ${basename(local)} (${nativeBinaryVersion(local) ?? "unknown version"})`);
    list.push(new chromeMod.ServiceBuilder(local));
  } else {
    const stale = scanDrivers().find((p) => {
      const v = nativeBinaryVersion(p);
      return v !== null && majorOf(v) !== majorOf(browserVersion);
    });
    if (stale) {
      console.log(`  driver: ${basename(stale)} on disk is stale for chromium ${browserVersion} - Selenium Manager downloads the matching major`);
    }
  }
  list.push(new chromeMod.ServiceBuilder());
  return list;
}

/**
 * Fail-fast driver probe for the runner, browser-aware: it knows the
 * embedded Chromium major the launch will target, so "chromedriver 154 vs
 * chromium 156" is surfaced here (the browser-preference path is the actual
 * plan: launch falls back to Selenium Manager for the matching major) instead
 * of one loud session-refusal launch later. When the disk can supply the
 * matching major it is preferred over a merely reporting driver. Best-effort:
 * launch falls back to Selenium Manager when this returns null.
 */
export function ensureChromeDriver() {
  const browserBinary = BROWSERS[0];
  const browserVersion = browserBinary ? (embeddedChromiumVersion(browserBinary) ?? nativeBinaryVersion(browserBinary)) : null;
  const neededMajor = majorOf(browserVersion);

  let drivers = scanDrivers();
  if (drivers.length === 0) {
    console.log("  no chromedriver on disk - brew reinstalling...");
    brewReinstallChromedriver();
    drivers = scanDrivers();
  }
  const sane = [];
  for (const bin of drivers) {
    const version = nativeBinaryVersion(bin);
    if (version === null) {
      console.log(`  driver probe: ${basename(bin)} failed to report a version - skipped`);
      continue;
    }
    const matches = majorOf(version) === neededMajor;
    sane.push({ bin, version, matches });
  }
  if (sane.length === 0) {
    console.log("  driver probe: no usable chromedriver on disk - Selenium Manager resolves at launch");
    return null;
  }
  const matching = sane.find((d) => d.matches);
  if (matching) {
    console.log(`  driver probe: ${basename(matching.bin)} (${matching.version}) matches chromium ${browserVersion}`);
    return matching.bin;
  }
  const stale = sane[0];
  console.log(`  driver probe: ${basename(stale.bin)} (${stale.version}) is stale for chromium ${browserVersion} - launch will prefer Selenium Manager's matching major`);
  return null;
}

/**
 * Boot a headless, isolated-profile Chromium session with the userscript realm
 * injected. Reused across cases; destroyed once per tool run.
 */
export class ChromiumSession {
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
      throw new Error("no Chromium browser found (set HELIUM_PATH or install Helium)");
    }
    const browserVersion = embeddedChromiumVersion(browserBinary) ?? nativeBinaryVersion(browserBinary);
    if (browserVersion === null) {
      throw new Error(`cannot read a Chromium version out of ${browserBinary}`);
    }
    console.log(`  browser: ${basename(browserBinary)} (chromium ${browserVersion})`);

    const profileDir = mkdtempSync(join(tmpdir(), "check-driver-"));
    const { Builder } = await import("selenium-webdriver");
    const chromeMod = await import("selenium-webdriver/chrome.js");
    const options = new chromeMod.Options()
      .setChromeBinaryPath(shimBrowser(browserBinary, profileDir))
      .setAcceptInsecureCerts(true)
      .addArguments(
        `--user-data-dir=${profileDir}`,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
        "--window-size=1440,900"
      );

    // Candidate ladder: a version-matched local driver first, Selenium
    // Manager always behind it. A mid-fork-update disk (brew driver 154 vs
    // Chromium 156) therefore never guarantees a brew-heal round trip that
    // reinstalls the same stale version.
    const tried = [];
    const serviceAndAttempt = async (service) => {
      const label = serviceLabel(service);
      try {
        const built = await new Builder()
          .forBrowser("chrome")
          .setChromeOptions(options)
          .setChromeService(service)
          .build();
        tried.push({ label, ok: true });
        return built;
      } catch (err) {
        tried.push({ label, ok: false, reason: classifyDriverFailure(err), raw: String(err.message ?? err).split("\n")[0].slice(0, 140) });
        throw err;
      }
    };
    let driver = null;
    for (const service of serviceCandidates(chromeMod, browserVersion)) {
      try {
        driver = await serviceAndAttempt(service);
        break;
      } catch {}
    }
    if (driver === null) {
      // A brew reinstall only helps launch when it can either restore a
      // corrupted binary we never reached, or bring a NEW major onto the
      // disk. If a local driver was already tried, or a matching one still
      // exists but failed, the reinstall replays the identical bytes.
      const wantsHeal = !tried.some((t) => t.ok === false && t.label !== "Selenium Manager (auto)")
        && localDriverFor(browserVersion) === null;
      if (wantsHeal) {
        brewReinstallChromedriver();
        driver = await new Builder()
          .forBrowser("chrome")
          .setChromeOptions(options)
          .setChromeService(serviceFor(chromeMod, browserVersion))
          .build()
          .catch((err) => {
            tried.push({ label: "brew heal", ok: false, reason: classifyDriverFailure(err), raw: String(err.message ?? err).split("\n")[0].slice(0, 140) });
            return null;
          });
      }
      if (driver === null) {
        throw new Error(
          `chromedriver launch failed for chromium ${browserVersion}; attempts:\n  ` +
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

    // Startup-tab hygiene: a fork-browser update often spawns its own
    // welcome/startup tab ahead of the driver's about:blank; commands would
    // then keep talking to whichever tab is current while the fixture boots
    // land somewhere invisible. Everything but the tab the sentinel just
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

    const session = new ChromiumSession(driver, profileDir);
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
    // updated fork browser) would otherwise plant every later probe on a
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
        // Byte-range support is not cosmetic: without it Chromium treats the
        // stream as non-seekable and silently discards currentTime seeks,
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
    // Second loopback listener, same handler: Chromium treats localhost and
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

  /** An origin Chromium treats as distinct from baseUrl - same routes, same
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
