import { delay } from "../../shared/time.js";
import { flashElement } from "../../shared/flash.js";
import { iconMarkup } from "./icons.js";

/**
 * Single toast surface hosted in the shell HUD layer: icon + text +
 * optional action buttons, optional auto-hide, and group-tagged hides so
 * overlapping callers (scrub hints, hold indicators) don't clobber each
 * other. Visibility is a pure opacity morph on pf-visible; stacking above
 * captions and below the panel is plain local z-index.
 *
 * Producer convention: durations come from TUNING.toast (flash for
 * completed actions, info for status, action for toasts with buttons,
 * hint for onboarding); sticky gesture toasts pass 0 explicitly and are
 * hidden by their gesture's end. Every producer tags its family via
 * `group` (skip, hold, scrub, fs, volume, pinch, resume, data).
 */
export class ToastManager {
  #toast;
  #icon;
  #text;
  #actions;
  /** Cancel handle for the pending auto-hide, null when none is scheduled. */
  #cancelAutoHide = null;
  #activeGroup = null;

  constructor(hudLayer) {
    const doc = hudLayer.ownerDocument;
    this.#toast = doc.createElement("pf-toast");
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
    // Inline, not stylesheet: ".pf-hud-layer > *" re-enables pointer events
    // on every HUD child and would let the hidden pill swallow clicks across
    // the player's top strip. show() flips this to "auto" only when action
    // buttons ride along; the hide path resets to "" which lands back here.
    this.#toast.style.pointerEvents = "none";
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
          flashElement(button);
          action.onClick?.();
        });
        this.#actions.appendChild(button);
      }
      this.#actions.style.display = "";
      this.#toast.style.pointerEvents = "auto";
    } else {
      this.#actions.textContent = "";
      this.#actions.style.display = "none";
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
