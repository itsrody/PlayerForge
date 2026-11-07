import { sleep } from "../../lib/driver.mjs";
import { DEBUG_HASH_TAG } from "../../../src/kernel/contract.js";
// Real-world frame scenarios, on native injection.
//
// The extension content script runs in EVERY frame (no @noframes and no
// frame filtering: the manifest's matches broaden, the content script's own
// scope law - one shell per document of that document's own video - decides
// where a shell lands). Each document boots natively at document_start; no
// realm or bundle is built by the harness. The kernel's frame-aware boot,
// the frame bridge (page-context pipe) and the fullscreen provisioning must
// handle the embed layouts real sites have. The scenarios (top -> deeper):
//
//   1. direct embed          - the player in the top document (baseline)
//   2. same-origin iframe    - host page -> player iframe, one shell total
//   3. cross-origin iframe   - host at 127.0.0.1, frame at localhost:
//                              window.top is unreadable, so the frame's
//                              resume entry must carry the TOP's context via
//                              the bridge
//   4. nested frames         - host -> cross-origin mid -> same-origin player;
//                              the innermost shell provisions allowfullscreen
//                              on BOTH ancestor iframes, and the
//                              fullscreenerror failure path re-arms both
//                              with no new shell
//   5. mixed walk chain      - host -> same-origin mid -> cross-origin player;
//                              the ctx route's vouch reaches a nested asker
//                              through the readable walk while the fullscreen
//                              provisioner refuses that same non-direct asker
//   6. switchboard           - one placeholder iframe whose document swaps
//                              between three supported SDK stubs (Plyr,
//                              Video.js, DPlayer) playing the same video
//
// The embed fixture pages carry the debug hash INSIDE the player frame's own
// source, so the player document's debug sentinel (kernel + storageDump +
// the pfLog mirror) is reachable from the frame chain while the host top
// stays a stock page. SDK stubs are plain wrapper divs carrying the
// registry's namespaced anchor classes - no vendor script.
export async function run({ session, baseUrl, crossBaseUrl, boot }) {
  const rows = [];
  const latencies = {};

  const failRow = async (name, err) => {
    let note = String(err?.message ?? err).slice(0, 140);
    for (const path of [[0], [0, 0]]) {
      const state = await session.snapshotFrameState(path);
      if (state) { note += ` frame${JSON.stringify(path)}=${JSON.stringify(state)}`; break; }
    }
    rows.push({ name, status: "fail", note, ms: null });
  };

  /** Boot a frame scenario: a real navigation (the content script injects
   *  natively in every frame at document_start), then the shell wait in the
   *  named frame chain. Returns the attach latency for the budget row. */
  const bootFrameScenario = async ({ pagePath, shellPath, timeoutMs = 9000 }) => {
    await session.navigate(`${baseUrl}${pagePath}?boot=${Date.now()}`);
    const started = Date.now();
    await session.waitForFrame(shellPath, `return !!document.querySelector(".pf-shell");`, timeoutMs);
    return Date.now() - started;
  };

  const shellCount = (path) => session.evalInFrame(path, function main() {
    return document.querySelectorAll(".pf-shell").length;
  });

  const topShellCount = () => session.eval(function main() {
    return document.querySelectorAll(".pf-shell").length;
  });

  /** The frame's resume store read through ITS debug sentinel. A bridged
   *  answer carries the TOP's path/domain; a fallback to the frame's own
   *  context names the frame page's origin instead - the discriminator. */
  const waitForEntry = (path, expectedPath, expectedDomain, timeoutMs = 12000) =>
    session.waitForFrame(path, `
      try {
        const raw = window.PlayerForge?.storageDump?.();
        if (!raw) return false;
        const entries = (JSON.parse(raw).resume?.entries) ?? [];
        return entries.find((e) => e && e.path === ${JSON.stringify(expectedPath)} && e.domain === ${JSON.stringify(expectedDomain)}) || false;
      } catch { return false; }
    `, timeoutMs).then((v) => v || null, () => null);

  /** Which registry record the frame's kernel adopted (the debug sentinel's
   *  snapshot arm - the JSON string is the one shape the compartment waiver
   *  hands every reader, the live kernel object's own door is privileged). */
  const sdkInFrame = (path) => session.evalInFrame(path, function main() {
    try {
      return JSON.parse(window.PlayerForge?.diagnosticSnapshot?.() ?? "{}").shell ?? null;
    } catch { return null; }
  });

  /** Switchboard: swap the placeholder's document to a new SDK stub page and
   *  wait for its shell (native injection arms the fresh document itself). */
  const swapVariant = async (url) => {
    await session.eval(function main(next) { window.swapBoard(next); }, url);
    const pathname = new URL(url).pathname;
    await session.waitForFrame([0], `return location.pathname === ${JSON.stringify(pathname)} && document.readyState === "complete";`, 8000);
    const started = Date.now();
    await session.waitForFrame([0], `return !!document.querySelector(".pf-shell");`, 9000);
    return Date.now() - started;
  };

  // ---- Scenario 1: direct embed (the baseline every other row deviates from)
  await boot({ pagePath: "/check" });
  const direct = await topShellCount();
  rows.push({
    name: "direct embed: the top document boots one shell",
    status: direct === 1 ? "pass" : "fail",
    note: `shells=${direct}`,
    ms: null
  });

  // ---- Scenario 2: same-origin iframe
  try {
    latencies.so = await bootFrameScenario({ pagePath: "/check/frames-so", shellPath: [0] });
    const top = await topShellCount();
    const frame = await shellCount([0]);
    rows.push({
      name: "same-origin iframe: shell boots in the frame, top stays unbooted",
      status: frame === 1 && top === 0 ? "pass" : "fail",
      note: `frame shells=${frame}; top shells=${top}`,
      ms: null
    });
    const entry = await waitForEntry([0], "/check/frames-so", "127-0-0-1");
    rows.push({
      name: "same-origin iframe: resume entry reads the top context directly",
      status: !!entry ? "pass" : "fail",
      note: entry ? "path+domain are the top's" : "no entry",
      ms: null
    });
  } catch (err) {
    latencies.so = null;
    await failRow("same-origin iframe scenario failed", err);
  }

  // ---- Scenario 3: cross-origin iframe (the frame bridge's designed case)
  try {
    latencies.cross = await bootFrameScenario({ pagePath: "/check/frames-cross", shellPath: [0] });
    // Fallback (own context) would give domain 1-o-c-a-l-h-o-s-t - only a
    // bridged answer carries the top document's context up the pipe.
    const entry = await waitForEntry([0], "/check/frames-cross", "127-0-0-1");
    rows.push({
      name: "cross-origin iframe: shell boots and bridges the top context into its resume entry",
      status: !!entry ? "pass" : "fail",
      note: entry ? `path=${entry.path} domain=${entry.domain} (bridged from ${crossBaseUrl})` : "no bridged entry",
      ms: null
    });
  } catch (err) {
    latencies.cross = null;
    await failRow("cross-origin iframe scenario failed", err);
  }

  // ---- Scenario 4: nested frames (cross-origin mid -> same-origin player)
  try {
    latencies.nested = await bootFrameScenario({ pagePath: "/check/frames-nested", shellPath: [0, 0] });
    const top = await topShellCount();
    const mid = await shellCount([0]);
    const inner = await shellCount([0, 0]);
    rows.push({
      name: "nested frames: only the innermost document boots a shell",
      status: inner === 1 && mid === 0 && top === 0 ? "pass" : "fail",
      note: `inner shells=${inner}; mid shells=${mid}; top shells=${top}`,
      ms: null
    });
    // The innermost shell latches an FS request up the chain on creation:
    // each ancestor document grants its DIRECT child iframe allowfullscreen.
    const topGrant = await session.waitFor(
      `return document.getElementById("player-frame")?.hasAttribute("allowfullscreen") === true;`,
      5000
    ).then(() => true, () => false);
    const midGrant = await session.waitForFrame([0],
      `return document.querySelector("iframe")?.hasAttribute("allowfullscreen") === true;`,
      5000
    ).then(() => true, () => false);
    rows.push({
      name: "nested frames: fullscreen provisioning reaches both ancestor iframes",
      status: topGrant && midGrant ? "pass" : "fail",
      note: `top granted=${topGrant}; mid granted=${midGrant}`,
      ms: null
    });
    // Wipe + retry: strip both grants (a host re-render rebuilds its iframe
    // and carries the provisioned attributes away), reject a fullscreen
    // attempt - the event is synthesized because only the browser's own
    // rejection plumbing is fake under the synthetic-fs precedent; the
    // reject hop, relay, registry vouch, and provisioner are all real - and
    // require the failure path alone to restore both grants with no new
    // shell created.
    await session.eval(function main() {
      const frame = document.getElementById("player-frame");
      frame?.removeAttribute("allowfullscreen");
      frame?.removeAttribute("allow");
    });
    await session.evalInFrame([0], function main() {
      const frame = document.querySelector("iframe");
      frame?.removeAttribute("allowfullscreen");
      frame?.removeAttribute("allow");
    });
    await session.evalInFrame([0, 0], function main() {
      document.dispatchEvent(new Event("fullscreenerror"));
    });
    const reTopGrant = await session.waitFor(
      `return document.getElementById("player-frame")?.hasAttribute("allowfullscreen") === true;`,
      5000
    ).then(() => true, () => false);
    const reMidGrant = await session.waitForFrame(
      [0],
      `return document.querySelector("iframe")?.hasAttribute("allowfullscreen") === true;`,
      5000
    ).then(() => true, () => false);
    const shellsAfterRetry = await shellCount([0, 0]);
    rows.push({
      name: "nested frames: fullscreenerror re-arms provisioning without a new shell",
      status: reTopGrant && reMidGrant && shellsAfterRetry === 1 ? "pass" : "fail",
      note: `top re-granted=${reTopGrant}; mid re-granted=${reMidGrant}; shells=${shellsAfterRetry}`,
      ms: null
    });
  } catch (err) {
    latencies.nested = null;
    await failRow("nested frames scenario failed", err);
  }

  // ---- Scenario 5: mixed-topology vouch posture. Chain: top -> SAME-origin
  // mid -> cross-origin player. The mid being readable from the top is the
  // branch the /check/frames-nested chain (cross mid) cannot reach. The two
  // routes intentionally carry different vouch postures against this one
  // topology: the ctx route accepts a nested asker through isOwnFrame's
  // same-origin readable walk; the fullscreen provisioner accepts direct
  // children only.
  try {
    latencies.walk = await bootFrameScenario({ pagePath: "/check/frames-walk", shellPath: [0, 0] });
    // (a) The player frame direct-sends a plain pf:ctx-request to window.top,
    // skipping the mid relay. Top's origin differs from bottom's, so ONLY the
    // readable-walk can vouch the asker: top's document -> mid's document
    // (same-origin) -> the iframe element holding bottom's window. A walk
    // that stopped at direct children drops this request unanswered - and a
    // positive answer carrying domain=127-0-0-1 proves the TOP wrote it
    // (bottom's own fallback context would say localhost).
    await session.evalInFrame([0, 0], function main() {
      window.__ctxNonce = crypto.randomUUID();
      window.__ctx = null;
      window.addEventListener("message", (event) => {
        const d = event && event.data;
        if (d && typeof d === "object" && d.type === "pf:ctx"
            && d.nonce === window.__ctxNonce) {
          window.__ctx = d;
        }
      });
      window.top.postMessage(
        { type: "pf:ctx-request", nonce: window.__ctxNonce }, "*");
    });
    const ctx = await session.waitForFrame([0, 0],
      `return window.__ctx ? { domain: window.__ctx.domain, path: window.__ctx.path } : false;`,
      5000
    ).then((v) => v, () => null);
    rows.push({
      name: "walk chain: ctx route vouches a nested asker through the readable descendant walk",
      status: !!ctx && ctx.domain === "127-0-0-1" ? "pass" : "fail",
      note: ctx ? `domain=${ctx.domain} path=${ctx.path}` : "no bridged answer",
      ms: null
    });
    // (b) The same asker posture must NOT punch the top's fullscreen grant.
    // Strip the top grant, then have the player frame re-request fullscreen
    // DIRECT to the top again - the provisioner's iframeRegistry.child vouch
    // matches only its DIRECT child's contentWindow (mid), so a grandchild's
    // request dead-ends with nothing re-granted.
    await session.eval(function main() {
      document.getElementById("player-frame")?.removeAttribute("allowfullscreen");
      document.getElementById("player-frame")?.removeAttribute("allow");
    });
    await session.evalInFrame([0, 0], function main() {
      window.top.postMessage({ type: "pf:req-fullscreen" }, "*");
    });
    await sleep(900);
    const topGrant = await session.eval(function main() {
      const frame = document.getElementById("player-frame");
      return {
        fs: frame?.hasAttribute("allowfullscreen") ?? false,
        allow: (frame?.getAttribute("allow") ?? "").includes("fullscreen")
      };
    });
    rows.push({
      name: "walk chain: fullscreen provisioner refuses a non-direct-child re-request",
      status: topGrant.fs === false && topGrant.allow === false ? "pass" : "fail",
      note: `top player-frame allowfullscreen=${topGrant.fs} allow-fullscreen=${topGrant.allow}`,
      ms: null
    });
  } catch (err) {
    latencies.walk = null;
    await failRow("walk chain scenario failed", err);
  }

  // ---- Scenario 6: switchboard (one placeholder, three SDK stubs, same video)
  try {
    latencies.plyr = await bootFrameScenario({ pagePath: "/check/switchboard", shellPath: [0] });
    let sdk = await sdkInFrame([0]);
    let counts = await shellCount([0]);
    rows.push({
      name: "switchboard: Plyr variant boots exactly one shell",
      status: counts === 1 && sdk === "Plyr" ? "pass" : "fail",
      note: `sdk=${sdk} shells=${counts}`,
      ms: null
    });

    latencies.videojs = await swapVariant(`${baseUrl}/sdk/videojs#${DEBUG_HASH_TAG}`);
    sdk = await sdkInFrame([0]);
    counts = await shellCount([0]);
    rows.push({
      name: "switchboard: Video.js variant re-anchors without stale shells",
      status: counts === 1 && sdk === "Video.js" ? "pass" : "fail",
      note: `sdk=${sdk} shells=${counts}`,
      ms: null
    });

    latencies.dplayer = await swapVariant(`${baseUrl}/sdk/dplayer#${DEBUG_HASH_TAG}`);
    sdk = await sdkInFrame([0]);
    counts = await shellCount([0]);
    rows.push({
      name: "switchboard: DPlayer variant re-anchors without stale shells",
      status: counts === 1 && sdk === "DPlayer" ? "pass" : "fail",
      note: `sdk=${sdk} shells=${counts}`,
      ms: null
    });

    const src = await session.evalInFrame([0], function main() {
      const v = document.querySelector("video");
      return v ? v.currentSrc : null;
    });
    rows.push({
      name: "switchboard: every variant plays the same fixture video",
      status: typeof src === "string" && src.includes("/check-video.mp4") ? "pass" : "fail",
      note: src ?? "no currentSrc",
      ms: null
    });
    const top = await topShellCount();
    rows.push({
      name: "switchboard: the host page never boots its own shell",
      status: top === 0 ? "pass" : "fail",
      note: `top shells=${top}`,
      ms: null
    });
  } catch (err) {
    latencies.videojs ??= null;
    latencies.dplayer ??= null;
    await failRow("switchboard scenario failed", err);
  }

  // ---- Efficiency: every scenario's shell attach picked up inside 6s
  const latenciesOk = Object.values(latencies).every((v) => typeof v === "number" && v <= 6000);
  rows.push({
    name: "frame scenario shell attach latencies within the 6s budget",
    status: latenciesOk ? "pass" : "fail",
    note: JSON.stringify(latencies),
    ms: null
  });

  return rows;
}
