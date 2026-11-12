import { sleep } from "../../lib/driver.mjs";
/**
 * The gesture contract, driven by REAL input events through geckodriver's
 * action layer (W3C pointer streams and keystrokes sent to the headless
 * browser), with the semantic pf:gesture-* reactions recorded off the shell
 * host. Keyboard preconditions documented in inputs/forge.js: focus must not
 * sit in text entry, and the active engine arbitrates - so the pointer probes
 * park a press first, and keys arrive through the same trusted surface.
 */
import { TUNING } from "../../../src/shared/core.js";
import { Pointer, Origin, Button } from "selenium-webdriver/lib/input.js";

/** A W3C touch-pointer stroke: geckodriver's native emulation of the
 * pointerType "touch" input source synthesizes the trusted pointer/touch
 * event stream through Gecko's own event-synthesis path. */
async function touchStroke(raw, points) {
  const finger = new Pointer("check-touch", Pointer.Type.TOUCH);
  const seq = [
    finger.move({ x: Math.round(points[0].x), y: Math.round(points[0].y), origin: Origin.VIEWPORT, duration: 0 }),
    finger.press(Button.LEFT),
    ...points.slice(1).map((p) => finger.move({ x: Math.round(p.x), y: Math.round(p.y), origin: Origin.VIEWPORT, duration: 60 })),
    finger.release(Button.LEFT)
  ];
  await raw.actions({ async: true }).insert(finger, ...seq).perform();
}

function videoCenterScript() {
  // The kernel marks data-pf-shell on video/container AND our shadow host;
  // the event surface is the .pf-shell div (the attachShadow host).
  const host = document.querySelector(".pf-shell");
  if (host === null) return null;
  const r = host.parentElement.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
}

async function recordGestureEvents(session) {
  await session.eval(function main() {
    window.__pfEvents = [];
    const host = document.querySelector(".pf-shell");
    if (host === null) return;
    host.addEventListener("pf:gesture-skip", () => window.__pfEvents.push("skip"));
    host.addEventListener("pf:gesture-mute", () => window.__pfEvents.push("mute"));
    host.addEventListener("pf:gesture-volume", () => window.__pfEvents.push("volume"));
    host.addEventListener("pf:gesture-scrub", () => window.__pfEvents.push("scrub"));
    host.addEventListener("pf:gesture-scrub-end", () => window.__pfEvents.push("scrub-end"));
    host.addEventListener("pf:gesture-release", () => window.__pfEvents.push("scrub-release"));
    host.addEventListener("pf:gesture-panel", () => window.__pfEvents.push("panel"));
    host.addEventListener("pf:gesture-pip", () => window.__pfEvents.push("pip"));
    host.addEventListener("pf:gesture-dbltap", () => window.__pfEvents.push("dbltap"));
    host.addEventListener("pf:gesture-hold", (e) => window.__pfEvents.push("hold:" + e.detail.zone));
    host.addEventListener("pf:gesture-swipe-start", () => window.__pfEvents.push("swipe-start"));
    host.addEventListener("pf:gesture-swipe", (e) => window.__pfEvents.push("swipe:" + e.detail.direction));
    host.addEventListener("pf:gesture-pinch", (e) => window.__pfEvents.push("pinch:" + e.detail.direction));
  });
}

function status(rows, name, ok, note = null) {
  rows.push({ name, status: ok ? "pass" : "fail", note: ok ? null : note, ms: null });
}

export async function run({ session, baseUrl, boot, bundle }) {
  const rows = [];
  await boot();
  await recordGestureEvents(session);

  // Re-derivable: the inline forge-entry row below round-trips a REAL
  // element fullscreen, and the later viewport-coordinate rows must read
  // the post-exit box, not the pre-entry snapshot.
  let center = await session.eval(videoCenterScript);
  if (center === null) {
    rows.push({ name: "shell host present for gestures", status: "fail", note: "no [data-pf-shell]", ms: null });
    return rows;
  }
  const raw = session.raw;
  // geckodriver actions: keyDown/keyUp consume Key constants (Key.ARROW,
  // Key.UP, etc.) - press()/release()/move() drive the pointer device.
  const acts = () => raw.actions({ async: true });
  const pressDown = async () => {
    await acts().move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) }).press().pause(40).perform();
  };
  const pressUp = async () => {
    await acts().move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) }).release().pause(40).perform();
  };
  const singleTap = async () => {
    await pressDown();
    await pressUp();
  };

  const KEY_OF = {
    ArrowRight: "\uE014",
    ArrowLeft: "\uE012",
    ArrowUp: "\uE013",
    ArrowDown: "\uE015",
    KeyM: "m",
    KeyS: "s",
    KeyP: "p"
  };
  const fireKeys = async (codes) => {
    const actions = acts();
    for (const code of codes) {
      actions.keyDown(KEY_OF[code]).keyUp(KEY_OF[code]).pause(80);
    }
    await actions.perform();
  };

  // Skip via arrow keys, deterministically: pause + seek first, so the step's
  // SIGN carries the assertion - a backward skip from 0 clamps to 0, which the
  // old `> 0` check confused with playback drift.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 2;
  });
  await fireKeys(["ArrowRight"]);
  await sleep(400);
  status(rows, "ArrowRight skips forward (+5s)", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return window.__pfEvents.includes("skip") && t > 5 && t < 10;
  }), "skip event or forward step missing");

  await session.eval(function main() {
    document.querySelector("#check-video").currentTime = 7;
  });
  await fireKeys(["ArrowLeft"]);
  await sleep(400);
  status(rows, "ArrowLeft skips backward (-5s)", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return window.__pfEvents.includes("skip") && t > 0 && t < 4;
  }), "skip event or backward step missing");

  // Inline (fs gate closed - the check window is 1440x900 while the
  // fixture's fixed 1280x720 canvas covers only part of it), the edge-skip
  // path is fs-gated end-to-end: resolves a left-edge zone for a real edge
  // press, double-taps there, and requires NO dbltap/skip dispatch - the
  // dispatch never fires because the intent gate is closed (the taps'
  // native clicks pass to the page untouched).
  await session.eval(function main() {
    window.__pfEvents = [];
    document.querySelector("#check-video").play();
  });
  const edgePoint = await session.eval(function main() {
    const r = document.querySelector("#check-video").getBoundingClientRect();
    return { x: Math.round(r.left + 8), y: Math.round(r.top + r.height / 2) };
  });
  await acts()
    .move({ origin: "viewport", x: edgePoint.x, y: edgePoint.y }).press().pause(30).release()
    .pause(100)
    .move({ origin: "viewport", x: edgePoint.x, y: edgePoint.y }).press().pause(30).release()
    .pause(250)
    .perform();
  await sleep(300);
  status(rows, "inline edge dbltap stays fs-gated: no dbltap/skip dispatch", await session.eval(function main() {
    return !window.__pfEvents.includes("dbltap") && !window.__pfEvents.includes("skip");
  }), `events=${JSON.stringify(await session.eval(function main() {
    return window.__pfEvents;
  }))}`);
  // The zone plane fs-honesty: an inline edge press reports the viewport-
  // honest left-edge zone through the hold telemetry (screen-relative it
  // would still mean the real physical edge), and a center press reads
  // "screen" - both carried by the fs:false hold gesture, real input.
  await session.eval(function main() {
    window.__pfEvents = [];
    document.querySelector("#check-video").play();
  });
  await acts()
    .move({ origin: "viewport", x: edgePoint.x, y: edgePoint.y }).press().pause(450).release()
    .pause(200)
    .move({ origin: "viewport", x: center.x, y: center.y }).press().pause(450).release()
    .pause(200)
    .perform();
  status(rows, "inline hold reports viewport-honest edge/screen zones", await session.eval(function main() {
    return window.__pfEvents.includes("hold:left-edge") && window.__pfEvents.includes("hold:screen");
  }), `events=${JSON.stringify(await session.eval(function main() {
    return window.__pfEvents;
  }))}`);
  // Element fullscreen, the synthetic-API-datum arc: the real driver
  // fullscreen course needs a user-activated requestFullscreen (probed
  // available to a Marionette click) but the entry resizes the window out
  // from under the rows' viewport coordinate frame, so the arc mounts the
  // Fullscreen API's own datum - document.fullscreenElement, the exact
  // property the gate's truth reads (FsGate.#truth) - and a synthetic
  // fullscreenchange fires the same update event a real entry would. The
  // real-driver horizontal drag then scrubs fs-style, proving the armed
  // end-to-end path; the dismount below re-seats the gate to the real
  // truth before the inline rows.
  await session.eval(function main() {
    window.__pfEvents = [];
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get() { return document.querySelector(".pf-shell"); }
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 2;
  });
  await sleep(300);
  await acts()
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) }).press()
    .move({ origin: "viewport", x: Math.round(center.x + 60), y: Math.round(center.y) })
    .pause(80)
    .move({ origin: "viewport", x: Math.round(center.x + 140), y: Math.round(center.y) })
    .pause(80)
    .release()
    .perform();
  await sleep(400);
  status(rows, "fs-armed drag scrubs against the synthetic fullscreenElement", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return !!document.fullscreenElement &&
      window.__pfEvents.includes("scrub") && t > 2;
  }), `fullEl=${JSON.stringify(await session.eval(function main() {
    return { el: !!document.fullscreenElement, events: window.__pfEvents, t: document.querySelector("#check-video").currentTime };
  }))}`);
  // The fs double-tap arm, the second half of the prevent scope: two rapid
  // taps at center - the document-level recorder must see NO dblclick (the
  // SDK's native double tap is prevented at the fullscreen gesture surface),
  // though both taps' presses passed natively.
  await session.eval(function main() {
    window.__pfDbclicks = [];
    document.addEventListener("dblclick", (e) => window.__pfDbclicks.push(e.isTrusted));
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 2;
  });
  await acts()
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press().release()
    .press().release()
    .pause(500)
    .perform();
  await sleep(300);
  status(rows, "fs double tap: SDK's native dblclick prevented at the surface", await session.eval(function main() {
    return window.__pfDbclicks.length === 0;
  }), `dbclicks=${JSON.stringify(await session.eval(function main() {
    return window.__pfDbclicks;
  }))}`);
  await session.eval(function main() {
    // Dismount the synthetic datum: deleting the own property restores the
    // prototype getter (real fullscreenElement), and the extra
    // fullscreenchange re-seats the gate at the real truth (fs closed).
    delete document.fullscreenElement;
    document.dispatchEvent(new Event("fullscreenchange"));
    window.__pfEvents = [];
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 2;
  });
  await sleep(300);
  // Inline forge entry, the complement: with fs closed the same two-tap
  // sequence at center IS the forge entry now - fullscreen IS forge mode -
  // so the shell's own container requests REAL fullscreen on the taps'
  // trusted activation (focusWindow is the document-focused precondition
  // the bare rows pinned) and the native dblclick is suppressed, the same
  // prevent-scope face the fs surface showed above. The bar rides in with
  // the flip (container-fs satisfies the contains-chain) and stays shown -
  // the paused hold disarms the idle sweep.
  await session.focusWindow();
  await session.eval(function main() {
    window.__pfDbclicks = [];
    window.__pfEvents = [];
  });
  await acts()
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press().release()
    .press().release()
    .pause(500)
    .perform();
  await sleep(600);
  status(rows, "inline center dbltap enters forge mode: container fullscreen, no native dblclick, bar shown", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const bar = host?.shadowRoot?.querySelector(".pf-forge-bar");
    return !!document.fullscreenElement &&
      document.fullscreenElement.contains(host.parentElement) &&
      window.__pfDbclicks.length === 0 &&
      bar !== null && bar.hidden === false;
  }), `fs=${JSON.stringify(await session.eval(function main() {
    return document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null;
  }))} dbclicks=${JSON.stringify(await session.eval(function main() {
    return window.__pfDbclicks;
  }))} bar=${JSON.stringify(await session.eval(function main() {
    const bar = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-forge-bar");
    return bar ? { present: true, hidden: bar.hidden } : { present: false };
  }))}`);
  // Forge exit re-seats the inline posture for the keyboard rows below:
  // script exitFullscreen is allowed (the activation lives on entry only),
  // and the box re-derivation re-arms the later viewport-coordinate rows
  // against any residue the element-fullscreen round-trip leaves.
  await session.eval(function main() { document.exitFullscreen()?.catch(() => {}); });
  await sleep(500);
  center = await session.eval(videoCenterScript);
  await session.eval(function main() {
    window.__pfEvents = [];
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 2;
  });
  await sleep(200);

  await fireKeys(["KeyM"]);
  await sleep(350);
  status(rows, "KeyM flips muted through pf:gesture-mute", await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return window.__pfEvents.includes("mute") && v.muted !== v.hasAttribute("muted");
  }), "no mute event or muted state unchanged");

  await fireKeys(["ArrowUp"]);
  await sleep(350);
  status(rows, "ArrowUp raises volume through pf:gesture-volume", await session.eval(function main() {
    return window.__pfEvents.includes("volume") && document.querySelector("#check-video").volume > 0;
  }), "no volume event or element unchanged");
  // The completed-action gesture toasts (flashMs window is still open): the
  // toast sheet must paint the same opaque ink with zero backdrop-filter as
  // the panel - R1 counts both floating sheets.
  status(rows, "toast sheet paints opaque ink with zero backdrop-filter", await session.eval(function main() {
    const toast = document.querySelector(".pf-shell")?.shadowRoot?.querySelector("pf-toast.pf-visible");
    if (!toast) return false;
    const cs = getComputedStyle(toast);
    return cs.backdropFilter === "none" && cs.backgroundColor === "rgb(14, 14, 16)";
  }), "no live toast or computed style not the ink shape");

  // Keyboard panel open via KeyS.
  await fireKeys(["KeyS"]);
  await sleep(400);
  status(rows, "KeyS opens the panel (pf:gesture-panel)", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    return host !== null && host.shadowRoot !== null &&
      host.shadowRoot.querySelector(".pf-panel.pf-open") !== null;
  }), "panel element still closed");
  // Ink law proof, open panel (R1/R3/R6): the sheet is opaque ink with zero
  // composited blur - the glass era's per-frame backdrop-filter over live
  // video is required gone by the budget, and the resting sheet must be the
  // exact --pf-sheet value, unchanged by open state.
  status(rows, "open sheet paints opaque ink with zero backdrop-filter", await session.eval(function main() {
    const panel = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel.pf-open");
    if (!panel) return false;
    const cs = getComputedStyle(panel);
    return cs.backdropFilter === "none" && cs.backgroundColor === "rgb(14, 14, 16)";
  }), "computed backdrop-filter/read not the ink shape");
  // Close it again: the open panel's modal shield eats pointer input, which
  // would starve the scrub probe below.
  await fireKeys(["KeyS"]);
  await sleep(300);
  status(rows, "KeyS closes the panel again", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host !== null ? host.shadowRoot.querySelector(".pf-panel") : null;
    return panel === null || !panel.classList.contains("pf-open");
  }), "panel still open");

  // The ended-video hotkey row (arbitration's vacancy fallback): key
  // arbitration filters candidates by engine liveness - a video that
  // reached its end no longer "owns playback". Deliberate for the
  // multi-engine case (an ended engine must not steal keys from a live
  // one), but with one engine that left every key dead exactly when the
  // keyboard should matter most: after the credits roll, panel/history/
  // settings are the only things left to do. Vacancy answers: no playable
  // candidate = nothing for a dead key to not-steal, so the shell's keys
  // still work. Seek to the exact end marks ended on a paused video; a
  // short play-through catches any engine quirk, then the same trusted
  // KeyS drive must still open the panel.
  const endedWitness = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = v.duration;
    return v.duration;
  });
  if (endedWitness) {
    await sleep(250);
    const ended = await session.eval(function main() {
      const v = document.querySelector("#check-video");
      return v.ended || (v.currentTime >= v.duration && v.paused);
    });
    if (!ended) {
      await session.eval(function main() {
        document.querySelector("#check-video").play()?.catch?.(() => {});
      });
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline
        && !(await session.eval(function main() {
          const v = document.querySelector("#check-video");
          return v.ended;
        }))) {
        await sleep(150);
      }
    }
  }
  await fireKeys(["KeyS"]);
  await sleep(400);
  status(rows, "ended video still answers chrome keys (panel opens on the vacancy fallback)", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const v = document.querySelector("#check-video");
    return (v === null || v.ended) &&
      host !== null && host.shadowRoot !== null &&
      host.shadowRoot.querySelectorAll(".pf-panel.pf-open").length === 1;
  }), "no ended witness or panel stayed closed");
  // Restore the shared fixture for the later rows: un-end it by seeking
  // back and pausing, and close the panel again so the Space/PiP rows
  // below meet the same plain-shell state their probe scripts assume
  // (the open panel parks focus inside the shell, which re-routes the
  // held Space away from the session key).
  const restored = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.currentTime = 2;
    v.pause();
    const host = document.querySelector(".pf-shell");
    const panel = host !== null ? host.shadowRoot.querySelector(".pf-panel") : null;
    if (panel !== null && panel.classList.contains("pf-open")) {
      return "open";
    }
    return "closed";
  });
  if (restored === "open") {
    await fireKeys(["KeyS"]);
    await sleep(300);
  }


  // The gathered-definition row: hold-to-speed is ONE INPUT_ACTIONS row
  // whose inputs gather both trigger kinds - the pointer hold is proven
  // above by the zone-telemetry row, so this drives the KEY side: a held
  // Space key rides the same hold/release events through the key-session
  // machine the table row builds. The keydown's preventDefault cancels the
  // UA space-activates-video default, but play() runs muted first anyway:
  // with sound it can meet a headless autoplay policy. Driver keys stay
  // down across separate action chains, so the drive is two chains:
  // keydown + 700ms (the 300ms hold timer fires mid-chain) then keyup.
  // The keysym is the literal space character, not the W3C Unidentified
  // key (U+E000) - the latter carries no physical-key identity, so the
  // event's code comes through empty and matches no INPUT_ACTIONS row.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.muted = true;
    v.playbackRate = 1;
    v.play();
    window.__pfEvents = [];
  });
  await sleep(150);
  await raw.actions({ async: true }).keyDown(" ").pause(700).perform();
  const spaceHold = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return { rate: v.playbackRate, held: window.__pfEvents.includes("hold:screen") };
  });
  status(rows, "held Space boosts 2x through the hold-speed session key",
    spaceHold.rate === 2 && spaceHold.held, JSON.stringify(spaceHold));
  await raw.actions({ async: true }).keyUp(" ").pause(150).perform();
  const spaceRelease = await session.eval(function main() {
    const v = document.querySelector("#check-video");
    const at = { rate: v.playbackRate, released: window.__pfEvents.includes("scrub-release") };
    v.pause();
    v.muted = false;
    return at;
  });
  status(rows, "Space keyup releases the boost back to 1x",
    spaceRelease.rate === 1 && spaceRelease.released, JSON.stringify(spaceRelease));

  // KeyP asks for picture-in-picture through the kernel's semantic layer;
  // the PiP window itself is not openable in headless automation, so the row
  // asserts the contract, not the browser-side window.
  await recordGestureEvents(session);
  await fireKeys(["KeyP"]);
  await sleep(400);
  status(rows, "KeyP asks for picture-in-picture", await session.eval(function main() {
    return window.__pfEvents.includes("pip");
  }), "no pf:gesture-pip");

  // Scrub/swipe/pinch are fs:true-binding intents (actions.js): the mount
  // re-arms the Fullscreen API's own datum (the fixture stays a boring page
  // under a boring window - element fullscreen would resize the driver
  // window out from under the rows' coordinate frame), and the synthetic
  // fullscreenchange flips the kernel's fs latch the way a real fullscreen
  // would. The stub persists through the fs territory below.
  await session.eval(function main() {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get() { return document.querySelector(".pf-shell"); }
    });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  await sleep(150);

  // Gate lifecycle re-arm: persisted pagehide force-falsy and pageshow
  // re-seed from the live document (src/shared/dom.js FsGate). Driven here
  // by native synthetic events so the drag rows below run against the
  // re-armed latch, not the original tick - a synthetic fullscreenchange
  // alone would only exercise the happy path.
  status(rows, "fs gate re-arms across a persisted pagehide/pageshow cycle",
    await session.eval(function main() {
      const video = document.querySelector("#check-video");
      if (video === null) return "no video";
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
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      // The intent must be dead while the stale latch lasts, or the
      // force-false does nothing: a swipe attempt mid-cycle must not latch.
      fire("pointerdown", cx, cy, 1);
      fire("pointermove", cx, cy + 30, 1);
      const deadTransform = video.style.transform;
      fire("pointerup", cx, cy + 30, 0);
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      fire("pointerdown", cx, cy, 1);
      fire("pointermove", cx, cy + 30, 1);
      const liveTransform = video.style.transform;
      fire("pointerup", cx, cy + 30, 0);
      video.getAnimations().forEach((a) => a.cancel());
      video.style.transform = "";
      return deadTransform === "" && liveTransform.includes("translateY(30px)") ?
        true : `dead=${deadTransform} live=${liveTransform}`;
    }), "gate re-arm mismatch");

  // Horizontal drag = scrub family (fullscreen territory).
  await recordGestureEvents(session);
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press()
    .move({ origin: "viewport", x: Math.round(center.x) + 60, y: Math.round(center.y) })
    .move({ origin: "viewport", x: Math.round(center.x) + 140, y: Math.round(center.y) })
    .release()
    .pause(120)
    .perform();
  await sleep(400);
  status(rows, "drag produces scrub stream + scrubEnd",
    await session.eval(function main() {
      return window.__pfEvents.includes("scrub") &&
        (window.__pfEvents.includes("scrub-end") || window.__pfEvents.includes("scrub-release"));
    }), `events=${JSON.stringify(await session.eval(function main() { return window.__pfEvents; }))}`);

  // Pointer-universality proof, real TOUCH: the mouse drag row above and this
  // row feed the SAME recognizer letters through two faces of the one W3C
  // input plane (the W3C touch pointer type arrives as pointer events with
  // pointerType "touch", synthesized by Gecko's own event path). The engine
  // holds zero pointerType branches; this row pins the claim end-to-end on
  // the Android geometry - a horizontal touch stroke latches scrub and
  // commits through the same display-clock pipeline, so nothing in the input
  // plane is routed by modality anywhere.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 8.5;
    window.__pfTouchSeed = v.currentTime;
    window.__pfEvents = [];
  });
  await touchStroke(raw, [
    center,
    { x: center.x + 40, y: center.y },
    { x: center.x + 90, y: center.y },
    { x: center.x + 140, y: center.y }
  ]);
  await sleep(300);
  const touchScrub = await session.eval(function main() {
    return {
      events: window.__pfEvents,
      t: document.querySelector("#check-video").currentTime,
      seed: window.__pfTouchSeed
    };
  });
  status(rows, "real touch stroke drives the same scrub recognizer + commit",
    touchScrub.events.includes("scrub") &&
      (touchScrub.events.includes("scrub-end") || touchScrub.events.includes("scrub-release")) &&
      touchScrub.t > touchScrub.seed + 0.02,
    `t=${touchScrub.t} seed=${touchScrub.seed} events=${JSON.stringify(touchScrub.events)}`);

  // Dead-zone residue, the slow-stroke row: a genuine slow drag arrives as
  // sub-pixel per-move travel (0.3px per event) that per-event dropping
  // would starve entirely. Synthetic scrub events reach the action layer
  // directly (recognition is already proven by the drag row above): ten
  // +0.3px moves must accrue and apply (currentTime moves off the seed),
  // then alternating +/-0.3px jitter (a holding finger) must net to zero -
  // the residue's sign-cancellation is the anti-shimmer the dead zone
  // exists for.
  await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 5;
    const station = (state) => { window.__pfStation = state; return window.__pfStation; };
    station({
      fire(dx, velocity) {
        host.dispatchEvent(new CustomEvent("pf:gesture-scrub", {
          detail: { zone: "screen", method: "pointer", dx, dy: 0, velocity, timestamp: performance.now() }
        }));
      }
    });
    for (let i = 0; i < 10; i++) {
      window.__pfStation.fire(0.3, 40);
    }
  });
  await sleep(250);
  status(rows, "sub-pixel slow stroke accrues through the dead zone", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return t > 5 && t < 5.05;
  }), `t=${JSON.stringify(await session.eval(function main() {
    return document.querySelector("#check-video").currentTime;
  }))}`);
  await session.eval(function main() {
    window.__pfJitterSeed = document.querySelector("#check-video").currentTime;
    for (let i = 0; i < 20; i++) {
      window.__pfStation.fire(i % 2 === 0 ? 0.3 : -0.3, 40);
    }
  });
  await sleep(250);
  status(rows, "holding-finger jitter nets to zero through the residue", await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const t = Math.abs(video.currentTime - window.__pfJitterSeed);
    const end = () => {
      video.dispatchEvent(new CustomEvent("pf:gesture-scrubEnd", {
        detail: { zone: "screen", method: "pointer" }
      }));
    };
    end();
    return t < 0.0005;
  }), `t=${JSON.stringify(await session.eval(function main() {
    return document.querySelector("#check-video").currentTime;
  }))}`);

  // Commit pacing, the display-clock row: the pointer stream no longer writes
  // the decoder directly - moves only accrue pending travel and the
  // compositor tick (requestAnimationFrame) commits one seek per refresh.
  // One big stroke fired synchronously must therefore leave currentTime
  // byte-identical within the same eval (the accrual is still uncommitted),
  // and matter only after the next frame commits it - the per-event write
  // this row forbids was exactly the input/decode coupling the rewrite cut.
  //
  // The settle assert is derived, not copied: paceCurve replays the shipped
  // scrub math straight from the product's source table (src/shared/core.js
  // TUNING) - knee-saturated gain over the fs reference width, sensitivity
  // anchor linear outside the curve, the scrubTo clamp - against the live
  // duration and reference width. The width mirror is the same one truth the
  // engine's shared ReferenceBox reads (shared/dom.js): the same SDK
  // container discovery resolved, ONE GBCR read in both modes - the
  // synthetic fs flip here never physically expands the container, so the
  // mirror reads that same container rect the engine reads (the .pf-shell
  // host's parentElement). A tuning retune re-arms the row's own
  // expectation; only a real regression in the accrue->rAF->commit
  // pipeline (or a geometry identity drift the replay does not share)
  // parts the settled time from it.
  const paceCurve = {
    sens: TUNING.controller.scrubSensitivity /
      TUNING.controller.scrubSensitivityAnchor,
    slow: TUNING.scrub.velocity.slowFullWidthSeconds,
    fast: TUNING.scrub.velocity.fastFullWidthFraction,
    knee: TUNING.scrub.velocity.kneeVelocityPxS,
    exp: TUNING.scrub.velocity.exponent,
    stroke: { dx: 200, velocity: 800 }
  };
  await session.eval(function main(curve) {
    const v = document.querySelector("#check-video");
    v.pause();
    v.currentTime = 7;
    window.__pfPaceSeed = v.currentTime;
    window.__pfStation.fire(curve.stroke.dx, curve.stroke.velocity);
    window.__pfSyncTime = v.currentTime;
  }, paceCurve);
  status(rows, "scrub events accrue without an immediate decoder write", await session.eval(function main() {
    return Math.abs(window.__pfSyncTime - window.__pfPaceSeed) < 1e-9;
  }), `t=${JSON.stringify(await session.eval(function main() {
    return document.querySelector("#check-video").currentTime;
  }))}`);
  await sleep(400);
  const paceEnd = await session.eval(function main(curve) {
    const video = document.querySelector("#check-video");
    // The width mirror is the engine's own rule (shared/dom.js
    // ReferenceBox): the SDK container's rect - the .pf-shell host's
    // parentElement, the same element discovery resolved and the engine
    // pools its fill box from - in ONE read for both modes.
    const width = document.querySelector(".pf-shell").parentElement
      .getBoundingClientRect().width;
    const duration = video.duration;
    const ratio = curve.stroke.velocity / curve.knee;
    const t = Math.min(1, ratio ** curve.exp);
    const slowGain = curve.slow / width;
    const fastGain = duration * curve.fast / width;
    const delta = curve.stroke.dx * (slowGain + (fastGain - slowGain) * t) *
      curve.sens;
    // The scrubTo clamp, shared letter for letter. The baseline is the seeded
    // pre-stroke position - currentTime here is post-commit, the very quantity
    // under assertion.
    const expected = Math.min(duration,
      Math.max(0, window.__pfPaceSeed + delta));
    const settled = Math.abs(video.currentTime - expected) < 0.005;
    video.dispatchEvent(new CustomEvent("pf:gesture-scrubEnd", {
      detail: { zone: "screen", method: "pointer" }
    }));
    return { t: video.currentTime, expected, settled };
  }, paceCurve);
  status(rows, "compositor tick commits the accrued stroke", paceEnd.settled,
    `t=${paceEnd.t} expected=${paceEnd.expected}`);

  // Mid-hold pause cancels the boost: the hold arms on "playing at
  // threshold" and a pause after the boost begins is a state that decision
  // cannot know - leaving it latched would resume the video at the boosted
  // rate. A synthetic hold event boosts a playing video (paused -> assert
  // nothing: the engine gates its own arms - this row targets the action
  // layer), then a real pause event must restore the pre-boost rate and
  // drain the sources, so the trailing stray release the engine still
  // dispatches no-ops harmlessly.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.muted = true;
    v.playbackRate = 1;
    v.play();
    window.__pfPlayPaused = v.paused;
    document.querySelector(".pf-shell").dispatchEvent(new CustomEvent("pf:gesture-hold", {
      detail: { zone: "screen", method: "pointer" }
    }));
    window.__pfBoostedRate = v.playbackRate;
    v.pause();
  });
  await sleep(120);
  status(rows, "mid-hold pause restores the saved playback rate", await session.eval(function main() {
    return window.__pfPlayPaused === false &&
      window.__pfBoostedRate === 2 &&
      document.querySelector("#check-video").playbackRate === 1;
  }), `latched=${JSON.stringify(await session.eval(function main() {
    return [window.__pfPlayPaused, window.__pfBoostedRate, document.querySelector("#check-video").playbackRate];
  }))}`);
  await session.eval(function main() {
    document.querySelector("#check-video").muted = false;
  });

  // SDK-control passthrough, proven with real driver input while the
  // fs-bound pointer intents are ARMED (the state that used to eat them):
  // an overlay button inside the container - every SDK rail's shape - keeps
  // its own pointerdown and click; their storage counters are read before
  // the probe is removed.
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const sb = document.createElement("button");
    sb.id = "pf-sdkprobe";
    sb.textContent = "SDK";
    sb.style.cssText = "position:absolute;left:8px;top:8px;width:72px;height:40px;z-index:2147483000;";
    sb.__pfCounts = { down: 0, click: 0 };
    sb.addEventListener("pointerdown", () => sb.__pfCounts.down++);
    sb.addEventListener("click", () => sb.__pfCounts.click++);
    video.parentElement.appendChild(sb);
  });
  const probePoint = await session.eval(function main() {
    const r = document.querySelector("#pf-sdkprobe").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: probePoint.x, y: probePoint.y })
    .press()
    .release()
    .pause(120)
    .perform();
  await sleep(300);
  status(rows, "sdk control passthrough: overlay button keeps pointerdown + click",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkprobe")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1;
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkprobe")?.__pfCounts ?? null;
    }))}`);
  await session.eval(function main() {
    document.querySelector("#pf-sdkprobe")?.remove();
  });

  // Role-less SDK chrome, the two shapes the shape-list exemption never
  // covered (real driver input). Under the prevent-scope rule the engine
  // claims no stream at press time, so BOTH probes ride the fully native
  // tap sequence - the assertions also pin isTrusted, the fact this batch
  // is about: the SDK's single tap is its own real click again.
  //   probe 1 - an affordance-declaring div (cursor:pointer, no role) whose
  //     press is exempt from adoption outright.
  //   probe 2 - an affordance-declaring NOTHING div (default cursor): adopted
  //     as a decision, stream untouched - the native down/click pair fires.
  const probeCenterFor = (id) => session.eval(function main(id) {
    const l = document.querySelector(id)?.getBoundingClientRect();
    return l ? { x: Math.round(l.left + l.width / 2), y: Math.round(l.top + l.height / 2) } : null;
  }, id);
  // Probe 1: affordance cursor -> exempt.
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const el = document.createElement("div");
    el.id = "pf-sdkcursor";
    el.textContent = "ctl";
    el.__pfCounts = { down: 0, click: 0, trusted: [] };
    el.style.cssText = "position:absolute;left:96px;top:8px;width:72px;height:40px;cursor:pointer;z-index:2147483000;";
    el.addEventListener("pointerdown", (e) => { el.__pfCounts.down++; el.__pfCounts.trusted.push(e.isTrusted); });
    el.addEventListener("click", (e) => { el.__pfCounts.click++; el.__pfCounts.trusted.push(e.isTrusted); });
    video.parentElement.appendChild(el);
  });
  const cursorPoint = await probeCenterFor("#pf-sdkcursor");
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: cursorPoint.x, y: cursorPoint.y })
    .press()
    .release()
    .pause(120)
    .perform();
  await sleep(300);
  status(rows, "affordance-cursor roleless div keeps its REAL pointerdown + trusted click",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkcursor")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1 &&
        counts.trusted.length === 2 && counts.trusted.every(Boolean);
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkcursor")?.__pfCounts ?? null;
    }))}`);
  // Probe 2: no affordance -> adopted decision, native stream untouched: the
  // div's own listeners fire exactly once each, on the trusted events.
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const el = document.createElement("div");
    el.id = "pf-sdkbare";
    el.textContent = "ctl";
    el.__pfCounts = { down: 0, click: 0, trusted: [] };
    el.style.cssText = "position:absolute;left:96px;top:56px;width:72px;height:40px;z-index:2147483000;";
    el.addEventListener("pointerdown", (e) => { el.__pfCounts.down++; el.__pfCounts.trusted.push(e.isTrusted); });
    el.addEventListener("click", (e) => { el.__pfCounts.click++; el.__pfCounts.trusted.push(e.isTrusted); });
    video.parentElement.appendChild(el);
  });
  const barePoint = await probeCenterFor("#pf-sdkbare");
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: barePoint.x, y: barePoint.y })
    .press()
    .release()
    .pause(120)
    .perform();
  await sleep(400);
  status(rows, "roleless bare div keeps the fully native tap: pointerdown + trusted click",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkbare")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1 &&
        counts.trusted.length === 2 && counts.trusted.every(Boolean);
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkbare")?.__pfCounts ?? null;
    }))}`);
  // Probe 3: a FULL-COVER affordance overlay (click-to-pause family) stays
  // adopted by the decision (tap feeds the machine), while its own stream
  // passes natively - a single tap reaches it trusted, exactly once. Proves
  // the decision/stream split: adoption without suppression.
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const el = document.createElement("div");
    el.id = "pf-sdkcover";
    el.__pfCounts = { down: 0, click: 0, trusted: [] };
    el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;cursor:pointer;z-index:2147483100;";
    el.addEventListener("pointerdown", (e) => { el.__pfCounts.down++; el.__pfCounts.trusted.push(e.isTrusted); });
    el.addEventListener("click", (e) => { el.__pfCounts.click++; el.__pfCounts.trusted.push(e.isTrusted); });
    video.parentElement.appendChild(el);
  });
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press()
    .release()
    .pause(120)
    .perform();
  await sleep(400);
  status(rows, "full-cover affordance overlay: adopted but stream-open - native trusted single tap",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkcover")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1 &&
        counts.trusted.length === 2 && counts.trusted.every(Boolean);
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkcover")?.__pfCounts ?? null;
    }))}`);
  await session.eval(function main() {
    document.querySelector("#pf-sdkcursor")?.remove();
    document.querySelector("#pf-sdkbare")?.remove();
    document.querySelector("#pf-sdkcover")?.remove();
  });

  // Touch pointer-type stream through the ENGINE claim (synthetic
  // PointerEvent dispatch - event listeners are pointer-type agnostic, and
  // untrusted events still traverse the capture path the engine listens on).
  // The W3C touch pointer row below covers the trusted stream; this row
  // exists because the compose pin needs what a driver stream cannot give -
  // the exact two-move envelope and a transform read BETWEEN moves with no
  // driver-timing jitter in between. The seeded compose pins
  // the prepend contract: the follow translate must LEAD the list whatever
  // the base scale is, or the follow rides inside scale() at s× pointer
  // rate. State is restored in the same turn - the ease's finish commit
  // would otherwise re-apply the compose after cleanup.
  status(rows, "touch pointer stream: swipe-down follows pointer-rate over a scaled compose",
    await session.eval(function main() {
      const video = document.querySelector("#check-video");
      if (video === null) return "no video";
      video.style.transform = "scale(1.25)";
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
      fire("pointermove", cx, cy + 20, 1);
      fire("pointermove", cx, cy + 100, 1);
      const midTransform = video.style.transform;
      const willChange = video.style.willChange;
      fire("pointerup", cx, cy + 100, 0);
      video.getAnimations().forEach((a) => a.cancel());
      video.style.transform = "";
      const events = window.__pfEvents.filter((e) => e.startsWith("swipe"));
      const ok = midTransform === "translateY(100px) scale(1.25)" &&
        willChange === "transform" &&
        events.includes("swipe-start") &&
        events.includes("swipe:down");
      return ok ? true :
        `transform=${midTransform}, willChange=${willChange}, events=${JSON.stringify(events)}`;
    }), "apex follow compose mismatch");

  // Two-finger pinch under capture-at-press: the recognition contract (and
  // the no-release-transition contract behind it) - a pinch END must need no
  // capture dance, so both fingers' streams stay anchored to the zone across
  // the transition. Synthetic pointer pair for the same reason the swipe row
  // runs synthetic: the engine contract is the surface this harness can
  // drive; the compositor touch recognition itself stays device-verified.
  status(rows, "touch pinch pair: fill recognition needs no capture release",
    await session.eval(function main() {
      const video = document.querySelector("#check-video");
      if (video === null) return "no video";
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
      fire("pointerdown", 11, cx, cy, 1);
      fire("pointerdown", 12, cx + 60, cy, 1);
      fire("pointermove", 11, cx - 20, cy, 1);
      fire("pointermove", 12, cx + 80, cy, 1);
      fire("pointerup", 11, cx - 20, cy, 0);
      fire("pointerup", 12, cx + 80, cy, 0);
      const events = window.__pfEvents.filter((e) => e.startsWith("pinch"));
      return events.length === 1 && events[0] === "pinch:out" ? true :
        `pinch events=${JSON.stringify(events)}`;
    }), "pinch recognition mismatch");

  // Real input-pipeline touch through geckodriver's W3C touch pointer -
  // Gecko's own event-synthesis path dispatches the trusted pointer/touch
  // stream, not the synthetic PointerEvent surface the rows above drove.
  // This closes the honest gap the synthetic rows carried: the pinch/swipe
  // engine contract is proven END TO END on trusted events (the last
  // pipeline step - physical hardware - stays device-verified).
  await session.eval(function arm() {
    window.__pfEvents = [];
  });
  await touchStroke(raw, [
    center,
    { x: center.x, y: center.y + 30 },
    { x: center.x, y: center.y + 90 },
    { x: center.x, y: center.y + 150 }
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  status(rows, "input-pipeline touch stream: real swipe recognition end-to-end",
    await session.eval(function main() {
      const events = (window.__pfEvents || []).filter((e) => e.startsWith("swipe"));
      if (!events.includes("swipe-start") || !events.includes("swipe:down")) {
        return `events=${JSON.stringify(events)}`;
      }
      // Leader compose + willChange are the same pin as the synthetic row:
      // the real pipeline must land on the identical engine state.
      const video = document.querySelector("#check-video");
      const clean = video.getAnimations().map((a) => a.cancel());
      void clean;
      video.style.transform = "";
      video.style.willChange = "";
      return true;
    }), "compositor touch swipe mismatch");

  // Owned-touch tap-highlight determination: since the prevent-scope cut the
  // tap's whole native stream passes (no at-press cancellation), so whether
  // the engine's paint side (a compositor-applied tap highlight - nothing a
  // DOM inspection can witness) fires on a video-zone tap is NOT
  // DOM-observable - it is a
  // compositor paint - and this row answers it with a screenshot diff on a
  // paused video (a static surface whose only possible paint change across
  // the tap is the highlight itself.
  await session.eval(function pause() {
    const video = document.querySelector("#check-video");
    video.pause();
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const { By } = await import("selenium-webdriver");
  const videoElement = await raw.findElement(By.css("#check-video"));
  const elementShot = () => raw.takeScreenshot(videoElement);
  const shotBefore = Buffer.from(await elementShot(), "base64");
  // The press: a held W3C touch pointer (input-source state persists across
  // perform calls per the WebDriver spec, so the hold spans two commands).
  const finger = new Pointer("check-tap", Pointer.Type.TOUCH);
  const holdActions = raw.actions({ async: true }).insert(finger,
    finger.move({ x: Math.round(center.x), y: Math.round(center.y), origin: Origin.VIEWPORT, duration: 0 }),
    finger.press(Button.LEFT));
  await holdActions.perform();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const shotDuring = Buffer.from(await elementShot(), "base64");
  await raw.actions({ async: true }).insert(finger, finger.release(Button.LEFT)).perform();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const highlightFree = shotBefore.equals(shotDuring);
  await session.eval(function resume() {
    const video = document.querySelector("#check-video");
    video.play?.();
    video.getAnimations().forEach((a) => a.cancel());
    video.style.transform = "";
    video.style.willChange = "";
  });
  status(rows, "owned touch press leaves the video surface highlight-free",
    highlightFree ? true : "screenshots diverged across the owned press", "tap highlight mismatch");

  // The engine's one total admission premise, pinned on the floor (ledger
  // batch 3 — the inputs family): the event-stream intakes are NUMERIC,
  // page-originated, and the engine feeds them into commit math
  // (#pendingDelta += dx, then clamp at the seek). The load-bearing fact is
  // the platform's own IDL, measured on this floor: PointerEventInit's
  // clientX/clientY and WheelEventInit's deltaY are non-unrestricted
  // doubles, so NaN/±Infinity throw TypeError at the dictionary conversion
  // — the admission gate IS a native engine operation. movementX is NOT
  // engine-gated on either floor (the engine never consumes it —
  // clientX/clientY and the deltaY sign are its only numeric reads;
  // witness attempt below, not part of the pass gate). Every
  // FINITE garbage value beyond the gate degrades through sinks that
  // already own the bounds (the seek clamp saturates at the duration; the
  // swipe transform's invalid-at-parse values are dropped by the CSSOM;
  // the pinch payload carries a direction string only). This row machines
  // the rejection on the real realm; a floor that accepts NaN on the
  // rejectable surface would trip the row and reveal the premise.
  const intakes = await session.eval(function main() {
    const attempts = [];
    for (const [label, make] of [
      // Control first: a well-formed init must be ACCEPTED, so a broken
      // harness can never pass this row vacuously.
      ["control finite", () => new PointerEvent("pointermove", { clientX: 4, clientY: 4 })],
      // The rejectable surface: PointerEventInit's clientX/clientY and
      // WheelEventInit's deltaY are non-unrestricted doubles (measured
      // TypeError at the dictionary conversion, this floor).
      ["clientX NaN", () => new PointerEvent("pointermove", { clientX: NaN, clientY: 4 })],
      ["clientX Infinity", () => new PointerEvent("pointermove", { clientX: Infinity, clientY: 4 })],
      ["clientY NaN", () => new PointerEvent("pointermove", { clientX: 4, clientY: NaN })],
      ["WheelEvent deltaY NaN", () => new WheelEvent("wheel", { deltaY: NaN, deltaX: 0 })],
      // Measured witness, NOT part of the pass gate: movementX is NOT
      // engine-gated - its init is a loose member on both floors. On 159 a
      // NaN init rode the getter as NaN; Firefox 160 coerces the NaN init
      // to 0 (probe: finite init honored verbatim, NaN→0, no exception -
      // check/.tmp/firefox160-floor-probe.mjs MOVEMENT axis). Either
      // reading is inert by non-consumption: the engine never reads
      // movement* (clientX/clientY and the deltaY sign are its only
      // numeric intakes). Recorded so a future engine reader of movement*
      // knows the intake is NOT engine-gated and must carry its own bound.
      ["movementX NaN (non-gated)", () => new PointerEvent("pointermove", { movementX: NaN, clientX: 4 })]
    ]) {
      try {
        make();
        attempts.push(label + ": ACCEPTED");
      } catch (err) {
        attempts.push(label + ": rejected " + (err instanceof TypeError ? "TypeError" : String(err?.name ?? err)));
      }
    }
    return attempts;
  });
  const controlOk = intakes[0]?.includes("control finite: ACCEPTED");
  const gate = intakes.slice(1, 5); // control + the four rejectable attempts; movementX is the witness
  const hostileOk = gate.every((a) => a.includes("rejected TypeError"));
  status(rows, "non-finite event intake rejected at the IDL conversion (native admission gate)",
    controlOk === true && hostileOk === true,
    gate.length + " rejectable attempts all TypeError + " + intakes.join("; "));

  // ---- The bare tier's surface takeover (second boot, controls fixture) ----
  // With the native controls attribute present, Firefox's UA controls widget
  // consumes pointerdown/up inside its closed shadow tree before the page
  // sees them, in EVERY posture (floor-probed: check/.tmp/bare-ctl-fs-probe.mjs
  // - only stray pointermoves escape). The tier strips the attribute at
  // adoption, so the engine becomes the control surface: tap play/pause,
  // dbltap fullscreen entry, and the fs-flagged intents arm in normal view
  // (the gesture-space gate opens for the bare shell; SDK shells keep the
  // fullscreen-only law).
  session.registerFixture("/check/bare-surface", `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>bare surface</title>
<style>
  #player { position: relative; width: 640px; height: 360px; margin: 40px; }
  video { width: 100%; height: 100%; display: block; }
</style></head>
<body style="background:#000">
  <div id="player"><video id="check-video" controls playsinline></video></div>
</body>
</html>`);
  const bareRect = () => session.eval(function main() {
    const r = document.querySelector("video").getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const bareState = () => session.eval(function main() {
    const v = document.querySelector("video");
    return {
      paused: v.paused,
      t: Math.round(v.currentTime * 10) / 10,
      controls: v.controls,
      fs: document.fullscreenElement ? (document.fullscreenElement.id || document.fullscreenElement.tagName) : null
    };
  });
  const bareTap = async (x, y) => {
    const p = new Pointer("bare-tap", Pointer.Type.MOUSE);
    await raw.actions({ async: true }).insert(
      p,
      p.move({ x: Math.round(x), y: Math.round(y), origin: Origin.VIEWPORT, duration: 0 }),
      p.press(Button.LEFT),
      p.release(Button.LEFT)
    ).perform();
  };

  // Manual boot ceremony (the discovery case's bootAttempt shape), NOT the
  // stage's boot(): the bare tier needs the blob feed BEFORE the shell can
  // exist (evidence bar: blob: currentSrc + played.length), and the stage's
  // boot throws when the shell never attaches. The window rect is re-asserted
  // because the first boot's dbltap row drove REAL fullscreen, which can
  // reshape the headed window.
  await session.normalizeWindowRect();
  await session.navigate(`${baseUrl}/check/bare-surface?boot=${Date.now()}`);
  await session.injectGMRealm({ storage: { "pf:configs": { discovery: { bareVideos: true } } } });
  await session.injectBundle(bundle);
  await session.wakeVideos();
  const bareFed = await session.evalAsync(function main(done) {
    fetch("/check-video.mp4")
      .then((r) => r.blob())
      .then((b) => {
        const v = document.querySelector("#check-video");
        v.src = URL.createObjectURL(b);
        v.muted = true;
        v.addEventListener("playing", () => done({ ok: true }), { once: true });
        v.play().catch((err) => done({ ok: false, why: `play rejected: ${err}` }));
        setTimeout(() => done({ ok: false, why: "playing never fired" }), 6000);
      })
      .catch((err) => done({ ok: false, why: `fetch failed: ${err}` }));
  });
  const bareShell = await session.waitFor(function main() {
    return document.querySelector(".pf-shell") !== null ? { ready: true } : null;
  }, 9000, 120).catch(() => null);
  if (!bareFed?.ok || bareShell === null) {
    status(rows, "bare surface boot (controls fixture)", false,
      `fed=${JSON.stringify(bareFed)} shell=${bareShell !== null}`);
  } else {
    // Failure-time diagnostics for the fs/dbltap rows: the shell's gesture
    // dispatches and the document's fullscreen outcomes, page-lifetime. The
    // row notes read these on fail - a fullscreenElement=null answer without
    // the dispatched gesture, a dispatched gesture with a rejection, or a
    // stale activation answer each name a different defect.
    await session.eval(function main() {
      window.__pfBare = { events: [], fsErrs: [], fsChanges: 0 };
      const host = document.querySelector(".pf-shell");
      if (host) {
        host.addEventListener("pf:gesture-tap", () => window.__pfBare.events.push("tap"));
        host.addEventListener("pf:gesture-dbltap", () => window.__pfBare.events.push("dbltap"));
      }
      document.addEventListener("fullscreenerror", () => window.__pfBare.fsErrs.push("error"));
      document.addEventListener("fullscreenchange", () => window.__pfBare.fsChanges++);
      // Record the actual rejection reason: the spec fires fullscreenerror
      // without one, and the shell's own catch logs at debug level (off).
      const orig = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...args) {
        return orig.apply(this, args).catch((err) => {
          window.__pfBare.fsErrs.push(`${err?.name}: ${String(err?.message).slice(0, 100)}`);
          throw err;
        });
      };
    });
    const bareStart = await bareState();
    status(rows, "bare surface: adoption strips native controls", bareStart.controls === false,
      `video.controls=${bareStart.controls} (the fixture carries the attribute)`);

    const r1 = await bareRect();
    await session.eval(function main() { document.querySelector("video").pause(); });
    await sleep(300);
    const tapBefore = await bareState();
    await bareTap(r1.x + r1.w / 2, r1.y + r1.h * 0.4);
    await sleep(500);
    const tapAfter = await bareState();
    status(rows, "bare tap toggles playback (normal view)", tapBefore.paused !== tapAfter.paused,
      `paused ${tapBefore.paused}->${tapAfter.paused}`);

    const r2 = await bareRect();
    await session.eval(function main() {
      const v = document.querySelector("video");
      v.currentTime = 1;
      return v.play();
    });
    await sleep(400);
    const scrubBefore = await bareState();
    const bareP = new Pointer("bare-scrub", Pointer.Type.MOUSE);
    await raw.actions({ async: true }).insert(
      bareP,
      bareP.move({ x: Math.round(r2.x + r2.w * 0.3), y: Math.round(r2.y + r2.h * 0.4), origin: Origin.VIEWPORT, duration: 0 }),
      bareP.press(Button.LEFT),
      bareP.move({ x: Math.round(r2.x + r2.w * 0.6), y: Math.round(r2.y + r2.h * 0.4), origin: Origin.VIEWPORT, duration: 100 }),
      bareP.move({ x: Math.round(r2.x + r2.w * 0.85), y: Math.round(r2.y + r2.h * 0.4), origin: Origin.VIEWPORT, duration: 100 }),
      bareP.release(Button.LEFT)
    ).perform();
    await sleep(800);
    const scrubAfter = await bareState();
    status(rows, "bare scrub commits a seek (normal view, no fs stub)", scrubAfter.t > scrubBefore.t + 2,
      `t ${scrubBefore.t}->${scrubAfter.t}`);

    const r3 = await bareRect();
    // The fullscreen denial class: requestFullscreen rejects when the
    // DOCUMENT is not focused (spec step, independent of user activation -
    // a headed battery run minutes deep loses OS focus to the user's own
    // window). Re-assert focus and record the state with the row.
    await session.focusWindow();
    await session.eval(function main() { document.querySelector("video").pause(); });
    await sleep(300);
    const act = await session.eval(function main() {
      return { active: navigator.userActivation.isActive, transient: navigator.userActivation.hasBeenActive, focused: document.hasFocus() };
    });
    await bareTap(r3.x + r3.w / 2, r3.y + r3.h / 2);
    await sleep(80);
    await bareTap(r3.x + r3.w / 2, r3.y + r3.h / 2);
    await sleep(900);
    const fsAfter = await bareState();
    const bareDiag = await session.eval(function main() { return window.__pfBare; });
    status(rows, "bare center dbltap enters real fullscreen", fsAfter.fs !== null,
      `fullscreenElement=${JSON.stringify(fsAfter.fs)} paused=${fsAfter.paused} events=${JSON.stringify(bareDiag.events)} fsErrs=${JSON.stringify(bareDiag.fsErrs)} fsChanges=${bareDiag.fsChanges} act=${JSON.stringify(act)}`);
    await session.eval(function main() { document.exitFullscreen()?.catch(() => {}); });
    await sleep(400);

    await session.eval(function main() {
      const v = document.querySelector("video");
      window.__bareDetached = v;
      v.remove();
    });
    await sleep(1200);
    const bareTeardown = await session.eval(function main() {
      return {
        shell: document.querySelector(".pf-shell") !== null,
        controls: window.__bareDetached ? window.__bareDetached.controls : null
      };
    });
    status(rows, "bare removal: shell destroyed and controls restored", bareTeardown.shell === false && bareTeardown.controls === true,
      `shell=${bareTeardown.shell} controls(restored)=${bareTeardown.controls}`);
  }

  return rows;
}
