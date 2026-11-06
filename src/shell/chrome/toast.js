import { DomPool } from "../../shared/dom.js";
import { delay } from "../../shared/runtime.js";
import { flashElement, button, createIconElement } from "./ui.js";

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
 * `group` (skip, scrub, hold, fs, pip, volume, pinch, filter, subtitles,
 * resume, panel).
 */
export class ToastManager {
  #pool;
  #toast;
  #icon;
  #text;
  #actions;
  /**
   * The pointer-anchored readout's anchor point: one zero-size fixed element
   * (`.pf-gesture-point`, anchor-name --pf-gesture-point) beside the pill in
   * the HUD layer. It is the tree's first JS-positioned consumer: the producer
   * writes ONLY the point's inset (raw gesture coordinates, no DOM reads here),
   * and the CSS anchor lattice (position-anchor + position-area +
   * position-try-fallbacks, resolved natively) carries the pill around it -
   * edge clamping included. It must precede the pill in tree order (CSS
   * anchor validity), so it is inserted before the pooled acquisition below.
   * One page-lifetime element, carried out of the document with the whole
   * HUD layer like the held pill.
   */
  #point;
  /** Cancel handle for the pending auto-hide, null when none is scheduled. */
  #cancelAutoHide = null;
  /** Whether the pointer/focus is over the toast (auto-hide held for WCAG 2.2.1). */
  #paused = false;
  /** Duration to schedule with when a held toast resumes (full duration, like a fresh show). */
  #pausedDuration = 0;
  /** Stable auto-hide callback, cached so show() never re-creates a closure. */
  #autoHide = () => {
    this.#cancelAutoHide = null;
    this.#isVisible = false;
    this.#applyPose(false, 0, 0);
    this.#toast.classList.remove("pf-visible");
  };
  #activeGroup = null;
  /**
   * Whether the toast is currently showing - the "already visible" half of
   * the repeated-show skip below. #autoHide and hide() reset it.
   */
  #isVisible = false;
  /** Render fingerprint of the last show(), for the alloc-free skip. */
  #lastIcon = undefined;
  #lastText = "";
  #lastColor = "";
  #lastHadActions = false;
  /** Mirrors the `pf-toast-anchored` class so pose writes are idempotent. */
  #anchoredActive = false;

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
        // Live region: every show() rewrites text/instant content, and the
        // announcement rides the accessibility tree rather than focus.
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-atomic", "true");
        // Hold the auto-hide while the pointer rests on the pill or an action
        // button has focus, so a keyboard/mouse user can actually reach the
        // buttons before the toast vanishes (WCAG 2.2.1). Pointer events only
        // reach the pill when the stylesheet makes it interactive, so purely
        // informational toasts keep their fixed lifetime.
        toast.addEventListener("pointerenter", () => this.#pauseAutoHide());
        toast.addEventListener("pointerleave", () => this.#resumeAutoHide());
        toast.addEventListener("focusin", () => this.#pauseAutoHide());
        toast.addEventListener("focusout", () => this.#resumeAutoHide());
        // Pointer-events follow the stylesheet now (hidden/informational = none,
        // visible + actions = auto) - no inline writes that could go stale
        // across pool reuse.
        hudLayer.appendChild(toast);
        return toast;
      },
      reset: (toast) => {
        toast.style.color = "";
        return toast;
      }
    });
    // The point is a SIBLING that must come BEFORE the pill: CSS anchor
    // validity excludes an anchor positioned after the anchored element in
    // tree order (the fallback then reads the pill at its static spot -
    // probed both orders), so the point is appended first and the pooled
    // pill lands after it.
    this.#point = doc.createElement("div");
    this.#point.className = "pf-gesture-point";
    hudLayer.appendChild(this.#point);
    this.#toast = this.#pool.acquire();
    this.#icon = this.#toast.querySelector(".pf-toast-icon");
    this.#text = this.#toast.querySelector(".pf-toast-text");
    this.#actions = this.#toast.querySelector(".pf-toast-actions");
  }

  /** The anchored-readout pose. A truthy `anchored` payload field claims it
   *  and this beat's gesture point repositions the anchor element; anything
   *  else restores the resting top-center pose. Runs before the visibility
   *  write in both show() arms, so a pose flip never paints the wrong pose.
   *  The class toggle is dirty-checked; the point inset is not (the stroke
   *  moves it every beat by definition). */
  #applyPose(anchored, atX, atY) {
    if (anchored && Number.isFinite(atX) && Number.isFinite(atY)) {
      this.#point.style.left = `${atX}px`;
      this.#point.style.top = `${atY}px`;
      if (!this.#anchoredActive) {
        this.#anchoredActive = true;
        this.#toast.classList.add("pf-toast-anchored");
        // Anchored-claim rewarm. Gecko re-derives an element's anchor plan
        // only at frame construction: a pose claimed on an element already
        // in the tree resolves as static fallback forever - per-poke probes
        // on the real HUD (aug 2026 diagnosis) exhausted every restyle arm:
        // sheet re-cascade, pocket re-adopt, class retoggle, inline
        // anchor-name/position-anchor rewrites, hud paint writes, point
        // reinsertion - all stale; reinserting the QUERY element (this
        // pill) is the one arm that re-plans it. So the one transition that
        // can claim the pose re-appends the pill to its parent (an
        // already-parented appendChild is a pure move - same parent, same
        // last-child slot, listeners live). Subsequent pose claims go
        // through the re-warmed element still-live: no further arm needed.
        this.#toast.parentElement?.appendChild(this.#toast);
      }
      return;
    }
    if (this.#anchoredActive) {
      this.#anchoredActive = false;
      this.#toast.classList.remove("pf-toast-anchored");
    }
  }

  show({ icon, text, duration = 0, color, group, actions, anchored, atX, atY } = {}) {
    const prevGroup = this.#activeGroup;
    this.#activeGroup = group ?? null;
    const hadActions = !!(actions?.length);
    // Pose first, both arms: the skip arm below means the pose write must
    // not be buried behind the fingerprint bail.
    this.#applyPose(anchored, atX, atY);
    // Repeated-show skip: the scrub hint re-calls show() every ~100ms tick with
    // an unchanged icon/text. Resolving a cloned SVG icon, rewriting text, and
    // re-rendering buttons each tick is pure churn when the toast is already
    // showing that exact payload for the same group - so skip the DOM work and
    // just re-assert visibility + reset the auto-hide timer. Button-bearing
    // toasts and cross-group replays always re-render (their payloads are
    // cheap and genuinely vary).
    if (
      this.#isVisible &&
      this.#activeGroup === prevGroup &&
      !hadActions && !this.#lastHadActions &&
      icon === this.#lastIcon &&
      (text || "") === this.#lastText &&
      (color || "") === this.#lastColor
    ) {
      this.#toast.classList.add("pf-visible");
      this.#scheduleAutoHide(duration);
      return;
    }
    this.#isVisible = true;
    this.#lastIcon = icon;
    this.#lastText = text || "";
    this.#lastColor = color || "";
    this.#lastHadActions = hadActions;
    // Clone from the cached icon template: a repeated icon is a cheap
    // cloneNode, not an HTML re-parse. aria-hidden lives on the template.
    // replaceChildren() (86) is the pooled-clear backend: the textContent=""
    // idiom this replaced conflated "clear children" with the text setter.
    this.#icon.replaceChildren();
    const iconEl = icon ? createIconElement(icon, this.#icon.ownerDocument) : null;
    if (iconEl) {
      this.#icon.appendChild(iconEl);
    }
    this.#icon.hidden = !iconEl;
    this.#text.textContent = text || "";
    this.#text.hidden = !text;
    if (actions && actions.length) {
      this.#actions.replaceChildren();
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
    } else {
      this.#actions.replaceChildren();
      this.#actions.hidden = true;
    }
    this.#toast.style.color = color || "";
    this.#toast.classList.add("pf-visible");
    this.#scheduleAutoHide(duration);
  }

  /** (Re)arm the auto-hide after a show; held while #paused, deferred to resume. */
  #scheduleAutoHide(duration) {
    this.#pausedDuration = duration;
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = duration > 0 && !this.#paused ? delay(this.#autoHide, duration) : null;
  }

  #pauseAutoHide() {
    if (this.#paused) {
      return;
    }
    this.#paused = true;
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = null;
  }

  #resumeAutoHide() {
    if (!this.#paused) {
      return;
    }
    this.#paused = false;
    if (this.#isVisible && this.#pausedDuration > 0) {
      this.#cancelAutoHide = delay(this.#autoHide, this.#pausedDuration);
    }
  }

  hide(group) {
    if (group === undefined || group === this.#activeGroup) {
      this.#cancelAutoHide?.();
      this.#cancelAutoHide = null;
      this.#isVisible = false;
      this.#applyPose(false, 0, 0);
      this.#toast.classList.remove("pf-visible");
    }
  }

  destroy() {
    // Cancel the pending auto-hide directly: #pauseAutoHide() early-returns
    // when the pause was never engaged, so a show(duration>0) that ran
    // without a hover left a delay armed against the removed HUD - whose
    // eventual flip lands as a class write on a detached node. #paused
    // latches too: nothing remains to resume, so a late pointerleave
    // cannot re-arm anything either way.
    this.#cancelAutoHide?.();
    this.#cancelAutoHide = null;
    this.#paused = true;
    // Only the AVAILABLE side empties here: the held #toast was acquired at
    // construction and never re-enters the pool, and it stays attached by
    // contract - the HUD host's removal (the shell's #dom defer)
    // carries it out with the whole layer's unregistering.
    this.#pool.destroy();
  }
}
