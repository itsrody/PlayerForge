import SHELL_CSS from "./styles.css";
import { logger } from "../shared/logger.js";
import { iconMarkup } from "../shared/icons.js";
import { CueRenderer } from "./cue-renderer.js";

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
 * host > hud layer > [toast, cue layer].
 */
export function injectShell(container) {
  if (!container) {
    logger.error("injection", "injectShell: no container");
    return null;
  }
  const doc = container.ownerDocument;
  const host = doc.createElement("div");
  host.setAttribute("class", "pf-shell");
  host.setAttribute("tabindex", "-1");

  const hudLayer = doc.createElement("div");
  hudLayer.setAttribute("class", "pf-hud-layer");
  host.appendChild(hudLayer);

  const toast = doc.createElement("pf-toast");
  const toastIcon = doc.createElement("span");
  toastIcon.className = "pf-toast-icon";
  const toastText = doc.createElement("span");
  toastText.className = "pf-toast-text";
  const toastActions = doc.createElement("span");
  toastActions.className = "pf-toast-actions";
  toast.appendChild(toastIcon);
  toast.appendChild(toastText);
  toast.appendChild(toastActions);
  hudLayer.appendChild(toast);

  const cueLayer = doc.createElement("div");
  cueLayer.className = "pf-cue-layer";
  cueLayer.setAttribute("aria-hidden", "true");
  hudLayer.appendChild(cueLayer);

  const cuePool = new CueRenderer(cueLayer);

  if (container.firstChild) {
    container.insertBefore(host, container.firstChild);
  } else {
    container.appendChild(host);
  }
  logger.log("injection", `Shell DOM built inside ${container.tagName}#${container.id || container.className}`);

  let autoHideTimer = null;
  let activeGroup = null;

  function toastFn({ icon, text, duration = 0, color, group, actions } = {}) {
    activeGroup = group ?? null;
    if (icon) {
      const markup = iconMarkup(icon);
      if (markup) {
        toastIcon.innerHTML = markup;
        toastIcon.style.display = "";
      } else {
        toastIcon.innerHTML = "";
        toastIcon.style.display = "none";
      }
    } else {
      toastIcon.innerHTML = "";
      toastIcon.style.display = "none";
    }
    if (text) {
      toastText.textContent = text;
      toastText.style.display = "";
    } else {
      toastText.textContent = "";
      toastText.style.display = "none";
    }
    if (actions && actions.length) {
      toastActions.textContent = "";
      for (const action of actions) {
        const button = doc.createElement("button");
        button.type = "button";
        if (action.icon) {
          const markup = iconMarkup(action.icon);
          if (markup) {
            button.innerHTML = markup;
          }
        } else {
          button.textContent = action.label;
        }
        button.title = action.title ?? action.label ?? "";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick?.();
        });
        toastActions.appendChild(button);
      }
      toastActions.style.display = "";
      toast.classList.add("pf-toast-interactive");
      toast.style.pointerEvents = "auto";
    } else {
      toastActions.style.display = "none";
      toast.classList.remove("pf-toast-interactive");
      toast.style.pointerEvents = "";
    }
    if (color) {
      toast.style.color = color;
    } else {
      toast.style.color = "";
    }
    toast.classList.add("pf-visible");
    clearTimeout(autoHideTimer);
    if (duration > 0) {
      autoHideTimer = setTimeout(() => {
        toast.classList.remove("pf-visible");
      }, duration);
    }
  }

  function hideToastFn(group) {
    if (group === undefined || group === activeGroup) {
      clearTimeout(autoHideTimer);
      toast.classList.remove("pf-visible");
    }
  }

  return {
    host,
    hudLayer,
    cueLayer,
    cuePool,
    toast: toastFn,
    hideToast: hideToastFn
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

export function removeEl(el) {
  el?.remove();
}
