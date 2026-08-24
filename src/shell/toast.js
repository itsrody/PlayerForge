import { logger } from "../shared/logger.js";
import { iconMarkup } from "./icons.js";

/**
 * Seconds -> "M:SS" (or "H:MM:SS" past the hour). Lives here because every
 * consumer formats time solely to render toast text.
 */
export function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

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
  #autoHideTimer = null;
  #activeGroup = null;

  constructor(hudLayer) {
    const doc = hudLayer.ownerDocument;
    this.#toast = doc.createElement("pf-toast");
    this.#toast.setAttribute("popover", "manual");
    try {
      this.#toast.showPopover();
    } catch (err) {
      logger.warn("toast", "Top Layer unavailable - toast falls back to HUD layer", err);
    }
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
  }

  show({ icon, text, duration = 0, color, group, actions } = {}) {
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
    clearTimeout(this.#autoHideTimer);
    if (duration > 0) {
      this.#autoHideTimer = setTimeout(() => {
        this.#toast.classList.remove("pf-visible");
      }, duration);
    }
  }

  hide(group) {
    if (group === undefined || group === this.#activeGroup) {
      clearTimeout(this.#autoHideTimer);
      this.#toast.classList.remove("pf-visible");
    }
  }

  destroy() {
    clearTimeout(this.#autoHideTimer);
    this.#autoHideTimer = null;
    this.#toast.remove();
  }
}
