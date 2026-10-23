/**
 * Firefox session boot for the check tool (gecko branch).
 *
 * Playwright owns the browser lifecycle — the version-pinned Firefox build
 * (installed with `npx playwright install firefox`, refreshed whenever
 * playwright moves its pin), an isolated persistent profile, and CDP-free
 * page-level driving. There is no driver binary on disk to go
 * stale, so the launch-failure class the old ladder maintained (version
 * refusals, handshake floods, heal round-trips) cannot recur.
 * Everything else the cases consume — the fixture server, the GM realm, the
 * screenshot forensics — keeps its contract.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { installGMRealm } from "./gm-realm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const SENTINEL_TIMEOUT_MS = 15000;

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

/**
 * Fail-fast install probe: playwright can tell exactly what it is missing,
 * which is friendlier than one confusing "Executable doesn't exist" launch
 * error later. `npx playwright install firefox` stays the single healing
  * action; nothing else is diffed against disk state.
 */
export async function ensureFirefox() {
  const { firefox } = await import("playwright");
  let exe = null;
  try { exe = firefox.executablePath(); } catch { exe = null; }
  if (exe) {
    try {
      execFileSync(exe, ["--version"], { stdio: "pipe", timeout: 30000 });
    } catch {
      exe = null;
    }
  }
  if (!exe) {
    console.log("  firefox build missing - running `npx playwright install firefox`...");
    try {
      execFileSync("npx", ["playwright", "install", "firefox"], { stdio: "inherit", timeout: 420000 });
    } catch (err) {
      throw new Error(`playwright firefox install failed: ${err.message.slice(0, 160)}`);
    }
  }
  return firefox;
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
  #context;
  #page;
  #profileDir;
  #server;
  #crossServer;
  #fixturePort;
  #fixtureRoutes = new Map();
  /** Session-level GM backing store: what `harvestGm()` last pulled off the
   *  live page. Opt-in persistence for the realm (opt-out stays isolated). */
  #gmHead = new Map();

  static async launch() {
    const firefox = await ensureFirefox();
    const tryExe = firefox.executablePath?.();
    const exe = typeof tryExe === "string" ? tryExe : "";
    const profileDir = mkdtempSync(join(tmpdir(), "check-firefox-"));
    const context = await firefox.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 1440, height: 900 }
    });
    console.log(`  browser: playwright firefox${exe ? ` (${exe.slice(exe.lastIndexOf("/") + 1)})` : ""}`);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("about:blank");
    // Sentinel: the session must answer script probes before any case lands,
    // else a wedged launch would surface as baffling mid-gate navigation
    // races. Poll - never assume one evaluate() proves responsiveness.
    const deadline = Date.now() + SENTINEL_TIMEOUT_MS;
    let responsive = false;
    let lastPollError = null;
    while (Date.now() < deadline) {
      try { responsive = await page.evaluate(() => window.__checkReady === true); } catch (err) { lastPollError = String(err.message ?? err).split("\n")[0].slice(0, 140); }
      if (responsive) break;
      await page.evaluate(() => { window.__checkReady = true; }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!responsive) {
      const state = await page.evaluate(() => ({ url: String(location.href), ready: document.readyState, sent: window.__checkReady ?? null })).catch((err) => ({ probeError: String(err.message ?? err).slice(0, 100) }));
      await context.close().catch(() => {});
      rmSync(profileDir, { recursive: true, force: true });
      throw new Error(`browser never became responsive after launch (about:blank sentinel) - ${JSON.stringify(state)} lastPollError=${lastPollError}`);
    }
    return new BrowserSession(context, page, profileDir);
  }

  constructor(context, page, profileDir) {
    this.#context = context;
    this.#page = page;
    this.#profileDir = profileDir;
  }

  /** The live page, for the cases' input-layer work (mouse/keyboard streams,
   *  viewport emulation). TEST-ONLY surface. */
  get raw() {
    return this.#page;
  }

  /**
   * Driver-parity script evaluation. Cases pass closures whose captured
   * scope never crossed a driver boundary (as with executeScript) and single
   * plain-data arguments; the string body form (waitFor) carries a `return`
   * statement and rides the arrow-wrap. Evaluated via the same wrapping the
   * devtools channel uses, so page CSP never clips probes.
   */
  #run(fn, args, target = this.#page) {
    if (typeof fn === "string") {
      return target.evaluate(`(() => { ${fn.trim()} })()`);
    }
    if (args.length === 0) {
      return target.evaluate(fn);
    }
    if (args.length === 1) {
      return target.evaluate(fn, args[0]);
    }
    // Multi-arg closures: serialize through source. (No case payload travels
    // here today; the path stays because the session owns the parity.)
    return target.evaluate(({ src, rest }) => (0, eval(`(${src})`))(...rest), { src: fn.toString(), rest: args });
  }

  eval(fn, ...args) {
    return this.#run(fn, args);
  }

  /** Async-completion closures: `main(done)` style, awaited like the in-page
   *  promises they resolve. */
  evalAsync(fn, ...args) {
    const target = this.#page;
    if (typeof fn !== "string" && args.length <= 1) {
      return target.evaluate(async (payload) => await new Promise((done) => (0, eval(`(${payload.src})`))(...payload.rest, done)), {
        src: fn.toString(),
        rest: args
      });
    }
    return this.#run(fn, args);
  }

  async navigate(url) {
    await this.#page.goto(url);
    // Verify the landing: a goto() that resolves while the browser stays on
    // the pre-navigation document would otherwise plant every later probe on
    // a page without its fixture.
    let landed = this.#page.url();
    if (!sameDocument(url, landed)) {
      await new Promise((r) => setTimeout(r, 400));
      await this.#page.goto(url);
      landed = this.#page.url();
      if (!sameDocument(url, landed)) {
        throw new Error(`navigation did not land: requested ${urlSlice(url)} current ${urlSlice(landed)}`);
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
    // Second loopback listener, same handler: the localhost and 127.0.0.1
    // origins are distinct, so cross-origin frame scenarios ride the same
    // fixture routes without a second server. Same port across address
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
    const backing = await this.eval(() => ({ ...(window.__pfBacking ?? {}) })).catch(() => null);
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
      try { last = await this.#run(checkFn, []); if (last) return last; }
      catch (err) { last = err.message; }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`timeout after ${timeoutMs}ms - last=${JSON.stringify(last)}`);
  }

  /** Resolve the Frame object for an index path ([0, 1] = first iframe of the
   *  top document -> its second iframe). Playwright's frame tree mirrors the
   *  DOM: each nesting level of the frames lab is a static static-hosted
   *  chain, so discovery order == iframe order at every depth. Cross-origin
   *  out-of-process frames need no special casing at this level - the Frame
   *  object is the auto-switching script target. */
  async #frameFor(path) {
    let frame = this.#page.mainFrame();
    for (let depth = 0; depth < path.length; depth++) {
      const idx = path[depth];
      const kids = frame.childFrames();
      if (idx < 0 || idx >= kids.length) {
        throw new Error(`frame path [${path.join(",")}] broke: depth ${depth} has ${kids.length} iframe(s), index ${idx} wanted`);
      }
      frame = kids[idx];
    }
    return frame;
  }

  /** Execute a script inside a frame chain (indices, top-first). Playwright
   *  holds no implicit driver frame cursor, so nothing can be poisoned by an
   *  excursion; a frame whose document navigates simply invalidates its
   *  object, which the waitForFrame re-entrance below handles. */
  async evalInFrame(path, fn, ...args) {
    const frame = await this.#frameFor(path);
    if (typeof fn === "string") {
      return frame.evaluate(`(() => { ${fn.trim()} })()`);
    }
    if (args.length <= 1) {
      return frame.evaluate(fn, args[0]);
    }
    return frame.evaluate(({ src, rest }) => (0, eval(`(${src})`))(...rest), { src: fn.toString(), rest: args });
  }

  /** waitFor() inside a frame chain. Each poll re-resolves the frame - a
   *  frame whose document navigated replaced its object anyway, and the
   *  re-resolution absorbs partial loads. */
  async waitForFrame(path, checkFn, timeoutMs = 5000, intervalMs = 40) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      try {
        last = await this.evalInFrame(path, checkFn);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
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
      const png = await this.#page.screenshot({ path: join(outDir, "last-failure.png") });
      void png;
      const state = await this.#page.evaluate(function main() {
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
    try { await this.#context?.close(); } catch {}
    if (this.#profileDir) { try { rmSync(this.#profileDir, { recursive: true, force: true }); } catch {} }
  }
}
