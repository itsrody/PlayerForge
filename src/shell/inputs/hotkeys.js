import { GestureController } from "./gestures.js";
import { getSetting } from "../config.js";
import { formatTime } from "../toast.js";
import { GESTURE_EVENTS } from "../../shared/events.js";
import { logger } from "../../shared/logger.js";

const SCRUB_MAX_MULTIPLIER = 6;
const SCRUB_VELOCITY_MAX = 1200;
const SWIPE_EXIT_MIN_PX = 100;
const STREAK_RESET_MS = 600;
const VOLUME_STEP = 0.1;

/** Shown once per page load on first fullscreen enter. */
let fullscreenHintShown = false;

/**
 * Shell-owned input layer: long-press speed boost, drag scrubbing,
 * swipe-down-to-exit-fullscreen, double-tap zones, keyboard skips,
 * volume steps, mute toggle, and pinch-to-fill. Not a lifecycle feature —
 * each Shell instantiates it directly and destroys it on teardown.
 */
export class HotkeysController {
  #shell;
  #gestureController = null;

  // Hold-to-speed state.
  #savedRate = 1;
  #activeHolds = new Set();

  // Scrub state.
  #scrubbing = false;
  #scrubDirectionMomentum = 0;
  #scrubDuration = 0;
  #scrubPixelsPerSecond = 0;

  // Skip streak state.
  #streakCount = 0;
  #lastSkipDirection = null;
  #streakResetTimer = null;

  // Fill mode state.
  #fillActive = false;
  #lastScrubToastAt = 0;

  // Misc.
  #scope = new AbortController();
  #gestureListeners = {};

  constructor(shell) {
    this.#shell = shell;
    if (!shell.container) {
      logger.error("controller", "No shell container");
      return;
    }
    const host = shell.shellHost;
    this.#gestureController = new GestureController(
      shell.video,
      shell.container,
      host,
      () => shell.fullscreen
    );
    // Trackpad pinch is fullscreen-only: keep its non-passive wheel listener
    // attached only while it can fire.
    this.#gestureController.setTrackpadPinchEnabled(shell.fullscreen);

    shell.bus.addEventListener("shell:fullscreen-change", (event) => {
      const { shellId, fullscreen } = event.detail;
      if (shellId !== shell.id) {
        return;
      }
      this.#gestureController?.setTrackpadPinchEnabled(fullscreen);
      if (fullscreen && !fullscreenHintShown) {
        fullscreenHintShown = true;
        shell.toast({
          icon: "exit-fullscreen",
          text: "Swipe down to exit",
          duration: 2500
        });
      }
      if (!fullscreen && this.#fillActive) {
        this.#clearFillMode(shell);
        logger.log("controller", "Fill cleared — fullscreen exited");
      }
    }, { signal: this.#scope.signal });

    this.#listen(host, GESTURE_EVENTS.hold, (event) => this.#onHold(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.release, (event) => this.#onRelease(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.scrub, (event) => this.#onScrub(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.scrubEnd, () => this.#onScrubEnd(shell));
    this.#listen(host, GESTURE_EVENTS.swipeStart, (event) => this.#onSwipeStart(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.swipe, (event) => this.#onSwipe(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.dbltap, (event) => this.#onDoubleTap(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.skip, (event) => this.#onSkip(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.volume, (event) => this.#onVolume(shell, event.detail));
    this.#listen(host, GESTURE_EVENTS.mute, () => this.#onMute(shell));
    this.#listen(host, GESTURE_EVENTS.pinch, (event) => this.#onPinch(shell, event.detail));
    logger.log("controller", `Attached (${shell.sdkName})`);
  }

  destroy() {
    this.#gestureController?.destroy();
    this.#gestureController = null;
    this.#scope.abort();
    this.#scrubbing = false;
    this.#scrubDirectionMomentum = 0;
    this.#scrubDuration = 0;
    this.#scrubPixelsPerSecond = 0;
    this.#activeHolds.clear();
    this.#savedRate = 1;
    this.#streakCount = 0;
    this.#lastSkipDirection = null;
    clearTimeout(this.#streakResetTimer);
    this.#streakResetTimer = null;
    this.#fillActive = false;
    for (const [target, type, handler] of Object.values(this.#gestureListeners)) {
      target.removeEventListener(type, handler);
    }
    this.#gestureListeners = {};
    logger.log("controller", "Destroyed");
  }

  #listen(target, type, handler) {
    target.addEventListener(type, handler);
    this.#gestureListeners[type] = [target, type, handler];
  }

  #onHold(shell, { method }) {
    if (!shell.video) {
      return;
    }
    const source = method || "pointer";
    if (this.#activeHolds.has(source) || (this.#activeHolds.add(source), this.#activeHolds.size > 1)) {
      return;
    }
    const speed = getSetting("controller.holdSpeed");
    this.#savedRate = shell.playbackRate;
    shell.playbackRate = speed;
    shell.toast({
      icon: "RArrows",
      text: `${speed}x`,
      group: "hold"
    });
    logger.log("controller", `Hold → ${speed}x (${source})`);
  }

  #onRelease(shell, { method, duration }) {
    const source = method || "pointer";
    if (!this.#activeHolds.delete(source)) {
      return;
    }
    if (this.#activeHolds.size > 0) {
      return;
    }
    if (shell.video) {
      shell.playbackRate = this.#savedRate;
    }
    shell.hideToast("hold");
    logger.log("controller", `Release → ${this.#savedRate}x after ${Math.round(duration)}ms (${source})`);
  }

  #onScrub(shell, { dx, velocity }) {
    if (!shell.fullscreen || !shell.video) {
      return;
    }
    if (!this.#scrubbing) {
      const duration = shell.duration;
      if (!duration || !isFinite(duration)) {
        return;
      }
      this.#scrubbing = true;
      this.#scrubDuration = duration;
      this.#scrubPixelsPerSecond = getSetting("controller.scrubSensitivity") / (duration / 300);
      this.#scrubDirectionMomentum = 0;
    }

    const multiplier = Math.min(1 + Math.abs(velocity) / SCRUB_VELOCITY_MAX, SCRUB_MAX_MULTIPLIER);
    const deltaSeconds = (dx / this.#scrubPixelsPerSecond) * multiplier;
    shell.video.currentTime = Math.max(0, Math.min(shell.video.currentTime + deltaSeconds, this.#scrubDuration));
    const instantDirection = dx > 1 ? 1 : dx < -1 ? -1 : 0;
    this.#scrubDirectionMomentum = this.#scrubDirectionMomentum * 0.6 + instantDirection * 0.4;

    const now = performance.now();
    if (now - this.#lastScrubToastAt < 100) {
      return;
    }
    this.#lastScrubToastAt = now;
    shell.toast({
      icon: this.#scrubDirectionMomentum >= 0 ? "RArrows" : "LArrows",
      text: `${formatTime(this.#scrubDuration)} / ${formatTime(shell.video.currentTime)}`,
      group: "scrub"
    });
  }

  #onScrubEnd(shell) {
    if (!this.#scrubbing) {
      return;
    }
    this.#scrubbing = false;
    this.#scrubDirectionMomentum = 0;
    this.#scrubDuration = 0;
    this.#scrubPixelsPerSecond = 0;
    shell.hideToast("scrub");
    logger.log("controller", `Scrub ended at ${shell.video?.currentTime.toFixed(1)}s`);
  }

  #onSwipeStart(shell, { direction }) {
    if (shell.fullscreen && direction === "down") {
      shell.toast({
        icon: "fs-exiting",
        text: "Exiting Fullscreen",
        group: "fs"
      });
    }
  }

  #onSwipe(shell, { direction, distance }) {
    if (!shell.fullscreen || direction !== "down") {
      return;
    }
    if (distance > SWIPE_EXIT_MIN_PX) {
      this.#clearFillMode(shell, false);
      shell.toast({
        icon: "fs-exit",
        text: "Fullscreen Exited",
        duration: 800,
        group: "fs"
      });
      shell.exitFullscreen();
      logger.log("controller", `Swipe down → exit fullscreen (${Math.round(distance)}px)`);
    } else {
      shell.hideToast("fs");
    }
  }

  #performSkip(shell, direction) {
    const streakMax = getSetting("controller.streakMax");
    if (direction === this.#lastSkipDirection) {
      this.#streakCount = Math.min(this.#streakCount + 1, streakMax);
    } else {
      this.#streakCount = 1;
      this.#lastSkipDirection = direction;
    }
    clearTimeout(this.#streakResetTimer);
    this.#streakResetTimer = setTimeout(() => {
      this.#streakCount = 0;
      this.#lastSkipDirection = null;
    }, STREAK_RESET_MS);

    const step = getSetting("controller.stepSeek") * this.#streakCount;
    shell.skip(direction === "right" ? step : -step);
    shell.toast({
      icon: direction === "right" ? "RArrows" : "LArrows",
      text: `${step}s`,
      duration: 800,
      group: "skip"
    });
  }

  #onSkip(shell, { direction }) {
    this.#performSkip(shell, direction);
  }

  #onVolume(shell, { direction }) {
    if (!shell.video) {
      return;
    }
    if (direction === "up") {
      shell.volume = Math.min(1, shell.volume + VOLUME_STEP);
    } else {
      shell.volume = Math.max(0, shell.volume - VOLUME_STEP);
    }
    const volume = shell.volume;
    const icon =
      volume === 0 ? "muted" :
      volume > 0.7 ? "volume-1" :
      volume > 0.4 ? "volume-2" : "volume-3";
    shell.toast({
      icon,
      text: `${Math.round(volume * 100)}%`,
      duration: 800,
      group: "volume"
    });
  }

  #onMute(shell) {
    if (!shell.video) {
      return;
    }
    shell.toggleMute();
    const icon =
      shell.muted ? "muted" :
      shell.volume > 0.7 ? "volume-1" :
      shell.volume > 0.4 ? "volume-2" : "volume-3";
    shell.toast({
      icon,
      text: shell.muted ? "Muted" : `${Math.round(shell.volume * 100)}%`,
      duration: 800,
      group: "volume"
    });
  }

  /**
   * Fullscreen-mode semantics only: edges skip, center toggles playback.
   * Inline-mode double-taps belong to the browser/player natively.
   */
  #onDoubleTap(shell, { zone }) {
    if (zone === "left-edge" || zone === "right-edge") {
      this.#performSkip(shell, zone === "left-edge" ? "left" : "right");
    } else if (zone === "screen") {
      shell.togglePlay();
    }
  }

  /**
   * Scale factor needed for the video's rendered box to cover the visual
   * viewport.
   */
  #computeCoverScale(video) {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) {
      return 0;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    if (!viewportWidth || !viewportHeight) {
      return 0;
    }
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return 0;
    }
    const aspect = videoWidth / videoHeight;
    const fittedWidth = Math.min(rect.width, rect.height * aspect);
    const fittedHeight = Math.min(rect.height, rect.width / aspect);
    return Math.max(viewportWidth / fittedWidth, viewportHeight / fittedHeight);
  }

  #onPinch(shell, { direction }) {
    if (!shell.fullscreen || !shell.video) {
      return;
    }
    const video = shell.video;
    if (direction === "out" && !this.#fillActive) {
      const scale = this.#computeCoverScale(video);
      if (scale <= 1) {
        return;
      }
      video.style.transition = "transform 0.15s cubic-bezier(0.2, 0, 0, 1)";
      video.style.transform = `scale(${scale})`;
      this.#fillActive = true;
      shell.toast({
        icon: "fill-aspect",
        text: "Fill Mode",
        duration: 800
      });
      logger.log("controller", `Pinch out → fill (${scale.toFixed(2)}x)`);
    } else if (direction === "in" && this.#fillActive) {
      this.#clearFillMode(shell);
      logger.log("controller", "Pinch in → unfilled");
    }
  }

  #clearFillMode(shell, animate = true) {
    if (!this.#fillActive) {
      return;
    }
    this.#fillActive = false;
    const video = shell.video;
    if (video) {
      video.style.transition = animate ? "transform 0.15s cubic-bezier(0.2, 0, 0, 1)" : "none";
      video.style.transform = "";
      if (animate) {
        setTimeout(() => {
          if (video) {
            video.style.transition = "";
          }
        }, 200);
      } else {
        video.style.transition = "";
      }
    }
  }
}
