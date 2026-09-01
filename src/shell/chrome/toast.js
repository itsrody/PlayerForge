import { DomPool } from "../../shared/dom-pool.js";
import { delay } from "../../shared/time.js";
import { flashElement } from "./animate.js";
import { button } from "./elements.js";
import { createIconElement } from "./icons.js";

/**
 * Single toast surface hosted in the shell HUD layer: icon + text +
 * optional action buttons, optional auto-hide, and group-tagged hides so
 * overlapping callers (scrub hints, hold indicators) don't clobber each
 * other. Visibility is a pure opacity morph on pf-visible; stacking above
 * captions and below the panel is plain local z-index.
 *
 * The toast element is pre-created via DomPool for zero first-show latency.
 * Only one toast is visible at a time — acquire() always returns the same
 * pre-built node.
 *
 * Producer convention: durations come from TUNING.toast (flash for
 * completed actions, info for status, action for toasts with buttons,
 * hint for onboarding); sticky gesture toasts pass 0 explicitly and are
 * hidden by their gesture's end. Every producer tags its family via
 * `group` (skip, hold, scrub, fs, volume, pinch, resume, data).
 */
export class ToastManager {
  #pool;
  #toast;
  #icon;
  #text;
  #actions;
  /** Cancel handle for the pending auto-hide, null when none is scheduled. */
  #cancelAutoHide = null;
  #activeGroup = null;

  constructor(hudLayer) {
    const doc = hudLayer.ownerDocument;
    this.#pool = new DomPool({
      initial: 1,
      factory: () => {
        const toast = doc.createElement("pf-toast");
        const icon = doc.createElement("span");
        icon.className = "pf-toast-icon";
        const text = doc.createElement("span");
        text.className = "pf-toast-text";
        const actions = doc.createElement("span");
        actions.className = "pf-toast-actions";
        toast.appendChild(icon);
        toast.appendChild(text);
        toast.appendChild(actions);
        // Inline, not stylesheet: ".pf-hud-layer > *" re-enables pointer events
        // on every HUD child and would let the hidden pill swallow clicks across
        // the player's top strip. show() flips this to "auto" only when action
        // buttons ride along; the hide path resets to "" which lands back here.
        toast.style.pointerEvents = "none";
        hudLayer.appendChild(toast);
        return toast;
      },
      reset: (toast) => {
        toast.style.pointerEvents = "none";
        toast.style.color = "";
        return toast;
      }
    });
    this.#toast = this.#pool.acquire();
    this.#icon = this.#toast.querySelector(".pf-toast-icon");
    this.#text = this.#toast.querySelector(".pf-toast-text");
    this.#actions = this.#toast.querySelector(".pf-toast-actions");
  }

  show({ icon, text, duration = 0, color, group, actions } = {}) {
    this.#activeGroup = group ?? null;
    // Clone from the cached icon template: a repeated icon is a cheap
    // cloneNode, not an HTML re-parse. aria-hidden lives on the template.
    this.#icon.textContent = "";
    const iconEl = icon ? createIconElement(icon, this.#icon.ownerDocument) : null;
    if (iconEl) {
      this.#icon.appendChild(iconEl);
    }
    this.#icon.style.display = iconEl ? "" : "none";
    this.#text.textContent = text || "";
    this.#text.style.display = text ? "" : "none";
    if (actions && actions.length) {
      this.#actions.textContent = "";
      const doc = this.#actions.ownerDocument;
      for (const action of actions) {
        const buttonEl = button({
          title: action.title ?? action.label ?? "",
          icon: action.icon ? createIconElement(action.icon, doc) : null
        }, this.#actions);
        if (!action.icon) {
          buttonEl.textContent = action.label;
        }
        buttonEl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          flashElement(buttonEl);
          action.onClick?.();
        });
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
    this.#pool.destroy();
  }
}
