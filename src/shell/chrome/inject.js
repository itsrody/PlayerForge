import SHELL_CSS from "./styles.css";
import { logger } from "../../shared/logger.js";

/** DOM contract: marks videos/containers/shell hosts this script manages. */
export const SHELL_MARKER = "data-pf-shell";

let stylesInjected = false;

export function ensureStyles() {
  if (!stylesInjected) {
    stylesInjected = true;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(SHELL_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
}

/**
 * Build the shell DOM inside the player container as a parasite:
 * host > hud layer > cue layer, appended LAST so no SDK child ever changes
 * index. Rendering dominance comes from the host's z-index, not tree order.
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

  const hudLayer = doc.createElement("div");
  hudLayer.className = "pf-hud-layer";
  host.appendChild(hudLayer);

  const cueLayer = doc.createElement("div");
  cueLayer.className = "pf-cue-layer";
  cueLayer.setAttribute("aria-hidden", "true");
  hudLayer.appendChild(cueLayer);

  container.appendChild(host);
  logger.log("inject", `Shell DOM built inside ${container.tagName}#${container.id || container.className}`);

  return {
    host,
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
  let reconnectObserver = null;

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

  const armReconnectWatch = () => {
    if (reconnectObserver) {
      return;
    }
    reconnectObserver = new MutationObserver(schedule);
    reconnectObserver.observe(container.ownerDocument.documentElement, { childList: true, subtree: true });
  };

  const dropReconnectWatch = () => {
    reconnectObserver?.disconnect();
    reconnectObserver = null;
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
