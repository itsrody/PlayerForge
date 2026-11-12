import SHELL_CSS from "./styles.css";
import { logger } from "../../shared/runtime.js";
import { SHELL_MARKER } from "../../kernel/contract.js";
import { el } from "./ui.js";
import { gmGetResourceText } from "../../shared/store.js";

// Re-export the single contract-sourced marker so shell/forge keep importing
// it from here - one source of truth, no mirrored literal to drift.
export { SHELL_MARKER };

/**
 * One owner of the shell stylesheet lifecycle: the embedded sheet applied
 * synchronously at document-start, the @resource upgrade in the background
 * (replaceSync in place, propagating to every adopted reference), and its
 * adoption into the document. The three loose variables it replaced are
 * private fields so "adopted once, upgraded monotonically" is one object's
 * story; warmStyles()/injectShell() stay plain-call façades.
 */
class ShellStyle {
  #sheet = null;
  #adopted = false;
  #load = null;

  /** The live sheet - attached to every shadow root inject() creates. */
  get sheet() {
    return this.#sheet;
  }

  /** Apply now (synchronously available CSS), arm the @resource upgrade. */
  warm() {
    if (this.#sheet) {
      return this.#sheet;
    }
    this.#sheet = new CSSStyleSheet();
    this.#sheet.replaceSync(SHELL_CSS);
    if (!this.#adopted) {
      this.#adopted = true;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.#sheet];
    }
    this.#load = this.#warmFromResource();
    return this.#sheet;
  }

  /** Resolve the authoritative (post-@resource) stylesheet. Never rejects. */
  settled() {
    return this.#load;
  }

  async #warmFromResource() {
    let css = null;
    try {
      css = await gmGetResourceText("pfStyle");
    } catch (err) {
      logger.error("inject", "Failed to load @resource stylesheet:", err);
    }
    // Parity guard: only ever swap in STRICTLY better CSS. An empty or
    // malformed resource must not clobber the working embedded sheet - the
    // upgrade is strictly-monotonic, so the shell can never go blank from a
    // pathological fetch. replaceSync throws on invalid CSS; catch it and
    // keep the last-good sheet rather than risk a blank UI. In production the
    // @resource text is byte-identical to the embedded sheet (same esbuild
    // minifier, same source), so skip the redundant replaceSync: re-parsing
    // 19 KB and restyling the document + every adopted shadow root right at
    // first-video dimming buys nothing.
    if (css && css !== SHELL_CSS && css.trim().length > 0) {
      try {
        // Replace in place: adopted sheets everywhere see the upgrade.
        this.#sheet.replaceSync(css);
      } catch (err) {
        logger.error("inject", "Rejected malformed @resource stylesheet:", err);
      }
    }
    return this.#sheet;
  }
}

const style = new ShellStyle();

/* The container pockets ride a real <style> element, not the adopted
   constructable sheet: in the harness engine builds (Chromium and Firefox
   both, established by the check browser gate probes), @container SIZE rules
   inside
   an adoptedStyleSheets sheet never evaluate their conditions (a same-rule
   <style> twin evaluates and tracks size live), nor do @container queries
   nested inside a size
   @container. Both pockets style selectors that only exist in this shadow
   (.pf-panel-slot, .pf-panel-*) so the document-realm adoption is inert:
   - the stage band writer is --pf-compact-auto's only writer;
   - the pocket also owns the panel's whole stage-true tail - the density
     block (panel under 330px, its landscape token adjustment) and the
     compact reader - moved here as one ordered unit. Cascade rank above
     the sheet is the price; within the pocket, source order restates the
     sheet's old tie order exactly (density, landscape adjustment, compact
     LAST), so every value pair resolves as it did in the sheet. */
const CONTAINER_POCKET_CSS = `
  @container pf-stage (max-width: 480px) {
    /* Descendant has(): same match shape as the sheet's compact on-reader
       (styles.css), so the two readers mirror each other. */
    .pf-panel-slot:not(:has(.pf-panel[data-compact="off"])) {
      --pf-compact-auto: 1;
    }
  }
  /* Stage-true density: the same trigger the sheet originally carried
     (panel under 330px = stage under ~354px for the fixed panel width
     formula). A nested @container inside a size @container does not resolve
     in this build (gate probe), so no style() gate re-arms here - instead
     the whole pocket resolves ties by source order, mirroring the sheet
     order it replaced: density first, its landscape token adjustment, then
     the compact reader LAST (compact outranks density on shared tokens,
     exactly as it did in the sheet). */
  @container pf-panel (max-width: 330px) {
    .pf-panel-header { padding: var(--pf-space-sm); gap: var(--pf-space-sm); }
    .pf-panel-body { padding: var(--pf-space-sm); }
    .pf-panel-grid { grid-template-columns: minmax(0, 1fr); }
    .pf-history-card { padding: 5px var(--pf-space-sm); gap: var(--pf-space-sm); }
    .pf-history-title { --pf-history-title-size: var(--pf-font-xs); }
    .pf-history-meta { --pf-history-meta-size: var(--pf-font-2xs); }
    .pf-history-list { --pf-history-list-height: 152px; }
    /* The sheet's landscape block kept the list at 144px at this size; the
       pocket owns the tie now, so the value rides along. */
    @media (orientation: landscape) and (pointer: coarse) and (max-height: 480px) {
      .pf-history-list { --pf-history-list-height: 144px; }
    }
  }
  /* Compact reader - moved with the density block so the one live <style>
     keeps their tie order (compact last). Same style() engine the sheet
     carried: registered numeric bus on the slot, attribute-driven explicit. */
  @container pf-compact-bus style(--pf-compact: 1) {
    .pf-panel {
      width: min(300px, calc(100% - 16px));
      font-size: var(--pf-font-sm);

      .pf-panel-header {
        padding: var(--pf-space-sm);
        gap: var(--pf-space-sm);
      }

      .pf-panel-body {
        padding: var(--pf-space-xs) var(--pf-space-sm) var(--pf-space-md);
      }

      .pf-panel-grid {
        grid-template-columns: minmax(0, 1fr);
        gap: var(--pf-space-xs);
      }

      .pf-panel-tab {
        padding: 5px 6px;
        font-size: var(--pf-font-xs);
      }

      .pf-panel-tab svg {
        width: 12px;
        height: 12px;
      }

      .pf-panel-close {
        padding: var(--pf-space-xs) var(--pf-space-sm);
        font-size: 14px;
      }

      .pf-btn {
        padding: var(--pf-space-md) var(--pf-space-lg);
        font-size: var(--pf-font-sm);
      }

      .pf-settings-toggle {
        padding: var(--pf-space-sm) var(--pf-space-md);
        font-size: var(--pf-font-sm);
      }

      .pf-history-card {
        padding: 5px 8px;
        gap: var(--pf-space-sm);
      }

      .pf-history-title {
        --pf-history-title-size: var(--pf-font-xs);
      }

      .pf-history-meta {
        --pf-history-meta-size: var(--pf-font-2xs);
      }

      .pf-history-list {
        --pf-history-list-height: 152px;
      }

      .pf-stepper {
        height: 28px;
      }

      /* Compact mode on touch devices: keep thumb-sized targets. */
      @media (pointer: coarse) {
        .pf-panel-tab { padding: 7px 8px; }
        .pf-btn { padding: 9px 10px; }
        .pf-settings-toggle { padding: 7px 8px; }
        .pf-stepper { height: 30px; }
      }

      /* Compact mode bottom-sheet on portrait touch phones. */
      @media (max-width: 520px) and (pointer: coarse) {
        width: auto;
        top: auto;
        bottom: var(--pf-space-sm);
        left: var(--pf-space-sm);
        right: var(--pf-space-sm);
        max-height: 56vh;
        border-radius: 14px 14px 0 0;
        border-left: none;
        border-right: none;
        border-bottom: none;
      }
    }
  }
`;

/**
 * Apply the shell stylesheet as early as possible - ideally from
 * document-start, the real timing Violentmonkey MV2's registered
 * pre-matched injections give - so first-video dimming never waits on
 * a network round trip. The embedded string is applied synchronously first
 * (it is always available), then the @resource text is fetched in the
 * background and the SAME sheet is upgraded in place via replaceSync, which
 * propagates to every already-adopted reference (document + shadow roots).
 * Synchronous; returns the live sheet immediately. Idempotent; safe to call
 * from bootstrap() and again from shells.
 */
export function warmStyles() {
  return style.warm();
}

/**
 * The shell host's attachment defense, owned by the platform's own custom
 * element lifecycle. Every connectivity transition of the host delivers a
 * callback - the floor probe (check/.tmp/shell-mount-probe.mjs, Firefox 160)
 * proved the full matrix: eviction, container detach, container re-attach,
 * connected re-homing and moveBefore moves all deliver d/c around the move,
 * so the steady state carries ZERO observers and zero churn wakes. The one
 * lifecycle-invisible shape - an eviction while the container itself is
 * detached (no connectivity transition, and the container's re-insertion
 * cannot recover a host that is no longer its child) - is covered by a
 * childList observer on the container armed ONLY inside that window, whose
 * immediate re-append into the detached container lets the container's own
 * re-insertion announce recovery through connectedCallback. No timers, no
 * surrender - the same indefinite-fight posture the hand-rolled watchdog
 * carried, one native machine instead of observation machinery around one.
 *
 * Built lazily: the isolated import smoke evaluates this module in Node,
 * where HTMLElement does not exist, and the class is only ever constructed
 * inside a page realm (the first shellHostTag() call).
 */
let ShellHostClass = null;

function shellHostClass() {
  if (ShellHostClass) {
    return ShellHostClass;
  }
  ShellHostClass = class PfShellHost extends HTMLElement {
    #container = null;
    #dead = false;
    #armed = null;

    /** injectShell hands the container over before the host is appended:
        connectedCallback reads it, so adoption must precede insertion. */
    adopt(container) {
      this.#container = container;
    }

    /** Shell destroy: latch dead BEFORE the removal so the lifecycle never
        fights the teardown, drop the armed watch, then remove. */
    dispose() {
      this.#dead = true;
      this.#armed?.disconnect();
      this.#armed = null;
      this.remove();
    }

    #reattach() {
      this.#container.appendChild(this);
      logger.log("inject", "Shell host re-attached by lifecycle");
    }

    connectedCallback() {
      // An alien-upgraded element (a page-authored node of our tag upgraded
      // by our define) carries no container: every callback is a no-op.
      if (this.#dead || !this.#container) {
        return;
      }
      if (this.parentElement === this.#container) {
        // Back in place (re-attach, or the recovery append landing). The
        // detached window is over: drop the armed watch.
        this.#armed?.disconnect();
        this.#armed = null;
      } else if (this.#container.isConnected) {
        // Delivered in an alien parent - the connected re-home shape fires
        // d,c around the move (floor-probed): go back now.
        this.#reattach();
      }
    }

    disconnectedCallback() {
      if (this.#dead || !this.#container) {
        return;
      }
      if (this.parentElement === this.#container && !this.isConnected) {
        // Still parented and disconnected: the CONTAINER subtree left the
        // document (the only shape with this signature - an evict+re-add in
        // one task lands here connected and needs nothing). Eviction inside
        // this detached window fires nothing on the host, so a container
        // childList observer is armed for exactly this window.
        if (!this.#armed) {
          const armed = new MutationObserver(() => {
            if (this.parentElement !== this.#container) {
              // Re-append into the (detached) container immediately: the
              // container's own re-insertion then announces recovery through
              // our connectedCallback, and the armed watch is dropped there.
              this.#container.appendChild(this);
            }
          });
          armed.observe(this.#container, { childList: true });
          this.#armed = armed;
        }
      } else if (this.parentElement !== this.#container && this.#container.isConnected) {
        // Parentless eviction (or a re-home whose d delivered after the
        // move): the container is live - go back now.
        this.#reattach();
      }
      // Parentless while the container is itself detached: the armed watch
      // (armed at the container's own detach) catches the container-side
      // removal and re-appends; nothing to do here.
    }
  };
  return ShellHostClass;
}

const SHELL_HOST_TAG = "pf-shell-host";
let shellHostResolved = null;

/**
 * The host tag. The primary name is defined once per realm (each frame's
 * script realm evaluates this module separately, one registry entry each).
 * A page that pre-defines the primary name must not reach a define throw at
 * boot (NotSupportedError - the hostile-define probe) and createElement must
 * never yield an unregistered element, so a taken name walks counter names
 * until a free one is defined and cached for the realm. At document-start
 * the page has run no script yet, so the primary name is the shipped path;
 * the walk exists for managers and harness ceremonies that inject later.
 */
function shellHostTag() {
  if (shellHostResolved) {
    return shellHostResolved;
  }
  if (!customElements.get(SHELL_HOST_TAG)) {
    customElements.define(SHELL_HOST_TAG, shellHostClass());
    shellHostResolved = SHELL_HOST_TAG;
    return shellHostResolved;
  }
  for (let i = 1; ; i++) {
    const name = `${SHELL_HOST_TAG}-${i}`;
    if (!customElements.get(name)) {
      customElements.define(name, shellHostClass());
      shellHostResolved = name;
      return name;
    }
  }
}

/**
 * Build the shell DOM inside the player container as a parasite:
 * host > #shadow-root > hud layer > cue layer, appended LAST so no SDK
 * child ever changes index. Rendering dominance comes from the host's
 * z-index, not tree order. The open shadow root encapsulates all PF UI
 * for style isolation from host-page CSS. The host is a custom element
 * (see PfShellHost): its own attachment lifecycle is the defense, so the
 * caller no longer installs any watchdog machinery.
 */
export function injectShell(container) {
  if (!container) {
    logger.error("inject", "injectShell: no container");
    return null;
  }
  const host = el(shellHostTag(), { class: "pf-shell", tabindex: "-1" });
  host.adopt(container);
  container.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  if (style.sheet) {
    shadow.adoptedStyleSheets = [style.sheet];
  }

  const hudLayer = el("div", { class: "pf-hud-layer" }, shadow);
  const cueLayer = el("div", { class: "pf-cue-layer", "aria-hidden": "true" }, hudLayer);
  // The container-pocket carrier: style-element only (same adoption defect the
  // compact pocket dodges), namespaced subject, zero cascade intersections.
  const pocket = document.createElement("style");
  pocket.textContent = CONTAINER_POCKET_CSS;
  shadow.appendChild(pocket);

  logger.log("inject", `Shell DOM built inside ${container.tagName}#${container.id || container.className}`);

  return {
    host,
    shadow,
    hudLayer,
    cueLayer
  };
}

/**
 * Edge-to-edge fullscreen bypass for the SDK's iframe document.
 *
 * Chromium's Android DisplayCutoutController sets the window's
 * `layoutInDisplayCutoutMode` from the viewport-fit value of the ACTIVE
 * (fullscreen) frame - and when PlayerForge fullscreens a div, the active
 * frame is THIS iframe's document, not the top page. So the top page's
 * `viewport-fit=cover` meta alone is NOT enough: the iframe's own document
 * must also report `viewport-fit=cover`, otherwise Chrome applies the default
 * cutout mode and letterboxes the fullscreen iframe around the notch - the
 * exact "bars" PlayerForge is asked to remove.
 *
 * This injects / merges `viewport-fit=cover` into the SDK document's existing
 * viewport meta (or adds one) in the <head>, so the fullscreen frame reports
 * cover and Chrome draws it behind the display cutout. Idempotent; never
 * clobbers the other viewport keys (e.g. user-scalable, maximum-scale).
 */

/** Ensure the document's viewport meta includes viewport-fit=cover. */
export function ensureViewportFitCover(doc = document) {
  const head = doc.head || doc.getElementsByTagName("head")[0] || doc.documentElement;
  const meta = head.querySelector?.('meta[name="viewport"]');
  if (meta) {
    const content = meta.getAttribute("content") || "";
    if (/viewport-fit\s*=/i.test(content)) {
      // Override whatever fit the SDK/embed set: only "cover" opts IN to edge-
      // to-edge drawing under the cutout, so forcing it is precisely the point
      // (the user can disable the whole feature, not the fit keyword).
      const merged = content.replace(/viewport-fit\s*=\s*[^;,\s]+/i, "viewport-fit=cover");
      if (merged !== content) {
        meta.setAttribute("content", merged);
      }
    } else {
      meta.setAttribute("content", `${content.replace(/\s*,\s*$/, "")},viewport-fit=cover`);
    }
  } else {
    const created = doc.createElement("meta");
    created.setAttribute("name", "viewport");
    created.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
    head.appendChild(created);
  }
}
