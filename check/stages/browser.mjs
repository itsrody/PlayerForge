/**
 * Browser gate - everything the tool verifies about behavior happens here, in
 * a real native Firefox running the real shipping extension.
 *
 * One session per run; one fresh document per case (navigate → the content
 * script boots natively → shell attach), then the case file runs its probes
 * and reports rows. The GM-realm/bundle-eval ceremony is gone with the
 * userscript plane: the browser installs dist/playerforge.xpi itself, so the
 * checked artifact IS the shipping artifact.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import { DEBUG_HASH_TAG } from "../../src/kernel/contract.js";
import { BrowserSession } from "../lib/driver.mjs";
import { FIXTURE_PAGE, FALLBACK_PAGE, VIDEOJS_STUB_PAGE, DPLAYER_STUB_PAGE, SUBS_PAGE, embedHostPage, switchboardPage, ensureVideoAsset } from "../lib/fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "..", "browser", "cases");
const ROOT = join(HERE, "..", "..");

/**
 * Standard ceremony so every case starts from the same known page state:
 * navigate (the content script injects natively at document_start in every
 * frame - no realm to build, no bundle to eval, nothing to wake) and wait
 * for the shell, which proves this page's discovery picked its main video.
 * pagePath may carry a `#hash` fragment (debug mode, e.g. `/check#pf-debug`)
 * - the boot-bust query stays before the fragment.
 */
async function bootCasePage(session, { pagePath, baseUrl }) {
  const at = pagePath.indexOf("#");
  const path = at >= 0 ? pagePath.slice(0, at) : pagePath;
  const hash = at >= 0 ? pagePath.slice(at) : "";
  // A distinct query per boot forces a real document navigation: driver.get
  // to the identical URL can race as a same-URL reload.
  await session.navigate(`${baseUrl}${path}?boot=${Date.now()}${hash}`);
  const shellSeen = await session.waitFor("return !!document.querySelector('.pf-shell');", 9000).then(() => true, () => false);
  if (!shellSeen) {
    const info = await session.eval(function main() { return { ready: document.readyState, shell: document.querySelectorAll(".pf-shell").length, video: !!document.querySelector("video"), errors: (document.documentElement.dataset.plErr ?? "").split("\n").slice(0, 3) }; }).catch((e) => ({ evalError: e.message.slice(0, 100) }));
    throw new Error("shell never attached on " + path + " - " + JSON.stringify(info));
  }
  return { shellHost: true };
}

export async function run() {
  const start = Date.now();
  const rows = [];
  let session = null;
  // Hoisted for the outer catch: the abort row names the live case file.
  let lastCaseFile = null;
  try {
    session = await BrowserSession.launch();
    await session.install();
    const baseUrl = await session.startFixtureServer();
    const videoRoute = ensureVideoAsset();
    session.registerFixture("/check", FIXTURE_PAGE);
    session.registerFixture("/check/blank", FALLBACK_PAGE);
    // Frame lab: embed hosts carry no player themselves - the player lives in
    // the iframe(s). /check (and /sdk/*) are the embeddable playback pages.
    // The hash on the player frame's own source arms that document's debug
    // sentinel (kernel snapshot + storageDump + pfLog mirror) where the frame
    // cases read identity and resume state; the host tops stay stock pages.
    session.registerFixture("/check/frames-so", embedHostPage("/check#pf-debug", "pf same-origin embed"));
    session.registerFixture("/check/frames-cross", embedHostPage(`${session.crossBaseUrl}/check#pf-debug`, "pf cross-origin embed"));
    // Nested: top -> cross-origin mid host -> same-origin (to the mid) embed
    // page. The mid's relative embed src stays on the cross origin, and only
    // reading window.top is cross - exactly the bridge's designed case.
    session.registerFixture("/check/nested-mid", embedHostPage("/check#pf-debug", "pf nested mid"));
    session.registerFixture("/check/frames-nested", embedHostPage(`${session.crossBaseUrl}/check/nested-mid#pf-debug`, "pf nested host"));
    // Walk topology: top -> SAME-origin mid -> cross-origin player. The mid
    // being readable from the top is what lets the ctx route's isOwnFrame
    // deep walk vouch a nested descendant directly - the /check/frames-nested
    // chain (cross mid) deliberately cannot exercise that branch.
    session.registerFixture("/check/frames-walk-mid", embedHostPage(`${session.crossBaseUrl}/sdk/plyr#pf-debug`, "pf walk mid"));
    session.registerFixture("/check/frames-walk", embedHostPage("/check/frames-walk-mid", "pf walk host"));
    // Switchboard: one placeholder iframe whose doc swaps between the SDK
    // stub pages - each registry-adopted by its namespaced anchor classes.
    session.registerFixture("/check/switchboard", switchboardPage(`/sdk/plyr#${DEBUG_HASH_TAG}`));
    session.registerFixture("/sdk/plyr", FIXTURE_PAGE);
    session.registerFixture("/sdk/videojs", VIDEOJS_STUB_PAGE);
    // Letterbox stage: square video element in a taller stage, so object-fit
    // contain puts the 16:9 stream at a KNOWN picture rect the cue anchor
    // math must land on (see cases/subtitles.mjs for the numbers).
    session.registerFixture("/check/subs", SUBS_PAGE);
    session.registerFixture("/sdk/dplayer", DPLAYER_STUB_PAGE);
    session.registerAsset(videoRoute, await readFile(join(ROOT, "check", ".tmp", "check-video.mp4")), "video/mp4");
    session.registerAsset("/check/xhr-ok", Buffer.from("PONG-OK"), "text/plain");
    // Stalls well past the relay timeout window - the server hanging is the
    // precondition for AbortSignal.timeout being a real deadline and not a
    // fast 404.
    session.registerDelayedRoute("/check/xhr-slow", { delayMs: 8000, body: "SLOW", contentType: "text/plain" });
    session.registerAsset("/check/subs-ok.srt", Buffer.from("1\n00:00:01,000 --> 00:00:09,000\nfixture line\n"), "application/x-subrip");

    const stepPage = async (overrides = {}) => bootCasePage(session, {
      pagePath: overrides.pagePath ?? "/check",
      baseUrl
    });

    // CASE=<name> filters to one case file for a single-case diagnosis cycle
    // (CI/harness-only affordance; a full battery run leaves it unset).
    const caseFilter = process.env.CASE ? process.env.CASE.replace(/\.mjs$/, "") : null;
    for (const caseFile of readdirSync(CASES_DIR).filter((f) => f.endsWith(".mjs")).sort()) {
      if (caseFilter && caseFile.replace(/\.mjs$/, "") !== caseFilter) continue;
      lastCaseFile = caseFile;
      const mod = await import(join(CASES_DIR, caseFile));
      let caseRows;
      try {
        caseRows = await mod.run({ session, baseUrl, crossBaseUrl: session.crossBaseUrl, boot: stepPage });
      } catch (err) {
        // Case-local crash naming: the abort row and the stack print carry the
        // live case file so a mid-gate driver timeout names where it landed.
        console.log(`    [${caseFile}] case crashed: ${String(err?.name ?? "?")}: ${String(err?.message ?? err).slice(0, 200)}`);
        throw err;
      }
      // Status honesty: only an explicit "pass" passes. A case returning a
      // boolean or shorthand status (a real failure this once shipped as a
      // false row the aggregator skipped past) reads as fail here, so no
      // future row shape can outrun the gate.
      for (const r of caseRows) {
        r.status = r.status === "pass" ? "pass" : "fail";
      }
      // The error rail's round trip: any uncaught page error / unhandled
      // rejection the document or its frames captured fails the case.
      const rail = await session.errors().catch(() => "");
      if (rail) {
        caseRows.push(...rail.split("\n").slice(0, 3).map((e) => ({ name: `uncaught error in ${caseFile}`, status: "fail", note: e, ms: null })));
      }
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
    // lastCaseFile may itself be unset if the failure predates the loop.
    const at = typeof lastCaseFile === "string" ? lastCaseFile : "<pre-session>";
    const aborted = { name: `browser gate aborted (${at})`, status: "fail", note: `${String(err?.name ?? "?")}: ${String(err?.message ?? err).slice(0, 160)}`, ms: null };
    const captured = await session?.snapshot?.("abort: " + err.message.slice(0, 40));
    if (captured) aborted.note += ` [capture: ${captured}]`;
    rows.push(aborted);
    console.log(`    at: ${String(err.stack ?? "").split("\n").slice(1, 9).join(" ")}`);
    await session?.destroy();
    return { rows, ok: false };
  }
  await session.destroy();
  const failures = rows.filter((r) => r.status === "fail").length;
  return { rows, ok: failures === 0, totalMs: Date.now() - start };
}
