/**
 * The gesture contract, driven by REAL input events through the WebDriver
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
  // WebDriver action chains: keyDown/keyUp consume Key constants (Key.ARROW,
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

  // Named keys ride WebDriver code points: arrows are unicode key values;
  // letters ride plain.
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

  // Keyboard panel open via KeyS.
  await fireKeys(["KeyS"]);
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "KeyS opens the panel (pf:gesture-panel)", await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    return host !== null && host.shadowRoot !== null &&
      host.shadowRoot.querySelector(".pf-panel.pf-open") !== null;
  }), "panel element still closed");
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
  // pip-window creation may be blocked in a headless session, so the row
  // asserts the contract, not the browser-side window.
  await recordGestureEvents(session);
  await fireKeys(["KeyP"]);
  await new Promise((r) => setTimeout(r, 400));
  status(rows, "KeyP asks for picture-in-picture", await session.eval(function main() {
    return window.__pfEvents.includes("pip");
  }), "no pf:gesture-pip");

  // Scrub/swipe/pinch are fs:true-binding intents (actions.js): the kernel's
  // fs gate reads `doc.fullscreenElement`, and a headless session refuses
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

  // Horizontal drag = scrub family (fullscreen territory). The chained moves
  // give the stream router the intermediate pointermove samples the
  // exp-smoothed velocity filter consumes.
  await recordGestureEvents(session);
  await acts()
    .move({ origin: "viewport", x: Math.round(center.x), y: Math.round(center.y) })
    .press()
    .move({ origin: "viewport", x: Math.round(center.x) + 60, y: Math.round(center.y) })
    .pause(30)
    .move({ origin: "viewport", x: Math.round(center.x) + 100, y: Math.round(center.y) })
    .pause(30)
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
  await acts()
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

  return rows;
}
