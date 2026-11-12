import { sleep } from "../../lib/driver.mjs";
/**
 * The robustness case, both planes on one file (merged Nov 12 2026 - user
 * direction "merge robust and robust2 in one well-optimized module"; every
 * row preserved, the former robust2.mjs retired, the two normal-install
 * planes now share one boot).
 *
 * Storage floor (boot 1, first): backing churn during background lives (page
 * hidden mid-playback, storage echo floods from cross-tab merges) raises the
 * stakes on everything PlayerForge persists through SYNCHRONOUS GM storage
 * at playback boundaries. Rows: the hidden flush must land the played
 * position with no user pause, the checkpoint cadence must ride the native
 * timeupdate media clock (no presented-frame crank), and the storage
 * echo/merge hot paths must stay inside a tiering-era wall-clock budget (the
 * engine's optimizer tiers silently mask regressions on dev hardware - this
 * guard does not).
 *
 * Interruption plane (boot 1, continued): every recorded session-end path
 * (sweep #11: blur, pointercancel, destroy-readopt) driven live - a mid-hold
 * window blur must release the rate boost, a mid-drag/mid-swipe/mid-pinch
 * pointercancel must end the stroke with no stranded transform or latch and
 * leave the recognizer working for the next stroke, a fullscreen exit
 * mid-fill must hand the element box back, and a rapid re-home storm must
 * converge to exactly one shell.
 *
 * Hostile-storage plane (boots 2-4): the Native-first ledger's admission
 * adoptions pinned ON the floor - a hostile pf:configs seed must clamp at
 * the FILTER_SCHEMA bound the steppers commit with (the seed-bypass class),
 * a hostile pf:resume entry must clamp its restore at the media sink and
 * ride the string-field admission into a clean History render, and
 * non-object docs must degrade to defaults without a throw. Uncaught errors
 * and rejections from any row fail the case through the stage's audit net.
 */
export async function run({ session, boot }) {
  const rows = [];
  const status = (name, ok, note = null) =>
    rows.push({ name, status: ok === true ? "pass" : "fail", note: ok === true ? null : note, ms: null });
  const raw = session.raw;
  const waitDuration = () => session.waitFor(
    "return (() => { const v = document.querySelector('#check-video'); return v && v.duration > 3 ? v.duration : false; })()",
    6000
  );
  const settle = () => sleep(900); // kernel boot re-anchor settles (boot page drive pattern)
  // The store's own-entry read: hidden-flush before/after and every later
  // backing assertion share this one body shape.
  const storeResume = () => session.eval(function main() {
    const store = window.__pfBacking["pf:resume"] ?? { entries: [] };
    const own = (store.entries ?? []).find((e) => e && e.path === "/check");
    return own ? own.resume : -1;
  });
  const KEY_OF = { KeyS: "s" };
  const fireKeys = async (codes) => {
    const actions = raw.actions({ async: true });
    for (const code of codes) {
      actions.keyDown(KEY_OF[code]).keyUp(KEY_OF[code]).pause(80);
    }
    await actions.perform();
  };
  // The engine's semantic-event recorder (gestures.mjs's shape): host-level
  // listeners push every pf:gesture-* dispatch into window.__pfEvents, so the
  // cancel rows' witnesses are the events the engine actually emitted - the
  // page-lifetime listeners survive every row of boot 1 (the array itself is
  // re-seeded per row, the listeners keep pushing into whatever is current).
  const wireGestureRecorder = () => session.eval(function main() {
    window.__pfEvents = [];
    const host = document.querySelector(".pf-shell");
    if (host === null) return;
    host.addEventListener("pf:gesture-scrub", () => window.__pfEvents.push("scrub"));
    host.addEventListener("pf:gesture-scrub-end", () => window.__pfEvents.push("scrub-end"));
    host.addEventListener("pf:gesture-swipe-start", () => window.__pfEvents.push("swipe-start"));
    host.addEventListener("pf:gesture-swipe", (e) => window.__pfEvents.push("swipe:" + e.detail.direction));
    host.addEventListener("pf:gesture-pinch", (e) => window.__pfEvents.push("pinch:" + e.detail.direction));
  });
  // The fs-gated territory's synthetic-API arc (gestures.mjs pins the same):
  // scrub/swipe/pinch are fs:true-binding intents, so the Fullscreen API's
  // own datum is mounted and a synthetic fullscreenchange fires the update.
  const armFsStub = () => session.eval(function main() {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get() { return document.querySelector(".pf-shell"); }
    });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  // One page-side pointer driver for every gesture row (the same
  // window-global pattern as __pfEvents): deltas are relative to the video's
  // center read per call, and every call passes isPrimary explicitly so each
  // row keeps its original pointer semantics (the pinch pair's second
  // pointer and the fresh pair are non-primary, exactly as the per-row
  // closures spelled them).
  const armPointerDriver = () => session.eval(function main() {
    window.__pfFire = (id, type, dx, dy, buttons, isPrimary) => {
      const v = document.querySelector("#check-video");
      const rect = v.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      v.dispatchEvent(new PointerEvent(type, {
        pointerId: id,
        pointerType: "touch",
        isPrimary,
        button: type === "pointerup" ? -1 : 0,
        buttons,
        bubbles: true,
        cancelable: true,
        clientX: cx + dx,
        clientY: cy + dy,
      }));
    };
  });
  // The fill-release row's staged stage shape must go back for the thrash
  // row below (the wrapper's explicit box and the embed's staged fit both).
  const restoreStage = () => session.eval(function main() {
    const w = document.querySelector(".plyr__video-wrapper");
    if (w) { w.style.width = ""; w.style.height = ""; }
    const v = document.querySelector("#check-video");
    if (v) v.style.objectFit = "";
  });

  // ---------------------------------------------------------------------
  // Boot 1 - the storage floor + the interruption plane on one normal
  // install (the merge's saving: the former robust.mjs booted separately
  // for the same fixture state).
  // ---------------------------------------------------------------------
  await boot();
  await waitDuration();
  await settle();
  await wireGestureRecorder();

  // Hidden-flush row: the tracker's suspension flush (visibilitychange -> hidden
  // at the playback boundary) must persist WITHOUT a user pause. Regression
  // surface: if a future refactor moves persistence onto async backends (IDB/
  // fetch), a suspension discards the in-flight write and this row goes red.
  // The boundary is REAL: a genuine second tab sets the fixture document's
  // visibilityState to hidden and fires the native visibilitychange (the
  // Page Lifecycle freeze surface this row once dispatched synthetically is
  // Chromium vocabulary Firefox 159 has no realm for - probed; hidden is the
  // flush belt's real suspension surface on the floor).
  const before = await storeResume();
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
  const pageHandle = await session.raw.getWindowHandle();
  // Real suspension: a second tab takes the window's focus; the fixture page
  // witnesses its own transition through a planted listener (the resume
  // realm holds the flush path, this flag is only the row's witness), and
  // the second document carries no script instance (about:blank - the
  // entry's skip gate refuses it) to write the store concurrently.
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
  await session.raw.switchTo().window(pageHandle);
  await sleep(200); // context switch back settles before the store read
  const seen = await session.eval("return { hiddenSeen: window.__pfHiddenSeen, state: document.visibilityState }");
  const after = await storeResume();
  status(
    "real second-tab suspension reaches the fixture page",
    seen.hiddenSeen === true && seen.state === "visible",
    `after return hiddenSeen=${seen.hiddenSeen} visibilityState=${seen.state}`
  );
  status(
    "hidden-flush persists the played position without a user pause",
    typeof before === "number" && Number(played) >= 9.2 && after >= 9.0 && after > Math.max(0, before),
    `before=${before} played=${played} after=${after}`
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
  // Baseline re-arm: the cadence row's play can itself cross the completion
  // ratio while its poll runs, so the persisted zero this row waits for may
  // already exist on disk - and a zero-to-zero reset is a no-op write that
  // correctly leaves the stamp alone, reading as an eaten write. Park a real
  // sub-ratio position first (the seek flush carries it into the backing);
  // the row's zero can then only be its OWN completion reset, whose save
  // must bump the stamp.
  await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ why: "no-video" }); return; }
    v.playbackRate = 1;
    v.currentTime = Math.min(3.5, v.duration / 3);
    v.play().catch(() => {});
    const deadline = Date.now() + 5000;
    const tick = () => {
      const entry = ((window.__pfBacking["pf:resume"] ?? {}).entries ?? [])
        .find((e) => e && e.path === "/check");
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

  // Window blur mid-hold: the engine ends every live session through the
  // normal release paths on blur (the belt for a swallowed Space keyup), so
  // the boost must fall back to 1x WITHOUT the matching keyup - and the
  // late stray keyup must then be a no-op, not a second release.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.muted = true;
    v.playbackRate = 1;
    v.play();
    window.__pfEvents = [];
  });
  await sleep(150);
  await raw.actions({ async: true }).keyDown(" ").pause(700).perform();
  const boosted = await session.eval(function main() {
    return document.querySelector("#check-video").playbackRate;
  });
  await session.eval(function main() {
    window.dispatchEvent(new Event("blur"));
  });
  await sleep(300);
  const afterBlur = await session.eval(function main() {
    return document.querySelector("#check-video").playbackRate;
  });
  await raw.actions({ async: true }).keyUp(" ").pause(150).perform();
  const afterStray = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    const rate = v.playbackRate;
    v.pause();
    v.muted = false;
    return rate;
  });
  status("window blur mid-hold releases the boost (stray keyup stays a no-op)",
    boosted === 2 && afterBlur === 1 && afterStray === 1,
    JSON.stringify({ boosted, afterBlur, afterStray }));

  // Panel churn x10: every flip builds and tears down the per-open dismissal
  // scope under overlapping view transitions. The churn must end closed with
  // the toggle still live (open again, close again) - a stranded dismissal
  // scope or a dead toggle is the fail.
  const churn = await session.evalAsync(function main(done) {
    const host = document.querySelector(".pf-shell");
    if (!host) { done({ ok: false, why: "no shell" }); return; }
    let i = 0;
    const step = () => {
      host.dispatchEvent(new CustomEvent("pf:gesture-panel"));
      i++;
      if (i < 10) { setTimeout(step, 120); return; }
      setTimeout(() => {
        const panel = host.shadowRoot.querySelector(".pf-panel");
        const closedAfterChurn = panel === null || !panel.classList.contains("pf-open");
        // The toggle must still work after the churn.
        host.dispatchEvent(new CustomEvent("pf:gesture-panel"));
        setTimeout(() => {
          const reopened = host.shadowRoot.querySelector(".pf-panel")?.classList.contains("pf-open") === true;
          host.dispatchEvent(new CustomEvent("pf:gesture-panel"));
          setTimeout(() => {
            const reclosed = host.shadowRoot.querySelector(".pf-panel")?.classList.contains("pf-open") !== true;
            done({ ok: true, closedAfterChurn, reopened, reclosed });
          }, 250);
        }, 250);
      }, 300);
    };
    step();
  });
  status("panel churn x10 ends closed with the toggle still live",
    churn.ok === true && churn.closedAfterChurn === true && churn.reopened === true && churn.reclosed === true,
    JSON.stringify(churn));

  await armFsStub();
  await armPointerDriver();
  await sleep(200);

  // Scrub storm x30: every rapid stroke must end (scrub-end per stroke), and
  // the storm must leave no stranded state - rate, volume, mute untouched.
  const storm = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const host = document.querySelector(".pf-shell");
    const video = document.querySelector("#check-video");
    if (!host || !video) { done({ ok: false, why: "no shell/video" }); return; }
    let ends = 0;
    host.addEventListener("pf:gesture-scrub-end", () => { ends++; });
    const volumeBefore = video.volume;
    for (let i = 0; i < 30; i++) {
      window.__pfFire(5, "pointerdown", 0, 0, 1, true);
      window.__pfFire(5, "pointermove", 40, 0, 1, true);
      window.__pfFire(5, "pointerup", 40, 0, 0, true);
    }
    setTimeout(() => {
      done({
        ok: true,
        ends,
        rate: video.playbackRate,
        muted: video.muted,
        volume: video.volume,
        volumeBefore,
      });
    }, 400);
  });
  status("scrub storm x30: every stroke ends, playback state untouched",
    storm.ok === true && storm.ends === 30 && storm.rate === 1 && storm.muted === false && storm.volume === storm.volumeBefore,
    JSON.stringify(storm));

  // Pointercancel mid-drag: the cancel path must run the stroke's end (the
  // scrub-end dispatch the engine pairs with any release shape) and strand
  // nothing, then a fresh drag must scrub again.
  const cancelDrag = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    window.__pfFire(6, "pointerdown", 0, 0, 1, true);
    window.__pfFire(6, "pointermove", 60, 0, 1, true);
    window.__pfFire(6, "pointercancel", 60, 0, 1, true);
    const cancelled = window.__pfEvents.slice();
    setTimeout(() => {
      window.__pfEvents = [];
      window.__pfFire(6, "pointerdown", 0, 0, 1, true);
      window.__pfFire(6, "pointermove", 50, 0, 1, true);
      window.__pfFire(6, "pointerup", 50, 0, 0, true);
      setTimeout(() => {
        const follow = window.__pfEvents;
        done({
          ok: true,
          endAfterCancel: cancelled.includes("scrub-end"),
          scrubsBeforeCancel: cancelled.filter((e) => e === "scrub").length,
          followUpScrubs: follow.filter((e) => e === "scrub").length,
        });
      }, 300);
    }, 250);
  });
  status("pointercancel mid-drag ends the scrub (follow-up drag still scrubs)",
    cancelDrag.ok === true && cancelDrag.endAfterCancel === true &&
      cancelDrag.scrubsBeforeCancel > 0 && cancelDrag.followUpScrubs > 0,
    JSON.stringify(cancelDrag));

  // Pointercancel mid-swipe: the transform the stroke wrote must be restored
  // (the release path runs on cancel too), and a follow-up swipe must commit
  // its direction - the recognizer must not strand on the cancelled stroke.
  const cancelSwipe = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const video = document.querySelector("#check-video");
    window.__pfFire(7, "pointerdown", 0, 0, 1, true);
    window.__pfFire(7, "pointermove", 0, 40, 1, true);
    const midTransform = video.style.transform;
    window.__pfFire(7, "pointercancel", 0, 40, 1, true);
    const cancelled = window.__pfEvents.slice();
    setTimeout(() => {
      const restored = video.style.transform;
      window.__pfEvents = [];
      window.__pfFire(7, "pointerdown", 0, 0, 1, true);
      window.__pfFire(7, "pointermove", 0, 150, 1, true);
      window.__pfFire(7, "pointerup", 0, 150, 0, true);
      setTimeout(() => {
        video.getAnimations().forEach((a) => a.cancel());
        video.style.transform = "";
        done({
          ok: true,
          midTransform,
          swipeStartBeforeCancel: cancelled.includes("swipe-start"),
          restored,
          followUpSwipe: window.__pfEvents.includes("swipe:down"),
        });
      }, 400);
    }, 700);
  });
  status("pointercancel mid-swipe restores the transform (follow-up swipe still commits)",
    cancelSwipe.ok === true && cancelSwipe.swipeStartBeforeCancel === true &&
      cancelSwipe.midTransform.startsWith("translateY(40px)") &&
      cancelSwipe.restored === "" && cancelSwipe.followUpSwipe === true,
    JSON.stringify(cancelSwipe));

  // Pointercancel mid-pinch session: the pair first recognizes (the live
  // pinch session dispatches once on the move-apart), then cancelling ONE
  // finger must end the session so the trailing orphan pointerup dispatches
  // nothing further, and a fresh pair must recognize exactly once - the
  // recognizer must not strand on the cancelled session.
  const cancelPinch = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const video = document.querySelector("#check-video");
    // Live pair: both down, one move-apart each - recognition fires here.
    // isPrimary rides id === 11 exactly as the per-row closure spelled it.
    window.__pfFire(11, "pointerdown", 0, 0, 1, true);
    window.__pfFire(12, "pointerdown", 60, 0, 1, false);
    window.__pfFire(11, "pointermove", -20, 0, 1, true);
    window.__pfFire(12, "pointermove", 80, 0, 1, false);
    const livePinch = window.__pfEvents.filter((e) => e.startsWith("pinch")).slice();
    // Per-step split: the close sequence must ADD nothing - the counts stay
    // at the live snapshot (the array is not re-seeded between, so the
    // recognition itself is the baseline), and the full array after both
    // closes must be byte-identical to it.
    window.__pfFire(11, "pointercancel", -20, 0, 1, true);
    const afterCancelOnly = window.__pfEvents.filter((e) => e.startsWith("pinch")).length;
    window.__pfFire(12, "pointerup", 80, 0, 0, false);
    const afterOrphanUp = window.__pfEvents.filter((e) => e.startsWith("pinch")).length;
    const eventsAfterClose = window.__pfEvents.slice();
    // Fresh pair, same recipe gestures.mjs pins for the recognition contract.
    window.__pfEvents = [];
    window.__pfFire(21, "pointerdown", 0, 0, 1, false);
    window.__pfFire(22, "pointerdown", 60, 0, 1, false);
    window.__pfFire(21, "pointermove", -20, 0, 1, false);
    window.__pfFire(22, "pointermove", 80, 0, 1, false);
    window.__pfFire(21, "pointerup", -20, 0, 0, false);
    window.__pfFire(22, "pointerup", 80, 0, 0, false);
    setTimeout(() => {
      const follow = window.__pfEvents.filter((e) => e.startsWith("pinch"));
      done({
        ok: true,
        livePinch,
        afterCancelOnly,
        afterOrphanUp,
        eventsAfterClose,
        followPinch: follow,
        transform: video.style.transform,
      });
    }, 400);
  });
  status("pointercancel mid-pinch session: orphan release dispatches nothing (fresh pair still recognizes)",
    cancelPinch.ok === true &&
      cancelPinch.livePinch.length === 1 && cancelPinch.livePinch[0] === "pinch:out" &&
      cancelPinch.afterCancelOnly === cancelPinch.livePinch.length &&
      cancelPinch.afterOrphanUp === cancelPinch.livePinch.length &&
      cancelPinch.eventsAfterClose.length === cancelPinch.livePinch.length &&
      cancelPinch.followPinch.length === 1 && cancelPinch.followPinch[0] === "pinch:out" &&
      cancelPinch.transform === "",
    JSON.stringify(cancelPinch));

  // Fill mode's own interruption rule: a fullscreen exit mid-fill releases
  // the fill instantly (transform cleared, object-fit handed back) - the one
  // cross-feature release the destroy path also relies on. The container box
  // is mismatched against the 16:9 fixture by an explicit stage shape (a
  // 900x720 wrapper: the fixture video's width/height:100% CSS otherwise
  // auto-heights the wrapper to the video's own aspect at ANY width, which
  // is an aspect-matched box whose cover scale is exactly 1 - media.mjs's
  // mismatch came from a fresh video that didn't carry that CSS). The embed
  // owns a staged inline object-fit so the release assert proves the REAL
  // hand-back: the prior value restored, not an empty-vs-empty coincidence.
  // The fill engages through the semantic pinch event the engine dispatches.
  const fillRelease = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ ok: false, why: "no video" }); return; }
    v.closest(".plyr__video-wrapper").style.cssText = "width:900px;height:720px";
    v.style.objectFit = "cover";
    setTimeout(() => {
      document.querySelector(".pf-shell").dispatchEvent(
        new CustomEvent("pf:gesture-pinch", { detail: { direction: "out" } }));
      const deadline = Date.now() + 3000;
      const pollFill = () => {
        if (v.style.transform.indexOf("scale(") === 0 && v.style.objectFit === "contain") {
          // Capture the fill-state reads BEFORE the exit: the done() body
          // runs once, after the release, so the released values must be
          // frozen here while the fill is still live.
          const fillTransform = v.style.transform;
          const fillObjectFit = v.style.objectFit;
          // Fill is live: exit fullscreen for real (the stub dies, the gate
          // re-seats to the API's truth) and the fill must release.
          delete document.fullscreenElement;
          document.dispatchEvent(new Event("fullscreenchange"));
          setTimeout(() => {
            done({ ok: true, fillTransform, fillObjectFit });
          }, 400);
          return;
        }
        if (Date.now() < deadline) setTimeout(pollFill, 100);
        else done({ ok: false, why: "fill never engaged", transform: v.style.transform, objectFit: v.style.objectFit });
      };
      pollFill();
    }, 350);
  });
  // Re-capture the released reads outside the frozen closure (the eval body
  // serializes once; the release values must be read live).
  const released = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return { transform: v.style.transform, objectFit: v.style.objectFit };
  });
  status("fullscreen exit mid-fill releases the fill (box handed back)",
    fillRelease.ok === true && String(fillRelease.fillTransform).startsWith("scale(") &&
      released.transform === "" && released.objectFit === "cover",
    JSON.stringify({ fill: fillRelease, released }));

  // The stub is dead; restore the staged stage shape for the thrash row
  // below (the wrapper's explicit box and the embed's staged fit both go).
  await restoreStage();
  await sleep(200);

  // Destroy-readopt thrash x20: rapid re-homes into fresh Plyr-styled
  // wrappers drive the re-parent seam's destroy-readopt over and over
  // (displaced shells destroyed, never orphaned; mid-boot candidates
  // refused and re-armed). The storm must converge: exactly one shell,
  // attached to the LAST wrapper, with the video stamped again.
  const thrash = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done({ ok: false, why: "no video" }); return; }
    let i = 0;
    const step = () => {
      const second = document.createElement("div");
      second.className = "plyr";
      second.setAttribute("data-plyr", "");
      second.style.cssText = "position:absolute;left:0;top:0;width:1280px;height:720px;";
      second.innerHTML = "<div class=\"plyr__video-wrapper\" style=\"width:100%;height:100%\"></div>";
      document.body.append(second);
      second.querySelector(".plyr__video-wrapper").moveBefore(v, null);
      // Old wrappers stay (media.mjs's proven re-home recipe): the
      // destroy-readopt removes the dead shell's own host DOM, which is
      // exactly what the convergence poll's shells === 1 asserts.
      i++;
      if (i < 20) { setTimeout(step, 220); return; }
      const deadline = Date.now() + 8000;
      const tick = () => {
        const wrapper = v.closest(".plyr__video-wrapper");
        const shellHost = wrapper?.querySelector(".pf-shell");
        const host = !!(shellHost && shellHost.parentElement === wrapper);
        const shells = document.querySelectorAll(".pf-shell").length;
        if (host && shells === 1 && v.matches("[data-pf-shell]")) {
          done({ ok: true, shells, host: true, stamped: true });
          return;
        }
        if (Date.now() < deadline) setTimeout(tick, 150);
        else done({ ok: true, shells, host, stamped: v.matches("[data-pf-shell]") });
      };
      tick();
    };
    step();
  });
  status("destroy-readopt thrash x20 converges to one shell at the last home",
    thrash.ok === true && thrash.shells === 1 && thrash.host === true && thrash.stamped === true,
    JSON.stringify(thrash));

  // Echo-contract budget: N sync GM_setValue calls + their microtask echo
  // deliveries must land inside the budget. The store watch layer plus the
  // kernel's listeners run per write; tiering-era engines make this
  // minutes-cheap,
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
  // tracker is loaded by the earlier playback sweeps, so every write pays
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

  // ---------------------------------------------------------------------
  // Boot 2 - hostile pf:configs seed: the seed-bypass class the ledger
  // adopted must clamp/degrade at the schema bound live.
  // ---------------------------------------------------------------------
  await boot({
    seed: {
      "pf:configs": {
        version: 1,
        filter: { brightness: 1e9, contrast: "alert(1)", saturate: -50, hue: "x" },
      },
    },
  });
  await waitDuration();
  await settle();
  const hostileFilter = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.muted = true;
    v.play();
    return { filter: v.style.filter };
  });
  status("hostile filter seed clamps at the schema bound (brightness 1e9 -> 200%)",
    hostileFilter.filter.includes("brightness(200%)") && !hostileFilter.filter.includes("brightness(1000000"),
    JSON.stringify(hostileFilter));
  status("hostile filter seed degrades to the schema defaults (contrast/hue absent)",
    !hostileFilter.filter.includes("contrast(") && !hostileFilter.filter.includes("hue(") &&
      hostileFilter.filter.includes("saturate(0%)"),
    JSON.stringify(hostileFilter));

  // ---------------------------------------------------------------------
  // Boot 3 - hostile pf:resume doc: the restore clamps at the media sink
  // and the hostile-shape entry rides the string-field admission into a
  // clean History render.
  // ---------------------------------------------------------------------
  const now = Date.now();
  await boot({
    seed: {
      "pf:resume": {
        version: 1,
        updatedAt: now,
        entries: [
          {
            id: "pf-hostile-restore", domain: "127-0-0-1", path: "/check",
            title: "Hostile Restore", duration: 12, resume: 1e9,
            subOffset: 0, createdAt: now - 1000, updatedAt: now,
          },
          {
            id: "pf-hostile-shape", domain: 5, path: "/elsewhere",
            title: { evil: "payload" }, duration: 12, resume: 7,
            createdAt: now - 1000, updatedAt: now,
          },
        ],
      },
    },
  });
  await waitDuration();
  await sleep(1200);
  const hostileRestore = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return { t: v.currentTime, duration: v.duration };
  });
  status("hostile resume position 1e9 restores clamped at the duration",
    hostileRestore.t > 5 && hostileRestore.t <= hostileRestore.duration + 0.5,
    JSON.stringify(hostileRestore));
  await fireKeys(["KeyS"]);
  await sleep(500);
  const hostileHistory = await session.eval(function main() {
    const cards = [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []];
    const texts = cards.map((c) => c.textContent ?? "");
    return { cards: cards.length, poisoned: texts.some((t) => t.includes("[object Object]")) };
  });
  status("hostile-shaped resume entry renders clean (string admission, no [object Object])",
    hostileHistory.cards >= 2 && hostileHistory.poisoned === false,
    JSON.stringify(hostileHistory));
  await fireKeys(["KeyS"]);
  await sleep(300);

  // ---------------------------------------------------------------------
  // Boot 4 - non-object docs: the store's truthiness-object read degrades
  // both roots to defaults without a throw.
  // ---------------------------------------------------------------------
  await boot({ seed: { "pf:configs": "garbage", "pf:resume": 42 } });
  // Park playback first: the fixture autoplays, so the witness must not read
  // normal playback drift as a restore artifact - any wrongly-adopted
  // restore lands above RESUME_MIN_POSITION (5s), drift stays below it.
  await session.eval(function main() {
    document.querySelector("#check-video")?.pause();
  });
  await waitDuration();
  await sleep(1200); // any wrongly-adopted restore seek must have landed
  const nonObjectDocs = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return { filter: v.style.filter, t: v.currentTime };
  });
  status("non-object pf:configs degrades to filter defaults (no throw, no filter)",
    nonObjectDocs.filter === "none",
    JSON.stringify(nonObjectDocs));
  status("non-object pf:resume degrades to no restore (no seek artifact)",
    nonObjectDocs.t < 5,
    JSON.stringify(nonObjectDocs));

  return rows;
}
