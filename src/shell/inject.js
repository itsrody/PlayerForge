import SHELL_CSS from "./styles.css";
import { logger } from "../shared/logger.js";

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
 * Build the shell DOM inside the player container:
 * host > hud layer > cue layer.
 */
export function injectShell(container) {
  if (!container) {
    logger.error("injection", "injectShell: no container");
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

  if (container.firstChild) {
    container.insertBefore(host, container.firstChild);
  } else {
    container.appendChild(host);
  }
  logger.log("injection", `Shell DOM built inside ${container.tagName}#${container.id || container.className}`);

  return {
    host,
    hudLayer,
    cueLayer
  };
}

/**
 * Keep the shell host alive inside its container: re-insert it if something
 * removes or reorders it, and re-arm on container re-parenting.
 */
export function watchShellHost(container, host) {
  let reorderObserver = null;
  let reparentObserver = null;
  let parent = container.parentElement;

  const restorePosition = () => {
    if (host.parentElement !== container) {
      if (container.firstChild) {
        container.insertBefore(host, container.firstChild);
      } else {
        container.appendChild(host);
      }
      return;
    }
    if (container.firstChild !== host) {
      container.insertBefore(host, container.firstChild);
    }
  };

  reorderObserver = new MutationObserver(restorePosition);
  reorderObserver.observe(container, { childList: true });

  reparentObserver = new MutationObserver(() => {
    if (container.parentElement !== parent) {
      reparentObserver.disconnect();
      parent = container.parentElement;
      if (!parent) {
        return;
      }
      reparentObserver.observe(parent, { childList: true, subtree: false });
    }
    restorePosition();
  });

  if (parent) {
    reparentObserver.observe(parent, { childList: true, subtree: false });
  }

  return () => {
    reorderObserver.disconnect();
    reparentObserver.disconnect();
  };
}
