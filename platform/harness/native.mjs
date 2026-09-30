/**
 * Native userScripts harness support.
 *
 * The integration suite has to run the userscript the way the shipping manager
 * does: inside Firefox's isolated `userScript` realm, with the manager's GM
 * semantics, reached through `browser.userScripts`. Injecting the bundle with
 * WebDriver's `executeScript` cannot do that - it always runs in the page
 * world - so the harness installs a temporary add-on instead and drives it.
 *
 * Two pieces live here:
 *   ControlServer  a long-poll command channel the add-on connects back to
 *   buildExtension packs native-extension/ into a temporary .xpi
 */
import { createServer as createHttpServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip } from "./xpi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, "native-extension");

/** How long a long-poll is held before the add-on re-asks. */
const POLL_TIMEOUT_MS = 30_000;

/**
 * Long-poll command channel.
 *
 * Each waiting add-on gets one `GET /next` request that the server holds open
 * until a command is dispatched, so the add-on is never spinning. Results come
 * back on `POST /result` keyed by command id.
 */
export class ControlServer {
  #server = null;
  #port = 0;
  #nextId = 0;
  #waiters = [];
  #queue = [];
  #results = new Map();
  #diagnostics = new Set();
  #realmLog = [];
  #bundle = "";
  #storage = {};

  get port() {
    return this.#port;
  }

  async start() {
    this.#server = createHttpServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", resolve);
    });
    this.#port = this.#server.address().port;
    return this;
  }

  #handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/probe-page") {
      // Throws away one navigation so a fresh session can prove the startup
      // registration reached the content process before a test relies on it.
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<!DOCTYPE html><title>harness probe</title><body>probe</body>");
      return;
    }

    if (req.method === "GET" && url.pathname === "/bootstrap") {
      // One round trip for everything the add-on needs before it registers,
      // so startup cannot half-succeed on a missing piece.
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ bundle: this.#bundle, storage: this.#storage }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/next") {
      // A command dispatched before the add-on connected is delivered straight
      // away, so ordering is preserved and nothing waits a full poll cycle.
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(queued));
        return;
      }
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
        res.writeHead(204).end();
      }, POLL_TIMEOUT_MS);
      this.#waiters.push({ res, timer });
      res.on("close", () => {
        clearTimeout(timer);
        this.#waiters = this.#waiters.filter((w) => w.timer !== timer);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(204).end();
        try {
          const payload = JSON.parse(body);
          const settle = this.#results.get(payload.id);
          if (settle) {
            this.#results.delete(payload.id);
            settle(payload);
          }
        } catch {
          // A malformed result must not wedge the harness; the command's
          // timeout below is the backstop.
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/diagnostic") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.writeHead(204).end();
        let payload;
        try { payload = JSON.parse(body); } catch { return; }
        if (payload && payload.ev === "realm" && payload.stage === "after-load") {
          this.#realmLog.push({ index: this.#realmLog.length, payload });
          if (this.#realmLog.length > 64) {
            this.#realmLog.shift();
          }
        }
        for (const listener of this.#diagnostics) {
          try { listener(payload); } catch { /* ignore */ }
        }
      });
      return;
    }

    res.writeHead(404).end();
  }

  /**
   * The bundle the extension registers at startup.
   *
   * Set before the add-on is installed, so the extension's first fetch always
   * finds it and registration needs no retry.
   *
   * @param {string} source
   */
  setBundle(source, storage = {}) {
    this.#bundle = source;
    this.#storage = storage;
  }

  /**
   * How many realm reports have arrived so far.
   *
   * A driver marks this before navigating and waits for a report past the mark,
   * which is what ties "the script ran" to the document it is asking about
   * rather than to a report still in flight from the previous one.
   */
  diagnosticCount() {
    return this.#realmLog.length;
  }

  /**
   * Wait for a realm report newer than `mark`.
   *
   * @param {number} mark - Value from diagnosticCount() before navigating.
   * @param {number} [timeoutMs=10000]
   */
  async waitForRealm(mark, timeoutMs = 10000) {
    // mark is a count of entries already seen, and indexes are 0-based, so the
    // first report that counts is the one at index === mark.
    const already = this.#realmLog.some((entry) => entry.index >= mark);
    if (already) {
      return;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (this.#realmLog.some((entry) => entry.index >= mark)) {
        return;
      }
      if (Date.now() > deadline) {
        // Whatever the realm did manage to say is the difference between "the
        // script never ran" and "the script ran and the kernel threw".
        const seen = this.#realmLog.slice(-4).map((e) => JSON.stringify(e.payload));
        throw new Error(
          "the userscript never reported in; the add-on registered it at " +
          `startup but the content process did not run it. Recent: ${seen.join(" | ") || "none"}`
        );
      }
    }
  }

  /**
   * Observe diagnostics reported from inside the userScript realm.
   * @param {(payload: object) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  onDiagnostic(listener) {
    this.#diagnostics.add(listener);
    return () => this.#diagnostics.delete(listener);
  }

  /**
   * Dispatch a command and wait for the add-on's result.
   *
   * @param {object} payload - Command body, without an id.
   * @param {number} [timeoutMs=15000]
   * @returns {Promise<object>} The add-on's result payload.
   */
  send(payload, timeoutMs = 15_000) {
    const id = ++this.#nextId;
    const command = { id, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#results.delete(id);
        reject(new Error(
          `native harness command "${payload.op}" timed out after ${timeoutMs}ms ` +
          `(is the add-on installed?)`
        ));
      }, timeoutMs);
      this.#results.set(id, (result) => {
        clearTimeout(timer);
        if (result.ok === false) {
          reject(new Error(`native harness command "${payload.op}" failed: ${result.error}`));
          return;
        }
        resolve(result);
      });

      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        // Nothing is connected yet; the add-on takes it on its next poll.
        this.#queue.push(command);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(command));
    });
  }

  async stop() {
    if (this.#server === null) return;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.res.writeHead(204).end();
    }
    this.#waiters = [];
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push({ name: relative(EXTENSION_DIR, full).split("\\").join("/"), full });
    }
  }
  return out;
}

/**
 * Pack native-extension/ into .xpi bytes.
 *
 * The control port is substituted into the background script at pack time, so
 * each session gets its own ephemeral port and concurrent sessions cannot
 * collide on a fixed one.
 *
 * @param {number} port - Control port for this session.
 * @returns {Buffer} The .xpi bytes.
 */
export function buildExtension(port) {
  const files = walk(EXTENSION_DIR).map(({ name, full }) => {
    let data = readFileSync(full);
    if (name === "content/background.js" || name === "content/api.js") {
      data = Buffer.from(
        data.toString("utf8").replace("__PF_CONTROL_PORT__", String(port)),
        "utf8"
      );
    }
    return { name, data };
  });
  return buildZip(files);
}
