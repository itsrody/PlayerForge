import { sleep } from "../../lib/driver.mjs";
/**
 * Interrupted-state + hostile-storage robustness, on the real engine: the
 * interruption rows drive every recorded session-end path (sweep #11: blur,
 * pointercancel, destroy-readopt) live — a mid-hold window blur must release
 * the rate boost, a mid-drag/mid-swipe/mid-pinch pointercancel must end the
 * stroke with no stranded transform or latch and leave the recognizer
 * working for the next stroke, a fullscreen exit mid-fill must hand the
 * element box back, and a rapid re-home storm must converge to exactly one
 * shell. The hostile-storage rows pin the Native-first ledger's admission
 * adoptions ON the floor: a hostile pf:configs seed must clamp at the
 * FILTER_SCHEMA bound the steppers commit with (the seed-bypass class), a
 * hostile pf:resume entry must clamp its restore at the media sink and ride
 * the string-field admission into a clean History render, and non-object
 * docs must degrade to defaults without a throw. Uncaught errors and
 * rejections from any row fail the case through the stage's audit net.
 */
export async function run({ session, boot }) {
  const rows = [];
  const status = (rowsArg, name, ok, note = null) => rows.push({ name, status: ok === true ? "pass" : "fail", note: ok === true ? null : note, ms: null });
  const raw = session.raw;
  const KEY_OF = { KeyS: "s" };
  const fireKeys = async (codes) => {
    const actions = raw.actions({ async: true });
    for (const code of codes) {
      actions.keyDown(KEY_OF[code]).keyUp(KEY_OF[code]).pause(80);
    }
    await actions.perform();
  };
  const waitDuration = () => session.waitFor(
    "return (() => { const v = document.querySelector('#check-video'); return v && v.duration > 3 ? v.duration : false; })()",
    6000
  );
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

  // ---------------------------------------------------------------------
  // Boot 1 - the interruption/thrash plane on a normal install.
  // ---------------------------------------------------------------------
  await boot();
  await waitDuration();
  await sleep(900); // kernel boot re-anchor settles (shared boot drive pattern)
  await wireGestureRecorder();

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
  status(rows, "window blur mid-hold releases the boost (stray keyup stays a no-op)",
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
  status(rows, "panel churn x10 ends closed with the toggle still live",
    churn.ok === true && churn.closedAfterChurn === true && churn.reopened === true && churn.reclosed === true,
    JSON.stringify(churn));

  // The fs-gated territory: scrub/swipe/pinch are fs:true-binding intents,
  // so the Fullscreen API's own datum is mounted (the same synthetic-API
  // arc gestures.mjs pins) and a synthetic fullscreenchange fires the update.
  await session.eval(function main() {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get() { return document.querySelector(".pf-shell"); }
    });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  await sleep(200);

  // Scrub storm x30: every rapid stroke must end (scrub-end per stroke), and
  // the storm must leave no stranded state - rate, volume, mute untouched.
  const storm = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const host = document.querySelector(".pf-shell");
    const video = document.querySelector("#check-video");
    if (!host || !video) { done({ ok: false, why: "no shell/video" }); return; }
    const rect = video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type, x, y, buttons) => video.dispatchEvent(new PointerEvent(type, {
      pointerId: 5,
      pointerType: "touch",
      isPrimary: true,
      button: type === "pointerup" ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
    let ends = 0;
    host.addEventListener("pf:gesture-scrub-end", () => { ends++; });
    const volumeBefore = video.volume;
    for (let i = 0; i < 30; i++) {
      fire("pointerdown", cx, cy, 1);
      fire("pointermove", cx + 40, cy, 1);
      fire("pointerup", cx + 40, cy, 0);
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
  status(rows, "scrub storm x30: every stroke ends, playback state untouched",
    storm.ok === true && storm.ends === 30 && storm.rate === 1 && storm.muted === false && storm.volume === storm.volumeBefore,
    JSON.stringify(storm));

  // Pointercancel mid-drag: the cancel path must run the stroke's end (the
  // scrub-end dispatch the engine pairs with any release shape) and strand
  // nothing, then a fresh drag must scrub again.
  const cancelDrag = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const video = document.querySelector("#check-video");
    const rect = video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type, x, y, buttons) => video.dispatchEvent(new PointerEvent(type, {
      pointerId: 6,
      pointerType: "touch",
      isPrimary: true,
      button: type === "pointerup" ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
    fire("pointerdown", cx, cy, 1);
    fire("pointermove", cx + 60, cy, 1);
    fire("pointercancel", cx + 60, cy, 1);
    const cancelled = window.__pfEvents.slice();
    setTimeout(() => {
      window.__pfEvents = [];
      fire("pointerdown", cx, cy, 1);
      fire("pointermove", cx + 50, cy, 1);
      fire("pointerup", cx + 50, cy, 0);
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
  status(rows, "pointercancel mid-drag ends the scrub (follow-up drag still scrubs)",
    cancelDrag.ok === true && cancelDrag.endAfterCancel === true &&
      cancelDrag.scrubsBeforeCancel > 0 && cancelDrag.followUpScrubs > 0,
    JSON.stringify(cancelDrag));

  // Pointercancel mid-swipe: the transform the stroke wrote must be restored
  // (the release path runs on cancel too), and a follow-up swipe must commit
  // its direction - the recognizer must not strand on the cancelled stroke.
  const cancelSwipe = await session.evalAsync(function main(done) {
    window.__pfEvents = [];
    const video = document.querySelector("#check-video");
    const rect = video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type, x, y, buttons) => video.dispatchEvent(new PointerEvent(type, {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      button: type === "pointerup" ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
    fire("pointerdown", cx, cy, 1);
    fire("pointermove", cx, cy + 40, 1);
    const midTransform = video.style.transform;
    fire("pointercancel", cx, cy + 40, 1);
    const cancelled = window.__pfEvents.slice();
    setTimeout(() => {
      const restored = video.style.transform;
      window.__pfEvents = [];
      fire("pointerdown", cx, cy, 1);
      fire("pointermove", cx, cy + 150, 1);
      fire("pointerup", cx, cy + 150, 0);
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
  status(rows, "pointercancel mid-swipe restores the transform (follow-up swipe still commits)",
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
    const rect = video.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type, id, x, y, buttons) => video.dispatchEvent(new PointerEvent(type, {
      pointerId: id,
      pointerType: "touch",
      isPrimary: id === 11,
      button: type === "pointerup" ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }));
    // Live pair: both down, one move-apart each - recognition fires here.
    fire("pointerdown", 11, cx, cy, 1);
    fire("pointerdown", 12, cx + 60, cy, 1);
    fire("pointermove", 11, cx - 20, cy, 1);
    fire("pointermove", 12, cx + 80, cy, 1);
    const livePinch = window.__pfEvents.filter((e) => e.startsWith("pinch")).slice();
    // Per-step split: the close sequence must ADD nothing - the counts stay
    // at the live snapshot (the array is not re-seeded between, so the
    // recognition itself is the baseline), and the full array after both
    // closes must be byte-identical to it.
    fire("pointercancel", 11, cx - 20, cy, 1);
    const afterCancelOnly = window.__pfEvents.filter((e) => e.startsWith("pinch")).length;
    fire("pointerup", 12, cx + 80, cy, 0);
    const afterOrphanUp = window.__pfEvents.filter((e) => e.startsWith("pinch")).length;
    const eventsAfterClose = window.__pfEvents.slice();
    // Fresh pair, same recipe gestures.mjs pins for the recognition contract.
    window.__pfEvents = [];
    fire("pointerdown", 21, cx, cy, 1);
    fire("pointerdown", 22, cx + 60, cy, 1);
    fire("pointermove", 21, cx - 20, cy, 1);
    fire("pointermove", 22, cx + 80, cy, 1);
    fire("pointerup", 21, cx - 20, cy, 0);
    fire("pointerup", 22, cx + 80, cy, 0);
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
  status(rows, "pointercancel mid-pinch session: orphan release dispatches nothing (fresh pair still recognizes)",
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
  status(rows, "fullscreen exit mid-fill releases the fill (box handed back)",
    fillRelease.ok === true && String(fillRelease.fillTransform).startsWith("scale(") &&
      released.transform === "" && released.objectFit === "cover",
    JSON.stringify({ fill: fillRelease, released }));

  // The stub is dead; restore the staged stage shape for the thrash row
  // below (the wrapper's explicit box and the embed's staged fit both go).
  await session.eval(function main() {
    const w = document.querySelector(".plyr__video-wrapper");
    if (w) { w.style.width = ""; w.style.height = ""; }
    const v = document.querySelector("#check-video");
    if (v) v.style.objectFit = "";
  });
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
  status(rows, "destroy-readopt thrash x20 converges to one shell at the last home",
    thrash.ok === true && thrash.shells === 1 && thrash.host === true && thrash.stamped === true,
    JSON.stringify(thrash));

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
  await sleep(900);
  const hostileFilter = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.muted = true;
    v.play();
    return { filter: v.style.filter };
  });
  status(rows, "hostile filter seed clamps at the schema bound (brightness 1e9 -> 200%)",
    hostileFilter.filter.includes("brightness(200%)") && !hostileFilter.filter.includes("brightness(1000000"),
    JSON.stringify(hostileFilter));
  status(rows, "hostile filter seed degrades to the schema defaults (contrast/hue absent)",
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
  status(rows, "hostile resume position 1e9 restores clamped at the duration",
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
  status(rows, "hostile-shaped resume entry renders clean (string admission, no [object Object])",
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
  status(rows, "non-object pf:configs degrades to filter defaults (no throw, no filter)",
    nonObjectDocs.filter === "none",
    JSON.stringify(nonObjectDocs));
  status(rows, "non-object pf:resume degrades to no restore (no seek artifact)",
    nonObjectDocs.t < 5,
    JSON.stringify(nonObjectDocs));

  return rows;
}
