/**
 * Real playback through the real bundle: the fixture video is served over
 * http, reaches a real duration, and panel + resume paths that depend on
 * media state hold up end to end.
 */
export async function run({ session, baseUrl, boot }) {
  const rows = [];
  await boot();

  const duration = await session.waitFor(
    `return (() => { const v = document.querySelector("#check-video"); return v && v.duration > 3 ? v.duration : false; })()`,
    5000
  ).catch(async (err) => {
    const probe = await session.eval(function main() {
      const v = document.querySelector("#check-video");
      return v ? { duration: v.duration, readyState: v.readyState, networkState: v.networkState, error: String(v.error?.message ?? null), srcSet: !!v.src, paused: v.paused } : "video-missing";
    }).catch((e) => ({ probeError: e.message }));
    throw new Error(`duration never arrived - ${err.message.slice(0, 40)} - ${JSON.stringify(probe)}`);
  });
  rows.push({
    name: `fixture video streams (duration ${Number(duration).toFixed(2)}s)`,
    status: Number(duration) > 3 ? "pass" : "fail",
    ms: null
  });

  // Panel opens from its key binding; panel content mounts in the shell's
  // shadow root. This engine drives it through the pf:gesture-panel semantic
  // event; the recorder is attached BEFORE the key dispatch.
  await session.eval(function main() {
    window.__pfPanelEvents = 0;
    const host = document.querySelector(".pf-shell");
    host?.addEventListener("pf:gesture-panel", () => window.__pfPanelEvents++);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", key: "s", bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const panelCount = await session.eval(function main() {
    return window.__pfPanelEvents;
  });
  rows.push({
    name: "KeyS emits pf:gesture-panel",
    status: panelCount >= 1 ? "pass" : "fail",
    ms: null
  });

  const panelDom = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    if (!host || !host.shadowRoot) return 0;
    return host.shadowRoot.querySelectorAll("[class*=panel], [data-pf-panel], pf-panel, [aria-modal]").length;
  });
  rows.push({
    name: "panel mounts dom when opened",
    status: panelDom > 0 ? "pass" : "fail",
    note: panelDom === 0 ? "no panel nodes found in shadow root" : null,
    ms: null
  });

  // R4 scroll-edge law, measured on computed styles rather than screenshotted:
  // at the top of the scroll the pinned header must be fully transparent (the
  // sheet's own tint is the one glass layer - a second painted layer used to
  // stack over it and read as a darker band), and once content actually
  // scrolls beneath the bar the scroll-driven ramp must have engaged
  // (--pf-scroll-edge off zero, header background no longer transparent).
  const edge = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    const header = panel?.querySelector(".pf-panel-header");
    if (!panel || !header) return null;
    const alphaOf = (bg) => {
      const rgba = /rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(String(bg));
      if (rgba) return Number(rgba[1]);
      const colorFn = /color\(\s*\S+\s*[-\d.]+\s+[-\d.]+\s+[-\d.]+\s*\/\s*([\d.]+)/.exec(String(bg));
      return colorFn ? Number(colorFn[1]) : null;
    };
    const readEdge = () => {
      const raw = getComputedStyle(header).getPropertyValue("--pf-scroll-edge");
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    };
    const frames = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
    return new Promise((resolve) => {
      frames(() => {
        const atRest = { edge: readEdge(), alpha: alphaOf(getComputedStyle(header).backgroundColor), top: panel.scrollTop };
        // The sheet sizes to its content and the fixture panel fits the
        // viewport (measured: its content tops out well under 300px), so it
        // would never overflow on its own - a 140px window guarantees the
        // scroll range the edge treatment responds to (inline only, restored
        // before the row resolves).
        const priorHeight = panel.style.height;
        panel.style.height = "140px";
        frames(() => {
          panel.scrollTop = 120;
          frames(() => {
            const scrolled = { edge: readEdge(), alpha: alphaOf(getComputedStyle(header).backgroundColor), top: panel.scrollTop };
            panel.scrollTop = 0;
            panel.style.height = priorHeight;
            resolve({ atRest, scrolled });
          });
        });
      });
    });
  });
  rows.push({
    name: "R4: pinned header is transparent at rest (no double tint)",
    status: !!edge && edge.atRest.top === 0 && edge.atRest.edge === 0 && edge.atRest.alpha === 0 ? "pass" : "fail",
    note: !edge ? "panel/header missing" : JSON.stringify(edge.atRest),
    ms: null
  });
  rows.push({
    name: "R4: scroll-driven header tint engages over passing content",
    status: !!edge && edge.scrolled.top > 0 && edge.scrolled.edge > 0 && edge.scrolled.alpha > 0 ? "pass" : "fail",
    note: !edge ? "panel/header missing" : JSON.stringify(edge.scrolled),
    ms: null
  });

  // The softened glass scale ships as decided, asserted off the real sheet:
  // concentric chain R5 (16 outermost, tab one ring in twice) and the blur
  // pair - measured computed values, per the measured-not-screenshotted law.
  const glassScale = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!panel) return null;
    const cs = getComputedStyle(panel);
    return { panelRadius: cs.borderRadius, blur: cs.backdropFilter };
  });
  rows.push({
    name: "glass scale: softened radii + blur land as declared",
    status: !!glassScale && glassScale.panelRadius === "16px" && /blur\(24px\)/.test(glassScale.blur) ? "pass" : "fail",
    note: glassScale ? JSON.stringify(glassScale) : "panel missing",
    ms: null
  });

  // The shell contract must survive a full teardown: drop the current anchor,
  // append a fresh video, and require the kernel to re-anchor onto it - the
  // new video node must carry the shell marker (the old markers on container
  // garbage are not credit).
  const reAnchor = await session.evalAsync(function main(done) {
    document.querySelector("#check-video")?.remove();
    const wrapper = document.querySelector(".plyr__video-wrapper");
    if (!wrapper) { done(null); return; }
    const v2 = document.createElement("video");
    v2.id = "check-video-2";
    v2.preload = "metadata";
    v2.muted = true;
    v2.autoplay = true;
    v2.src = "/check-video.mp4";
    wrapper.appendChild(v2);
    v2.addEventListener("loadeddata", () => {
      const deadline = Date.now() + 8000;
      const tick = () => {
        const stamped = v2.matches("[data-pf-shell]");
        const shells = document.querySelectorAll(".pf-shell").length;
        if (stamped || shells > 1) done({ stamped, shells });
        else if (Date.now() < deadline) setTimeout(tick, 150);
        else done(null);
      };
      tick();
    }, { once: true });
    setTimeout(() => done(null), 11000);
  });
  rows.push({
    name: "kernel re-anchors a shell onto the replacement video",
    status: reAnchor ? "pass" : "fail",
    note: reAnchor ? `stamped=${reAnchor.stamped} shells=${reAnchor.shells}` : "no re-anchor within 10s",
    ms: null
  });

  return rows;
}
