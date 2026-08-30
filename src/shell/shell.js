import { logger } from "../shared/logger.js";
import { deepestActiveElement, isInsideShell, fs } from "../shared/shadow.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { VideoFilter } from "./filter.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection } from "./chrome/config.js";
import { TUNING } from "./chrome/config.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { requestFullscreenProvision } from "../shared/context.js";

const VIDEO_EVENTS = [
  "play", "pause", "playing", "waiting", "seeking", "seeked", "timeupdate",
  "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "ended", "volumechange", "ratechange", "progress", "stalled", "emptied", "error"
];

const MEDIA_SESSION_SYNC_EVENTS = new Set([
  "play", "pause", "playing", "ended", "seeked", "durationchange", "ratechange",
  "volumechange", "loadedmetadata"
]);

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
  sdkName;

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

  constructor({ video, container, sdk, sdkName, onDestroy }) {
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.sdkName = sdkName;
    this.#onDestroy = onDestroy;
    this.#media = createMediaControls({ video });
    this.ready = this.#boot();
  }

  /** Resolves when the shell DOM and HUD are live. Styles load is awaited. */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdkName}": failed to inject shell DOM`);
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
    logger.log("shell", `Shell "${this.sdkName}" constructed`);
  }

  get volume() {
    return this.video.volume;
  }

  set volume(value) {
    this.video.volume = Math.max(0, Math.min(1, value));
  }

  get currentTime() {
    return this.video.currentTime;
  }

  set currentTime(value) {
    this.video.currentTime = value;
  }

  get duration() {
    return this.video.duration || 0;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  set playbackRate(value) {
    this.video.playbackRate = value;
  }

  get muted() {
    return this.video.muted;
  }

  set muted(value) {
    this.video.muted = value;
  }

  get paused() {
    return this.video.paused;
  }

  get playing() {
    return !this.video.paused && !this.video.ended && this.video.readyState > 2;
  }

  get ended() {
    return this.video.ended;
  }

  get buffered() {
    return this.video.buffered;
  }

  get seekable() {
    return this.video.seekable;
  }

  get readyState() {
    return this.video.readyState;
  }

  get textTracks() {
    return this.video.textTracks;
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

  async play() {
    return this.#media.play();
  }

  pause() {
    this.#media.pause();
  }

  togglePlay() {
    return this.#media.togglePlay();
  }

  stop() {
    this.#media.stop();
  }

  toggleMute() {
    this.#media.toggleMute();
  }

  seek(time) {
    this.#media.seekTo(time);
  }

  /** Continuous drag variant of seek: canonical clamp, no command event. */
  scrubTo(time) {
    this.#media.scrubTo(time);
  }

  skip(delta) {
    this.#media.skip(delta);
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

  focus() {
    this.shellHost?.focus();
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
        queueMicrotask(() => {
          if (!this.#destroyed && deepestActiveElement(host) !== host) {
            host.focus();
          }
        });
      }
    };
    this.container.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true, signal: this.#scope.signal });
  }

  toast(payload) {
    this.#toasts?.show(payload);
  }

  hideToast(group) {
    this.#toasts?.hide(group);
  }

  get toasts() {
    return this.#toasts;
  }

  /** Whole-store clipboard export (JSON) for the Data panel section. */
  exportResume() {
    return this.#resume?.exportResume() ?? null;
  }

  /** Merge pasted JSON into the resume store; returns counts or null. */
  importResume(text) {
    return this.#resume?.importResume(text) ?? null;
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
    // ancestor embed lacks allowfullscreen - Firefox requires it on every
    // frame edge, bug 1608358). Surface a hint and re-provision the chain
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
      logger.log("shell", `Destroying shell "${this.sdkName}"`);
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
