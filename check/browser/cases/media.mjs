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

  // The retired focus assertions, measured rather than trusted: the panel
  // keeps ONE tint state (the resting 58%) even with focus inside it, and
  // the numeric stepper's border stays the neutral hairline when its input
  // is focused - no darkened sheet, no accent border.
  const focusRest = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!panel) return null;
    const stepper = panel.querySelector(".pf-stepper") || host.shadowRoot.querySelector(".pf-stepper");
    if (!stepper) return null;
    const before = {
      tint: getComputedStyle(panel).backgroundColor,
      border: getComputedStyle(stepper).borderColor
    };
    stepper.querySelector(".pf-stepper-input")?.focus();
    const after = {
      tint: getComputedStyle(panel).backgroundColor,
      border: getComputedStyle(stepper).borderColor
    };
    return { before, after };
  });
  rows.push({
    name: "focus rest: panel tint stays the resting state, stepper border stays neutral",
    status: !!focusRest && focusRest.before.tint === focusRest.after.tint && focusRest.after.border === focusRest.before.border ? "pass" : "fail",
    note: focusRest ? JSON.stringify(focusRest) : "panel/stepper missing",
    ms: null
  });

  // The compact engine is materially CSS now: the panel carries only the
  // setting's data-compact attribute, while auto-detect resolves in the style
  // pipeline (stage container query + pointer media). Rows read the hud bus
  // (--pf-compact) plus the used panel width, so both the plumbing and the
  // cascade through the style() reader are credited. The fixture stage is a
  // fixed 1280px, which keeps every width deterministic. The browser-gate
  // pointer is a mouse on a wide stage: default auto-detect resolves OFF.
  const compactDashboard = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const hud = host?.shadowRoot?.querySelector(".pf-panel-slot");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!hud || !panel) return null;
    const cs = getComputedStyle(panel);
    return {
      bus: getComputedStyle(hud).getPropertyValue("--pf-compact").trim(),
      width: cs.width,
      attr: panel.dataset.compact ?? null
    };
  });
  rows.push({
    name: "compact engine: wide stage + pointer fine stays uncompressed",
    status: !!compactDashboard && compactDashboard.bus === "0" && compactDashboard.width === "380px" ? "pass" : "fail",
    note: compactDashboard ? JSON.stringify(compactDashboard) : "hud/panel missing",
    ms: null
  });

  // Explicit setting wins at any stage: data-compact="on" drives the merged
  // bus and the compressed shape - no matchMedia, no class stamping.
  await session.eval(function on() {
    const panel = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel");
    if (panel) {
      panel.dataset.compact = "on";
    }
  });
  const forced = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const hud = host?.shadowRoot?.querySelector(".pf-panel-slot");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!hud || !panel) return null;
    return {
      bus: getComputedStyle(hud).getPropertyValue("--pf-compact").trim(),
      width: getComputedStyle(panel).width
    };
  });
  await session.eval(function off() {
    const panel = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel");
    if (panel) {
      delete panel.dataset.compact;
    }
  });
  rows.push({
    name: "compact engine: data-compact=on forces compressed at any stage",
    status: !!forced && forced.bus === "1" && forced.width === "300px" ? "pass" : "fail",
    note: forced ? JSON.stringify(forced) : "hud/panel missing",
    ms: null
  });

  // The auto band, per engine half (see :scope comments in styles.css for
  // why the halves are separate): shrink the STAGE inline - the fixture video
  // container is a fixed 1280px - and the pf-stage container query must
  // re-evaluate LIVE (the band var flips, no JS re-arm), while the device
  // pointer form stays fine, so the merged bus correctly stays closed. Then
  // assume the coarse device (inline var - pointer media is not emulable
  // in this headless session, established by the probe fields) and the full
  // auto semantics must light up: bus 1 + the compact bottom-sheet corner.
  // The setting's explicit false must veto ONLY the auto band afterwards.
  let auto = null;
  let coarseAssumed = null;
  let veto = null;
  let densGate = null;
  const cdp = await session.raw.createCDPConnection("page");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 700, deviceScaleFactor: 1, mobile: true });
  try {
    await session.eval(function narrow() {
      document.querySelector(".pf-shell")?.parentElement?.style.setProperty("width", "400px");
    });
    auto = await session.eval(function main() {
      const host = document.querySelector(".pf-shell");
      const slot = host?.shadowRoot?.querySelector(".pf-panel-slot");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (!slot || !panel) return null;
      return {
        stage: host.getBoundingClientRect().width,
        band: getComputedStyle(slot).getPropertyValue("--pf-compact-auto").trim(),
        bus: getComputedStyle(slot).getPropertyValue("--pf-compact").trim(),
        attr: panel.dataset.compact ?? null,
        // Restoration ledger: the shell-true density engine - the 330px
        // pocket rule fires (one-column collapse + tighter history tokens
        // written on the list element) at a 280px stage. Compact outranks
        // it by pocket source order; the densGate row below proves it.
        ada: (() => {
          const shadow = host.shadowRoot;
          const mel = document.createElement("style");
          mel.textContent = `
            @container pf-panel (max-width: 330px) {
              .pf-panel-header { --pf-dens-probe: 1; }
            }`;
          shadow.appendChild(mel);
          const plyr = host.parentElement;
          const heldWidth = plyr.style.getPropertyValue("width");
          plyr.style.setProperty("width", "280px");
          const panel2 = shadow.querySelector(".pf-panel");
          const panelProbe = getComputedStyle(panel2.querySelector(".pf-panel-header")).getPropertyValue("--pf-dens-probe").trim();
          mel.remove();
          // The moved density rules write the token on .pf-history-list, a
          // descendant: read there (the panel-level var stays 168px; vars do
          // not inherit upward).
          const density = panel2 ? getComputedStyle(panel2.querySelector(".pf-history-list")).getPropertyValue("--pf-history-list-height").trim() : "nil";
          if (heldWidth === "") {
            plyr.style.removeProperty("width");
          } else {
            plyr.style.setProperty("width", heldWidth);
          }
          return `probe=${panelProbe}|density@280px=${density}`;
        })()
      };
    });
    await session.eval(function coarse() {
      document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel-slot")
        ?.style.setProperty("--pf-is-coarse", "1");
    });
    coarseAssumed = await session.eval(function main() {
      const host = document.querySelector(".pf-shell");
      const hud = host?.shadowRoot?.querySelector(".pf-panel-slot");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (!hud || !panel) return null;
      return {
        bus: getComputedStyle(hud).getPropertyValue("--pf-compact").trim(),
        width: getComputedStyle(panel).width
      };
    });
    await session.eval(function vetoIt() {
      const panel = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel");
      if (panel) {
        panel.dataset.compact = "off";
      }
    });
    veto = await session.eval(function main() {
      const host = document.querySelector(".pf-shell");
      const hud = host?.shadowRoot?.querySelector(".pf-panel-slot");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (!hud || !panel) return null;
      return {
        bus: getComputedStyle(hud).getPropertyValue("--pf-compact").trim(),
        corner: getComputedStyle(panel).borderTopLeftRadius
      };
    });
    // Compact-vs-density: at a stage both engines could paint (280px), the
    // compact reader must win the panel shape. Width discriminates: density
    // never sizes the panel, so 264px = min(300px, 100% - 16px) is reachable
    // only through compact; shared tokens (density fired but outranked) can
    // not move it.
    await session.eval(function dens() {
      const host = document.querySelector(".pf-shell");
      host?.parentElement?.style.setProperty("width", "280px");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (panel) {
        panel.dataset.compact = "on";
      }
    });
    densGate = await session.eval(function main() {
      const host = document.querySelector(".pf-shell");
      const slot = host?.shadowRoot?.querySelector(".pf-panel-slot");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (!slot || !panel) return null;
      return {
        busy: getComputedStyle(slot).getPropertyValue("--pf-compact").trim(),
        width: getComputedStyle(panel).width
      };
    });
  } finally {
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
    await cdp.send("Emulation.clearDeviceMetricsOverride", {});
    await session.eval(function restore() {
      const host = document.querySelector(".pf-shell");
      host?.parentElement?.style.removeProperty("width");
      host?.shadowRoot?.querySelector(".pf-panel-slot")?.style.removeProperty("--pf-is-coarse");
      const panel = host?.shadowRoot?.querySelector(".pf-panel");
      if (panel) {
        delete panel.dataset.compact;
      }
    });
  }
  rows.push({
    name: "compact engine: stage band re-evaluates live, closed by pointer form",
    status: !!auto && auto.stage === 400 && auto.band === "1" && auto.bus === "0" && auto.attr === null && auto.ada === "probe=1|density@280px=152px" ? "pass" : "fail",
    note: auto ? JSON.stringify(auto) : "hud/panel missing",
    ms: null
  });
  rows.push({
    name: "compact engine: assumed-coarse stage lights the full auto bus",
    status: !!coarseAssumed && coarseAssumed.bus === "1" && coarseAssumed.width === "300px" ? "pass" : "fail",
    note: coarseAssumed ? JSON.stringify(coarseAssumed) : "hud/panel missing",
    ms: null
  });
  rows.push({
    name: "compact engine: data-compact=off vetoes only the auto band",
    status: !!veto && veto.bus === "0" && veto.corner === "16px" ? "pass" : "fail",
    note: veto ? JSON.stringify(veto) : "hud/panel missing",
    ms: null
  });
  rows.push({
    name: "density + compact: pocket order keeps compact ahead",
    status: !!densGate && densGate.busy === "1" && densGate.width === "264px" ? "pass" : "fail",
    note: densGate ? JSON.stringify(densGate) : "slot/panel missing",
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
