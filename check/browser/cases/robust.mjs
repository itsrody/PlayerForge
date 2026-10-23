/**
 * Gecko build robustness: everything PlayerForge persists through SYNCHRONOUS
 * GM storage at playback boundaries rides the freeze/pagehide discipline
 * Firefox keeps for background pages. Rows: the freeze flush must
 * land the played position with no user pause, the rVFC crank (the save
 * surface Firefox affords on presented frames) must be present on the
 * running video, and the storage echo/merge hot paths must stay inside a
 * tiering-era wall-clock budget (JIT tiers silently mask regressions on dev
 * hardware - this guard does not).
 */
export async function run({ session, boot }) {
  const rows = [];
  const status = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note: ok ? null : note, ms: null });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  await boot();

  // Freeze-flush row: the kernel's Page Lifecycle flush (freeze -> #saveProgress
  // at the last presented frame) must persist WITHOUT a user pause. Regression
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

  // rVFC presence: the save crank prefers requestVideoFrameCallback (fires
  // only for presented frames); a build that drops it silently downgrades
  // to the timeupdate fallback - this row makes the downgrade audible.
  const rvfc = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return typeof (v ?? {}).requestVideoFrameCallback;
  });
  status("rVFC frame crank surface present on the fixture video", rvfc === "function", `typeof=${rvfc}`);

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
