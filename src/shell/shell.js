import { logger } from "../shared/logger.js";
import { deepestActiveElement, isInsideShell, fs } from "../shared/shadow.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { VideoFilter } from "./filter.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection, getSetting } from "./chrome/config.js";
import { TUNING } from "./chrome/config.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls, MEDIA_SESSION_SYNC_EVENTS } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { ensureViewportFitCover } from "./chrome/viewport.js";
import { requestFullscreenProvision } from "../shared/context.js";

const VIDEO_EVENTS = [
  "play", "pause", "playing", "waiting", "seeking", "seeked", "timeupdate",
  "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "ended", "volumechange", "ratechange", "progress", "stalled", "emptied", "error"
];

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
  /** Every platform subscription this facade makes dies with this signal. */
  #scope = new AbortController();
  /** Command plane: all playback control routes through these primitives. */
  #media;
  /** OS media-key facet, null without MediaSession support. */
  #mediaSession = null;
  #savedPositionStyle = null;

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
    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);
    this.#subtitles = new SubtitlesSection(this);
    this.#filter = new VideoFilter(this, this.#panel);
    addHistorySection(this.#panel, this);
    addSettingsSection(this.#panel);
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
    return this.video.duration || 0;
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

  #suppressContextMenu() {
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    this.container.addEventListener("contextmenu", handler, { capture: true, signal: this.#scope.signal });
  }

  /** Keep focus on the shell host when pointer interactions happen inside it. */
  #setupFocusManagement() {
    const host = this.shellHost;
    if (!host) {
      return;
    }
    host.focus();
    const onPointerDown = (event) => {
      if (!this.#destroyed && !isInsideShell(host, event.composedPath()[0])) {
        queueMicrotask(() => this.#restoreFocusIfNeeded(host));
      }
    };
    this.container.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true, signal: this.#scope.signal });
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
    this.#shellDom.host.setAttribute(SHELL_MARKER, "");
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#savedPositionStyle = style.position;
      this.container.style.position = "relative";
    }
    watchShellHost(this.container, this.#shellDom.host, { signal: this.#scope.signal });
  }

  #forwardMediaEvents() {
    const video = this.video;
    const handler = () => {
      this.#mediaSession?.sync();
    };
    for (const name of MEDIA_SESSION_SYNC_EVENTS) {
      video.addEventListener(name, handler, { signal: this.#scope.signal, passive: true });
    }
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - Chromium requires it on every
    // frame edge). Surface a hint and re-provision the chain
    // (idempotent) so a retry succeeds if the attributes were just granted,
    // e.g. an SDK iframe created after our boot-time provisioning.
    document.addEventListener("fullscreenerror", () => {
      if (this.#destroyed || fs) {
        return;
      }
      this.#toasts?.show({
        icon: "fs-block",
        text: "Fullscreen blocked by embed",
        duration: TUNING.toast.infoMs,
        group: "fs-block"
      });
      if (window.top !== window) {
        requestFullscreenProvision();
      }
    }, { signal: this.#scope.signal });
  }

  /** Keep screen awake while video is playing; release on pause/ended/hidden. */
  #watchWakeLock() {
    const video = this.video;
    const { signal } = this.#scope;
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
    video.addEventListener("play", acquire, { signal, passive: true });
    video.addEventListener("pause", release, { signal, passive: true });
    video.addEventListener("ended", release, { signal, passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !video.paused && !video.ended) {
        acquire();
      }
    }, { signal });
  }

  exitFullscreen() {
    if (fs) {
      document.exitFullscreen()?.catch(() => {});
    }
  }

  #markManaged() {
    this.video.setAttribute(SHELL_MARKER, "");
    this.container.setAttribute(SHELL_MARKER, "");
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      logger.log("shell", `Destroying shell "${this.sdk.name}"`);
      this.#resume?.destroy();
      this.#resume = null;
      this.#subtitles?.destroy();
      this.#subtitles = null;
      this.#filter?.destroy();
      this.#filter = null;
      this.#wakeLock?.release();
      this.#wakeLock = null;
      // One abort tears down every platform subscription: media event
      // forwarding, fullscreen watch, focus management, host watchdog,
      // MediaSession ownership.
      this.#scope.abort();
      this.#inputs?.destroy();
      this.#inputs = null;
      this.#panel?.destroy();
      this.#panel = null;
      this.#toasts?.destroy();
      this.#toasts = null;
      this.#shellDom?.host.remove();
      this.#shellDom = null;
      if (this.#savedPositionStyle != null) {
        this.container.style.position = this.#savedPositionStyle;
      }
      this.video.removeAttribute(SHELL_MARKER);
      this.container.removeAttribute(SHELL_MARKER);
      this.#onDestroy?.(this);
    }
  }
}
