import { delay } from "../../shared/scheduler.js";
import { HudReconciler } from "../../shared/hud-reconciler.js";
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
 * The toast element is pre-created at construction for zero first-show
 * latency and handed to the shell's DOMManager with own(), so its removal
 * rides the shell's teardown. Only one toast is visible at a time, so this
 * used to sit in a DomPool with initial:1 — which bought nothing: acquire()
 * ran exactly once, the node was never released, and pool.destroy() could
 * not remove a node that had left the pool's free list.
 *
 * Rendering is L5's problem: every DOM write for the pill hangs off one
 * HudReconciler bindings table (visibility, icon, text, colour, buttons),
 * so a repeated show() of an unchanged payload issues zero writes instead of
 * the previous hand-rolled `#lastIcon` / `#lastText` / `#lastColor` /
 * `#lastHadActions` fingerprint. The output is byte-identical either way;
 * only the write count moves. The old fingerprint also could not gate a
 * *partial* change (a new colour with the same text re-cloned the icon and
 * rewrote textContent) because it compared the payload as a whole — the
 * field-by-field diff does, which is the point of routing it.
 *
 * Producer convention: durations come from TUNING.toast (flash for
 * completed actions, info for status, action for toasts with buttons,
 * hint for onboarding); sticky gesture toasts pass 0 explicitly and are
 * hidden by their gesture's end. Every producer tags its family via
 * `group` (skip, hold, scrub, fs, volume, pinch, resume, data).
 *
 * Producers must pass a *fresh* payload per call. The scrub hint re-uses and
 * mutates one object between ticks, so show() normalises its arguments into a
 * new snapshot rather than handing the reconciler the caller's object — the
 * identity fast path would otherwise skip every repaint.
 */
export class ToastManager {
  #toast;
  #icon;
  #text;
  #actions;
  /** One bindings table: the only writer for each of the pill's five fields. */
  #reconciler;
  /** Cancel handle for the pending auto-hide, null when none is scheduled. */
  #cancelAutoHide = null;
  /** Stable auto-hide callback, cached so show() never re-creates a closure. */
  #autoHide = () => {
    this.#cancelAutoHide = null;
    this.#setVisible(false);
  };
  /** Routing metadata only — the group writes nothing, so it is not a field. */
  #activeGroup = null;

  constructor(hudLayer, dom) {
    const doc = hudLayer.ownerDocument;
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
    this.#toast = dom.own(toast);
    this.#icon = icon;
    this.#text = text;
    this.#actions = actions;
    this.#reconciler = new HudReconciler({
      bindings: {
        visible: (value) => {
          this.#toast.classList.toggle("pf-visible", !!value);
        },
        // Clone from the cached icon template: a repeated icon is a cheap
        // cloneNode, not an HTML re-parse. aria-hidden lives on the template.
        icon: (value) => {
          this.#icon.textContent = "";
          const iconEl = value ? createIconElement(value, this.#icon.ownerDocument) : null;
          if (iconEl) {
            this.#icon.appendChild(iconEl);
          }
          this.#icon.hidden = !iconEl;
        },
        text: (value) => {
          this.#text.textContent = value;
          this.#text.hidden = !value;
        },
        color: (value) => {
          this.#toast.style.color = value;
        },
        actions: (value) => {
          this.#renderActions(value);
        }
      }
    });
  }

  show({ icon, text, duration = 0, color, group, actions } = {}) {
    this.#activeGroup = group ?? null;
    // A fresh snapshot per call, normalised so Object.is has a stable shape.
    this.#reconciler.apply({
      visible: true,
      icon: icon || null,
      text: text || "",
      color: color || "",
      actions: actions?.length ? actions : null
    });
    // Re-arming the timer is unconditional: a repeated show() re-arms even
    // when it wrote nothing, exactly as the old skip path did.
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = duration > 0 ? delay(this.#autoHide, duration) : null;
  }

  hide(group) {
    if (group === undefined || group === this.#activeGroup) {
      this.#cancelAutoHide?.();
      this.#cancelAutoHide = null;
      this.#setVisible(false);
    }
  }

  /** Flip visibility through the reconciler so it stays the single source. */
  #setVisible(value) {
    const applied = this.#reconciler.applied;
    this.#reconciler.apply({ ...(applied ?? {}), visible: value });
  }

  /** Sole writer for the `actions` field. Buttons are rebuilt wholesale. */
  #renderActions(actions) {
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
      this.#actions.hidden = false;
      this.#toast.style.pointerEvents = "auto";
    } else {
      this.#actions.textContent = "";
      this.#actions.hidden = true;
      this.#toast.style.pointerEvents = "";
    }
  }

  destroy() {
    // The toast node is the shell manager's to remove (own() at
    // construction); only the pending auto-hide is ours to cancel.
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = null;
  }
}
