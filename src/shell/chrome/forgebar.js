import { delay } from "../../shared/runtime.js";
import { subscribeFullscreen } from "../../shared/dom.js";
import { TUNING, formatTime } from "../../shared/core.js";
import { button, createIconElement, el } from "./ui.js";

/**
 * The forge-mode control bar: the shell-owned strip fullscreen mode shows in
 * place of the hidden SDK chrome (the document-realm hide rule in
 * styles.css). Backward / play-pause / forward / seek scrubber with the
 * playhead ball / current-total time / settings / exit, in that order.
 *
 * Two laws shape it:
 *  - Zero engine gestures. The buttons call the shell API directly (media,
 *    panel, exitFullscreen) instead of dispatching gesture events - the
 *    probe's E1a row pins that a bar tap dispatches nothing, so the engine's
 *    own gesture vocabulary never fires from chrome.
 *  - Idle auto-hide with WCAG 2.2.1 holds. One self-extending delay sweep:
 *    the witnesses (pointermove/pointerdown/keydown on window CAPTURE - the
 *    engine's document-capture keydown stopImmediatePropagation cannot kill
 *    a window-capture listener, the propagation path reaches window first)
 *    only stamp an activity time; the sweep on fire re-arms with the time
 *    left since that stamp, so no witness ever touches a timer. Hover over
 *    the bar, focus within it, or a paused video park the hide until
 *    released.
 *
 * Visibility is the fullscreen gate's own fact: the bar exists only while
 * this document's fullscreenElement contains the shell container (the
 * container-fs shape enterFullscreen() produces, and the same-document
 * root-fs shape a page can produce around it). A cross-frame fullscreen -
 * a PARENT document fullscreening this iframe element - presents no
 * fullscreenElement inside this document and fires no fullscreenchange, so
 * the gate goes dark there by the same recorded construction the fs gate
 * itself rides; forge mode is not entered that way.
 *
 * The seek scrubber is a native <input type=range>: the engine's keydown
 * arbitration already declines for a focused input (native arrows own it),
 * a focused button declines without allowControlFocus, and the floor probe
 * proved a real driver drag moves a styled ::-moz-range-thumb. Range/time
 * writes skip while the thumb is :active (the drag owns the value) except
 * on seeked, which always lands.
 */
export class ForgeBar {
  #shell;
  #actions;
  #signal;
  #root;
  #range;
  #time;
  #playBtn;
  /** Monotonic stamp of the last user activity; the sweep reads it. */
  #lastActive = 0;
  /** The one delay() handle (abort closure); null when disarmed. */
  #hideTimer = null;
  /** Whether a fullscreen chain containing the shell container is live. */
  #live = false;
  /** WCAG holds: pointer over the bar, focus within it, video paused. */
  #hover = false;
  #focusWithin = false;
  #paused = true;

  constructor({ shell, actions, signal }) {
    this.#shell = shell;
    this.#actions = actions;
    this.#signal = signal;
    const hud = shell.shellDom.hudLayer;
    this.#build(hud, hud.ownerDocument);
    this.#wire();
    // A shell restored into a live fullscreen (bfcache restore, an embed
    // fullscreened before the kernel booted) starts visible, not hidden.
    const fsEl = document.fullscreenElement;
    this.#live = fsEl != null && fsEl.contains(shell.container);
    if (this.#live) {
      this.#show();
    }
    // The sweep handle rides delay() without a signal (the one timer
    // backend's shape), so teardown aborts it here.
    signal.addEventListener("abort", () => this.#cancelSweep(), { once: true });
  }

  #build(hud, doc) {
    const root = el("div", {
      class: "pf-forge-bar",
      role: "toolbar",
      "aria-label": "Forge controls",
      hidden: ""
    }, hud);
    const mk = (action, icon, label) =>
      button({
        class: "pf-forge-btn",
        "data-action": action,
        "aria-label": label,
        title: label,
        icon: createIconElement(icon, doc)
      }, root);
    mk("back", "left-arrows", "Skip backward");
    this.#playBtn = mk("play", "play", "Play or pause");
    mk("fwd", "right-arrows", "Skip forward");
    this.#range = el("input", {
      class: "pf-forge-range",
      type: "range",
      min: "0",
      max: "0",
      step: "any",
      "aria-label": "Seek"
    }, root);
    this.#time = el("span", { class: "pf-forge-time" }, root);
    mk("settings", "settings", "Settings");
    mk("exit", "exit-fullscreen", "Exit fullscreen");
    this.#root = root;
    this.#paused = this.#shell.video.paused;
    // The build's static icon is the paused glyph; a video already playing
    // at construct (autoplay embed, restore mid-playback) shows pause.
    this.#renderPlayIcon();
  }

  #wire() {
    const signal = this.#signal;
    const root = this.#root;
    const video = this.#shell.video;

    // The click router: one listener, the data-action contract the toast and
    // history cards already spell.
    root.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) {
        return;
      }
      switch (btn.getAttribute("data-action")) {
        case "back":
          this.#actions.skipStep("left");
          break;
        case "play":
          this.#shell.media.togglePlay();
          break;
        case "fwd":
          this.#actions.skipStep("right");
          break;
        case "settings":
          this.#shell.panel.open();
          break;
        case "exit":
          this.#shell.exitFullscreen();
          break;
      }
    }, { signal });

    // Idle-sweep witnesses. Window capture: these run before any document-
    // capture listener (the engine's keydown arbitration included) can
    // stopImmediatePropagation them away, and they only stamp a number.
    const poke = () => this.#poke();
    for (const type of ["pointermove", "pointerdown", "keydown"]) {
      window.addEventListener(type, poke, { capture: true, signal });
    }

    // WCAG 2.2.1 holds.
    root.addEventListener("pointerenter", () => {
      this.#hover = true;
      this.#syncHold();
    }, { signal });
    root.addEventListener("pointerleave", () => {
      this.#hover = false;
      this.#syncHold();
    }, { signal });
    root.addEventListener("focusin", () => {
      this.#focusWithin = true;
      this.#syncHold();
    }, { signal });
    root.addEventListener("focusout", () => {
      this.#focusWithin = false;
      this.#syncHold();
    }, { signal });

    // Playback state: the play icon and the paused hold ride the same two
    // events; the seek readout rides the media clock.
    video.addEventListener("play", () => {
      this.#paused = false;
      this.#renderPlayIcon();
      this.#syncHold();
    }, { signal });
    video.addEventListener("pause", () => {
      this.#paused = true;
      this.#renderPlayIcon();
      this.#syncHold();
    }, { signal });
    video.addEventListener("timeupdate", () => this.#syncTime(), { signal });
    video.addEventListener("seeked", () => this.#syncTime(true), { signal });
    video.addEventListener("durationchange", () => this.#syncTime(true), { signal });
    video.addEventListener("loadedmetadata", () => this.#syncTime(true), { signal });

    // Drag-seek: the commit loop's write (one per input event, the UA
    // coalesces the burst - the measured rAF-pump record), disabled ranges
    // deliver no input events so the duration gate is structural.
    this.#range.addEventListener("input", () => {
      const duration = video.duration;
      if (Number.isFinite(duration)) {
        this.#shell.media.scrubToLatched(Number(this.#range.value), duration);
      }
    }, { signal });

    subscribeFullscreen(() => this.#onFsFlip(), signal);
  }

  /** The fullscreen gate's flip: show inside our chain, hide outside it. */
  #onFsFlip() {
    const fsEl = document.fullscreenElement;
    this.#live = fsEl != null && fsEl.contains(this.#shell.container);
    if (this.#live) {
      this.#poke();
    } else {
      this.#hide();
    }
  }

  #poke() {
    if (!this.#live) {
      return;
    }
    this.#lastActive = performance.now();
    if (this.#root.hidden) {
      this.#show();
    }
  }

  #show() {
    this.#root.hidden = false;
    this.#syncTime(true);
    this.#armSweep();
  }

  #hide() {
    this.#cancelSweep();
    if (!this.#root.hidden) {
      this.#root.hidden = true;
    }
  }

  #cancelSweep() {
    this.#hideTimer?.();
    this.#hideTimer = null;
  }

  /**
   * Arm the hide sweep. The fire path is self-extending: it re-arms with the
   * time left since the last witness stamp (activity the arm never saw), and
   * while a hold is live it simply disarms - the next hold release re-arms
   * through #syncHold, so a parked state carries no timer at all.
   */
  #armSweep(ms = TUNING.forgeBar.hideMs) {
    this.#cancelSweep();
    this.#hideTimer = delay(() => {
      this.#hideTimer = null;
      const left = this.#lastActive + TUNING.forgeBar.hideMs - performance.now();
      if (left > 0) {
        this.#armSweep(left);
        return;
      }
      if (this.#isHeld()) {
        return;
      }
      this.#hide();
    }, ms);
  }

  #isHeld() {
    return this.#hover || this.#focusWithin || this.#paused;
  }

  /** A hold-edge change while visible: held parks the sweep, released arms a
   *  fresh window. While hidden (or fs gone) holds mean nothing. */
  #syncHold() {
    if (!this.#live) {
      return;
    }
    if (this.#isHeld()) {
      this.#cancelSweep();
    } else if (!this.#root.hidden) {
      this.#armSweep();
    }
  }

  #renderPlayIcon() {
    const icon = createIconElement(this.#shell.video.paused ? "play" : "pause",
      this.#root.ownerDocument);
    if (icon) {
      this.#playBtn.replaceChildren(icon);
    }
  }

  /**
   * The seek readout. force=true (seeked/durationchange/loadedmetadata)
   * writes through an active drag; the timeupdate cadence defers to it.
   * A non-finite duration (live stream) disables the range and shortens the
   * label to the elapsed time alone.
   */
  #syncTime(force = false) {
    const video = this.#shell.video;
    const t = video.currentTime;
    const duration = video.duration;
    const finite = Number.isFinite(duration);
    this.#range.disabled = !finite;
    if (finite && Number(this.#range.max) !== duration) {
      this.#range.max = String(duration);
    }
    if (force || !this.#range.matches(":active")) {
      if (finite && Number(this.#range.value) !== t) {
        this.#range.value = String(t);
      }
      const text = finite
        ? `${formatTime(t)} / ${formatTime(duration)}`
        : formatTime(t);
      if (this.#time.textContent !== text) {
        this.#time.textContent = text;
      }
    }
  }
}
