#!/usr/bin/env node
/**
 * Drive a running verification session (see `session.mjs`).
 *
 * Every invocation is a short-lived process: attach to the session's CDP port,
 * do one thing, record it, exit. Browser state stays in the session, so a new
 * question costs one command rather than an edit-and-relaunch cycle.
 *
 * Every command appends to `<scenario>/actions.log`, which is the verbatim
 * driving record a report quotes rather than reconstructs.
 */
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { liveSessions, readSession, isAlive, scenarioDir } from "./session.mjs";

const __filename = fileURLToPath(import.meta.url);

function fail(message) {
  console.error(`x ${message}`);
  process.exit(1);
}

function resolveSession(explicit) {
  if (explicit) {
    const s = readSession(explicit);
    if (!s) fail(`no session: ${explicit} - run: node platform/session.mjs start ${explicit}`);
    if (!isAlive(s)) fail(`session exited: ${explicit} - restart it`);
    return s;
  }
  const live = liveSessions();
  if (live.length === 1) return live[0];
  if (live.length === 0) fail("no live session - run: node platform/session.mjs start <scenario>");
  fail(`multiple sessions live, name one with --scenario: ${live.map((s) => s.scenario).join(", ")}`);
}

/** Minimal request/response CDP client over the browser endpoint. */
class Cdp {
  #socket;
  #next = 1;
  #pending = new Map();

  static async connect(port) {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
    const cdp = new Cdp();
    cdp.#socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.#socket.addEventListener("open", resolve, { once: true });
      cdp.#socket.addEventListener("error", reject, { once: true });
    });
    cdp.#socket.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const waiter = cdp.#pending.get(msg.id);
      if (!waiter) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    });
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.#socket.close();
  }
}

/** Render a CDP evaluation result, surfacing exceptions instead of swallowing them. */
function renderResult(res) {
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error(d.exception?.description ?? d.text);
  }
  const { value, type, description, unserializableValue } = res.result ?? {};
  if (unserializableValue !== undefined) return unserializableValue;
  if (value !== undefined) return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return description ?? type ?? "undefined";
}

/** Evaluate an expression in a target, awaiting promises. */
async function evalIn(cdp, sessionId, expression) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId
  );
  return renderResult(res);
}

/**
 * The current page is tracked by CDP target id, never by index: the manager
 * opens its own install/options pages, so indices shift under you.
 */
const activeFile = (scenario) => path.join(scenarioDir(scenario), ".active");
const readActive = (scenario) => {
  try {
    return JSON.parse(fs.readFileSync(activeFile(scenario), "utf8"));
  } catch {
    return null;
  }
};

async function attachTarget(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  return sessionId;
}

/** Navigable page targets. Background/offscreen documents are excluded on purpose. */
async function listPages(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}

/** The active page, or the first navigable one. Identity, never index: the
 *  manager opens pages of its own, which shifts indices underneath you. */
async function currentPage(cdp, scenario) {
  const pages = await listPages(cdp);
  if (!pages.length) fail("no page target open");
  return pages.find((p) => p.targetId === readActive(scenario)?.targetId) ?? pages[0];
}

async function serviceWorkerSession(cdp) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  if (!sw) fail("no extension service worker target");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  return { sessionId, id: new URL(sw.url).host };
}

const COMMANDS = {
  async goto(cdp, session, [url]) {
    if (!url) fail("goto needs a url");
    const target = await currentPage(cdp, session.scenario);
    const sid = await attachTarget(cdp, target.targetId);
    // Page.navigate, not location.href: script-initiated navigation is refused
    // for privileged schemes (chrome://, chrome-extension://) and silently fails.
    await cdp.send("Page.enable", {}, sid);
    const result = await cdp.send("Page.navigate", { url }, sid);
    if (result.errorText) throw new Error(`navigate failed: ${result.errorText}`);
    fs.writeFileSync(activeFile(session.scenario), JSON.stringify({ targetId: target.targetId, url }));
    return `goto ${url}`;
  },

  async eval(cdp, session, [expr]) {
    if (!expr) fail("eval needs an expression");
    const target = await currentPage(cdp, session.scenario);
    const sid = await attachTarget(cdp, target.targetId);
    fs.writeFileSync(activeFile(session.scenario), JSON.stringify({ targetId: target.targetId, url: target.url }));
    return await evalIn(cdp, sid, expr);
  },

  // Evaluate inside the extension service worker: a channel the driven page
  // does not share. Reading manager state from a content page measures the
  // content page, not the manager.
  async sw(cdp) {
    const { sessionId } = await serviceWorkerSession(cdp);
    return await evalIn(cdp, sessionId, process.argv[process.argv.indexOf("sw") + 1] ?? "1");
  },

  async console(cdp, session, [n = "80"]) {
    const file = path.join(scenarioDir(session.scenario), "console.log");
    if (!fs.existsSync(file)) return "no console output yet";
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    return lines.slice(-Number(n)).join("\n");
  },

  async pages(cdp, session) {
    const pages = await listPages(cdp);
    const active = readActive(session.scenario)?.targetId;
    return pages
      .map((p, i) => `${i === pages.findIndex((q) => q.targetId === active) ? "->" : "  "} [${i}] ${p.type} ${p.url}`)
      .join("\n");
  },

  async use(cdp, session, [index]) {
    const pages = await listPages(cdp);
    const target = pages[Number(index)];
    if (!target) fail(`no page at index ${index}`);
    fs.writeFileSync(activeFile(session.scenario), JSON.stringify({ targetId: target.targetId, url: target.url }));
    return `using [${index}] ${target.url}`;
  },

  async shot(cdp, session, [name = "shot"]) {
    const target = await currentPage(cdp, session.scenario);
    const sid = await attachTarget(cdp, target.targetId);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, sid);
    const dir = path.join(scenarioDir(session.scenario), "shots");
    fs.mkdirSync(dir, { recursive: true });
    // Numbered in capture order so a series reads chronologically.
    const seq = String(fs.readdirSync(dir).filter((f) => f.endsWith(".png")).length + 1).padStart(3, "0");
    const file = path.join(dir, `${seq}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  },

  /**
   * Evaluate inside an extension page.
   *
   * `chrome.runtime.sendMessage` issued from the service worker never reaches
   * the extension, so anything the extension must act on has to run from an
   * extension page instead. The manager's own pages are shadow-iframed, which
   * is why driving the install UI by selector is unreliable.
   */
  async xeval(cdp, _session, [expr]) {
    const { id } = await serviceWorkerSession(cdp);
    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page" && t.url.startsWith(`chrome-extension://${id}/`));
    if (!page) fail("no extension page open; navigate one first");
    const sid = await attachTarget(cdp, page.targetId);
    return await evalIn(cdp, sid, expr);
  },

  /** Install a userscript through the manager's own message API. */
  async install(cdp, _session, [file]) {
    if (!file) fail("install needs a .user.js path");
    const code = fs.readFileSync(path.resolve(file), "utf8");
    // Inlined as a JSON literal: the payload is a whole bundle, so passing it
    // as an evaluate() argument would mean transporting it twice.
    const result = await COMMANDS.xeval(cdp, null, [
      `chrome.runtime.sendMessage({
         action: "serviceWorker/script/installByCode",
         data: { uuid: crypto.randomUUID(), code: ${JSON.stringify(code)}, upsertBy: "user" }
       })`
    ]);
    return `installed ${path.basename(file)}: ${result}`;
  },

  async extid(cdp) {
    return (await serviceWorkerSession(cdp)).id;
  },
};

const USAGE = [
  "usage: node platform/drive.mjs [--scenario <name>] <command> [args]",
  "",
  "  goto <url>       navigate the current page",
  "  eval <js>        run an expression in the current page (await works)",
  "  sw <js>          run inside the extension service worker",
  "  extid            print the extension id",
  "  pages            list page targets (-> marks current)",
  "  use <i>          make page <i> current",
  "  console [n]      last n recorded lines, across all contexts",
  "  shot [name]      screenshot into <scenario>/shots/",
].join("\n");

const argv = process.argv.slice(2);
let explicitScenario;
const positional = [];
// Hand-rolled so the `sw` expression (which may itself start with --) survives.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--scenario") {
    explicitScenario = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}
const [command, ...args] = positional;

if (!command || command === "help" || command === "--help") {
  console.log(USAGE);
  process.exit(0);
}

const session = resolveSession(explicitScenario);
const handler = COMMANDS[command];
if (!handler) fail(`unknown command: ${command}\n${USAGE}`);

const cdp = await Cdp.connect(session.port);
try {
  const output = await handler(cdp, session, args);
  fs.appendFileSync(
    path.join(scenarioDir(session.scenario), "actions.log"),
    `${new Date().toISOString()} ${command} ${args.join(" ")}\n${output}\n\n`
  );
  console.log(output);
} finally {
  cdp.close();
}
