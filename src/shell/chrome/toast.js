import { logger } from "../../shared/logger.js";
import { delay } from "../../shared/time.js";
import { iconMarkup } from "./icons.js";
import { shellAnchorName } from "./inject.js";

/**
 * Single toast surface hosted in the shell HUD layer: icon + text +
 * optional action buttons, optional auto-hide, and group-tagged hides so
 * overlapping callers (scrub hints, hold indicators) don't clobber each
 * other. The element is a manual popover shown for its whole life: Gecko
 * paints it in the Top Layer above every page surface (fullscreen
 * included), while visibility stays a pure opacity morph on pf-visible.
 */
export class ToastManager {
  #toast;
  #icon;
  #text;
  #actions;
  /** Cancel handle for the pending auto-hide, null when none is scheduled. */
  #cancelAutoHide = null;
  #activeGroup = null;
  /** True once showPopover() succeeded - guards retries and teardown. */
  #inTopLayer = false;

  constructor(hudLayer, shellId) {
    const doc = hudLayer.ownerDocument;
    this.#toast = doc.createElement("pf-toast");
    this.#toast.setAttribute("popover", "manual");
    // Tether to the shell host: the stylesheet positions via anchor(), so
    // the engine keeps the toast over the player region with zero JS.
    this.#toast.style.setProperty("position-anchor", shellAnchorName(shellId));
    this.#toast.setAttribute("popover", "manual");
    this.#icon = doc.createElement("span");
    this.#icon.className = "pf-toast-icon";
    this.#text = doc.createElement("span");
    this.#text.className = "pf-toast-text";
    this.#actions = doc.createElement("span");
    this.#actions.className = "pf-toast-actions";
    this.#toast.appendChild(this.#icon);
    this.#toast.appendChild(this.#text);
    this.#toast.appendChild(this.#actions);
    hudLayer.appendChild(this.#toast);
    this.#claimTopLayer();
  }

  /**
   * Enter the Top Layer for the element's lifetime. showPopover() demands a
   * connected element, so this only runs after the HUD attach - and retries
   * lazily from show() when a shell was assembled while its host was torn
   * out and the watchdog brought it back.
   */
  #claimTopLayer() {
    if (this.#inTopLayer || !this.#toast.isConnected) {
      return;
    }
    try {
      this.#toast.showPopover();
      this.#inTopLayer = true;
    } catch (err) {
      logger.warn("toast", "Top Layer unavailable - toast falls back to HUD layer", err);
    }
  }

  show({ icon, text, duration = 0, color, group, actions } = {}) {
    this.#claimTopLayer();
    this.#activeGroup = group ?? null;
    const markup = icon ? iconMarkup(icon) : null;
    this.#icon.innerHTML = markup || "";
    this.#icon.style.display = markup ? "" : "none";
    this.#text.textContent = text || "";
    this.#text.style.display = text ? "" : "none";
    if (actions && actions.length) {
      this.#actions.textContent = "";
      const doc = this.#toast.ownerDocument;
      for (const action of actions) {
        const button = doc.createElement("button");
        button.type = "button";
        const actionMarkup = action.icon ? iconMarkup(action.icon) : null;
        if (actionMarkup) {
          button.innerHTML = actionMarkup;
        } else {
          button.textContent = action.label;
        }
        button.title = action.title ?? action.label ?? "";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action.onClick?.();
        });
        this.#actions.appendChild(button);
      }
      this.#actions.style.display = "";
      this.#toast.classList.add("pf-toast-interactive");
      this.#toast.style.pointerEvents = "auto";
    } else {
      this.#actions.textContent = "";
      this.#actions.style.display = "none";
      this.#toast.classList.remove("pf-toast-interactive");
      this.#toast.style.pointerEvents = "";
    }
    this.#toast.style.color = color || "";
    this.#toast.classList.add("pf-visible");
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = duration > 0
      ? delay(() => {
          this.#cancelAutoHide = null;
          this.#toast.classList.remove("pf-visible");
        }, duration)
      : null;
  }

  hide(group) {
    if (group === undefined || group === this.#activeGroup) {
      this.#cancelAutoHide?.();
      this.#cancelAutoHide = null;
      this.#toast.classList.remove("pf-visible");
    }
  }

  destroy() {
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = null;
    this.#toast.remove();
  }
}
