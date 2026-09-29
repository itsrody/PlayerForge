import { logger } from "../shared/diagnostics.js";
import { deepestActiveElement, isInsideShell, fs } from "../shared/shadow.js";
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
import { replayFullscreenProvision } from "../shared/context.js";
import { DOMManager } from "../shared/dom-manager.js";
import { Scope } from "../shared/scope.js";
import { createActivity } from "../shared/activity.js";
import { yield_ } from "../shared/scheduler.js";

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
  /** Pooled box reused by the referenceBox getter; values are rewritten on every read. */
  #refBox = { width: 0, height: 0 };
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
    // A boot that throws AFTER #injectDom has marked the video would otherwise
    // strand a half-live shell: the caller only logs, the video keeps its
    // SHELL_MARKER, and the kernel refuses to adopt a marked video for the
    // life of the document. Roll the half-built shell back here, where the
    // instance is still reachable, then re-throw so the caller still sees the
    // failure and can allow a retry. destroy() is null-safe across every
    // sub-component and idempotent via the scope.
    this.ready = this.#boot().catch((err) => {
      logger.error("shell", `Shell "${this.sdk.name}" boot failed - rolling back`, err);
      this.destroy();
      throw err;
    });
  }

  /** Resolves when the shell DOM and HUD are live. Styles load is awaited. */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
    }

    // Yield between DOM injection and component construction so the browser
    // can process pending layout/paint work before the panel builds its tree.
    await yield_();

    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer, this.#dom);
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
    this.#mediaSession = claimMediaSession({
      controls: this.#media,
      video: this.video,
      signal: this.#scope.signal
    });
    this.#watchFullscreen();
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
   * Unified contextual reference box, per the PlayerForge geometry rule: the
   * shell's own container inline, the physical screen in fullscreen (the
   * :fullscreen rule stretches the container to the screen). Read directly at
   * call time - no cache, no invalidation watchers; consumers read once per
   * gesture (scrub start, pinch-out). Returns { width, height }.
   */
  get referenceBox() {
    const box = this.#refBox;
    if (fs) {
      box.width = screen.width;
      box.height = screen.height;
    } else {
      box.width = this.container.clientWidth;
      box.height = this.container.clientHeight;
    }
    return box;
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
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    // Register host for auto-removal on destroy and mark managed attributes.
    this.#dom.onCleanup(() => this.#shellDom?.host.remove());
    this.#dom.markAttribute(this.#shellDom.host, SHELL_MARKER, "");
    // Mark the video/container in the same synchronous block as the injection.
    // The kernel treats the marker as "this video already has a shell"
    // (kernel.js #adoptVideo) and the stylesheet uses it as the fullscreen
    // hook, so leaving the video unmarked for the rest of boot - which spans
    // several yields while the panel builds - is a real window: the HUD is
    // already live and queryable, but the video claims to be unmanaged. A
    // second adoption in that window would boot a duplicate shell onto it.
    this.#markManaged();
    // Restore container position if we changed it from static.
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#dom.markStyle(this.container, "position", "relative");
    }
    // Parasite watchdog: re-attach host if evicted by SDK. The reconnect
    // subscription is manager-owned, so the watchdog's arm/disarm cycle stops
    // at shell destroy without a paired cleanup handle here.
    watchShellHost(this.container, this.#shellDom.host, this.#dom);
  }

  #forwardMediaEvents() {
    const video = this.video;
    const host = this.#shellDom?.host;
    const handler = () => {
      this.#mediaSession?.sync();
    };
    // Boundary events (play/pause/ended/seeked/durationchange/...) are rare and
    // must land even while paused - a seek or a volume change still has to
    // reach the OS surface - so they stay attached for the shell's life.
    for (const name of MEDIA_SESSION_SYNC_EVENTS) {
      if (name !== "timeupdate") {
        this.#dom.listen(video, name, handler, { passive: true });
      }
    }
    // `timeupdate` is the only continuous one: it is the ~4 Hz media clock, and
    // it only ticks while the playhead advances. That makes playback the
    // activity it belongs to, so it is attached for the playing window and
    // detached when the window closes - the clock listener does not exist while
    // paused, and the exit flush hands the OS surface the final position.
    createActivity({
      target: video,
      events: ["play", "playing", "pause", "ended", "emptied"],
      isActive: () => !video.paused && !video.ended,
      signal: this.#scope.signal,
      onEnter: (work) => {
        video.addEventListener("timeupdate", handler, { signal: work.signal, passive: true });
      },
      onExit: handler
    });
    // Expose media state as CSS custom properties on the host so the shadow
    // DOM can style based on playing/paused/muted without crossing the realm
    // boundary. The :playing/:paused/:muted pseudo-classes (which Firefox
    // does not ship, and which cannot reach into shadow roots anywhere)
    // are not relied on; custom properties bridge the gap.
    if (host) {
      // Write the custom properties only when their value actually flips.
      // volumechange fires continuously while volume/panner is dragged, and a
      // setProperty on a hot style recolors the host subtree for nothing when
      // neither flag changed.
      let pausedVar = null;
      let mutedVar = null;
      const sync = () => {
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
    // ancestor embed lacks allowfullscreen - the UA requires it on every
    // frame edge). Surface a hint and re-provision the chain
    // (idempotent) so a retry succeeds if the attributes were just granted,
    // e.g. an SDK iframe created after our boot-time provisioning.
    this.#dom.listen(document, "fullscreenerror", () => {
      if (this.#scope.disposed || fs) {
        return;
      }
      this.toastInfo("fs-block", "Fullscreen blocked by embed", "fs-block");
      if (window.top !== window) {
        // The replay entry point, not the boot-time one: the latch entry.js
        // spent at shell-ready is already set by now, so a request through it
        // would be dropped and the retry would fail the same way.
        replayFullscreenProvision();
      }
    });
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
