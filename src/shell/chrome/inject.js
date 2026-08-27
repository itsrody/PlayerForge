import SHELL_CSS from "./styles.css";
import { logger } from "../../shared/logger.js";
import { onDomMutations } from "../../kernel/dom-watch.js";

/** DOM contract: marks videos/containers/shell hosts this script manages. */
export const SHELL_MARKER = "data-pf-shell";

let sharedSheet = null;
let adopted = false;
let styleLoad = null;

function adopt() {
  if (adopted) {
    return;
  }
  adopted = true;
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sharedSheet];
}

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
  if (sharedSheet) {
    return sharedSheet;
  }
  sharedSheet = new CSSStyleSheet();
  sharedSheet.replaceSync(SHELL_CSS);
  adopt();

  styleLoad = (async () => {
    let css = null;
    if (typeof GM_getResourceText === "function") {
      try {
        css = await GM_getResourceText("pfStyle");
      } catch (err) {
        logger.error("inject", "Failed to load @resource stylesheet:", err);
      }
    }
    if (css) {
      // Replace in place: adopted sheets everywhere see the upgrade.
      sharedSheet.replaceSync(css);
    }
    return sharedSheet;
  })();
  return sharedSheet;
}

/**
 * Resolve the authoritative (post-@resource) stylesheet. Never rejects; a
 * failed/absent fetch resolves to the embedded sheet. NOT the shell's critical
 * path - shells should adopt via warmStyles() so dimming never blocks.
 */
export function ensureStyles() {
  warmStyles();
  return styleLoad;
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
  const doc = container.ownerDocument;
  const host = doc.createElement("div");
  host.className = "pf-shell";
  host.setAttribute("tabindex", "-1");

  const shadow = host.attachShadow({ mode: "open" });
  if (sharedSheet) {
    shadow.adoptedStyleSheets = [sharedSheet];
  }

  const hudLayer = doc.createElement("div");
  hudLayer.className = "pf-hud-layer";
  shadow.appendChild(hudLayer);

  const cueLayer = doc.createElement("div");
  cueLayer.className = "pf-cue-layer";
  cueLayer.setAttribute("aria-hidden", "true");
  hudLayer.appendChild(cueLayer);

  container.appendChild(host);
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
 * back indefinitely, and a stalemate is the user's to settle. Dies with
 * `signal`.
 */
export function watchShellHost(container, host, { signal } = {}) {
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

  signal?.addEventListener("abort", () => {
    observer.disconnect();
    dropReconnectWatch();
  }, { once: true });
}
