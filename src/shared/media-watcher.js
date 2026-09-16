/**
 * Standardized media event watcher.
 *
 * A single class that wires to a <video> element's event set and exposes
 * reactive state. Eliminates the per-shell pattern of manually registering
 * 10+ individual addEventListener calls for MEDIA_SESSION_SYNC_EVENTS,
 * CSS custom property sync, and resume progress tracking.
 *
 * The watcher owns its listener lifecycle via an AbortSignal — when the
 * signal fires, every listener is removed in one pass. Multiple consumers
 * (MediaSession sync, CSS props, resume tracker) share one watcher instance
 * instead of each wiring their own overlapping event sets.
 *
 * @example
 * const watcher = new MediaStateWatcher(video, signal);
 * watcher.onChange(() => mediaSession.sync());
 * watcher.onPlayPause(() => updateCssProps());
 * watcher.onDestroy(() => saveProgress());
 */
export class MediaStateWatcher {
  /** @type {HTMLVideoElement} */
  #video;
  /** @type {AbortSignal} */
  #signal;
  /** @type {Set<Function>} */
  #changeListeners = new Set();
  /** @type {Set<Function>} */
  #playPauseListeners = new Set();
  /** @type {Set<Function>} */
  #destroyListeners = new Set();
  #destroyed = false;

  /**
   * @param {HTMLVideoElement} video - The video element to watch.
   * @param {AbortSignal} signal - Lifecycle signal; abort tears down all listeners.
   */
  constructor(video, signal) {
    this.#video = video;
    this.#signal = signal;
    // Wire the two event groups once. Each group fires its own listener set.
    const opts = { signal, passive: true };
    // State-change events: anything that affects position/rate/volume.
    for (const name of MEDIA_CHANGE_EVENTS) {
      video.addEventListener(name, () => this.#notifyChange(), opts);
    }
    // Play/pause boundary events: for CSS property sync and pause-flush paths.
    for (const name of MEDIA_BOUNDARY_EVENTS) {
      video.addEventListener(name, () => this.#notifyPlayPause(), opts);
    }
    // Destroy event: ended or error signals final state.
    video.addEventListener("ended", () => this.#notifyDestroy(), opts);
    video.addEventListener("error", () => this.#notifyDestroy(), opts);
    // Auto-teardown on signal abort.
    signal.addEventListener("abort", () => {
      this.#destroyed = true;
      this.#changeListeners.clear();
      this.#playPauseListeners.clear();
      this.#destroyListeners.clear();
    }, { once: true });
  }

  /** Subscribe to any state change (play/pause/seek/volume/rate/metadata). */
  onChange(cb) {
    if (this.#destroyed) return () => {};
    this.#changeListeners.add(cb);
    return () => this.#changeListeners.delete(cb);
  }

  /** Subscribe to play/pause boundary transitions only. */
  onPlayPause(cb) {
    if (this.#destroyed) return () => {};
    this.#playPauseListeners.add(cb);
    return () => this.#playPauseListeners.delete(cb);
  }

  /** Subscribe to terminal events (ended/error) for final-state saves. */
  onDestroy(cb) {
    if (this.#destroyed) return () => {};
    this.#destroyListeners.add(cb);
    return () => this.#destroyListeners.delete(cb);
  }

  /** Direct video state accessors — no manual `video.paused` reads needed. */
  get paused() { return this.#video.paused; }
  get muted() { return this.#video.muted; }
  get currentTime() { return this.#video.currentTime; }
  get duration() { return this.#video.duration; }
  get playbackRate() { return this.#video.playbackRate; }

  #notifyChange() {
    for (const cb of this.#changeListeners) {
      try { cb(); } catch {}
    }
  }

  #notifyPlayPause() {
    for (const cb of this.#playPauseListeners) {
      try { cb(); } catch {}
    }
  }

  #notifyDestroy() {
    for (const cb of this.#destroyListeners) {
      try { cb(); } catch {}
    }
  }
}

/** Events that shift playback state (position, rate, volume, metadata). */
const MEDIA_CHANGE_EVENTS = [
  "play", "pause", "playing", "ended", "seeked",
  "durationchange", "ratechange", "volumechange",
  "loadedmetadata", "timeupdate"
];

/** Events at play/pause boundaries — for CSS prop sync and flush-on-pause. */
const MEDIA_BOUNDARY_EVENTS = ["play", "pause", "volumechange"];
