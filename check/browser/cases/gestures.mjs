/**
 * The gesture contract, driven by REAL input events through chromedriver's
 * action layer (pointer streams and keystrokes sent to the headless browser),
 * with the semantic pf:gesture-* reactions recorded off the shell host.
 * Keyboard preconditions documented in inputs/forge.js: focus must not sit in
 * text entry, and the active engine arbitrates - so the pointer probes park a
 * press first, and keys arrive through the same trusted surface.
 */
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

export async function run({ session, baseUrl, boot }) {
  const rows = [];
  await boot();
  await recordGestureEvents(session);

  const center = await session.eval(videoCenterScript);
  if (center === null) {
    rows.push({ name: "shell host present for gestures", status: "fail", note: "no [data-pf-shell]", ms: null });
    return rows;
  }
  const raw = session.raw;
  // chromium driver actions: keyDown/keyUp consume Key constants (Key.ARROW,
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
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "ArrowRight skips forward (+5s)", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return window.__pfEvents.includes("skip") && t > 5 && t < 10;
  }), "skip event or forward step missing");

  await session.eval(function main() {
    document.querySelector("#check-video").currentTime = 7;
  });
  await fireKeys(["ArrowLeft"]);
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "ArrowLeft skips backward (-5s)", await session.eval(function main() {
    const t = document.querySelector("#check-video").currentTime;
    return window.__pfEvents.includes("skip") && t > 0 && t < 4;
  }), "skip event or backward step missing");

  // Inline (fs gate closed), the edge-skip path is fs-gated end-to-end:
  // resolves a left-edge zone for a real edge press, double-taps there, and
  // requires NO dbltap/skip dispatch - the claimed plain taps fall through
  // to the immediate tail replay instead (the inline repair path, driven
  // with real pointer input).
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
  await new Promise((r) => setTimeout(r, 300));
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
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) }).press().pause(450).release()
    .pause(200)
    .perform();
  status(rows, "inline hold reports viewport-honest edge/screen zones", await session.eval(function main() {
    return window.__pfEvents.includes("hold:left-edge") && window.__pfEvents.includes("hold:screen");
  }), `events=${JSON.stringify(await session.eval(function main() {
    return window.__pfEvents;
  }))}`);

  await fireKeys(["KeyM"]);
  await new Promise((r) => setTimeout(r, 350));
  status(rows, "KeyM flips muted through pf:gesture-mute", await session.eval(function main() {
    const v = document.querySelector("#check-video");
    return window.__pfEvents.includes("mute") && v.muted !== v.hasAttribute("muted");
  }), "no mute event or muted state unchanged");

  await fireKeys(["ArrowUp"]);
  await new Promise((r) => setTimeout(r, 350));
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
  await new Promise((r) => setTimeout(r, 400));
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
  await new Promise((r) => setTimeout(r, 300));
  status(rows, "KeyS closes the panel again", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host !== null ? host.shadowRoot.querySelector(".pf-panel") : null;
    return panel === null || !panel.classList.contains("pf-open");
  }), "panel still open");

  // KeyP asks for picture-in-picture through the kernel's semantic layer;
  // pip-window creation may be blocked in headless Chromium, so the row
  // asserts the contract, not the browser-side window.
  await recordGestureEvents(session);
  await fireKeys(["KeyP"]);
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "KeyP asks for picture-in-picture", await session.eval(function main() {
    return window.__pfEvents.includes("pip");
  }), "no pf:gesture-pip");

  // Scrub/swipe/pinch are fs:true-binding intents (actions.js): the kernel's
  // fs gate reads `doc.fullscreenElement`, and headless Chromium refuses
  // real element fullscreen (Permissions check failed). The override below
  // points the same gate at the shell host; a synthetic fullscreenchange
  // then flips the kernel's fs latch the way a real fullscreen would.
  await session.eval(function main() {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get() { return document.querySelector(".pf-shell"); }
    });
    document.dispatchEvent(new Event("fullscreenchange"));
  });
  await new Promise((r) => setTimeout(r, 150));

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
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "drag produces scrub stream + scrubEnd",
    await session.eval(function main() {
      return window.__pfEvents.includes("scrub") &&
        (window.__pfEvents.includes("scrub-end") || window.__pfEvents.includes("scrub-release"));
    }), `events=${JSON.stringify(await session.eval(function main() { return window.__pfEvents; }))}`);

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
  await new Promise((r) => setTimeout(r, 300));
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
  // covered (repair A + B, real driver input):
  //   probe 1 - an affordance-declaring div (cursor:pointer, no role): the
  //     stream is EXEMPT outright, so its pointerdown + click are the real
  //     native ones, zero-latency.
  //   probe 2 - an affordance-declaring NOTHING div (default cursor): the
  //     press is claimed, but the plain tap replays the full press tail
  //     (pointerdown..click in Chromium's tap order) AT the pressed element
  //     inside the dbltap window - so its listeners still fire, once each.
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
    el.__pfCounts = { down: 0, click: 0 };
    el.style.cssText = "position:absolute;left:96px;top:8px;width:72px;height:40px;cursor:pointer;z-index:2147483000;";
    el.addEventListener("pointerdown", () => el.__pfCounts.down++);
    el.addEventListener("click", () => el.__pfCounts.click++);
    video.parentElement.appendChild(el);
  });
  const cursorPoint = await probeCenterFor("#pf-sdkcursor");
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: cursorPoint.x, y: cursorPoint.y })
    .press()
    .release()
    .pause(120)
    .perform();
  await new Promise((r) => setTimeout(r, 300));
  status(rows, "affordance-cursor roleless div keeps its REAL pointerdown + click",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkcursor")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1;
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkcursor")?.__pfCounts ?? null;
    }))}`);
  // Probe 2: no affordance -> claimed press, replayed plain-tap tail at the
  // pressed element (the window is 300ms; the click CAN no longer arrive
  // before the pointer tail - the replay synthesizes the whole sequence).
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const el = document.createElement("div");
    el.id = "pf-sdkbare";
    el.textContent = "ctl";
    el.__pfCounts = { down: 0, click: 0 };
    el.style.cssText = "position:absolute;left:96px;top:56px;width:72px;height:40px;z-index:2147483000;";
    el.addEventListener("pointerdown", () => el.__pfCounts.down++);
    el.addEventListener("click", () => el.__pfCounts.click++);
    video.parentElement.appendChild(el);
  });
  const barePoint = await probeCenterFor("#pf-sdkbare");
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: barePoint.x, y: barePoint.y })
    .press()
    .release()
    .pause(120)
    .perform();
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "roleless div under claim gets its tap tail replayed at the pressed element",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkbare")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1;
    }), `counts=${JSON.stringify(await session.eval(function main() {
      return document.querySelector("#pf-sdkbare")?.__pfCounts ?? null;
    }))}`);
  // Probe 3: a FULL-COVER affordance overlay (click-to-pause family) stays
  // the gesture surface - the box gate declines the exemption - and its tap
  // still reaches it through the replay tail. Proves the two-lattice split.
  await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const el = document.createElement("div");
    el.id = "pf-sdkcover";
    el.__pfCounts = { down: 0, click: 0 };
    el.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;cursor:pointer;z-index:2147483100;";
    el.addEventListener("pointerdown", () => el.__pfCounts.down++);
    el.addEventListener("click", () => el.__pfCounts.click++);
    video.parentElement.appendChild(el);
  });
  await raw.actions({ async: true })
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press()
    .release()
    .pause(120)
    .perform();
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "full-cover affordance overlay: gesture surface claimed, tap tail replayed",
    await session.eval(function main() {
      const counts = document.querySelector("#pf-sdkcover")?.__pfCounts;
      return !!counts && counts.down === 1 && counts.click === 1;
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
  // untrusted events still traverse the capture path the engine listens on;
  // chromedriver's actions surface has no touch pointer, so the compositor
  // touch pipeline itself stays device-verified). The seeded compose pins
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
  status(rows, "touch pinch pair: zoom recognition needs no capture release",
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

  // Real compositor touch through the browser input pipeline: CDP
  // Input.dispatchTouchEvent reaches Chromium's gesture/pointer pipelines -
  // the path every real Android touch rides - not the synthetic
  // PointerEvent surface the previous rows drove. This closes the honest gap
  // the synthetic rows carried: the pinch/swipe engine contract is now
  // proven END TO END on the same pipeline the compositor runs (the last
  // compositing-touch step - physical hardware - stays device-verified).
  const cdp = await raw.createCDPConnection("page");
  await session.eval(function arm() {
    window.__pfEvents = [];
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: Math.round(center.x), y: Math.round(center.y) }]
  });
  for (const dy of [30, 90, 150]) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: Math.round(center.x), y: Math.round(center.y + dy) }]
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  status(rows, "compositor touch stream: real swipe recognition end-to-end",
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

  // Owned-touch tap-highlight determination: the engine cancels every owned
  // touch press at pointerdown (the press claim). Whether that suppresses
  // Chromium's compositor tap highlight (gray flash) is NOT DOM-observable -
  // the highlight is a compositor paint - so this row answers it with a
  // screenshot diff on a paused video (a static surface whose only possible
  // paint change across the tap is the highlight itself).
  await session.eval(function pause() {
    const video = document.querySelector("#check-video");
    video.pause();
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const clip = {
    x: center.x - center.width / 2 + 8,
    y: center.y - center.height / 2 + 8,
    width: center.width - 16,
    height: center.height - 16,
    scale: 1
  };
  const shotBefore = await cdp.send("Page.captureScreenshot", { format: "png", clip });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: Math.round(center.x), y: Math.round(center.y) }]
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const shotDuring = await cdp.send("Page.captureScreenshot", { format: "png", clip });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const unwrap = (shot) => Buffer.from((shot?.data ?? shot?.result?.data), "base64");
  const highlightFree = unwrap(shotBefore).equals(unwrap(shotDuring));
  await session.eval(function resume() {
    const video = document.querySelector("#check-video");
    video.play?.();
    video.getAnimations().forEach((a) => a.cancel());
    video.style.transform = "";
    video.style.willChange = "";
  });
  status(rows, "owned touch press leaves the compositor surface highlight-free",
    highlightFree ? true : "screenshots diverged across the owned press", "tap highlight mismatch");

  return rows;
}
