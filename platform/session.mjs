#!/usr/bin/env node
/**
 * Lifecycle for a long-lived verification browser.
 *
 * Answering a new question costs one `drive.mjs` command instead of editing a
 * script and re-running the whole setup. That is the entire point: the earlier
 * throwaway-script-per-question approach meant every question re-did the launch,
 * the userScripts grant, and the install, and a crash lost all of it.
 *
 * Headless by default - verification must not steal desktop focus, and several
 * worktrees verify at once. `--headed` exists only to watch by eye.
 *
 * The CDP port is requested from the kernel (`listen(0)`) rather than hardcoded:
 * it is the one globally contended resource, and `drive.mjs` needs it to attach.
 *
 * Modelled on ScriptCat's `e2e/session.mjs`; see `docs/platform-harness.md` for
 * what differs and why.
 */
import process from "node:process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PLATFORM_DIR = path.dirname(__filename);
const HARNESS_DIR = path.join(PLATFORM_DIR, "harness");
const SCRATCH_DIR = path.join(PLATFORM_DIR, "scratch");

const SESSION_FILE = ".session.json";
const LOCK_FILE = ".session.lock";
const CONSOLE_LOG = "console.log";
const DAEMON_LOG = "daemon.log";

const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateScenario(scenario) {
  if (typeof scenario !== "string" || !SCENARIO_PATTERN.test(scenario)) {
    throw new Error(`scenario must be a single-level name (letters, digits, dot, underscore, hyphen): ${scenario}`);
  }
  return scenario;
}

export function scenarioDir(scenario) {
  return path.join(SCRATCH_DIR, validateScenario(scenario));
}

const sessionFile = (s) => path.join(scenarioDir(s), SESSION_FILE);
const lockFile = (s) => path.join(scenarioDir(s), LOCK_FILE);

export function readSession(scenario) {
  try {
    // A half-written session file is equivalent to no session.
    return JSON.parse(fs.readFileSync(sessionFile(scenario), "utf8"));
  } catch {
    return null;
  }
}

export function isAlive(session) {
  if (!session?.pid) return false;
  try {
    process.kill(session.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function liveSessions() {
  if (!fs.existsSync(SCRATCH_DIR)) return [];
  return fs
    .readdirSync(SCRATCH_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SCENARIO_PATTERN.test(e.name))
    .map((e) => readSession(e.name))
    .filter((s) => s && isAlive(s));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Prevent two sessions starting the same scenario concurrently. A lock left by a
 * dead process is reclaimed; a live one is a hard error.
 */
function acquireLock(scenario) {
  const token = randomUUID();
  const file = lockFile(scenario);
  fs.mkdirSync(scenarioDir(scenario), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token })}\n`);
      fs.closeSync(fd);
      return token;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJson(file);
      if (existing?.pid && isAlive(existing)) throw new Error(`session already starting: ${scenario}`);
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * Only ever delete a profile this harness made. A caller-supplied directory that
 * merely happens to sit in tmpdir must survive `stop`.
 */
function isManagedProfile(profile) {
  if (typeof profile !== "string") return false;
  const resolved = path.resolve(profile);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("pf-verify-");
}

function removeSessionArtifacts(scenario, session) {
  fs.rmSync(sessionFile(scenario), { force: true });
  if (isManagedProfile(session?.profile)) fs.rmSync(session.profile, { recursive: true, force: true });
}

/**
 * Static file server for a scenario, rooted at `<scenario>/public`.
 *
 * The session needs real HTTP pages: `data:` URLs cannot host a userscript
 * target (Chrome refuses the top-frame navigation), and CSP behaviour is only
 * observable from a response that actually carries the header. Keeping it to a
 * scenario-local directory is what stops one session from reading another's
 * fixtures.
 *
 * @returns {Promise<{url: string, close: () => void}>}
 */
export async function startScenarioServer(scenario) {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const root = path.join(scenarioDir(scenario), "public");

  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8"
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      // Contain the served tree: reject anything that escapes public/.
      const file = path.resolve(root, rel);
      if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root, "index.html")) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** Ask the kernel for a free port rather than hardcoding one. */
export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * The daemon body: holds the browser until SIGTERM.
 *
 * The driver import is deferred to here on purpose. selenium-webdriver is a
 * process-level singleton; importing it at module scope would break the pure
 * helpers above being imported by a test in the same process.
 */
async function serve(scenario, { headed, lockToken, extensions }) {
  // Imported by absolute path: this module sits one level above the harness,
  // so a relative specifier would resolve to platform/ instead of platform/harness/.
  const harness = (name) => import(pathToFileURL(path.join(HARNESS_DIR, name)).href);
  const { ChromiumDriver } = await harness("chromium.mjs");
  const { grantedUserScriptsProfile } = await harness("profile.mjs");
  const { attachConsoleCollector } = await harness("console-collector.mjs");

  const dir = scenarioDir(scenario);
  fs.mkdirSync(dir, { recursive: true });
  const appendConsole = (line) => fs.appendFileSync(path.join(dir, CONSOLE_LOG), `${new Date().toISOString()} ${line}\n`);

  let profile;
  let driver;
  let collector;
  let siteServer;
  let session;
  let closing = false;

  const shutdown = async () => {
    if (closing) return;
    closing = true;
    appendConsole("[session] stopping");
    fs.rmSync(sessionFile(scenario), { force: true });
    try {
      collector?.close();
      siteServer?.close();
      await driver?.destroy();
    } catch {
      // The browser may already be gone.
    }
    removeSessionArtifacts(scenario, session);
    fs.rmSync(lockFile(scenario), { force: true });
    process.exit(0);
  };

  try {
    const site = await startScenarioServer(scenario);
    siteServer = site;
    appendConsole(`[session] serving ${site.url} from <scenario>/public`);

    // The grant lives in a profile, so it is paid once and survives navigation,
    // reinstalls and every later command in this session.
    profile = extensions.length > 0 ? await grantedUserScriptsProfile({ extensions, headless: !headed }) : null;

    // Two different ports, and conflating them is the trap here: Selenium's
    // `port` is the ChromeDriver control port, while the console collector and
    // drive.mjs both speak raw CDP and need Chrome's own DevTools endpoint.
    const driverPort = await freePort();
    const cdpPort = await freePort();
    driver = await ChromiumDriver.launch({
      headless: !headed,
      port: driverPort,
      extensions,
      // Expose Chrome's DevTools endpoint so CDP clients have something to
      // attach to; ChromeDriver's port does not speak CDP.
      extraArgs: [`--remote-debugging-port=${cdpPort}`],
      ...(profile ? { profileDir: profile } : {})
    });

    appendConsole(`[session] started pid=${process.pid} cdp=${cdpPort} driver=${driverPort} profile=${profile ?? "ephemeral"}`);
    collector = await attachConsoleCollector(cdpPort, appendConsole);

    session = {
      scenario,
      pid: process.pid,
      port: cdpPort,
      driverPort,
      siteUrl: site.url,
      profile: profile ?? driver.profileDir,
      startedAt: Date.now()
    };
    fs.writeFileSync(sessionFile(scenario), `${JSON.stringify(session, null, 2)}\n`);

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // Hold the process open for the life of the browser.
    await new Promise(() => {});
  } catch (error) {
    fs.appendFileSync(path.join(dir, DAEMON_LOG), `${error?.stack ?? error}\n`);
    try {
      collector?.close();
      siteServer?.close();
      await driver?.destroy();
    } catch {
      /* best effort */
    }
    removeSessionArtifacts(scenario, session);
    fs.rmSync(lockFile(scenario), { force: true });
    throw error;
  }
}

/** Start a session and wait until it is usable. */
export async function start(scenario, { headed = false, extensions = [] } = {}) {
  validateScenario(scenario);
  const lockToken = acquireLock(scenario);
  const dir = scenarioDir(scenario);
  fs.mkdirSync(dir, { recursive: true });

  // Reuse this module as its own daemon: the parent waits on the child.
  const child = process.execPath;
  const args = [__filename, "__serve", scenario, headed ? "--headed" : "--headless", `--token=${lockToken}`];
  if (extensions.length > 0) args.push(`--extensions=${extensions.join(",")}`);

  const { spawn } = await import("node:child_process");
  const log = fs.openSync(path.join(dir, DAEMON_LOG), "a");
  const child_ = spawn(child, args, { detached: true, stdio: ["ignore", log, log] });
  child_.unref();

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const s = readSession(scenario);
    if (s && isAlive(s)) return s;
    if (!isAlive({ pid: child_.pid })) {
      const why = fs.existsSync(path.join(dir, DAEMON_LOG))
        ? fs.readFileSync(path.join(dir, DAEMON_LOG), "utf8").trim().split("\n").slice(-4).join("\n")
        : "no daemon log";
      throw new Error(`session failed to start:\n${why}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("session did not become ready within 90s");
}

export function stop(scenario) {
  const s = readSession(scenario);
  if (s && isAlive(s)) {
    try {
      process.kill(s.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  removeSessionArtifacts(scenario, s);
  fs.rmSync(lockFile(scenario), { force: true });
}

export function status() {
  return liveSessions().map((s) => ({ scenario: s.scenario, pid: s.pid, port: s.port, profile: s.profile }));
}

export function usage() {
  return [
    "usage:",
    "  node platform/session.mjs start <scenario> [--headed] [--extensions=<dir[,dir]>]",
    "  node platform/session.mjs status [<scenario>]",
    "  node platform/session.mjs stop <scenario> | --all",
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "__serve") {
    const scenario = rest[0];
    const headed = rest.includes("--headed");
    const extArg = rest.find((a) => a.startsWith("--extensions="));
    const token = rest.find((a) => a.startsWith("--token="))?.slice("--token=".length);
    await serve(scenario, {
      headed,
      lockToken: token,
      extensions: extArg ? extArg.slice("--extensions=".length).split(",").filter(Boolean) : []
    });
  } else if (cmd === "start") {
    const scenario = rest.find((a) => !a.startsWith("-"));
    const extArg = rest.find((a) => a.startsWith("--extensions="));
    const extensions = extArg ? extArg.slice("--extensions=".length).split(",").filter(Boolean) : [];
    if (!scenario) {
      console.error(usage());
      process.exit(1);
    }
    const s = await start(scenario, { headed: rest.includes("--headed"), extensions });
    console.log(`session ${s.scenario} ready (pid ${s.pid}, port ${s.port})`);
  } else if (cmd === "status") {
    const live = status();
    console.log(live.length ? JSON.stringify(live, null, 2) : "no live sessions");
  } else if (cmd === "stop") {
    if (rest.includes("--all") || rest[0] === "--all") {
      for (const s of liveSessions()) stop(s.scenario);
      console.log("stopped all");
    } else if (rest[0]) {
      stop(rest[0]);
      console.log(`stopped ${rest[0]}`);
    } else {
      console.error(usage());
      process.exit(1);
    }
  } else {
    console.log(usage());
  }
}
