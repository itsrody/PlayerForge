import { logger } from "../shared/logger.js";
import { SHELL_MARKER } from "../kernel/kernel.js";
import { HotkeysController } from "./inputs/hotkeys.js";
import { ResumeFeature } from "./features/resume.js";
import { SubtitlesFeature } from "./features/subtitles.js";
import { SettingsFeature } from "./features/settings.js";
import { SettingsPanel } from "./panel.js";
import { ensureStyles, injectShell, watchShellHost, removeEl } from "./inject.js";

export const VIDEO_EVENTS = [
  "play", "pause", "playing", "waiting", "seeking", "seeked", "timeupdate",
  "durationchange", "loadedmetadata", "loadeddata", "canplay", "canplaythrough",
  "ended", "volumechange", "ratechange", "progress", "stalled", "emptied", "error"
];

const SDK_FULLSCREEN_CLASSES = ["plyr--fullscreen", "mejs-container-fullscreen", "vjs-fullscreen"];
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
 * HUD, hosts the input layer, features, and settings panel, tracks fullscreen
 * state, and wires MediaSession.
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
  #features = [];
  #panel;
  #destroyed = false;
  #cleanups = new Set();
  #stopHostWatch = null;
  #fullscreen = false;
  #savedPositionStyle = null;

  constructor({ id, video, container, sdk, sdkName, bus }) {
    this.id = id;
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.sdkName = sdkName;
    this.#bus = bus;
    this.#injectDom();
    this.#panel = new SettingsPanel(this, bus);
    this.#inputs = new HotkeysController(this);
    this.#features = [
      new ResumeFeature(this),
      new SubtitlesFeature(this),
      new SettingsFeature(this)
    ];
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

  get fullscreen() {
    return this.#fullscreen;
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
    this.currentTime = Math.max(0, Math.min(this.currentTime + delta, this.duration));
  }

  get shellDom() {
    return this.#shellDom;
  }

  get shellHost() {
    return this.#shellDom?.host;
  }

  get cues() {
    return this.#shellDom?.cuePool;
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

  passFocusTo(target) {
    if (target) {
      target.focus();
    }
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
    this.container.addEventListener("pointerdown", onPointerDown, true);
    this.#cleanups.add(() => this.container.removeEventListener("pointerdown", onPointerDown, true));
  }

  toast(payload) {
    this.#shellDom?.toast?.(payload);
  }

  hideToast(group) {
    this.#shellDom?.hideToast?.(group);
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
    registerAction("previoustrack", null);
    registerAction("nexttrack", null);
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
    if (!!session && !!this.video.duration && !!isFinite(this.video.duration)) {
      try {
        session.setPositionState({
          duration: this.video.duration,
          playbackRate: this.video.playbackRate,
          position: Math.min(this.video.currentTime, this.video.duration)
        });
      } catch {}
    }
  }

  #watchFullscreen() {
    const checkFullscreen = () => {
      const active = this.#detectFullscreen();
      if (active !== this.#fullscreen) {
        this.#fullscreen = active;
        this.#bus.emit("shell:fullscreen-change", {
          shellId: this.id,
          fullscreen: active
        });
        logger.log("shell", `Fullscreen: ${active}`);
      }
    };
    document.addEventListener("fullscreenchange", checkFullscreen, true);
    this.#cleanups.add(() => document.removeEventListener("fullscreenchange", checkFullscreen, true));
    window.addEventListener("resize", checkFullscreen);
    this.#cleanups.add(() => window.removeEventListener("resize", checkFullscreen));

    const observer = new MutationObserver(checkFullscreen);
    const observeTree = (element) =>
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class", "style"],
        childList: true
      });
    let ancestor = this.container.parentElement;
    observeTree(this.container);
    for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
      observeTree(ancestor);
    }
    this.#cleanups.add(() => observer.disconnect());
    this.#fullscreen = this.#detectFullscreen();
  }

  exitFullscreen() {
    const fullscreenEl = document.fullscreenElement;
    if (fullscreenEl && this.#ownsFullscreenElement(fullscreenEl)) {
      document.exitFullscreen()?.catch(() => {});
      return;
    }
    for (let el = this.container; el; el = el.parentElement) {
      for (const cls of SDK_FULLSCREEN_CLASSES) {
        if (el.classList.contains(cls)) {
          el.classList.remove(cls);
        }
      }
    }
  }

  async enterFullscreen(lockOrientation = false) {
    if (!this.#fullscreen) {
      try {
        await this.container.requestFullscreen({ navigationUI: "hide" });
      } catch (err) {
        logger.error("shell", "Fullscreen enter failed:", err);
        return;
      }
      if (lockOrientation) {
        try {
          await screen.orientation?.lock?.("landscape");
        } catch (err) {
          const retryLock = () => {
            document.removeEventListener("fullscreenchange", retryLock, true);
            const lock = screen.orientation?.lock;
            if (lock) {
              lock("landscape").catch(() => {});
            }
          };
          document.addEventListener("fullscreenchange", retryLock, true);
          setTimeout(() => document.removeEventListener("fullscreenchange", retryLock, true), 2000);
          logger.log("shell", "Orientation lock unavailable:", err);
        }
      }
    }
  }

  #ownsFullscreenElement(element) {
    const container = this.container;
    const video = this.video;
    return element === container || element === video ||
      container?.contains(element) || video?.contains(element) || element.contains(container);
  }

  #detectFullscreen() {
    const fullscreenEl = document.fullscreenElement;
    if (fullscreenEl && this.#ownsFullscreenElement(fullscreenEl)) {
      return true;
    }
    for (let el = this.container; el; el = el.parentElement) {
      for (const cls of SDK_FULLSCREEN_CLASSES) {
        if (el.classList.contains(cls)) {
          return true;
        }
      }
    }
    return false;
  }

  #markManaged() {
    this.video.setAttribute(SHELL_MARKER, this.id);
    this.container.setAttribute(SHELL_MARKER, this.id);
  }

  destroy() {
    if (!this.#destroyed) {
      this.#destroyed = true;
      logger.log("shell", `Destroying shell "${this.id}"`);
      for (const feature of this.#features) {
        try {
          feature.destroy();
        } catch (err) {
          logger.error("shell", "Feature destroy error:", err);
        }
      }
      this.#features = [];
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
      this.#shellDom?.cuePool?.destroy();
      removeEl(this.#shellDom?.host);
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
