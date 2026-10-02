import { logger } from "../shared/logger.js";
import { deepestActiveElement, isInsideShell, fs, subscribeFullscreen } from "../shared/shadow.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { VideoFilter } from "./filter.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection, getSetting } from "./chrome/config.js";
import { TUNING } from "../shared/tuning.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls, MEDIA_SESSION_SYNC_EVENTS } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { ensureViewportFitCover } from "./chrome/viewport.js";
import { requestFullscreenProvision } from "../shared/context.js";
import { DOMManager } from "../shared/dom-manager.js";
import { Scope } from "../shared/scope.js";
import { yield_ } from "../shared/scheduler.js";

/**
 * Surfaces that legitimately own the native context menu inside the shell:
 * form fields (paste/copy/spellcheck) and contenteditable regions. Tested
 * against the deep (shadow-composed) event target, so panel inputs inside
 * the shadow root resolve via their own ancestor chain.
 */
const EDITABLE_SELECTOR =
  "input, textarea, [contenteditable]:not([contenteditable='false'])";

/** Human labels for MediaError.code; an unknown code falls back at the call. */
const MEDIA_ERROR_LABELS = {
  1: "Playback was aborted",
  2: "Network error while loading video",
  3: "Video could not be decoded",
  4: "Video format is not supported"
};

/**
 * Per-video facade: wraps the media element with a stable API, injects the
 * HUD, hosts the input layer, playback tracking, subtitles, and settings
 * panel, tracks fullscreen state, and wires MediaSession.
 */
export class Shell {
  id;
  video;
  container;
  sdk;

  #shellDom = null;
  #inputs = null;
  #resume = null;
  #subtitles = null;
  #filter = null;
  #panel;
  #toasts = null;
  /** Pooled reference-box result + validity flag (see the referenceBox getter). */
  #refBox = { width: 0, height: 0 };
  #refBoxValid = false;
  /** Active wake-lock session's abort controller; the browser owns release. */
  #wakeLockAbort = null;
  #onDestroy;
  /** DOM lifecycle manager: listeners, observers, elements, rollbacks. */
  #dom = new DOMManager();
  /** Lifecycle scope: disposal flag + signal passed to InputForge,
   *  MediaSession, settings, fullscreen watchers, etc. */
  #scope = new Scope();
  /** Command plane: all playback control routes through these primitives. */
  #media;
  /** OS media-key facet, null without MediaSession support. */
  #mediaSession = null;

  constructor({ video, container, sdk, onDestroy }) {
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.#onDestroy = onDestroy;
    this.#media = createMediaControls({ video });
    this.ready = this.#boot();
  }

  /**
   * Resolves when the shell DOM and HUD are live. Styles are NOT awaited:
   * warmStyles() applies the embedded sheet synchronously and upgrades it in
   * place when the @resource fetch lands, so boot resolves on DOM rather than
   * on a network round trip.
   */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
    }

    // Yield between DOM injection and component construction so the browser
    // can process pending layout/paint work before the panel builds its tree.
    await yield_();

    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);

    // Lazy section builder: panel sections (subtitles, filter, history,
    // settings) are constructed on first open to keep boot fast. Construction
    // yields to the event loop between sections so the first-open burst never
    // wedges input handling.
    this.#panel.setSectionBuilder(async () => {
      this.#subtitles = new SubtitlesSection(this);
      await yield_();
      this.#filter = new VideoFilter(this, this.#panel);
      await yield_();
      addHistorySection(this.#panel, this);
      await yield_();
      addSettingsSection(this.#panel, this.#scope.signal);
    });

    this.#setupFocusManagement();
    this.#suppressContextMenu();
    this.#forwardMediaEvents();
    this.#watchMediaErrors();
    this.#mediaSession = claimMediaSession({
      controls: this.#media,
      video: this.video,
      signal: this.#scope.signal
    });
    this.#watchFullscreen();
    this.#watchWakeLock();
    this.#watchOrientation();
    this.#watchReferenceBoxSize();
    this.#watchVisualViewport();
    this.#markManaged();
    logger.log("shell", `Shell "${this.sdk.name}" constructed`);
  }

  /** Read-only state views; all writes route through `shell.media`. */
  get volume() {
    return this.video.volume;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get duration() {
    return Number(this.video.duration) || NaN;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  get muted() {
    return this.video.muted;
  }

  get paused() {
    return this.video.paused;
  }

  /**
   * Sole fullscreen condition, read straight off the shared `fs` gate
   * (shadow.js) - built on the native fullscreen event by initFullscreenGate().
   * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
   * fullscreen; `fs` is the single boolean that gates fs features codebase-wide.
   */
  get fullscreen() {
    return fs;
  }

  /**
   * Unified contextual reference box, per the PlayerForge geometry rule: in
   * inline mode the reference is the shell's own container (the SDK container).
   * Fullscreen reference box used for fill-mode cover scaling and scrub
   * normalization. With the edge-to-edge bypass (see viewport.js) the
   * fullscreen iframe draws behind the cutout edge-to-edge, so the SDK's
   * rendered box IS the physical screen - `screen.width/height`. No env-based
   * safe-rect narrowing is needed (or possible: env(safe-area-inset-*) does
   * not resolve inside iframes, Chromium #467970444) - the bypass already puts
   * the frame at the screen. Returns { width, height }.
   */
  get referenceBox() {
    if (!this.#refBoxValid) {
      const box = this.#refBox;
      if (fs) {
        box.width = screen.width;
        box.height = screen.height;
      } else {
        box.width = this.container.clientWidth;
        box.height = this.container.clientHeight;
      }
      this.#refBoxValid = true;
    }
    return this.#refBox;
  }

  get shellDom() {
    return this.#shellDom;
  }

  get shellHost() {
    return this.#shellDom?.host;
  }

  get panel() {
    return this.#panel;
  }

  get resume() {
    return this.#resume;
  }

  /** The DOMManager — for sub-components that need lifecycle-tracked artifacts. */
  get dom() {
    return this.#dom;
  }

  #suppressContextMenu() {
    this.#dom.listen(this.container, "contextmenu", (event) => {
      // Editable surfaces (panel inputs, select popups, contenteditable)
      // keep the native context menu - paste/copy/spellcheck is part of
      // native-feel field editing. Everything else stays suppressed so the
      // page's menu never covers the shell.
      const deep = event.composedPath?.()[0];
      if (deep && typeof deep.closest === "function" && deep.closest(EDITABLE_SELECTOR)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });
  }

  /** Keep focus on the shell host when pointer interactions happen inside it. */
  #setupFocusManagement() {
    const host = this.shellHost;
    if (!host) {
      return;
    }
    host.focus();
    this.#dom.listen(this.container, "pointerdown", (event) => {
      if (this.#scope.disposed) {
        return;
      }
      // Common case: focus already lives on the host - no traversal needed.
      if (document.activeElement === host) {
        return;
      }
      if (!isInsideShell(host, event.composedPath()[0])) {
        queueMicrotask(() => this.#restoreFocusIfNeeded(host));
      }
    }, { capture: true, passive: true });
  }

  /** Re-focus the host after a pointerdown unless focus already moved inside. */
  #restoreFocusIfNeeded(host) {
    if (!this.#scope.disposed && deepestActiveElement(host) !== host) {
      host.focus();
    }
  }

  toast(payload) {
    this.#toasts?.show(payload);
  }

  /** Completion feedback (800ms). */
  toastFlash(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.flashMs, group });
  }

  /** Status message (2500ms). */
  toastInfo(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.infoMs, group });
  }

  /** Onboarding hint (5000ms). */
  toastHint(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.hintMs, group });
  }

  /** Action toast with buttons (4000ms). */
  toastAction(icon, text, group, actions) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.actionMs, group, actions });
  }

  hideToast(group) {
    this.#toasts?.hide(group);
  }

  /** The command plane, for interaction layers that issue media commands. */
  get media() {
    return this.#media;
  }

  async #injectDom() {
    // warmStyles() is synchronous - the embedded sheet is adopted immediately,
    // so shell construction never blocks on the @resource fetch. A warm
    // background upgrade later propagates through the same shared sheet.
    warmStyles();
    // Document-level (idempotent): make the SDK's own viewport report
    // viewport-fit=cover so the fullscreen frame can draw behind the Android
    // cutout edge-to-edge (see viewport.js). Gated by fullscreen.edgeToEdge:
    // when disabled we leave the iframe at the default (Chrome letterboxes to
    // the safe area itself) and fill simply covers the letterboxed frame.
    if (getSetting("fullscreen.edgeToEdge") !== false) {
      ensureViewportFitCover();
    }
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    // Register host for auto-removal on destroy and mark managed attributes.
    this.#dom.onCleanup(() => this.#shellDom?.host.remove());
    this.#dom.markAttribute(this.#shellDom.host, SHELL_MARKER, "");
    // Restore container position if we changed it from static.
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#dom.markStyle(this.container, "position", "relative");
    }
    // Parasite watchdog: re-attach host if evicted by SDK.
    const dropWatch = watchShellHost(this.container, this.#shellDom.host);
    this.#dom.onCleanup(dropWatch);
  }

  #forwardMediaEvents() {
    const video = this.video;
    const host = this.#shellDom?.host;
    // Expose media state as CSS custom properties on the host so the shadow
    // DOM can style based on playing/paused/muted without crossing the realm
    // boundary. The :playing/:paused/:muted pseudo-classes (Chromium 156+,
    // absent on the 154 floor - verified via selector probes) cannot select
    // the page's video from inside our shadow root either way; custom
    // properties bridge the gap.
    let pausedVar = null;
    let mutedVar = null;
    const cssSync = host
      ? () => {
          // Write the custom properties only when their value actually flips.
          // volumechange fires continuously while volume/panner is dragged, and
          // a setProperty on a hot style recolors the host subtree for nothing
          // when neither flag changed.
          const paused = video.paused ? "1" : "0";
          if (paused !== pausedVar) {
            pausedVar = paused;
            host.style.setProperty("--pf-media-paused", paused);
          }
          const muted = video.muted ? "1" : "0";
          if (muted !== mutedVar) {
            mutedVar = muted;
            host.style.setProperty("--pf-media-muted", muted);
          }
        }
      : null;
    // One registration set for both concerns: play/pause/volumechange are in
    // MEDIA_SESSION_SYNC_EVENTS, so separate css-sync listeners would double-
    // dispatch those three hottest state events into two closures each.
    const handler = () => {
      this.#mediaSession?.sync();
      cssSync?.();
    };
    for (const name of MEDIA_SESSION_SYNC_EVENTS) {
      this.#dom.listen(video, name, handler, { passive: true });
    }
    cssSync?.();
  }

  /**
   * Surface a terminal media failure. The `error` event on <video> means the
   * current resource cannot play (network/decode/format), a status the native
   * UI may or may not show; a toast makes the reason visible inside the shell.
   * `video.error` is read at event time (it can be cleared on a source reset)
   * and an unknown code still reports a generic failure.
   */
  #watchMediaErrors() {
    this.#dom.listen(this.video, "error", () => {
      if (this.#scope.disposed) {
        return;
      }
      const code = this.video.error?.code;
      this.toastInfo("alert", MEDIA_ERROR_LABELS[code] ?? "Video playback error", "media-error");
    });
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - Chromium requires it on every
    // frame edge). Surface a hint, and re-issue the provisioning request so an
    // embed that was granted the attributes late can still answer.
    //
    // NOTE: this is a no-op whenever a shell was created in a nested frame, and
    // that is the only case it guards. requestFullscreenProvision is latched
    // one-shot (context.js), and entry.js already calls it from onShellCreated,
    // so by the time a fullscreenerror can arrive the latch is long set. The
    // call is kept as defence in depth - if the latch is ever relaxed, or a
    // boot-time provision is skipped, this still tries - but it does not
    // currently enable the retry the code above describes.
    this.#dom.listen(document, "fullscreenerror", () => {
      if (this.#scope.disposed || fs) {
        return;
      }
      this.toastInfo("fs-block", "Fullscreen blocked by embed", "fs-block");
      if (window.top !== window) {
        requestFullscreenProvision();
      }
    });
  }

  /** Keep screen awake while video is playing; release on pause/ended/hidden. */
  #watchWakeLock() {
    const video = this.video;
    const release = () => {
      this.#wakeLockAbort?.abort();
      this.#wakeLockAbort = null;
    };
    // The signal option hands lock lifecycle to the browser: aborting the
    // controller drops an in-flight request (rejects with AbortError) or tears
    // down a held lock - so there is no manual lock.release() and no post-await
    // re-check for pause/ended/destroy racing the request.
    const acquire = () => {
      if (this.#scope.disposed || video.paused || video.ended) {
        return;
      }
      // Screen Wake Lock is optional and can be policed away by an embed; a
      // missing API must not throw straight out of the play/visibility
      // listener (and keep the already-armed listeners alive).
      if (typeof navigator.wakeLock?.request !== "function") {
        return;
      }
      // A newer acquire supersedes an in-flight one: last signal wins.
      this.#wakeLockAbort?.abort();
      const ac = new AbortController();
      this.#wakeLockAbort = ac;
      navigator.wakeLock.request("screen", { signal: ac.signal }).catch(() => {
        // Aborted (superseded/paused/hidden) or policy-denied: no lock formed.
        if (this.#wakeLockAbort === ac) {
          this.#wakeLockAbort = null;
        }
      });
    };
    this.#dom.listen(video, "play", acquire, { passive: true });
    this.#dom.listen(video, "pause", release, { passive: true });
    this.#dom.listen(video, "ended", release, { passive: true });
    this.#dom.listen(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && !video.paused && !video.ended) {
        acquire();
      }
    });
    // A resource already playing before this shell adopted it never fires
    // `play` again; acquire once here so the screen is still kept awake.
    acquire();
  }

  /** Lock to landscape on fullscreen entry (Android); unlock on exit. */
  #watchOrientation() {
    const unsub = subscribeFullscreen(async (active) => {
      if (this.#scope.disposed) {
        return;
      }
      try {
        if (active && screen.orientation?.lock) {
          await screen.orientation.lock("landscape");
        } else if (!active && screen.orientation?.unlock) {
          screen.orientation.unlock();
        }
      } catch {}
    }, this.#scope.signal);
    this.#dom.onCleanup(unsub);
  }

  exitFullscreen() {
    if (fs) {
      document.exitFullscreen()?.catch(() => {});
    }
  }

  /**
   * Keep the pooled referenceBox honest: invalidate it on fullscreen flips
   * (fs -> screen.* dims), window resizes, and container resizes. The getter
   * stays allocation + layout-read free in the scrub/pinch hot path; only a
   * change event forces the next read through the layout query.
   */
  #watchReferenceBoxSize() {
    const invalidate = () => {
      this.#refBoxValid = false;
    };
    // Fullscreen flips re-read screen.* dims; the container RO covers every
    // inline-mode layout change (zoom, URL bar, panel). window.resize is only
    // a fallback for hosts without ResizeObserver - kept out of the default
    // path so the page never pays a per-shell resize listener.
    subscribeFullscreen(invalidate, this.#scope.signal);
    if (typeof ResizeObserver === "function") {
      this.#dom.observeResize(this.container, invalidate);
    } else {
      this.#dom.listen(window, "resize", invalidate, { passive: true });
    }
    // Orientation flip changes the screen.* dims read in fullscreen, which the
    // container ResizeObserver cannot see (the iframe box may not change).
    const orientation = typeof screen !== "undefined" ? screen.orientation : null;
    if (orientation) {
      this.#dom.listen(orientation, "change", invalidate, { passive: true });
    } else {
      this.#dom.listen(window, "orientationchange", invalidate, { passive: true });
    }
  }

  /**
   * Mirror the visual viewport onto the shell host as CSS custom properties.
   * The mobile on-screen keyboard and collapsing URL bar shrink/offset the
   * visual viewport without changing the layout viewport, so the panel's
   * portrait bottom sheet reads these to stay above the keyboard and inside
   * the actually-visible area.
   */
  #watchVisualViewport() {
    const vv = window.visualViewport;
    const host = this.shellHost;
    if (!vv || !host) {
      return;
    }
    const sync = () => {
      if (this.#scope.disposed) {
        return;
      }
      host.style.setProperty("--pf-vv-height", `${vv.height}px`);
      const inset = window.innerHeight - vv.height - vv.offsetTop;
      host.style.setProperty("--pf-vv-inset-bottom", `${inset > 0 ? inset : 0}px`);
    };
    this.#dom.listen(vv, "resize", sync, { passive: true });
    this.#dom.listen(vv, "scroll", sync, { passive: true });
    sync();
  }

  #markManaged() {
    this.#dom.markAttribute(this.video, SHELL_MARKER, "");
    this.#dom.markAttribute(this.container, SHELL_MARKER, "");
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    logger.log("shell", `Destroying shell "${this.sdk.name}"`);
    // Scope first: flips disposed (re-entrancy guard), aborts the shared
    // signal (MediaSession/settings/fullscreen listeners die natively).
    this.#scope.dispose();
    // Destroy sub-components (each manages its own internal state).
    this.#resume?.destroy();
    this.#resume = null;
    this.#subtitles?.destroy();
    this.#subtitles = null;
    this.#filter?.destroy();
    this.#filter = null;
    this.#wakeLockAbort?.abort();
    this.#wakeLockAbort = null;
    this.#inputs?.destroy();
    this.#inputs = null;
    this.#panel?.destroy();
    this.#panel = null;
    this.#toasts?.destroy();
    this.#toasts = null;
    // DOM lifecycle: remove elements, disconnect observers, remove
    // listeners, restore attributes/styles — all in one call.
    this.#dom.destroy();
    this.#shellDom = null;
    this.#onDestroy?.(this);
  }
}
