import { logger } from "../shared/logger.js";
import { deepestActiveElement, isInsideShell, fs, subscribeFullscreen } from "../shared/shadow.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { VideoFilter } from "./filter.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection } from "./chrome/config.js";
import { TUNING } from "../shared/tuning.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls, MEDIA_SESSION_SYNC_EVENTS } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { requestFullscreenProvision } from "../shared/context.js";
import { DOMManager } from "../shared/dom-manager.js";

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
  #wakeLock = null;
  #onDestroy;
  #destroyed = false;
  /** DOM lifecycle manager: listeners, observers, elements, rollbacks. */
  #dom = new DOMManager();
  /** Sub-component scope: signal passed to InputForge, MediaSession, etc. */
  #scope = new AbortController();
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

  /** Resolves when the shell DOM and HUD are live. Styles load is awaited. */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
    }

    // Yield between DOM injection and component construction so the browser
    // can process pending layout/paint work before the panel builds its tree.
    // scheduler.yield() is Chromium-only; fall back to setTimeout on Firefox.
    if (typeof scheduler?.yield === "function") {
      await scheduler.yield();
    } else {
      await new Promise(r => { setTimeout(r, 0); });
    }

    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);

    // Lazy section builder: panel sections (subtitles, filter, history,
    // settings) are constructed on first open to keep boot fast.
    this.#panel.setSectionBuilder(() => {
      this.#subtitles = new SubtitlesSection(this);
      this.#filter = new VideoFilter(this, this.#panel);
      addHistorySection(this.#panel, this);
      addSettingsSection(this.#panel);
    });

    this.#setupFocusManagement();
    this.#suppressContextMenu();
    this.#forwardMediaEvents();
    this.#mediaSession = claimMediaSession({
      controls: this.#media,
      video: this.video,
      signal: this.#scope.signal
    });
    this.#watchFullscreen();
    this.#watchWakeLock();
    this.#watchOrientation();
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
   * inline mode the reference is the shell's own container (the SDK container);
   * in fullscreen the frame fills the screen, so the reference is the physical
   * screen. Firefox has no display-cutout letterboxing inside iframes, so no
   * safe-rect narrowing applies. Returns { width, height }.
   */
  get referenceBox() {
    if (fs) {
      return { width: screen.width, height: screen.height };
    }
    return { width: this.container.clientWidth, height: this.container.clientHeight };
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
      if (!this.#destroyed && !isInsideShell(host, event.composedPath()[0])) {
        queueMicrotask(() => this.#restoreFocusIfNeeded(host));
      }
    }, { capture: true, passive: true });
  }

  /** Re-focus the host after a pointerdown unless focus already moved inside. */
  #restoreFocusIfNeeded(host) {
    if (!this.#destroyed && deepestActiveElement(host) !== host) {
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
    const handler = () => {
      this.#mediaSession?.sync();
    };
    for (const name of MEDIA_SESSION_SYNC_EVENTS) {
      this.#dom.listen(video, name, handler, { passive: true });
    }
    // Expose media state as CSS custom properties on the host so the shadow
    // DOM can style based on playing/paused/muted without crossing the realm
    // boundary. Chromium 152+ :playing/:paused/:muted pseudo-classes exist but
    // cannot reach into shadow roots; custom properties bridge the gap.
    if (host) {
      const sync = () => {
        host.style.setProperty("--pf-media-paused", video.paused ? "1" : "0");
        host.style.setProperty("--pf-media-muted", video.muted ? "1" : "0");
      };
      sync();
      for (const evt of ["play", "pause", "volumechange"]) {
        this.#dom.listen(video, evt, sync, { passive: true });
      }
    }
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - Chromium requires it on every
    // frame edge). Surface a hint and re-provision the chain
    // (idempotent) so a retry succeeds if the attributes were just granted,
    // e.g. an SDK iframe created after our boot-time provisioning.
    this.#dom.listen(document, "fullscreenerror", () => {
      if (this.#destroyed || fs) {
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
    const acquire = async () => {
      if (this.#destroyed || video.paused || video.ended) {
        return;
      }
      try {
        this.#wakeLock = await navigator.wakeLock.request("screen");
      } catch {}
    };
    const release = () => {
      this.#wakeLock?.release();
      this.#wakeLock = null;
    };
    this.#dom.listen(video, "play", acquire, { passive: true });
    this.#dom.listen(video, "pause", release, { passive: true });
    this.#dom.listen(video, "ended", release, { passive: true });
    this.#dom.listen(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && !video.paused && !video.ended) {
        acquire();
      }
    });
  }

  /** Lock to landscape on fullscreen entry (Android); unlock on exit. */
  #watchOrientation() {
    const unsub = subscribeFullscreen(async (active) => {
      if (this.#destroyed) {
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

  #markManaged() {
    this.#dom.markAttribute(this.video, SHELL_MARKER, "");
    this.#dom.markAttribute(this.container, SHELL_MARKER, "");
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      logger.log("shell", `Destroying shell "${this.sdk.name}"`);
      // Destroy sub-components (each manages its own internal state).
      this.#resume?.destroy();
      this.#resume = null;
      this.#subtitles?.destroy();
      this.#subtitles = null;
      this.#filter?.destroy();
      this.#filter = null;
      this.#wakeLock?.release();
      this.#wakeLock = null;
      this.#inputs?.destroy();
      this.#inputs = null;
      this.#panel?.destroy();
      this.#panel = null;
      this.#toasts?.destroy();
      this.#toasts = null;
      // Sub-component scope (InputForge, MediaSession shared signal).
      this.#scope.abort();
      // DOM lifecycle: remove elements, disconnect observers, remove
      // listeners, restore attributes/styles — all in one call.
      this.#dom.destroy();
      this.#shellDom = null;
      this.#onDestroy?.(this);
    }
  }
}
