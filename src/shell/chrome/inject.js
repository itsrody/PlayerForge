import SHELL_CSS from "./styles.css";
import { logger } from "../../shared/runtime.js";
import { onDomMutations } from "../../shared/dom.js";
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
   constructable sheet: in this Chromium build, @container SIZE rules inside
   an adoptedStyleSheets sheet never evaluate their conditions (a same-rule
   <style> twin evaluates and tracks size live - established by the check
   browser gate probes), nor do @container queries nested inside a size
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
    /* Descendant has(): the panel rides the safe-box wrapper inside the
       slot, so a direct-child has() would miss the off veto. */
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
        padding-bottom: env(safe-area-max-inset-bottom, 0px);
      }
    }
  }
`;

/**
 * Apply the shell stylesheet as early as possible - ideally from document-start
 * under Tampermonkey instant injection - so first-video dimming never waits on
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
 * Build the shell DOM inside the player container as a parasite:
 * host > #shadow-root > hud layer > cue layer, appended LAST so no SDK
 * child ever changes index. Rendering dominance comes from the host's
 * z-index, not tree order. The open shadow root encapsulates all PF UI
 * for style isolation from host-page CSS.
 */
export function injectShell(container) {
  if (!container) {
    logger.error("inject", "injectShell: no container");
    return null;
  }
  const host = el("div", { class: "pf-shell", tabindex: "-1" }, container);

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
 * Parasite watchdog, fully event-driven. Reacts only to real evictions of
 * the host - ordinary player churn never wakes us - and rides the document
 * stream whenever the container itself leaves the DOM, since detach and
 * reattach fire nothing on the container. There are deliberately no timers,
 * delays, or surrender heuristics: a page that keeps fighting gets fought
 * back indefinitely, and a stalemate is the user's to settle.
 *
 * Returns a cleanup function that disconnects all observers and stops the
 * watchdog. Call it on shell destroy.
 */
export function watchShellHost(container, host) {
  let scheduled = false;
  /** Armed only while the container is out of the document. */
  let detachWatch = null;

  const reconcile = () => {
    scheduled = false;
    if (!container.isConnected) {
      armReconnectWatch();
      return;
    }
    dropReconnectWatch();
    if (host.parentElement !== container) {
      container.appendChild(host);
      logger.log("inject", "Shell host re-attached by watchdog");
    }
  };

  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(reconcile);
    }
  };

  // While detached, ANY document mutation may be the re-insertion - ride
  // the shared dom-watch dispatcher instead of owning a full-document
  // observer. The `scheduled` latch makes redundant wake-ups free.
  const armReconnectWatch = () => {
    if (!detachWatch) {
      detachWatch = onDomMutations(schedule);
    }
  };

  const dropReconnectWatch = () => {
    detachWatch?.();
    detachWatch = null;
  };

  const observer = new MutationObserver((records) => {
    for (const { removedNodes } of records) {
      for (const node of removedNodes) {
        if (node === host) {
          schedule();
          return;
        }
      }
    }
  });
  observer.observe(container, { childList: true });

  return () => {
    observer.disconnect();
    dropReconnectWatch();
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
    return !!head;
  }
  const created = doc.createElement("meta");
  created.setAttribute("name", "viewport");
  created.setAttribute("content", "width=device-width, initial-scale=1, viewport-fit=cover");
  (head || doc.documentElement).appendChild(created);
  return !!head;
}
