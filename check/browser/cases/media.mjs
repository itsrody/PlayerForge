import { sleep } from "../../lib/driver.mjs";
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
  await sleep(300);
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
  // The row also witnesses the mid-fill destroy release: before the move,
  // pinch-fill engages through the shell host's semantic pinch event (the
  // exact route the engine dispatches), against a mismatched container box
  // (the 16:9 fixture under a 900px stage gives a ~1.42 cover scale) and a
  // staged embed-owned inline object-fit, so the destroy's fill release has
  // real values to hand back - transform cleared and object-fit restored,
  // not carried into the re-adoption.
  const rewrap = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video-2");
    if (!v || !v.matches("[data-pf-shell]")) { done(null); return; }
    const result = { fill: null, release: null, host: false, shells: 0 };
    const stage2 = () => {
      const second = document.createElement("div");
      second.className = "plyr";
      second.setAttribute("data-plyr", "");
      second.style.cssText = "position:absolute;left:0;top:0;width:1280px;height:720px;";
      second.innerHTML = "<div class=\"plyr__video-wrapper\" style=\"width:100%;height:100%\"></div>";
      document.body.append(second);
      second.querySelector(".plyr__video-wrapper").moveBefore(v, null);
      const deadline = Date.now() + 9000;
      const tick = () => {
        const shellHost = second.querySelector(".pf-shell");
        const host = !!(shellHost && shellHost.parentElement === second.querySelector(".plyr__video-wrapper"));
        const shells = document.querySelectorAll(".pf-shell").length;
        if (host && shells === 1) {
          // The destroy ran before this: the readopt's fresh transform
          // must have found no hostage - transform cleared, staged fit back.
          result.host = true;
          result.shells = shells;
          result.release = { transform: v.style.transform, objectFit: v.style.objectFit };
          done(result);
          return;
        }
        if (Date.now() < deadline) setTimeout(tick, 150);
        else { result.shells = shells; done(result); }
      };
      tick();
    };
    // Stage an embed-owned inline fit (the stub stylesheet only sets a
    // computed one), mismatch the container box against the 16:9 fixture,
    // give the container RO one beat to tick the reference box, then the
    // semantic pinch the engine itself dispatches.
    v.style.objectFit = "cover";
    v.closest(".plyr").style.width = "900px";
    setTimeout(() => {
      document.querySelector(".pf-shell").dispatchEvent(
        new CustomEvent("pf:gesture-pinch", { detail: { direction: "out" } }));
      const deadline = Date.now() + 3000;
      const pollFill = () => {
        if (v.style.transform.indexOf("scale(") === 0 && v.style.objectFit === "contain") {
          result.fill = { transform: v.style.transform, objectFit: v.style.objectFit };
          stage2();
          return;
        }
        if (Date.now() < deadline) setTimeout(pollFill, 100);
        else { result.fill = { transform: v.style.transform, objectFit: v.style.objectFit }; stage2(); }
      };
      pollFill();
    }, 350);
  });
  rows.push({
    name: "re-wrap into a second SDK container: boot-identity shell dies, video re-adopts in the new home",
    status: rewrap && rewrap.host && rewrap.shells === 1 ? "pass" : "fail",
    note: rewrap ? JSON.stringify(rewrap) : "no stamped video to move",
    ms: null
  });
  rows.push({
    name: "mid-fill destroy releases the transform hostage (fill active at destroy; cleared + object-fit restored on re-adoption)",
    status: rewrap && rewrap.fill && rewrap.fill.transform.startsWith("scale(")
      && rewrap.host && rewrap.release
      && rewrap.release.transform === "" && rewrap.release.objectFit === "cover"
      ? "pass" : "fail",
    note: rewrap && rewrap.fill
      ? (!rewrap.fill.transform.startsWith("scale(")
        ? "fill never engaged (transform stayed empty)"
        : JSON.stringify({ fill: rewrap.fill, release: rewrap.release, host: rewrap.host }))
      : "no stamped video to move",
    ms: null
  });

  // One main video per page: once a shell is live, a later qualifying
  // candidate is refused. A second Plyr-styled wrapper with a second video
  // (appended while the main is live) fires loadeddata into the downgraded
  // media-event tap - adoption must refuse it: still exactly one shell, and
  // the second video stays unstamped. A refusal is an absence, so the row
  // samples until the absence is stable (early exit only when a second shell
  // wrongly appears or the stamp lands - both are failures).
  const refusal = await session.evalAsync(function main(done) {
    const third = document.createElement("div");
    third.className = "plyr";
    third.setAttribute("data-plyr", "");
    third.style.cssText = "position:absolute;left:0;top:740px;width:1280px;height:720px;";
    third.innerHTML = "<div class=\"plyr__video-wrapper\" style=\"width:100%;height:100%\"><video id=\"check-video-3\" muted autoplay playsinline></video></div>";
    document.body.append(third);
    const v3 = third.querySelector("video");
    v3.src = "/check-video.mp4";
    let observed = null;
    v3.addEventListener("loadeddata", () => {
      observed = Date.now();
      const tick = () => {
        const stamped = v3.matches("[data-pf-shell]");
        const shells = document.querySelectorAll(".pf-shell").length;
        if (stamped || shells !== 1) {
          done({ stamped, shells, waited: Date.now() - observed });
          return;
        }
        if (Date.now() - observed > 7000) {
          done({ stamped, shells, waited: 7000 });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, { once: true });
    setTimeout(() => done({ stamped: false, shells: document.querySelectorAll(".pf-shell").length, note: "loadeddata never fired" }), 11000);
  });
  rows.push({
    name: "one main video per page: a second qualifying candidate while the main is live is refused",
    status: refusal && !refusal.stamped && refusal.shells === 1 ? "pass" : "fail",
    note: refusal ? JSON.stringify(refusal) : "no assessment within 11s",
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

  // The shell host is a custom element whose own attachment lifecycle is the
  // eviction defense (the mount adoption). Row A: a plain SDK eviction of
  // the host while the container is live - disconnectedCallback (parentless,
  // container connected) re-attaches immediately, no observer, no watchdog.
  const evict = await session.evalAsync(function main(done) {
    const host = document.querySelector(".pf-shell");
    if (!host || !host.parentElement) { done(null); return; }
    const container = host.parentElement;
    host.remove();
    const deadline = Date.now() + 2000;
    const tick = () => {
      const back = host.parentElement === container && host.isConnected;
      if (back || Date.now() > deadline) {
        done({ back, tag: host.tagName.toLowerCase(), containerTag: container.tagName.toLowerCase() });
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
  rows.push({
    name: "SDK evicts the shell host - the mount re-attaches by lifecycle",
    status: evict && evict.back && evict.tag.startsWith("pf-shell-host") ? "pass" : "fail",
    note: evict ? JSON.stringify(evict) : "no shell host found",
    ms: null
  });

  // Row B: the one lifecycle-invisible shape - eviction while the container
  // itself is detached. Container detach arms the container childList watch;
  // the eviction fires nothing on the host, the armed watch re-appends into
  // the DETACHED container, and the container's own re-insertion announces
  // recovery through connectedCallback (floor-probe axis M7). The whole
  // detour must stay inside the kernel's 500ms removal grace - it does
  // (~20ms, three awaited ticks), so the running shell is never destroyed.
  const evictDetached = await session.evalAsync(function main(done) {
    const host = document.querySelector(".pf-shell");
    if (!host || !host.parentElement) { done(null); return; }
    const container = host.parentElement;
    const anchor = container.parentElement ?? document.body;
    const tick = (fn) => { setTimeout(fn, 30); };
    container.remove();                 // container subtree leaves the doc
    tick(() => {
      const armed = !host.isConnected && host.parentElement === container;
      if (!armed) { done({ armed }); return; }
      host.remove();                    // evict INSIDE the detached window
      tick(() => {
        const recovered = host.parentElement === container && !container.isConnected;
        anchor.append(container);       // container re-insertion = recovery
        tick(() => {
          done({
            armed,
            recovered,
            back: host.isConnected && host.parentElement === container
          });
        });
      });
    });
  });
  rows.push({
    name: "eviction while the container is detached recovers through the armed watch",
    status: evictDetached && evictDetached.armed && evictDetached.recovered && evictDetached.back ? "pass" : "fail",
    note: evictDetached ? JSON.stringify(evictDetached) : "no shell host found",
    ms: null
  });

  // The panel's open/close flights schedule their class flip through
  // document.startViewTransition, whose update callback runs on the UA's own
  // clock. A shell destroy landing between the scheduling and that callback
  // must find the update callable null-guarded - otherwise the flip throws
  // late and rejects updateCallbackDone/finished unhandled. Row: spy-wrap
  // startViewTransition to hold every update behind a 120ms delay, open the
  // panel (KeyS), close it (Escape), then tear the shell down synchronously
  // through the destroy-readopt seam (a fresh moveBefore re-home) while the
  // close flight is still pending (destroy at +30ms, update at +120ms).
  // Every captured flight's updateCallbackDone AND finished must RESOLVE.
  // The spy normalizes BOTH argument shapes: the panel's own contract is the
  // object form ({ update } - see panel.js), a bare callback is spec-legal
  // too; a spy that hands the object itself to the delay would stringify it
  // into a timer-fire parse error (the "[object Object]" trap this row once
  // tripped as "missing ] after element list").
  const vtRace = await session.evalAsync(function main(done) {
    const v0 = document.querySelector("#check-video-2");
    if (!v0 || !v0.matches("[data-pf-shell]")) { done(null); return; }
    // The engine disowns hotkeys on an ended video (#isActive: readyState>0
    // && !ended), and this row lands near the fixture's 12s end, wherever
    // earlier rows left playback - loop keeps the arbitration row-shape as
    // "one live engine" instead of a race with the fixture's clock.
    v0.loop = true;
    const out = { flights: 0, callbacks: "", finished: "", destroyed: "", adopted: "", reason: "" };
    const flights = [];
    const orig = document.startViewTransition;
    document.startViewTransition = (input) => {
      const update = typeof input === "function" ? input : input?.update;
      const t = orig.call(document, () => { setTimeout(update, 120); });
      flights.push(t);
      return t;
    };
    let dead = false;
    const finish = (patch) => {
      document.startViewTransition = orig;
      if (!dead) {
        dead = true;
        Object.assign(out, patch);
        done(out);
      }
    };
    // Open: KeyS rides the input table's panel row (the engine dispatches the
    // semantic panel event); the pf-open flip is INSIDE the delayed update.
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    const openDeadline = Date.now() + 6000;
    const openTick = () => {
      const host = document.querySelector(".pf-shell");
      const panel = host && host.shadowRoot && host.shadowRoot.querySelector(".pf-panel");
      if (!panel || !panel.classList.contains("pf-open")) {
        if (Date.now() < openDeadline) setTimeout(openTick, 120);
        else finish({ reason: "panel never opened" });
        return;
      }
      // Close: the per-open dismissal keydown schedules a close flight whose
      // update is delayed 120ms.
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      // +30ms: still inside the close flight's window - tear the shell down
      // synchronously through the re-parent seam.
      setTimeout(() => {
        const stage = document.createElement("div");
        stage.className = "plyr";
        stage.setAttribute("data-plyr", "");
        stage.style.cssText = "position:absolute;left:0;top:740px;width:1280px;height:720px;";
        stage.innerHTML = "<div class=\"plyr__video-wrapper\" style=\"width:100%;height:100%\"></div>";
        document.body.append(stage);
        const oldHost = document.querySelector(".pf-shell");
        stage.querySelector(".plyr__video-wrapper").moveBefore(v0, null);
        setTimeout(() => {
          // The destroy-readopt may have re-attached a NEW shell host within
          // this window, so the witness is the OLD host's disconnection -
          // not a momentary shell-count shape.
          out.destroyed = oldHost && !oldHost.isConnected ? "gone" : "host still attached";
        }, 80);
        setTimeout(() => {
          out.adopted = v0.matches("[data-pf-shell]") ? "re-adopted" : "not yet";
          out.flights = flights.length;
          if (!flights.length) {
            finish({ reason: "no view transitions captured - the race was never exercised" });
            return;
          }
          Promise.all(flights.flatMap((t) => [t.updateCallbackDone, t.finished])).then(
            () => finish({ callbacks: "resolved", finished: "resolved" }),
            (err) => finish({
              callbacks: "rejected",
              finished: "rejected",
              reason: String(err && err.message || err)
            })
          );
        }, 1100);
      }, 30);
    };
    openTick();
  });
  rows.push({
    name: "panel flight vs destroy: a shell destroyed mid-flight leaves every view transition resolving (null-guarded late update)",
    status: vtRace && vtRace.flights >= 2 && vtRace.destroyed === "gone" && vtRace.callbacks === "resolved" && vtRace.finished === "resolved" ? "pass" : "fail",
    note: vtRace ? JSON.stringify(vtRace) : "no stamped video to move",
    ms: null
  });

  // Refusal recovery, the one-main scope law's exit: the refusal row left
  // video3 refused and unpinned (a refusal is an absence - no seen-pin, no
  // gate). Once the registry's shell is REALLY removed - its owner video
  // leaves and the RemovalWatch grace ends the shell - the registry-empty
  // edge re-arms the full tap, and its seed walk re-runs adoption on the
  // surviving candidate. Which video owns the shell when this row starts
  // is the seed walk's doc-order pick (the refusal-row's third appended
  // FIRST, before the vtRace stage that holds video2), so the row removes
  // whoever owns it and expects the OTHER video - each of which sat in a
  // refusal at some point in this case - to adopt in its place. The strand
  // shape (a refusal that survives its refusal with no recovery path) is
  // this row's fail.
  const refusalRecovery = await session.evalAsync(function main(done) {
    const first = document.querySelector("#check-video-2");
    const second = document.querySelector("#check-video-3");
    if (!first || !second) {
      done(null);
      return;
    }
    const deadline = Date.now() + 9000;
    const ownerOf = () => document.querySelector(".pf-shell")?.parentNode?.querySelector("video")?.id ?? null;
    // Phase 1: a stable one-shell state with a KNOWN owner (the vtRace
    // teardown re-arms the seed; either video may hold the slot when this
    // row starts, and the vtRace row's re-adopt read "not yet" at +1100ms).
    const removed = { id: null };
    const waitStable = () => {
      const owner = ownerOf();
      if (owner === first.id || owner === second.id) {
        removed.id = owner;
        const ownerEl = owner === first.id ? first : second;
        ownerEl.remove();
        // Grace (500ms) plus settle + boot - poll from past the grace.
        setTimeout(tick, 650);
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(waitStable, 200);
        return;
      }
      done({ state: "no owned shell stabilized", shells: document.querySelectorAll(".pf-shell").length, owner: ownerOf() });
    };
    const tick = () => {
      const shells = document.querySelectorAll(".pf-shell").length;
      const owner = ownerOf();
      // Success: the one live shell belongs to the OTHER video - the
      // removed owner left, the surviving candidate (refused earlier in
      // this case) adopted through the re-armed tap.
      if (shells === 1 && owner && removed.id && owner !== removed.id) {
        done({ stamped: true, shells, owner, removed: removed.id });
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(tick, 250);
        return;
      }
      // The strand-shape diagnosis: name the surviving shell's owner.
      done({ stamped: false, shells, owner, removed: removed.id, first: first.matches("[data-pf-shell]"), second: second.matches("[data-pf-shell]") });
    };
    waitStable();
  });
  rows.push({
    name: "refusal recovery: the refused candidate adopts when the main leaves (registry-empty edge re-arms the tap)",
    status: refusalRecovery && refusalRecovery.stamped && refusalRecovery.shells === 1 ? "pass" : "fail",
    note: refusalRecovery ? JSON.stringify(refusalRecovery) : "no live main and refused candidate to work",
    ms: null
  });

  // Hostile pre-define: a page that defines our shell-host tag before the
  // bundle evaluates (reachable only for managers/harness ceremonies - the
  // shipped document-start eval precedes every page script). The tag ladder
  // must walk to a free counter name (pf-shell-host-1) and boot must not
  // reach the NotSupportedError a taken name throws; the page's own element
  // must stay alien (no upgrade, no shadow, no pf-shell class).
  const hostile = await boot({
    pre: function main() {
      customElements.define("pf-shell-host", class extends HTMLElement {});
      const alien = document.createElement("pf-shell-host");
      document.body.appendChild(alien);
    }
  });
  const alienState = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    const alien = document.querySelector("body > pf-shell-host");
    return {
      tag: host ? host.tagName.toLowerCase() : null,
      alien: alien
        ? { shadow: !!alien.shadowRoot, shellClass: alien.classList.contains("pf-shell") }
        : null
    };
  });
  rows.push({
    name: "hostile page pre-defines pf-shell-host - the tag ladder boots on a free name",
    status: hostile.shellHost && alienState.tag && alienState.tag !== "pf-shell-host" && alienState.tag.startsWith("pf-shell-host-") && alienState.alien && !alienState.alien.shadow && !alienState.alien.shellClass ? "pass" : "fail",
    note: JSON.stringify(alienState),
    ms: null
  });

  return rows;
}
