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
 * Resolve once the container's child list has been quiet for a run of
 * consecutive animation frames, or when the cap expires - whichever comes
 * first. SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 */
export function whenDomSettled(container, { quietFrames = 2, capMs = 150 } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let quiet = 0;
  let rafId = 0;
  const observer = new MutationObserver(() => {
    quiet = 0;
  });
  const done = () => {
    clearTimeout(capTimer);
    cancelAnimationFrame(rafId);
    observer.disconnect();
    resolve();
  };
  const tick = () => {
    quiet += 1;
    if (quiet >= quietFrames) {
      done();
      return;
    }
    rafId = requestAnimationFrame(tick);
  };
  const capTimer = setTimeout(done, capMs);
  observer.observe(container, { childList: true });
  rafId = requestAnimationFrame(tick);
  return promise;
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
 * Parasite watchdog: keep the shell host attached inside its container
 * without ever fighting the SDK over sibling order. A single debounced
 * observer re-appends the host (as last child) only when something removed
 * it from the container; re-parenting of the container carries the host
 * along and needs no reaction.
 */
export function watchShellHost(container, host) {
  let scheduled = false;

  const check = () => {
    scheduled = false;
    if (host.parentElement !== container && container.isConnected) {
      container.appendChild(host);
      logger.log("inject", "Shell host re-attached by watchdog");
    }
  };

  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(check);
  };

  const observer = new MutationObserver(schedule);
  observer.observe(container, { childList: true });

  return () => observer.disconnect();
}
