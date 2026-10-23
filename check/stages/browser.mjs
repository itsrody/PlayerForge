/**
 * Browser gate - everything the tool verifies about behavior happens here, in
 * a real Firefox (playwright-pinned build) with the real bundle.
 *
 * One session per run; one fresh document per case (navigate → GM realm →
 * inject bundle → wake videos), then the case file runs its probes in-page
 * and reports rows. A case is a function receiving { session, baseUrl } and
 * returning rows; the stage only owns the boot ceremony and bookkeeping.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import { BrowserSession } from "../lib/driver.mjs";
import { FIXTURE_PAGE, FALLBACK_PAGE, VIDEOJS_STUB_PAGE, DPLAYER_STUB_PAGE, embedHostPage, switchboardPage, ensureVideoAsset } from "../lib/fixture.mjs";
import { parseUserScriptHeader } from "../lib/gm-realm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "..", "browser", "cases");
const ROOT = join(HERE, "..", "..");

/** Standard ceremony so every case starts from the same known page state. */
async function bootCasePage(session, { pagePath, baseUrl, version, bundle, seed = {}, persist = false, grants = null, resources = null, header = null }) {
  // A distinct query per boot forces a real document navigation: driver.get to
  // the identical URL can race as a same-URL reload and eat the injected
  // bundle mid-document.
  if (persist) {
    await session.harvestGm();
  }
  await session.navigate(`${baseUrl}${pagePath}?boot=${Date.now()}`);
  await session.injectGMRealm({ version, storage: persist ? session.gmHeadSnapshot() : seed, grants, resources, header });
  await session.injectBundle(bundle);
  await session.wakeVideos();
  const shellSeen = await session.waitFor("return !!document.querySelector('.pf-shell');", 9000).then(() => true, () => false);
  if (!shellSeen) {
    const info = await session.eval(function main() { return { ready: document.readyState, shell: document.querySelectorAll(".pf-shell").length, video: !!document.querySelector("video"), pf: typeof window.PlayerForge, err: window.__lastInjectError ?? null }; }).catch((e) => ({ evalError: e.message.slice(0, 100) }));
    throw new Error("shell never attached on " + pagePath + " - " + JSON.stringify(info));
  }
  return { shellHost: true };
}

async function bundleSource() {
  const path = join(ROOT, "dist", "playerforge.user.js");
  if (!existsSync(path)) {
    throw new Error("dist/playerforge.user.js missing - run the bundle gate first");
  }
  return readFile(path, "utf8");
}

async function fixtureVersion() {
  const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  return packageJson.version;
}

export async function run() {
  const start = Date.now();
  const rows = [];
  let session = null;
  try {
    session = await BrowserSession.launch();
    const baseUrl = await session.startFixtureServer();
    const videoRoute = ensureVideoAsset();
    session.registerFixture("/check", FIXTURE_PAGE);
    session.registerFixture("/check/blank", FALLBACK_PAGE);
    // Frame lab: embed hosts carry no player themselves - the player lives in
    // the iframe(s). /check (and /sdk/*) are the embeddable playback pages.
    session.registerFixture("/check/frames-so", embedHostPage("/check", "pf same-origin embed"));
    session.registerFixture("/check/frames-cross", embedHostPage(`${session.crossBaseUrl}/check`, "pf cross-origin embed"));
    // Nested: top -> cross-origin mid host -> same-origin (to the mid) embed
    // page. The mid's relative embed src stays on the cross origin, and only
    // reading window.top is cross - exactly the bridge's designed case.
    session.registerFixture("/check/nested-mid", embedHostPage("/check", "pf nested mid"));
    session.registerFixture("/check/frames-nested", embedHostPage(`${session.crossBaseUrl}/check/nested-mid`, "pf nested host"));
    // Switchboard: one placeholder iframe whose doc swaps between the SDK
    // stub pages - each registry-adopted by its namespaced anchor classes.
    session.registerFixture("/check/switchboard", switchboardPage("/sdk/plyr#pf-debug"));
    session.registerFixture("/sdk/plyr", FIXTURE_PAGE);
    session.registerFixture("/sdk/videojs", VIDEOJS_STUB_PAGE);
    session.registerFixture("/sdk/dplayer", DPLAYER_STUB_PAGE);
    session.registerAsset(videoRoute, await readFile(join(ROOT, "check", ".tmp", "check-video.mp4")), "video/mp4");
    session.registerAsset("/check/xhr-ok", Buffer.from("PONG-OK"), "text/plain");
    // Stalls well past the probe's timeout window - the server hanging is the
    // precondition for ontimeout being a real deadline and not a fast 404.
    session.registerDelayedRoute("/check/xhr-slow", { delayMs: 8000, body: "SLOW", contentType: "text/plain" });

    const bundle = await bundleSource();
    const version = await fixtureVersion();
    const header = parseUserScriptHeader(bundle);
    // @resource pfStyle -> the shipped css plus one marker rule: the kernel's
    // resource-warm replaces the embedded css only when the resource differs,
    // so the marker must be there before the first boot of every case.
    let styleSource = "";
    try {
      styleSource = await readFile(join(ROOT, "dist", "playerforge.css"), "utf8");
    } catch {}
    const resources = { pfStyle: styleSource + "\n.pf-shell{--pf-check-probe:ok}\n" };
    const stepPage = (overrides = {}) => bootCasePage(session, {
      pagePath: overrides.pagePath ?? "/check",
      baseUrl,
      version,
      bundle,
      seed: overrides.seed ?? {},
      persist: overrides.persist ?? false,
      grants: header.grants,
      resources,
      header
    });

    for (const caseFile of readdirSync(CASES_DIR).filter((f) => f.endsWith(".mjs")).sort()) {
      const mod = await import(join(CASES_DIR, caseFile));
      const caseRows = await mod.run({ session, baseUrl, crossBaseUrl: session.crossBaseUrl, bundle, boot: stepPage, header, version, resources });
      // Uncaught page errors from this case's document realm fail the case
      // silently bypassing every row's own assertions.
      const pageErrors = await session.eval(function main() {
        return [...(window.__pfErrors ?? []), ...(window.__pfConsole ?? []).map((m) => "console: " + m)];
      }).catch(() => []);
      const realErrors = pageErrors.filter((e) => !e.startsWith("console:"));
      const consoleErrors = pageErrors.filter((e) => e.startsWith("console:"));
      caseRows.push(...realErrors.map((e) => ({ name: `uncaught error in ${caseFile}`, status: "fail", note: e, ms: null })));
      caseRows.push(...consoleErrors.slice(0, 2).map((e) => ({ name: `console.error in ${caseFile}`, status: "pass", note: e, ms: null })));
      // GM surface census: which APIs the kernel actually called (and how
      // many echo deliveries landed) from this case - informational.
      const usage = await session.eval(function main() {
        return window.__gmTest ? JSON.stringify(window.__gmTest.usage()) : null;
      }).catch(() => null);
      caseRows.push({ name: `GM usage audit ${caseFile}`, status: usage ? "pass" : "fail", note: usage ?? "realm missing", ms: null });
      // Forensics for every failing case before the session is torn down.
      if (caseRows.some((r) => r.status === "fail")) {
        const captured = await session.snapshot(caseFile);
        for (const r of caseRows.filter((x) => x.status === "fail")) {
          if (captured) r.note = `${r.note ? r.note + " " : ""}[capture: ${captured}]`;
        }
      }
      rows.push(...caseRows);
      for (const r of caseRows.filter((x) => x.status === "fail")) {
        console.log(`    [${caseFile}] ${r.name}${r.note ? " — " + r.note : ""}`);
      }
    }
  } catch (err) {
    const aborted = { name: "browser gate aborted", status: "fail", note: err.message.slice(0, 160), ms: null };
    const captured = await session?.snapshot?.("abort: " + err.message.slice(0, 40));
    if (captured) aborted.note += ` [capture: ${captured}]`;
    rows.push(aborted);
    console.log(`    stack: ${String(err.stack ?? "").split("\n").slice(1, 5).join(" ")}`);
    await session?.destroy();
    return { rows, ok: false };
  }
  await session.destroy();
  const failures = rows.filter((r) => r.status === "fail").length;
  return { rows, ok: failures === 0, totalMs: Date.now() - start };
}
