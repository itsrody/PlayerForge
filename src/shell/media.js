/** Volume delta applied by nudgeVolume, shared with UI feedback layers. */
export const VOLUME_STEP = 0.05;

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
    bus.emit("pf:media-command", { shellId, type, ...detail });
  };

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
      video.pause();
      emit("pause");
    },

    togglePlay() {
      if (video.paused) {
        return this.play();
      }
      this.pause();
    },

    stop() {
      video.pause();
      video.currentTime = 0;
      emit("stop");
    },

    seekTo(time) {
      video.currentTime = clampTarget(time);
      emit("seek", { to: video.currentTime });
    },

    /** Silent primitive for scrub drags: clamp without command chatter. */
    scrubTo(time) {
      video.currentTime = clampTarget(time);
    },

    skip(delta) {
      this.seekTo(video.currentTime + delta);
      emit("skip", { delta });
    },

    nudgeVolume(direction) {
      const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
      video.volume = Math.max(0, Math.min(1, video.volume + step));
      emit("volume", { volume: video.volume });
    },

    setVolume(value) {
      video.volume = Math.max(0, Math.min(1, value));
      emit("volume", { volume: video.volume });
    },

    toggleMute() {
      video.muted = !video.muted;
      emit("mute", { muted: video.muted });
    },

    /** Hold-to-fast-forward pair; `speed` is restored verbatim on release. */
    beginBoost(speed) {
      video.playbackRate = speed;
      emit("boost-start", { speed });
    },

    endBoost(speed) {
      video.playbackRate = speed;
      emit("boost-end", { speed });
    }
  };
}
