import { logger } from "../shared/logger.js";
import { SHELL_MARKER } from "../kernel/kernel.js";
import { HotkeysController } from "./inputs/hotkeys.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { CueRenderer } from "./subtitles/cue-renderer.js";
import { SettingsPanel } from "./panel.js";
import { addSettingsSection } from "./config.js";
import { ToastManager } from "./toast.js";
import { ensureStyles, injectShell, watchShellHost } from "./inject.js";

const VIDEO_EVENTS = [
  "play", "pause", "playing", "waiting", "seeking", "seeked", "timeupdate",
  "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "ended", "volumechange", "ratechange", "progress", "stalled", "emptied", "error"
];

const MEDIA_SESSION_SYNC_EVENTS = new Set([
  "play", "pause", "playing", "ended", "seeked", "durationchange", "ratechange",
  "volumechange", "loadedmetadata"
]);
const MEDIA_SESSION_ACTIONS = [
  "play", "pause", "stop", "seekbackward", "seekforward", "seekto",
  "previoustrack", "nexttrack"
];

/** The shell whose video currently owns navigator.mediaSession. */
let mediaSessionOwner = null;

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

  #bus;
  #shellDom = null;
  #inputs = null;
  #resume = null;
  #subtitles = null;
  #cues = null;
  #panel;
  #toasts = null;
  #destroyed = false;
  #cleanups = new Set();
  #stopHostWatch = null;
  /** Mirror of the fullscreen checkmark, used only to dedup change events. */
  #lastFullscreen = false;
  #savedPositionStyle = null;

  constructor({ id, video, container, sdk, sdkName, bus }) {
    this.id = id;
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.sdkName = sdkName;
    this.#bus = bus;
    this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${id}": failed to inject shell DOM`);
    }
    this.#panel = new SettingsPanel(this, bus);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer);
    this.#cues = new CueRenderer(this.#shellDom.cueLayer);
    this.#inputs = new HotkeysController(this);
    this.#resume = new ResumeTracker(this);
    this.#subtitles = new SubtitlesSection(this);
    addSettingsSection(this.#panel);
    this.#setupFocusManagement();
    this.#suppressContextMenu();
    this.#forwardMediaEvents();
    this.#registerMediaSession();
    this.#watchFullscreen();
    this.#markManaged();
    logger.log("shell", `Shell "${id}" constructed (${sdkName})`);
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
   * Pure platform truth: this shell is fullscreen iff the document's
   * fullscreen element belongs to it. No cached state, no SDK heuristics.
   */
  get fullscreen() {
    const el = document.fullscreenElement;
    return !!el && this.#ownsFullscreenElement(el);
  }

  async play() {
    try {
      await this.video.play();
    } catch (err) {
      if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
        throw err;
      }
    }
  }

  pause() {
    this.video.pause();
  }

  togglePlay() {
    if (this.paused) {
      this.play();
    } else {
      this.pause();
    }
  }

  toggleMute() {
    this.muted = !this.muted;
  }

  seek(time) {
    this.currentTime = time;
  }

  skip(delta) {
    const target = this.currentTime + delta;
    this.currentTime = this.duration > 0
      ? Math.max(0, Math.min(target, this.duration))
      : Math.max(0, target);
  }

  get shellDom() {
    return this.#shellDom;
  }

  get shellHost() {
    return this.#shellDom?.host;
  }

  get cues() {
    return this.#cues;
  }

  get panel() {
    return this.#panel;
  }

  #suppressContextMenu() {
    const handler = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    this.container.addEventListener("contextmenu", handler, true);
    this.#cleanups.add(() => this.container.removeEventListener("contextmenu", handler, true));
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
      if (!this.#destroyed && !host.contains(event.target)) {
        queueMicrotask(() => {
          if (!this.#destroyed && document.activeElement !== host) {
            host.focus();
          }
        });
      }
    };
    this.container.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    this.#cleanups.add(() => this.container.removeEventListener("pointerdown", onPointerDown, { capture: true, passive: true }));
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

  get bus() {
    return this.#bus;
  }

  #injectDom() {
    ensureStyles();
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    this.#shellDom.host.setAttribute(SHELL_MARKER, this.id);
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#savedPositionStyle = style.position;
      this.container.style.position = "relative";
    }
    this.#stopHostWatch = watchShellHost(this.container, this.#shellDom.host);
    logger.log("shell", "Shell DOM injected as first child of container");
  }

  #forwardMediaEvents() {
    const video = this.video;
    const makeHandler = (name) => (event) => {
      this.#bus.emit(`shell:${name}`, {
        shellId: this.id,
        event,
        video
      });
      if (MEDIA_SESSION_SYNC_EVENTS.has(name)) {
        this.#syncMediaSessionState();
      }
    };
    for (const name of VIDEO_EVENTS) {
      const handler = makeHandler(name);
      video.addEventListener(name, handler);
      this.#cleanups.add(() => video.removeEventListener(name, handler));
    }
  }

  #registerMediaSession() {
    const session = navigator.mediaSession;
    if (!session) {
      return;
    }
    if (mediaSessionOwner && mediaSessionOwner !== this) {
      mediaSessionOwner.#clearMediaSession();
    }
    mediaSessionOwner = this;
    const registerAction = (action, handler) => {
      session.setActionHandler(action, handler);
      this.#cleanups.add(() => {
        if (mediaSessionOwner === this) {
          session.setActionHandler(action, null);
        }
      });
    };
    registerAction("play", () => this.play());
    registerAction("pause", () => this.pause());
    registerAction("stop", () => {
      this.pause();
      this.currentTime = 0;
    });
    registerAction("seekbackward", (details) => this.skip(-(details?.seekOffset || 10)));
    registerAction("seekforward", (details) => this.skip(details?.seekOffset || 10));
    registerAction("seekto", (details) => {
      if (details?.seekTime != null) {
        this.currentTime = details.seekTime;
      }
    });
    session.playbackState = this.paused ? "paused" : "playing";
    this.#updatePositionState();
    this.#cleanups.add(() => {
      if (mediaSessionOwner === this) {
        session.playbackState = "none";
        mediaSessionOwner = null;
      }
    });
    logger.log("shell", "MediaSession handlers registered");
  }

  #clearMediaSession() {
    const session = navigator.mediaSession;
    if (session) {
      for (const action of MEDIA_SESSION_ACTIONS) {
        session.setActionHandler(action, null);
      }
      session.playbackState = "none";
    }
  }

  #syncMediaSessionState() {
    if (mediaSessionOwner !== this) {
      return;
    }
    const session = navigator.mediaSession;
    if (session) {
      session.playbackState = this.video.paused ? "paused" : "playing";
      this.#updatePositionState();
    }
  }

  #updatePositionState() {
    if (mediaSessionOwner !== this) {
      return;
    }
    const session = navigator.mediaSession;
    if (session && Number.isFinite(this.video.duration) && this.video.duration > 0) {
      try {
        session.setPositionState({
          duration: this.video.duration,
          playbackRate: this.video.playbackRate,
          position: Math.min(this.video.currentTime, this.video.duration)
        });
      } catch {}
    }
  }

  /** Emit shell:fullscreen-change whenever this shell's checkmark flips. */
  #watchFullscreen() {
    const onChange = () => {
      const active = this.fullscreen;
      if (active !== this.#lastFullscreen) {
        this.#lastFullscreen = active;
        this.#bus.emit("shell:fullscreen-change", {
          shellId: this.id,
          fullscreen: active
        });
        logger.log("shell", `Fullscreen: ${active}`);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    this.#cleanups.add(() => document.removeEventListener("fullscreenchange", onChange));
  }

  exitFullscreen() {
    const fullscreenEl = document.fullscreenElement;
    if (fullscreenEl && this.#ownsFullscreenElement(fullscreenEl)) {
      document.exitFullscreen()?.catch(() => {});
    }
  }

  #ownsFullscreenElement(element) {
    const container = this.container;
    const video = this.video;
    return element === container || element === video ||
      container?.contains(element) || video?.contains(element) || element.contains(container);
  }

  #markManaged() {
    this.video.setAttribute(SHELL_MARKER, this.id);
    this.container.setAttribute(SHELL_MARKER, this.id);
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      logger.log("shell", `Destroying shell "${this.id}"`);
      this.#resume?.destroy();
      this.#resume = null;
      this.#subtitles?.destroy();
      this.#subtitles = null;
      for (const cleanup of this.#cleanups) {
        try {
          cleanup();
        } catch (err) {
          logger.error("shell", "Cleanup error:", err);
        }
      }
      this.#cleanups.clear();
      this.#stopHostWatch?.();
      this.#stopHostWatch = null;
      this.#inputs?.destroy();
      this.#inputs = null;
      this.#panel?.destroy();
      this.#panel = null;
      this.#cues?.destroy();
      this.#cues = null;
      this.#toasts?.destroy();
      this.#toasts = null;
      this.#shellDom?.host.remove();
      this.#shellDom = null;
      if (this.#savedPositionStyle != null) {
        this.container.style.position = this.#savedPositionStyle;
      }
      this.video.removeAttribute(SHELL_MARKER);
      this.container.removeAttribute(SHELL_MARKER);
      this.#bus.emit("shell:destroyed", this);
    }
  }
}
