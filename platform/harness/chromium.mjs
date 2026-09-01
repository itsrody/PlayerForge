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
      const html = this.#pages.get(path);
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
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
    this.#pages.set(path, html);
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
