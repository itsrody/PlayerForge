/**
 * The robustness floor: backing churn during background lives (page frozen
 * mid-playback, storage echo floods from cross-tab merges) raises the stakes
 * on everything PlayerForge persists through SYNCHRONOUS GM storage at
 * playback boundaries. Rows: the freeze flush must land the played position
 * with no user pause, the checkpoint cadence must ride the native timeupdate
 * media clock (no presented-frame crank), and the storage echo/merge hot
 * paths must stay inside a tiering-era wall-clock budget (the engine's
 * optimizer tiers silently mask regressions on dev hardware - this guard
 * does not).
 */
export async function run({ session, boot }) {
  const rows = [];
  const status = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note: ok ? null : note, ms: null });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  await boot();

  // Freeze-flush row: the kernel's Page Lifecycle flush (freeze -> #saveProgress
  // at the playback boundary) must persist WITHOUT a user pause. Regression
  // surface: if a future refactor moves persistence onto async backends (IDB/
  // fetch), a freeze discards the in-flight write and this row goes red.
  await session.waitFor(
    "return (() => { const v = document.querySelector('#check-video'); return v && v.duration > 3 ? v.duration : false; })()",
    6000
  );
  await settle(900); // kernel boot re-anchor settles (boot page drive pattern)
  const before = await session.eval(function main() {
    const store = window.__pfBacking["pf:resume"] ?? { entries: [] };
    const own = (store.entries ?? []).find((e) => e && e.path === "/check");
    return own ? own.resume : -1;
  });
  const played = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done(null); return; }
    v.currentTime = 6;
    v.play().catch(() => {});
    const deadline = Date.now() + 6000;
    const tick = () => {
      if (v.currentTime >= 9.4) { done(v.currentTime); return; }
      if (Date.now() >= deadline) { done(v.paused ? "paused" : v.currentTime); return; }
      setTimeout(tick, 60);
    };
    tick();
  });
  // Synthetic freeze: resume.js flushes on the document freeze event; the
  // kernel's teardown keys on pagehide instead, so the session survives.
  const flushed = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    document.dispatchEvent(new Event("freeze"));
    setTimeout(() => done(v.currentTime), 300);
  });
  const after = await session.eval(function main() {
    const store = window.__pfBacking["pf:resume"] ?? { entries: [] };
    const own = (store.entries ?? []).find((e) => e && e.path === "/check");
    return own ? own.resume : -1;
  });
  status(
    "freeze-flush persists the played position without a user pause",
    typeof before === "number" && Number(played) >= 9.2 && Number(flushed) >= 9.0 && after >= 9.0 && after > Math.max(0, before),
    `before=${before} played=${played} flushedAt=${flushed} after=${after}`
  );

  // Checkpoint cadence: the save drive is the element's OWN timeupdate
  // broadcast (no presented-frame crank, no wall clock). Seek to 0 first -
  // the seeked flush persists a clean 0 baseline (the resume-seek floor is an
  // adoption gate, not a save gate) - then play at 4x and wait for the 10s
  // checkpoint span to land WITHOUT any flush edge: an ended flush would
  // read 12 (or completion-zero it), so the strict upper bound proves the
  // cadence landed by itself, mid-content.
  const cadence = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ at: "no-video" }); return; }
    const cleanup = () => { v.pause(); v.playbackRate = 1; };
    v.currentTime = 0;
    v.playbackRate = 4;
    v.play().catch(() => {});
    const deadline = Date.now() + 6000;
    const tick = () => {
      const store = window.__pfBacking["pf:resume"];
      const entry = (store?.entries ?? []).find((e) => e && e.path === "/check");
      const at = entry ? entry.resume : -1;
      if (at >= 10 && at < 11.5) {
        cleanup();
        done({ at });
        return;
      }
      if (Date.now() >= deadline) {
        cleanup();
        done({ at: `deadline pos=${v.currentTime} resume=${at}` });
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
  status(
    "checkpoint cadence lands on the native timeupdate media clock (10s span at 4x)",
    typeof cadence?.at === "number" && cadence.at >= 10 && cadence.at < 11.5,
    `resume=${cadence?.at ?? cadence}`
  );

  // Completion reset: playing past the completion ratio must PERSIST the
  // zero, not only flip it in memory. The save path hands the store the reset
  // directly - asserted jointly on resume=0 in the backing doc AND a bumped
  // doc stamp, because only a real persist produces both (an eaten write
  // leaves the stale position on disk with an untouched updatedAt, which is
  // then also what every other tab keeps merging). Completing from ~10
  // crosses 11.4 (0.95 * 12s) into the reset.
  const stampBefore = await session.eval(function main() {
    return window.__pfBacking["pf:resume"]?.updatedAt ?? 0;
  });
  const completionRow = await session.evalAsync(function main(stampBefore, done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ why: "no-video" }); return; }
    // A fresh sub-ratio baseline: a seek flush at 10 must save normally
    // (10/12 < 0.95), so the zero the row waits for can only be the
    // completion reset, never the earlier cadence work.
    const start = Math.min(10, v.duration - 2.5);
    if (start > 0) { v.currentTime = start; }
    v.playbackRate = 2;
    v.play().catch(() => {});
    const deadline = Date.now() + 6000;
    const tick = () => {
      const store = window.__pfBacking["pf:resume"];
      const entry = (store?.entries ?? []).find((e) => e && e.path === "/check");
      if (entry && entry.resume === 0 && (store?.updatedAt ?? 0) > stampBefore) {
        v.pause();
        v.playbackRate = 1;
        done({ resume: entry.resume, bumped: true });
        return;
      }
      if (Date.now() >= deadline) {
        v.pause();
        v.playbackRate = 1;
        done({ resume: entry ? entry.resume : -1, at: v.currentTime });
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  }, stampBefore);
  status(
    "completion reset persists the zero (resume=0 with bumped doc stamp)",
    completionRow?.resume === 0 && completionRow?.bumped === true,
    JSON.stringify(completionRow)
  );

  // Echo-contract budget: N sync GM_setValue calls + their microtask echo
  // deliveries must land inside the budget. The store watch layer plus the
  // kernel's listeners run per write; tiering-era V8 makes this minutes-cheap,
  // so a regression here is a real hot-path change, not measurement noise.
  const budget = (ms) => ms < 400;
  const echoes = await session.evalAsync(function main(done) {
    window.GM_addValueChangeListener("pf:bench", () => {});
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) window.GM_setValue("pf:bench", i);
    setTimeout(() => done({ ms: performance.now() - t0 }), 0);
  });
  status(
    "1000 GM setValue+echo cycles hold the hot-path budget",
    budget(echoes.ms), `${Math.round(echoes.ms)}ms (budget 400ms)`
  );

  // Cross-tab adoption budget: the tracker merge path (watchStorageKey ->
  // #adoptExternal -> in-place LWW) under 400 remote pf:resume writes. The
  // tracker is loaded by the freeze row's playback sweep, so every write pays
  // the real merge, not the !#loaded early return.
  const merges = await session.evalAsync(function main(done) {
    // A fresh doc per write keeps every iteration paying the real LWW merge
    // path (updatedAt strictly newer), not the no-op early return a constant
    // doc would take after the first echo.
    const remoteWrite = (i) => window.__gmTest.remoteWrite("pf:resume", {
      version: 1,
      entries: [{
        id: "check-bench-foreign", domain: "bench.test", path: "/bench",
        title: "bench", duration: 12, resume: 2,
        createdAt: 1750000000000 + i,
        updatedAt: 1750000000000 + i
      }]
    });
    remoteWrite(0); // warm the merge path so JIT tiers settle before the window
    setTimeout(() => {
      const t0 = performance.now();
      for (let i = 1; i <= 400; i++) remoteWrite(i);
      setTimeout(() => done({ ms: performance.now() - t0 }), 0);
    }, 60);
  });
  status(
    "400 remote pf:resume adoption merges hold the hot-path budget",
    merges.ms < 800, `${Math.round(merges.ms)}ms (budget 800ms)`
  );

  return rows;
}
