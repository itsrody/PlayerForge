import { sleep } from "../../lib/driver.mjs";
/**
 * The robustness floor: real page lifecycles during background playback (the
 * page hidden mid-stream by a real second tab) raise the stakes on everything
 * PlayerForge persists through browser.storage at playback boundaries. Rows:
 * the hidden flush must land the played position with no user pause, the
 * checkpoint cadence must ride the native timeupdate media clock (no
 * presented-frame crank, no wall clock), and the completion reset must
 * persist as a real store write (a bumped doc stamp beside the zero).
 *
 * Reads ride the debug storageDump sentinel. The former GM-synthetic storm
 * rows (1000 echoes / 400 merges) are retired with the GM plane: their
 * premise was a synthetic foreign-write surface the content plane cannot
 * honestly construct (a foreign write IS a real second tab or frame, whose
 * reach the persist case proves instead).
 */
export async function run({ session, boot }) {
  const rows = [];
  const status = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note, ms: null });

  await boot({ pagePath: "/check#pf-debug" });

  // Hidden-flush row: the tracker's suspension flush (visibilitychange ->
  // hidden at the playback boundary) must persist WITHOUT a user pause.
  // Regression surface: if a future refactor moves persistence onto async
  // backends (IDB/SQLite behind an await), the flush at hide time can miss
  // the store entirely - the row reads the STORE, not the element.
  const before = await session.eval(function main() {
    try {
      const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
      const entry = entries.find((e) => e && e.path === "/check");
      return entry ? entry.resume : 0;
    } catch { return 0; }
  });
  const played = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done("no-video"); return; }
    // 2x, not 4x: the video KEEPS PLAYING through the tab switch (that is
    // the row's premise - no user pause), and the remaining content must
    // survive the hide->return->read round trip on the wall clock, or the
    // natural end's completion flush (0.95 ratio -> zero) legitimately
    // rewrites the entry before the row reads it (probed: at 4x the video
    // ended mid-switch and the row raced the completion zero).
    v.playbackRate = 2;
    v.play().catch(() => {});
    const deadline = Date.now() + 12000;
    const tick = () => {
      if (Date.now() >= deadline) { done(v.currentTime); return; }
      if (!v.paused && v.currentTime >= 9.2) {
        done(v.currentTime);
        return;
      }
      setTimeout(tick, 60);
    };
    tick();
  });
  const pageHandle = await session.raw.getWindowHandle();
  // Real suspension: a second tab takes the window's focus; the fixture page
  // witnesses its own transition through a planted listener (the resume
  // realm holds the flush path, this flag is only the row's witness), and
  // the second document carries no script instance (about:blank - the
  // extension is filtered off chrome/new-tab/about pages) to write the
  // store concurrently.
  await session.eval(function main() {
    window.__pfHiddenSeen = false;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        window.__pfHiddenSeen = true;
      }
    });
  });
  await session.raw.switchTo().newWindow("tab");
  await sleep(400); // the fixture page's flush runs synchronously on hidden
  const tabHandle = await session.raw.getWindowHandle();
  await session.raw.switchTo().window(pageHandle);
  await sleep(200); // context switch back settles before the store read
  const seen = await session.eval("return { hiddenSeen: window.__pfHiddenSeen, state: document.visibilityState }");
  const after = await session.eval(function main() {
    try {
      const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
      const entry = entries.find((e) => e && e.path === "/check");
      return entry ? entry.resume : 0;
    } catch { return 0; }
  });
  status(
    "real second-tab suspension reaches the fixture page",
    seen.hiddenSeen === true && seen.state === "visible",
    `after return hiddenSeen=${seen.hiddenSeen} visibilityState=${seen.state}`
  );
  status(
    "hidden-flush persists the played position without a user pause",
    typeof played === "number" && Number(played) >= 9.2 && Number(after) > Number(before) + 1 && Number(after) >= 6,
    `before=${before} played=${played} after=${after}`
  );
  // Close the helper tab: the rest of this case and the later cases run the
  // single-tab session the standalone install produces.
  await session.raw.switchTo().window(tabHandle);
  await sleep(150);
  await session.raw.close().catch(() => {});
  await session.raw.switchTo().window(pageHandle);
  await sleep(200);

  // Checkpoint cadence: the save drive is the element's OWN timeupdate
  // broadcast (no presented-frame crank, no wall clock). Seek to 0 first -
  // the seeked flush persists a clean 0 baseline (the resume-seek floor is
  // an adoption gate, not a save gate) - then play at 4x and wait for the
  // 10s checkpoint span to land WITHOUT any flush edge: an ended flush
  // would read 12 (or completion-zero it), so the strict upper bound proves
  // the cadence landed by itself, mid-content. The read pauses the video
  // only when the span write is already caught.
  const cadence = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ at: "no-video" }); return; }
    const cleanup = () => { v.pause(); v.playbackRate = 1; };
    v.currentTime = 0;
    v.playbackRate = 4;
    v.play().catch(() => {});
    const deadline = Date.now() + 9000;
    const tick = () => {
      let entry = null;
      try {
        const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
        entry = entries.find((e) => e && e.path === "/check");
      } catch {}
      const at = entry ? entry.resume : -1;
      if (at >= 10 && at < 11.5 && !v.paused) {
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
  // zero, not only flip it in memory. The save path hands the store the
  // reset directly - asserted jointly on resume=0 in the store AND a bumped
  // doc stamp, because only a real persist produces both (an eaten write
  // leaves the stale position on disk with an untouched updatedAt, which is
  // then also what every other tab keeps merging). Baseline re-arm: park a
  // real sub-ratio position first (the pause flush carries it and bumps the
  // stamp), so the row's zero can only be its own completion reset.
  const parked = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ why: "no-video" }); return; }
    v.playbackRate = 1;
    v.currentTime = Math.min(3.5, v.duration / 3);
    v.play().catch(() => {});
    const deadline = Date.now() + 5000;
    const tick = () => {
      let entry = null;
      try {
        const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
        entry = entries.find((e) => e && e.path === "/check");
      } catch {}
      if (entry && entry.resume > 0) {
        v.pause();
        v.playbackRate = 1;
        done({ resume: entry.resume });
        return;
      }
      if (Date.now() >= deadline) {
        v.pause();
        done({ resume: entry ? entry.resume : -1, at: v.currentTime });
        return;
      }
      setTimeout(tick, 120);
    };
    tick();
  });
  const stampBefore = await session.eval(function main() {
    try {
      return JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.updatedAt ?? 0;
    } catch { return 0; }
  });
  const completionRow = await session.evalAsync(function main(stampBefore, done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ why: "no-video" }); return; }
    // A fresh sub-ratio baseline: a pause flush below 5s saves normally, so
    // the zero the row waits for can only be the completion reset, never
    // the earlier cadence work.
    const span = v.duration ?? 12;
    v.currentTime = Math.min(10, span - 2.5);
    v.playbackRate = 2;
    v.play().catch(() => {});
    const deadline = Date.now() + 6000;
    const tick = () => {
      let entry = null;
      let stamp = 0;
      try {
        const doc = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume ?? {};
        stamp = doc.updatedAt ?? 0;
        entry = (doc.entries ?? []).find((e) => e && e.path === "/check");
      } catch {}
      if (entry && entry.resume === 0 && stamp > stampBefore) {
        v.pause();
        v.playbackRate = 1;
        done({ resume: entry.resume, bumped: true });
        return;
      }
      if (Date.now() >= deadline) {
        v.pause();
        v.playbackRate = 1;
        done({ resume: entry ? entry.resume : -1, at: v.currentTime, stamp, stampBefore });
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

  return rows;
}
