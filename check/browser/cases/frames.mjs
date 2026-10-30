// Real-world frame scenarios.
//
// The bundle is a match-all userscript with no @noframes - a userscript
// manager injects it into every frame. Each document therefore runs its own
// realm + bundle (this case injects exactly that), and the kernel's
// frame-aware boot plus the frame bridge (page-context pipe + fullscreen
// provisioning) must handle the embed layouts real sites have:
// The scenarios (top document -> deeper documents):
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
//   5. switchboard           - one placeholder iframe whose document swaps
//                              between three supported SDK stubs (Plyr,
//                              Video.js, DPlayer) playing the same video
//
// SDK "stubs" are plain wrapper divs carrying the registry's namespaced
// anchor classes - no vendor script - and the frame's console chatter (the
// debug hash is on every playback page) names which record adopted the video.
export async function run({ session, baseUrl, crossBaseUrl, bundle, boot, header, version, resources }) {
  const rows = [];
  const grants = header?.grants ?? null;
  const bundleBody = bundle.slice(bundle.indexOf("==/UserScript==") + 16);
  const latencies = {};

  const askRows = (name, ok, note) => {
    rows.push({ name, status: ok ? "pass" : "fail", note: note ?? null, ms: null });
    return ok;
  };

  const frameDiag = async () => {
    for (const path of [[0], [0, 0]]) {
      const state = await session.snapshotFrameState(path);
      if (state) return `frame${JSON.stringify(path)}=${JSON.stringify(state)}`;
    }
    return "";
  };

  const failRow = async (name, err) => {
    let note = String(err?.message ?? err).slice(0, 140);
    try { note += " " + (await frameDiag()); } catch {}
    askRows(name, false, note);
  };

  /** Realm + bundle + wake into one frame chain (exact manager semantics:
   *  every frame document gets the full userscript surface). */
  const armFrame = async (path) => {
    await session.injectGMRealmFrame(path, { version, grants, resources });
    await session.evalInFrame(path, bundleBody);
    await session.evalInFrame(path, function main() {
      for (const v of document.querySelectorAll("video")) {
        v.dispatchEvent(new Event("loadeddata", { bubbles: true }));
      }
    });
  };

  /** Boot a frame scenario: top realm + bundle first (install-time bridge +
   *  provisioner code must exist in the ancestor chain before any player
   *  boots in a child), then every named frame chain, then shell wait. */
  const bootFrameScenario = async ({ pagePath, framePaths, shellPath, timeoutMs = 9000 }) => {
    await session.navigate(`${baseUrl}${pagePath}?boot=${Date.now()}`);
    await session.injectGMRealm({ version, grants, resources });
    await session.injectBundle(bundle);
    for (const p of framePaths) {
      await armFrame(p);
    }
    const started = Date.now();
    await session.waitForFrame(shellPath, `return !!document.querySelector(".pf-shell");`, timeoutMs);
    return Date.now() - started;
  };

  const frameCounts = (path) => session.evalInFrame(path, function main() {
    return {
      shells: document.querySelectorAll(".pf-shell").length,
      pf: typeof window.PlayerForge
    };
  });

  const topCounts = () => session.eval(function main() {
    return {
      shells: document.querySelectorAll(".pf-shell").length,
      pf: typeof window.PlayerForge
    };
  });

  /** Wait until the frame's resume store holds the expected entry (bridge
   *  proof: the path/domain written must be the TOP's, not the frame's). */
  const waitForEntry = (path, expectedPath, expectedDomain, timeoutMs = 5000) =>
    session.waitForFrame(path, `
      const store = window.__pfBacking?.["pf:resume"];
      const entry = (Array.isArray(store?.entries) ? store.entries : [])[0] ?? null;
      return entry && entry.path === ${JSON.stringify(expectedPath)} && entry.domain === ${JSON.stringify(expectedDomain)} ? entry : false;
    `, timeoutMs);

  /** Which registry record the frame's kernel adopted (debug chatter). */
  const sdkInFrame = (path) => session.evalInFrame(path, function main() {
    const lines = window.__pfConsoleLog ?? [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = /Shell registered:\s*(.+)$/.exec(lines[i]);
      if (m) return m[1].trim();
    }
    return null;
  });

  /** Switchboard: swap the placeholder's document to a new SDK stub page,
   *  rearm the fresh doc, and wait for its shell. */
  const swapVariant = async (url) => {
    await session.eval(function main(next) { window.swapBoard(next); }, url);
    const pathname = new URL(url).pathname;
    await session.waitForFrame([0], `return location.pathname === ${JSON.stringify(pathname)} && document.readyState === "complete";`, 8000);
    await armFrame([0]);
    const started = Date.now();
    await session.waitForFrame([0], `return !!document.querySelector(".pf-shell");`, 9000);
    return Date.now() - started;
  };

  // ---- Scenario 1: direct embed (the baseline every other row deviates from)
  await boot();
  const direct = await topCounts();
  askRows(
    "direct embed: the top document boots one shell",
    direct.shells === 1 && direct.pf === "object",
    `shells=${direct.shells} pf=${direct.pf}`
  );

  // ---- Scenario 2: same-origin iframe
  try {
    latencies.so = await bootFrameScenario({
      pagePath: "/check/frames-so", framePaths: [[0]], shellPath: [0]
    });
    const top = await topCounts();
    const frame = await frameCounts([0]);
    askRows(
      "same-origin iframe: shell boots in the frame, top stays unbooted",
      frame.shells === 1 && frame.pf === "object" && top.shells === 0,
      `frame shells=${frame.shells} pf=${frame.pf}; top shells=${top.shells} pf=${top.pf}`
    );
    const entry = await waitForEntry([0], "/check/frames-so", "127-0-0-1");
    askRows(
      "same-origin iframe: resume entry reads the top context directly",
      !!entry,
      entry ? `path=${entry.path} domain=${entry.domain}` : "no entry"
    );
  } catch (err) {
    latencies.so = null;
    await failRow("same-origin iframe scenario failed", err);
  }

  // ---- Scenario 3: cross-origin iframe (the frame bridge's designed case)
  try {
    latencies.cross = await bootFrameScenario({
      pagePath: "/check/frames-cross", framePaths: [[0]], shellPath: [0]
    });
    // Fallback (ownPageContext) would give path=/check domain=l-o-c-a-l-h-o-s-t -
    // only a bridged answer carries the top document's context up the pipe.
    const entry = await waitForEntry([0], "/check/frames-cross", "127-0-0-1");
    askRows(
      "cross-origin iframe: shell boots and bridges the top context into its resume entry",
      !!entry,
      entry ? `path=${entry.path} domain=${entry.domain} (bridged from ${crossBaseUrl})` : `no bridged entry`
    );
  } catch (err) {
    latencies.cross = null;
    await failRow("cross-origin iframe scenario failed", err);
  }

  // ---- VM echo: the settings live reload reaches the frame's RUNNING kernel.
  // Before the manager migration the foreign-write reload only re-seeded
  // sibling TABS - the embed kept its boot-time settings digest and stayed
  // stale until a reboot. The echo contract (now proven in the gm case)
  // delivers foreign-INSTANCE writes - another frame counts - so the frame's
  // Settings engine re-seeds from the fresh doc and its event-time consumers
  // see the flip. Proven on the hotkeys gate, the gating that guards every
  // keyboard action: a foreign flip off blocks the panel key mid-flight, and
  // the flip back re-arms it, with the two log sightings as delivery
  // witnesses (the kernel's debug mirror, then the Settings engine's
  // live-reload line). Synthetic keydown is the right probe here (the real
  // driver input path is the gestures case's territory) - what a stale frame
  // cache would miss is precisely the event-time getSetting() read.
  try {
    const armListener = () => session.evalInFrame([0], function main() {
      window.__pfEvents = [];
      const host = document.querySelector(".pf-shell");
      if (!host) {
        return false;
      }
      if (!window.__pfEventsInstalled) {
        window.__pfEventsInstalled = true;
        host.addEventListener("pf:gesture-panel", () => window.__pfEvents.push("panel"));
      }
      window.__pfConsoleLog = [];
      // Witness A - the kernel's debug mirror answers a foreign write with a
      // log line, proving the frame RECEIVES foreign-instance deliveries.
      const doc = JSON.parse(JSON.stringify(window.__pfBacking["pf:configs"] ?? { version: 1 }));
      doc.debug = doc.debug ?? {};
      doc.debug.logs = true;
      window.__gmTest.remoteWrite("pf:configs", doc);
      return true;
    });
    const frameConsole = () => session.evalInFrame([0], function main() {
      return { lines: window.__pfConsoleLog ?? [], docHotkeys: window.__pfBacking?.["pf:configs"]?.settings?.gestures?.hotkeys };
    });
    const writeSetting = (value) => session.evalInFrame([0], function main(value) {
      const doc = JSON.parse(JSON.stringify(window.__pfBacking["pf:configs"]));
      doc.settings = doc.settings ?? {};
      doc.settings.gestures = doc.settings.gestures ?? {};
      doc.settings.gestures.hotkeys = value;
      window.__pfEvents = [];
      window.__gmTest.remoteWrite("pf:configs", doc);
    }, value);
    const keyS = () => session.evalInFrame([0], function main() {
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    });
    const frameProbe = () => session.evalInFrame([0], function main() {
      return { events: window.__pfEvents ?? [], panelOpen: document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel.pf-open") !== null };
    });

    const armed = await armListener();
    await new Promise((r) => setTimeout(r, 250));
    const mirrorRun = await frameConsole();
    const mirrorSighted = mirrorRun.lines.some((l) => l.includes("Debug logs mirrored on"));
    // Flip the gate off; the Settings engine must re-seed (log line) and the
    // panel key must die mid-flight.
    await writeSetting(false);
    await new Promise((r) => setTimeout(r, 250));
    const afterOff = await frameConsole();
    const reloadSighted = afterOff.lines.some((l) => l.includes("Live-reloaded"));
    await keyS();
    await new Promise((r) => setTimeout(r, 300));
    const blocked = await frameProbe();
    // Flip back on; the engine re-seeds again and the panel key returns.
    await writeSetting(true);
    await new Promise((r) => setTimeout(r, 250));
    await keyS();
    await new Promise((r) => setTimeout(r, 300));
    const reArmed = await frameProbe();
    askRows(
      "foreign settings write live-reloads the frame's running kernel",
      armed && mirrorSighted && reloadSighted
        && blocked.events.length === 0 && blocked.panelOpen === false
        && reArmed.events.length === 1,
      `armed=${armed} mirror=${mirrorSighted} reload=${reloadSighted} blocked=${JSON.stringify(blocked.events)} panelOpen=${blocked.panelOpen} reArmed=${JSON.stringify(reArmed.events)} docAfterOff=${afterOff.docHotkeys}`
    );
  } catch (err) {
    await failRow("foreign settings live-reload row failed", err);
  }

  // ---- Scenario 4: nested frames (cross-origin mid -> same-origin player)
  try {
    latencies.nested = await bootFrameScenario({
      pagePath: "/check/frames-nested", framePaths: [[0], [0, 0]], shellPath: [0, 0]
    });
    const top = await topCounts();
    const mid = await frameCounts([0]);
    const inner = await frameCounts([0, 0]);
    askRows(
      "nested frames: only the innermost document boots a shell",
      inner.shells === 1 && inner.pf === "object" && mid.shells === 0 && top.shells === 0,
      `inner shells=${inner.shells}; mid shells=${mid.shells}; top shells=${top.shells}`
    );
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
    askRows(
      "nested frames: fullscreen provisioning reaches both ancestor iframes",
      topGrant && midGrant,
      `top granted=${topGrant}; mid granted=${midGrant}`
    );
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
    const shellsAfterRetry = await frameCounts([0, 0]);
    askRows(
      "nested frames: fullscreenerror re-arms provisioning without a new shell",
      reTopGrant && reMidGrant && shellsAfterRetry.shells === 1,
      `top re-granted=${reTopGrant}; mid re-granted=${reMidGrant}; shells=${shellsAfterRetry.shells}`
    );
  } catch (err) {
    latencies.nested = null;
    await failRow("nested frames scenario failed", err);
  }

  // ---- Scenario 4b: late-armed ancestors - the event-driven ready path.
  // Realm + bundle go in bottom-up (player document first: its chain is
  // absent above it, so its first bridge request is lost), then the mid
  // relay, then the top. No timed retry exists in the bridge; ONLY the
  // pf:ready announce-down + relay-echo path can drive a re-issue, so
  // resolving this chain proves the event-driven driver directly.
  try {
    await session.navigate(`${baseUrl}/check/frames-nested?boot=${Date.now()}`);
    await session.injectGMRealmFrame([0, 0], { version, grants, resources });
    await session.evalInFrame([0, 0], bundleBody);
    await session.injectGMRealmFrame([0], { version, grants, resources });
    await session.evalInFrame([0], bundleBody);
    await session.injectGMRealm({ version, grants, resources });
    await session.injectBundle(bundle);
    const started = Date.now();
    await session.waitForFrame([0, 0], `return !!document.querySelector(".pf-shell");`, 9000)
      .then(() => true, () => false);
    latencies.late = Date.now() - started;
    const entry = await waitForEntry([0, 0], "/check/frames-nested", "127-0-0-1", 5000);
    askRows(
      "late-armed ancestors: pf:ready drives resolution with zero timed retries",
      !!entry,
      entry ? `path=${entry.path} domain=${entry.domain} (${latencies.late}ms after top armed)` : "no bridged entry"
    );
  } catch (err) {
    latencies.late = null;
    await failRow("late-armed ancestors scenario failed", err);
  }

  // ---- Scenario 5: switchboard (one placeholder, three SDK stubs, same video)
  try {
    latencies.plyr = await bootFrameScenario({
      pagePath: "/check/switchboard", framePaths: [[0]], shellPath: [0]
    });
    let sdk = await sdkInFrame([0]);
    let counts = await frameCounts([0]);
    askRows(
      "switchboard: Plyr variant boots exactly one shell",
      counts.shells === 1 && sdk === "Plyr",
      `sdk=${sdk} shells=${counts.shells}`
    );

    latencies.videojs = await swapVariant(`${baseUrl}/sdk/videojs#pf-debug`);
    sdk = await sdkInFrame([0]);
    counts = await frameCounts([0]);
    askRows(
      "switchboard: Video.js variant re-anchors without stale shells",
      counts.shells === 1 && sdk === "Video.js",
      `sdk=${sdk} shells=${counts.shells}`
    );

    latencies.dplayer = await swapVariant(`${baseUrl}/sdk/dplayer#pf-debug`);
    sdk = await sdkInFrame([0]);
    counts = await frameCounts([0]);
    askRows(
      "switchboard: DPlayer variant re-anchors without stale shells",
      counts.shells === 1 && sdk === "DPlayer",
      `sdk=${sdk} shells=${counts.shells}`
    );

    const src = await session.evalInFrame([0], function main() {
      const v = document.querySelector("video");
      return v ? v.currentSrc : null;
    });
    askRows(
      "switchboard: every variant plays the same fixture video",
      typeof src === "string" && src.includes("/check-video.mp4"),
      src ?? "no currentSrc"
    );
    const top = await topCounts();
    askRows(
      "switchboard: the host page never boots its own shell",
      top.shells === 0,
      `top shells=${top.shells}`
    );
  } catch (err) {
    latencies.videojs ??= null;
    latencies.dplayer ??= null;
    await failRow("switchboard scenario failed", err);
  }

  // ---- Efficiency: every scenario's shell attach picked up inside 6s
  const latenciesOk = Object.values(latencies).every((v) => typeof v === "number" && v <= 6000);
  askRows(
    "frame scenario shell attach latencies within the 6s budget",
    latenciesOk,
    JSON.stringify(latencies)
  );

  return rows;
}
