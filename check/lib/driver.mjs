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

function brewReinstallChromedriver() {
  console.log("  brew reinstall chromedriver (heal attempt)...");
  try {
    execFileSync("brew", ["reinstall", "chromedriver"], { stdio: "inherit", timeout: 120000 });
  } catch (err) {
    console.log(`  brew reinstall failed: ${err.message}`);
  }
}

/**
 * Fail-fast driver probe for the runner: scan the disk fresh (a mid-run brew
 * heal must be visible), reinstall via brew when nothing reports a sane
 * version, and re-scan again before giving up. Best-effort: launch falls back
 * to Selenium Manager when this returns null.
 */
export function ensureChromeDriver() {
  let drivers = scanDrivers();
  if (drivers.length === 0) {
    console.log("  no chromedriver on disk - brew reinstalling...");
    brewReinstallChromedriver();
    drivers = scanDrivers();
  }
  for (const bin of drivers) {
    const version = nativeBinaryVersion(bin);
    if (version !== null) {
      console.log(`  driver probe: ${basename(bin)} (${version})`);
      return bin;
    }
  }
  console.log("  driver probe: no usable chromedriver on disk - Selenium Manager resolves at launch");
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

    const createDriver = async (shim) => {
      const chromeMod = await import("selenium-webdriver/chrome.js");
      const options = new chromeMod.Options()
        .setChromeBinaryPath(shim)
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
      return new Builder()
        .forBrowser("chrome")
        .setChromeOptions(options)
        .setChromeService(serviceFor(chromeMod, browserVersion))
        .build();
    };

    let driver;
    try {
      driver = await createDriver(shimBrowser(browserBinary, profileDir));
    } catch (err) {
      brewReinstallChromedriver();
      try {
        driver = await createDriver(shimBrowser(browserBinary, profileDir));
      } catch (err2) {
        throw new Error(`chromedriver handshake failed after brew heal: ${err2.message}`);
      }
    }

    // Wait out the session's own initial about:blank navigation: a mid-flight
    // startup navigation replaces the injected document and silently eats the
    // already-loaded bundle.
    await driver.get("about:blank");
    await driver.executeScript("window.__checkReady = true");
    const deadline = Date.now() + 5000;
    while ((Date.now() < deadline)) {
      await new Promise((r) => setTimeout(r, 300));
      let alive = false;
      try { alive = await driver.executeScript("window.__checkReady === true"); } catch {}
      if (alive) break;
      await driver.executeScript("window.__checkReady = true");
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
    this.#fixtureRoutes.set(path, { html: null, headers: { "Content-Type": contentType }, bytes:Buffer.from(body), delayMs });
  }

  async startFixtureServer() {
    if (this.#server) return this.baseUrl;
    this.#server = createServer((req, res) => {
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
    });
    await new Promise((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#fixturePort = this.#server.address().port;
    return this.baseUrl;
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.#fixturePort}`;
  }

  /** GM realm a fresh page needs before bundle injection. A full surface is
   *  built from `grants` (+ GM_info); `storage` seeds the backing so a reboot
   *  can play out with prior-session state in place. */
  injectGMRealm({ version, storage = {}, grants = null, resources = null, header = null } = {}) {
    return this.eval(installGMRealm, { version, storage, grants, resources, header });
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
    try { await this.#driver?.quit(); } catch {}
    if (this.#profileDir) { try { rmSync(this.#profileDir, { recursive: true, force: true }); } catch {} }
  }
}
