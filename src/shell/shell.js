import { logger } from "../shared/logger.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { CueRenderer } from "./subtitles/cue-renderer.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection } from "./chrome/config.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls } from "./media.js";
import { SHELL_MARKER, ensureStyles, injectShell, shellAnchorName, watchShellHost } from "./chrome/inject.js";

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

  #bus;
  #shellDom = null;
  #inputs = null;
  #resume = null;
  #subtitles = null;
  #cues = null;
  #panel;
  #toasts = null;
  #destroyed = false;
  /** Every platform subscription this facade makes dies with this signal. */
  #scope = new AbortController();
  /** Command plane: all playback control routes through these primitives. */
  #media;
  /** OS media-key facet, null without MediaSession support. */
  #mediaSession = null;
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
    this.#media = createMediaControls({ video, bus, shellId: id });
    this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${id}": failed to inject shell DOM`);
    }
    this.#panel = new SettingsPanel(this, bus);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer, this.id);
    this.#cues = new CueRenderer(this.#shellDom.cueLayer);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);
    this.#subtitles = new SubtitlesSection(this);
    addSettingsSection(this.#panel);
    this.#setupFocusManagement();
    this.#suppressContextMenu();
    this.#forwardMediaEvents();
    this.#mediaSession = claimMediaSession({
      controls: this.#media,
      video,
      signal: this.#scope.signal
    });
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
   * Pure platform truth: one main video page, so the document's fullscreen
   * element is ours by definition. No cached state, no SDK heuristics.
   */
  get fullscreen() {
    return !!document.fullscreenElement;
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
      if (!this.#destroyed && !host.contains(event.target)) {
        queueMicrotask(() => {
          if (!this.#destroyed && document.activeElement !== host) {
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

  get bus() {
    return this.#bus;
  }

  /** The command plane, for interaction layers that issue media commands. */
  get media() {
    return this.#media;
  }

  #injectDom() {
    ensureStyles();
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    this.#shellDom.host.setAttribute(SHELL_MARKER, this.id);
    // Anchor origin for the Top Layer surfaces: they tether to this box via
    // position-anchor, so the engine keeps them over the player region.
    this.#shellDom.host.style.setProperty("anchor-name", shellAnchorName(this.id));
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#savedPositionStyle = style.position;
      this.container.style.position = "relative";
    }
    watchShellHost(this.container, this.#shellDom.host, { signal: this.#scope.signal });
  }

  #forwardMediaEvents() {
    const video = this.video;
    const makeHandler = (name) => (event) => {
      this.#bus.emit(`pf:shell-${name}`, {
        shellId: this.id,
        event,
        video
      });
      if (MEDIA_SESSION_SYNC_EVENTS.has(name)) {
        this.#mediaSession?.sync();
      }
    };
    for (const name of VIDEO_EVENTS) {
      const handler = makeHandler(name);
      video.addEventListener(name, handler, { signal: this.#scope.signal });
    }
  }

  /** Emit shell:fullscreen-change whenever this shell's checkmark flips. */
  #watchFullscreen() {
    const onChange = () => {
      const active = this.fullscreen;
      if (active !== this.#lastFullscreen) {
        this.#lastFullscreen = active;
        this.#bus.emit("pf:shell-fullscreen-change", {
          shellId: this.id,
          fullscreen: active
        });
        logger.log("shell", `Fullscreen: ${active}`);
      }
    };
    document.addEventListener("fullscreenchange", onChange, { signal: this.#scope.signal });
  }

  exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()?.catch(() => {});
    }
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
      // One abort tears down every platform subscription: media event
      // forwarding, fullscreen watch, focus management, host watchdog,
      // MediaSession ownership.
      this.#scope.abort();
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
      this.#bus.emit("pf:shell-destroyed", this);
    }
  }
}
