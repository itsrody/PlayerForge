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
import { yield_ as yieldToBrowser } from "../shared/scheduler.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { requestFullscreenProvision } from "../shared/context.js";
import { DOMManager } from "../shared/dom-manager.js";
import { MediaStateWatcher } from "../shared/media-watcher.js";
import { VisibilityWatcher } from "../shared/visibility-watcher.js";

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
  /** Active wake-lock session's abort controller; the browser owns release. */
  #wakeLockAbort = null;
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
  /** Standardized media event watcher — replaces 13+ manual addEventListener calls. */
  #mediaWatcher = null;
  /** Standardized visibility watcher — replaces manual visibilitychange handling. */
  #visWatcher = null;

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
    await yieldToBrowser();

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
      await yieldToBrowser();
      this.#filter = new VideoFilter(this, this.#panel);
      await yieldToBrowser();
      addHistorySection(this.#panel, this, this.#scope.signal);
      await yieldToBrowser();
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

  /** Expose the media watcher so sub-components can subscribe directly. */
  get mediaWatcher() {
    return this.#mediaWatcher;
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
   * normalization. Firefox's fullscreen iframe covers the whole display on its
   * own (the top document's viewport-fit=cover drives the cutout edge-to-edge
   * behavior; no per-frame workaround is needed), so the SDK's rendered box IS
   * the physical screen - `screen.width/height`. Returns { width, height }.
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
    // Explicit passivity opt-out: this must cancel the browser's menu, so it
    // declares `passive: false` against the composer's passive-by-default.
    this.#dom.listen(this.container, "contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, passive: false });
  }

  /** Keep focus on the shell host when pointer interactions happen inside it. */
  #setupFocusManagement() {
    const host = this.shellHost;
    if (!host) {
      return;
    }
    host.focus();
    this.#dom.listen(this.container, "pointerdown", (event) => {
      if (this.#destroyed) {
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
    // Single MediaStateWatcher replaces 13+ individual addEventListener calls.
    // The watcher owns the lifecycle via #scope.signal — all listeners are
    // removed in one pass on destroy.
    this.#mediaWatcher = new MediaStateWatcher(video, this.#scope.signal);
    // MediaSession sync: fires on any state change.
    this.#mediaWatcher.onChange(() => {
      this.#mediaSession?.sync();
    });
    // CSS custom property sync: fires on play/pause/volume boundaries.
    if (host) {
      const syncCssProps = () => {
        host.style.setProperty("--pf-media-paused", video.paused ? "1" : "0");
        host.style.setProperty("--pf-media-muted", video.muted ? "1" : "0");
      };
      syncCssProps();
      this.#mediaWatcher.onPlayPause(syncCssProps);
    }
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - every engine gates fullscreen on
    // that attribute at each frame edge). Surface a hint and re-provision the
    // chain (idempotent) so a retry succeeds if the attributes were just
    // granted, e.g. an SDK iframe created after our boot-time provisioning.
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
    const release = () => {
      this.#wakeLockAbort?.abort();
      this.#wakeLockAbort = null;
    };
    // The signal option hands lock lifecycle to the browser: aborting the
    // controller drops an in-flight request (rejects with AbortError) or tears
    // down a held lock - so there is no manual lock.release() and no post-await
    // re-check for pause/ended/destroy racing the request.
    const acquire = () => {
      if (this.#destroyed || video.paused || video.ended) {
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
    // Use the MediaStateWatcher for play/pause/ended events instead of
    // manual addEventListener calls. The watcher's lifecycle is tied to
    // #scope.signal, so all listeners are removed on destroy.
    this.#mediaWatcher?.onPlayPause(() => {
      if (video.paused || video.ended) {
        release();
      } else {
        acquire();
      }
    });
    this.#mediaWatcher?.onDestroy(release);
    // Re-acquire on visibility resume: a background tab loses the wake lock
    // but the video may still be playing when the user returns.
    this.#visWatcher = new VisibilityWatcher(this.#scope.signal);
    this.#visWatcher.onVisible(() => {
      if (!video.paused && !video.ended) {
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
      this.#wakeLockAbort?.abort();
      this.#wakeLockAbort = null;
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
