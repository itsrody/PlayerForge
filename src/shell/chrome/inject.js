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
 * story; warmStyles()/ensureStyles()/injectShell() stay plain-call façades.
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
 * Resolve the authoritative (post-@resource) stylesheet. Never rejects; a
 * failed/absent fetch resolves to the embedded sheet. NOT the shell's critical
 * path - shells should adopt via warmStyles() so dimming never blocks.
 */
export function ensureStyles() {
  warmStyles();
  return style.settled();
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
