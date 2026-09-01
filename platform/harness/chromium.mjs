/**
 * ChromiumDriver lifecycle manager.
 *
 * Launches a headless Chromium/Brave 152 instance via Selenium WebDriver,
 * connects through the ChromeDriver protocol, and exposes helpers for script
 * injection, page navigation, and pointer event dispatch.
 *
 * Usage:
 *   const driver = await ChromiumDriver.launch();
 *   await driver.navigate("data:text/html,<video></video>");
 *   await driver.injectScript(readFileSync("dist/playerforge.user.js", "utf8"));
 *   const hasHud = await driver.eval(() => !!document.querySelector(".pf-hud-layer"));
 *   await driver.destroy();
 */
import { Builder } from "selenium-webdriver";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..", "..");

/**
 * Resolve the Chromium/Brave binary path on macOS.
 * Order: BRAVE_PATH env → known macOS locations → fallback error.
 */
function resolveBinary() {
  if (process.env.BRAVE_PATH && existsSync(process.env.BRAVE_PATH)) {
    return process.env.BRAVE_PATH;
  }
  const candidates = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    "No Chromium-based browser found. Set BRAVE_PATH or install Brave/Chrome."
  );
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
  /** @type {boolean} */
  #destroyed = false;

  constructor(driver) {
    this.#driver = driver;
  }

  /**
   * Launch a headless Chromium/Brave 152 instance.
   * @param {object} [options]
   * @param {boolean} [options.headless=true] - Run headless.
   * @param {number} [options.port=0] - ChromeDriver port (0 = auto).
   * @returns {Promise<ChromiumDriver>}
   */
  static async launch(options = {}) {
    const { headless = true, port = 0 } = options;
    const binary = resolveBinary();

    const args = [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--no-first-run",
      "--disable-web-security",
    ];
    if (headless) {
      args.push("--headless=new");
    }

    const chromeOptions = {
      binary,
      args,
      // Accept insecure certs for test pages.
      acceptInsecureCerts: true,
    };

    const driver = await new Builder()
      .forBrowser("chrome")
      .setChromeOptions(chromeOptions)
      .setChromeService(
        new (await import("selenium-webdriver/chrome.js")).ServiceBuilder()
      )
      .build();

    return new ChromiumDriver(driver);
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
   * Inject GM_* API stubs into the page context. Must be called before
   * injectScript() so the userscript finds the globals it expects.
   *
   * @param {object} [options]
   * @param {Record<string, any>} [options.storage] - Initial storage backing.
   */
  async injectGMStubs(options = {}) {
    const { storage = {} } = options;
    const stubSource = readFileSync(
      join(HERE, "gm-stubs.mjs"),
      "utf8"
    );
    // Evaluate the stub module as a self-contained script that populates
    // globalThis with all GM_* APIs.
    const initScript = `
      ${stubSource}
      window.__pfGMStorage = ${JSON.stringify(storage)};
      window.__pfGMListeners = {};
      window.GM_getValue = function(key, fallback) {
        const s = window.__pfGMStorage;
        return key in s ? s[key] : fallback;
      };
      window.GM_setValue = function(key, value) {
        window.__pfGMStorage[key] = value;
      };
      window.GM_deleteValue = function(key) {
        delete window.__pfGMStorage[key];
      };
      window.GM_registerMenuCommand = function(title, fn) {
        const id = 'menu_' + title;
        window.__pfGMListeners[id] = fn;
        return id;
      };
      window.GM_unregisterMenuCommand = function(id) {
        delete window.__pfGMListeners[id];
      };
      window.GM_addValueChangeListener = function(key, cb) {
        const id = ' listener_' + key + '_' + Date.now();
        window.__pfGMListeners[id] = { key, cb };
        return id;
      };
      window.GM_removeValueChangeListener = function(id) {
        delete window.__pfGMListeners[id];
      };
      window.GM_getResourceText = function(name) {
        return Promise.resolve('');
      };
      window.GM_info = {
        script: { version: '0.7.1-test' },
        scriptHandler: 'Tampermonkey',
        version: '5.5.0'
      };
      window.GM_xmlhttpRequest = function() {};
    `;
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
   * Simulates Tampermonkey's per-frame injection.
   * @param {number|string} frameId - Frame index or name.
   * @param {object} [gmOptions] - Passed to injectGMStubs.
   */
  async injectScriptInFrame(frameId, gmOptions = {}) {
    await this.#driver.switchTo().frame(frameId);
    try {
      // GM stubs first.
      const stubSource = readFileSync(join(HERE, "gm-stubs.mjs"), "utf8");
      const initScript = `
        ${stubSource}
        window.__pfGMStorage = ${JSON.stringify(gmOptions.storage || {})};
        window.__pfGMListeners = {};
        window.GM_getValue = function(key, fallback) {
          const s = window.__pfGMStorage;
          return key in s ? s[key] : fallback;
        };
        window.GM_setValue = function(key, value) {
          window.__pfGMStorage[key] = value;
        };
        window.GM_deleteValue = function(key) {
          delete window.__pfGMStorage[key];
        };
        window.GM_registerMenuCommand = function(title, fn) {
          const id = 'menu_' + title;
          window.__pfGMListeners[id] = fn;
          return id;
        };
        window.GM_unregisterMenuCommand = function(id) {
          delete window.__pfGMListeners[id];
        };
        window.GM_addValueChangeListener = function(key, cb) {
          const id = ' listener_' + key + '_' + Date.now();
          window.__pfGMListeners[id] = { key, cb };
          return id;
        };
        window.GM_removeValueChangeListener = function(id) {
          delete window.__pfGMListeners[id];
        };
        window.GM_getResourceText = function(name) {
          return Promise.resolve('');
        };
        window.GM_info = {
          script: { version: '0.7.1-test' },
          scriptHandler: 'Tampermonkey',
          version: '5.5.0'
        };
        window.GM_xmlhttpRequest = function() {};
      `;
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
