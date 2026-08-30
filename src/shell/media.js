import { logger } from "../shared/logger.js";
import { BUS_EVENTS } from "../shared/events.js";

/** Volume delta applied by nudgeVolume, shared with UI feedback layers. */
export const VOLUME_STEP = 0.1;

/**
 * Media command plane. Every way of controlling playback - gestures, hotkeys,
 * panel widgets, OS media keys through MediaSession - funnels through these
 * primitives so clamping, guarding, and observability live in exactly one
 * place. Commands execute immediately against the video and announce one
 * generic `pf:media-command` event; presentation (toasts) stays at the
 * interaction sites that own their context.
 *
 * `scrubTo` is deliberately silent: it serves continuous drag streams, not
 * discrete commands, and the resulting position is already broadcast through
 * the regular timeupdate path.
 */
export function createMediaControls({ video, bus, shellId }) {
  const emit = (type, detail) => {
    bus.emit(BUS_EVENTS.mediaCommand, { shellId, type, ...detail });
  };

  /**
   * Gate: every control stays inert until metadata is loaded (readyState
   * HAVE_METADATA, the point where duration is known). Before that the video
   * has no established timeline, so seeking/skipping is meaningless and a
   * play request could fight an in-flight load. Commands then no-op without
   * emitting, so the whole control surface - gestures, hotkeys, MediaSession
   * OS keys - simply does nothing until playback is ready.
   */
  const isReady = () => video.readyState >= 1;

  /** Canonical absolute-position clamp: inside duration when we know it. */
  const clampTarget = (time) => {
    if (!Number.isFinite(time)) {
      return 0;
    }
    return Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, Math.min(time, video.duration))
      : Math.max(0, time);
  };

  return {
    async play() {
      if (!isReady()) {
        return;
      }
      try {
        await video.play();
        emit("play");
      } catch (err) {
        // Interruptions by new loads and autoplay-policy rejections are
        // ordinary; anything else is a real error worth surfacing.
        if (err.name !== "AbortError" && err.name !== "NotAllowedError") {
          throw err;
        }
      }
    },

    pause() {
      if (!isReady()) {
        return;
      }
      video.pause();
      emit("pause");
    },

    togglePlay() {
      if (!isReady()) {
        return;
      }
      if (video.paused) {
        return this.play();
      }
      this.pause();
    },

    stop() {
      if (!isReady()) {
        return;
      }
      video.pause();
      video.currentTime = 0;
      emit("stop");
    },

    seekTo(time) {
      if (!isReady()) {
        return;
      }
      video.currentTime = clampTarget(time);
      emit("seek", { to: video.currentTime });
    },

    /** Silent primitive for scrub drags: clamp without command chatter. */
    scrubTo(time) {
      if (!isReady()) {
        return;
      }
      video.currentTime = clampTarget(time);
    },

    skip(delta) {
      if (!isReady()) {
        return;
      }
      this.seekTo(video.currentTime + delta);
      emit("skip", { delta });
    },

    nudgeVolume(direction) {
      if (!isReady()) {
        return;
      }
      const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
      video.volume = Math.max(0, Math.min(1, video.volume + step));
      emit("volume", { volume: video.volume });
    },

    setVolume(value) {
      if (!isReady()) {
        return;
      }
      video.volume = Math.max(0, Math.min(1, value));
      emit("volume", { volume: video.volume });
    },

    toggleMute() {
      if (!isReady()) {
        return;
      }
      video.muted = !video.muted;
      emit("mute", { muted: video.muted });
    },

    /** Hold-to-fast-forward pair; `speed` is restored verbatim on release. */
    beginBoost(speed) {
      if (!isReady()) {
        return;
      }
      video.playbackRate = speed;
      emit("boost-start", { speed });
    },

    endBoost(speed) {
      if (!isReady()) {
        return;
      }
      video.playbackRate = speed;
      emit("boost-end", { speed });
    }
  };
}

/* - MediaSession facet - */

const SESSION_ACTIONS = ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"];
/** Cleared defensively on teardown: managers remember stale handlers. */
const CLEAR_ACTIONS = [...SESSION_ACTIONS, "previoustrack", "nexttrack"];

/** The bridge whose media currently owns navigator.mediaSession. */
let sessionOwner = null;

/**
 * Rich metadata for OS media surfaces: page title, host as artist, poster as
 * artwork. Returns null when there is nothing to show or the poster URL is
 * malformed.
 */
function buildSessionMetadata(video) {
  let artwork;
  try {
    artwork = video.poster ? [{ src: new URL(video.poster, location.href).href }] : [];
  } catch {
    artwork = [];
  }
  const title = document.title?.trim();
  if (!title && !artwork.length) {
    return null;
  }
  return new MediaMetadata({
    title: title || undefined,
    artist: location.hostname || undefined,
    artwork
  });
}

/**
 * Claim this window's MediaSession for one shell: action handlers ride the
 * command plane, position state follows playback events via sync(), and rich
 * metadata lands in OS controls. A newer claim displaces the previous owner;
 * teardown runs once when `signal` aborts. No-op (returns null) without a
 * MediaSession implementation.
 */
export function claimMediaSession({ controls, video, signal, session = navigator.mediaSession }) {
  if (!session) {
    return null;
  }
  sessionOwner?.dispose();
  const bridge = new MediaSessionBridge(session, controls, video);
  sessionOwner = bridge;
  bridge.attach(signal);
  return bridge;
}

class MediaSessionBridge {
  #session;
  #controls;
  #video;
  #disposed = false;

  constructor(session, controls, video) {
    this.#session = session;
    this.#controls = controls;
    this.#video = video;
  }

  /** Wire handlers, metadata refresh, and signal teardown. Called once by claim. */
  attach(signal) {
    const session = this.#session;
    const controls = this.#controls;
    session.setActionHandler("play", () => controls.play());
    session.setActionHandler("pause", () => controls.pause());
    session.setActionHandler("stop", () => controls.stop());
    session.setActionHandler("seekbackward", (details) => controls.skip(-(details?.seekOffset || 10)));
    session.setActionHandler("seekforward", (details) => controls.skip(details?.seekOffset || 10));
    session.setActionHandler("seekto", (details) => {
      if (details?.seekTime != null) {
        if (details.fastSeek) {
          video.fastSeek(details.seekTime);
        } else {
          controls.seekTo(details.seekTime);
        }
      }
    });
    session.playbackState = this.#video.paused ? "paused" : "playing";
    this.sync();
    // Posters often arrive with metadata; refresh once it exists.
    this.#video.addEventListener("loadedmetadata", () => this.#refreshMetadata(), { signal });
    this.#refreshMetadata();
    signal.addEventListener("abort", () => this.dispose(), { once: true });
    logger.log("media", "MediaSession claimed - handlers registered");
  }

  /** playbackState plus guarded position state; safe to call per event batch. */
  sync() {
    if (this.#disposed) {
      return;
    }
    const session = this.#session;
    session.playbackState = this.#video.paused ? "paused" : "playing";
    if (Number.isFinite(this.#video.duration) && this.#video.duration > 0) {
      try {
        session.setPositionState({
          duration: this.#video.duration,
          playbackRate: this.#video.playbackRate,
          position: Math.min(this.#video.currentTime, this.#video.duration)
        });
      } catch {}
    }
  }

  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    if (sessionOwner === this) {
      sessionOwner = null;
    }
    for (const action of CLEAR_ACTIONS) {
      try {
        this.#session.setActionHandler(action, null);
      } catch {}
    }
    this.#session.playbackState = "none";
    this.#session.metadata = null;
    logger.log("media", "MediaSession released");
  }

  #refreshMetadata() {
    if (this.#disposed) {
      return;
    }
    try {
      this.#session.metadata = buildSessionMetadata(this.#video);
    } catch {}
  }
}
