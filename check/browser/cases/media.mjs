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
  // sheet's own ink is the resting surface - a second painted layer would
  // stack over it and read as a darker band), and once content actually
  // scrolls beneath the bar the scroll-driven ramp must have engaged
  // (--pf-scroll-edge off zero, header background no longer transparent).
  const edge = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    const header = panel?.querySelector(".pf-panel-header");
    if (!panel || !header) return null;
    const readEdge = (element) => {
      const raw = getComputedStyle(element, "::before").getPropertyValue("--pf-scroll-edge");
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    };
    const gradientOf = (element) => {
      const cs = getComputedStyle(element, "::before");
      return {
        grad: String(cs.backgroundImage).includes("gradient"),
        raw: String(cs.backgroundImage),
        blur: String(cs.backdropFilter) !== "none"
          ? /blur\(/.test(String(cs.backdropFilter))
          : false,
        mask: String(cs.maskImage).includes("gradient")
      };
    };
    const opacityOf = (element) => {
      const raw = getComputedStyle(element, "::before").opacity;
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    };
    const frames = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));
    let band = null;
    return new Promise((resolve) => {
      frames(() => {
        const atRest = { edge: readEdge(header), grad: gradientOf(header), alpha: opacityOf(header), top: panel.scrollTop };
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
            const scrolled = { edge: readEdge(header), alpha: opacityOf(header), top: panel.scrollTop };
            band = gradientOf(header);
            panel.scrollTop = 0;
            panel.style.height = priorHeight;
            resolve({ atRest, scrolled, band });
          });
        });
      });
    });
  });
  rows.push({
    name: "R4: pinned header edge band is unmarked at rest",
    status: !!edge && edge.atRest.top === 0 && edge.atRest.edge === 0 && edge.atRest.alpha === 0 ? "pass" : "fail",
    note: !edge ? "panel/header missing" : JSON.stringify(edge.atRest),
    ms: null
  });
  rows.push({
    name: "R4: scroll-driven solid-to-faded edge band engages over passing content",
    status: !!edge && edge.scrolled.top > 0 && edge.scrolled.edge > 0 && edge.scrolled.alpha > 0
      // Ink edition: the gradient alone carries the fade (solid -pf-sheet ink
      // at the rail) - blur and mask are required absent (R1's zero
      // backdrop-filter budget survives content engagement).
      && edge.band.grad && !edge.band.blur && !edge.band.mask
      && edge.band.raw.includes("rgb(14, 14, 16)") ? "pass" : "fail",
    note: !edge ? "panel/header missing" : JSON.stringify({ atRest: edge.atRest, scrolled: edge.scrolled, band: edge.band }),
    ms: null
  });

  // The ink scale ships as decided, asserted off the real sheet: the
  // concentric chain R5 (16 outermost, descendants derived) and R1's zero
  // backdrop-filter over the one opaque resting ink - measured computed
  // values, per the measured-not-screenshotted law. The shadow is the flat
  // shape: none - the rim era AND the soft drop shadow retired by direction,
  // the hairline is the whole separation - so any box-shadow returning in
  // the computed style is an era coming back through a token rename.
  const inkScale = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!panel) return null;
    const cs = getComputedStyle(panel);
    return {
      panelRadius: cs.borderRadius,
      blur: cs.backdropFilter,
      ink: cs.backgroundColor,
      shadow: cs.boxShadow
    };
  });
  rows.push({
    name: "ink scale: concentric radius + zero blur + flat shadow on the opaque sheet",
    status: !!inkScale && inkScale.panelRadius === "16px"
      && inkScale.blur === "none"
      && inkScale.ink === "rgb(14, 14, 16)"
      && inkScale.shadow === "none" ? "pass" : "fail",
    note: inkScale ? JSON.stringify(inkScale) : "panel missing",
    ms: null
  });

  // The options-row grammar, measured on the real staged slider (the only
  // options row left after ui.glassTint retired with the glass era): label
  // left, bare snapped range, active value hint right - all three on one
  // line, no tick tips on the slider itself.
  const optionsGrammar = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!panel) return null;
    const slider = panel.querySelector('input[aria-label="Skip Step"]');
    if (!slider) return null;
    const step = (index) => {
      slider.value = index;
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      return panel.querySelector('input[aria-label="Skip Step"]')?.closest(".pf-options-cell")?.querySelector(".pf-options-hint")?.textContent ?? null;
    };
    const to = step(2);
    const back = step(0);
    const cell = slider.closest(".pf-options-cell");
    const grammar = !cell ? null : {
      line: getComputedStyle(cell).flexDirection,
      label: cell.querySelector(":scope > .pf-panel-label")?.textContent,
      hint: cell.querySelector(".pf-options-hint")?.textContent,
      tips: cell.querySelectorAll(".pf-stage-ticks, .pf-stage-labels").length
    };
    return { to, back, grammar };
  });
  rows.push({
    name: "options rows read label left, hint right, no tick tips",
    status: !!optionsGrammar?.grammar
      && optionsGrammar.grammar.line === "row"
      && optionsGrammar.grammar.label === "Skip Step"
      && optionsGrammar.grammar.hint === "5s"
      && optionsGrammar.grammar.tips === 0 ? "pass" : "fail",
    note: optionsGrammar ? JSON.stringify(optionsGrammar) : "panel missing",
    ms: null
  });

  // Bool toggle = the shared monochrome switch pill (one owner, the panel
  // checkbox rule): 40x24 pill, 18px knob, a real click lights the ink and
  // slides the dark knob on, clicking again restores; reads wait out the
  // ease transitions so the snap-adjacent values are honest.
  const pill = await session.eval(async function main() {
    const host = document.querySelector(".pf-shell");
    const panel = host?.shadowRoot?.querySelector(".pf-panel");
    if (!panel) return null;
    const input = panel.querySelector(".pf-settings-toggle input");
    if (!input) return null;
    const snapshot = () => {
      const cs = getComputedStyle(input);
      const knob = getComputedStyle(input, "::before");
      return {
        checked: input.checked,
        bg: cs.backgroundColor,
        knobBg: knob.backgroundColor,
        knobTranslate: String(knob.translate),
        width: cs.width,
        knobWidth: knob.width
      };
    };
    input.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const first = snapshot();
    input.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const second = snapshot();
    return { first, second };
  });
  const onState = [pill?.first, pill?.second].filter((s) => s?.checked)[0];
  const offState = [pill?.first, pill?.second].filter((s) => s && !s.checked)[0];
  rows.push({
    name: "goldengate: bool toggles read as monochrome switch pills",
    status: !!pill
      && pill.first.checked !== pill.second.checked
      && onState?.width === "40px"
      && onState?.knobWidth === "18px"
      && String(onState?.bg).includes("rgb(255, 255, 255)")
      && String(onState?.knobBg).includes("rgb(0, 0, 0)")
      && /^18px/.test(onState?.knobTranslate ?? "")
      && offState?.knobBg !== onState?.knobBg ? "pass" : "fail",
    note: pill ? JSON.stringify(pill) : "panel missing",
    ms: null
  });

  // The segmented capsule re-seats under the active tab - slides between
  // tabs on a real switch and restores the starting selection.
  const tabCapsule = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const strip = host?.shadowRoot?.querySelector(".pf-panel-tabs");
    if (!strip) return null;
    const capsule = strip.querySelector(".pf-tab-capsule");
    if (!capsule) return null;
    const tabs = [...strip.querySelectorAll(".pf-panel-tab")];
    if (tabs.length < 2) return null;
    const first = tabs.findIndex((t) => t.classList.contains("pf-panel-tab-active"));
    const start = { translate: capsule.style.translate, width: capsule.style.width };
    tabs[(first + 1) % tabs.length].click();
    const after = { translate: capsule.style.translate };
    tabs[first].click();
    return { start, after, duration: getComputedStyle(capsule).transitionDuration };
  });
  rows.push({
    name: "goldengate: segmented capsule slides between tabs",
    status: !!tabCapsule
      && tabCapsule.start.width !== "" && tabCapsule.after.translate !== tabCapsule.start.translate
      ? "pass" : "fail",
    note: tabCapsule ? JSON.stringify(tabCapsule) : "tabs/capsule missing",
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

  // Real stage geometry the native way: no emulation channel exists on the
  // Firefox floor, so the 400x700 portrait pocket is the window's own rect -
  // the same viewport width the band math reads - while the localized band
  // forcing stays inline (the fixture's stage container width). The window
  // is restored to its launch rect in the finally.
  //
  // The auto band, per engine half (see :scope comments in styles.css for
  // why the halves are separate): shrink the STAGE inline and the pf-stage
  // container query must re-evaluate LIVE (the band var flips, no JS re-arm),
  // while the device pointer form stays fine, so the merged bus correctly
  // stays closed. Then assume the coarse device (inline var - pointer media
  // is not forceable in this headless session) and the full auto semantics
  // must light up: bus 1 + the compact bottom-sheet corner. The setting's
  // explicit false must veto ONLY the auto band afterwards.
  let auto = null;
  let coarseAssumed = null;
  let veto = null;
  let densGate = null;
  const windowState = await session.raw.manage().window().getRect().catch(() => null);
  await session.raw.manage().window().setRect({ width: 400, height: 700 }).catch(() => {});
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
    if (windowState) {
      await session.raw.manage().window().setRect(windowState).catch(() => {});
    }
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

  // The container pockets ride a real <style> element because @container SIZE
  // rules inside a document-adopted constructable sheet never evaluate their
  // conditions in the harness engine build (src/shell/chrome/inject.js compiles the
  // whole pocket as a <style> carrier). This row IS that premise probe: one
  // always-true @container rule seeded into both carriers, each writing a
  // distinct declaration of the same custom property. The <style> twin must
  // light the property; the adopted twin must never reach it (the twin's own
  // declaration is the sentinel). An engine fix that makes the adopted arm
  // evaluate flips this row and re-opens the pocket's carrier decision.
  const carrier = await session.evalAsync(async function main(done) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "container: pf-defect / inline-size; width: 400px;";
    const target = document.createElement("div");
    target.className = "pf-defect-target";
    wrap.appendChild(target);
    document.body.appendChild(wrap);
    const text = "@container pf-defect (max-width: 500px) { .pf-defect-target { --pf-defect-inline: 1; --pf-defect-adopted: none; } }";
    const twin = document.createElement("style");
    twin.textContent = text;
    document.head.appendChild(twin);
    const adopted = new CSSStyleSheet();
    adopted.replaceSync(text.replace("--pf-defect-inline: 1;", "--pf-defect-adopted: 1;"));
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
    // One frame: a size-container evaluation must have landed before reads.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const cs = getComputedStyle(target);
    const result = {
      inline: cs.getPropertyValue("--pf-defect-inline").trim(),
      adopted: cs.getPropertyValue("--pf-defect-adopted").trim()
    };
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== adopted);
    twin.remove();
    wrap.remove();
    done(result);
  });
  rows.push({
    name: "container carrier premise: adopted sheets never evaluate size containers",
    status: !!carrier && carrier.inline === "1" && carrier.adopted === "none" ? "pass" : "fail",
    note: carrier ? JSON.stringify(carrier) : "probe failed to run",
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

  // A containment re-wrap: the SDK container identity is a shell-lifetime
  // fact. The host re-nests the running video into a SECOND Plyr-styled
  // wrapper (the descriptor cache's parent-stamp exists for exactly this
  // shape), so the re-parent seam re-resolves detection and the
  // boot-identity shell is destroyed and re-adopted at the new home -
  // exactly one shell ends attached to the NEW container's wrapper
  // (positioned absolutely so the on-screen adoption gate sees it).
  const rewrap = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video-2");
    if (!v || !v.matches("[data-pf-shell]")) { done(null); return; }
    const second = document.createElement("div");
    second.className = "plyr";
    second.setAttribute("data-plyr", "");
    second.style.cssText = "position:absolute;left:0;top:0;width:1280px;height:720px;";
    second.innerHTML = "<div class=\"plyr__video-wrapper\" style=\"width:100%;height:100%\"></div>";
    document.body.append(second);
    second.querySelector(".plyr__video-wrapper").moveBefore(v, null);
    const deadline = Date.now() + 9000;
    const tick = () => {
      const newWrapper = second.querySelector(".pf-shell")?.parentElement === second.querySelector(".plyr__video-wrapper");
      const shells = document.querySelectorAll(".pf-shell").length;
      if (newWrapper && shells === 1) done({ host: newWrapper, shells });
      else if (Date.now() < deadline) setTimeout(tick, 150);
      else done({ host: newWrapper, shells });
    };
    tick();
  });
  rows.push({
    name: "re-wrap into a second SDK container: boot-identity shell dies, video re-adopts in the new home",
    status: rewrap && rewrap.host && rewrap.shells === 1 ? "pass" : "fail",
    note: rewrap ? JSON.stringify(rewrap) : "no stamped video to move",
    ms: null
  });

  // The state-preserving move: a host that reorders its player with
  // Element.moveBefore (live on the 159 floor) must not strand the running
  // shell - the queued removal record reads a video that is still connected,
  // so the grace cancels before it can fire.
  const reorder = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video-2");
    if (!v || !v.matches("[data-pf-shell]")) { done(null); return; }
    const sib = document.createElement("span");
    v.parentElement.append(sib);            // v is no longer the last child
    v.parentElement.moveBefore(v, null);    // real reorder: [sib, v]
    setTimeout(() => done({
      parent: v.parentElement === sib.parentElement,
      stamped: v.matches("[data-pf-shell]"),
      shells: document.querySelectorAll(".pf-shell").length
    }), 600);
  });
  rows.push({
    name: "a state-preserving moveBefore reorder never strands the shell",
    status: reorder && reorder.parent && reorder.stamped && reorder.shells === 1 ? "pass" : "fail",
    note: reorder ? JSON.stringify(reorder) : "no stamped video to move",
    ms: null
  });

  // Cross-parent rehome: the same primitive moving the video to a fresh
  // container outside the old anchor chain - the observation re-derives from
  // live state (removed record arrives with isConnected already true) and
  // the parent-equality check re-anchors; exactly one shell survives.
  const rehome = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video-2");
    if (!v || !v.matches("[data-pf-shell]")) { done(null); return; }
    const stage = document.createElement("div");
    stage.id = "move-stage";
    document.body.append(stage);
    stage.moveBefore(v, null);
    const deadline = Date.now() + 8000;
    const tick = () => {
      const stamped = v.matches("[data-pf-shell]");
      const shells = document.querySelectorAll(".pf-shell").length;
      if (stamped && shells === 1) done({ stamped, shells });
      else if (Date.now() < deadline) setTimeout(tick, 150);
      else done({ stamped, shells });
    };
    tick();
  });
  rows.push({
    name: "a moveBefore cross-parent move re-anchors the running shell",
    status: rehome && rehome.stamped && rehome.shells === 1 ? "pass" : "fail",
    note: rehome ? JSON.stringify(rehome) : "no stamped video to move",
    ms: null
  });

  return rows;
}
