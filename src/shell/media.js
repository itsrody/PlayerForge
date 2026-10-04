import { logger } from "../shared/diagnostics.js";
import { clamp, isBenignMediaPolicyError } from "../shared/primitives.js";
import { Scope } from "../shared/scope.js";

/** Volume delta applied by nudgeVolume. */
const VOLUME_STEP = 0.1;

/**
 * Media command plane. Every way of controlling playback - gestures, hotkeys,
 * panel widgets, OS media keys through MediaSession - funnels through these
 * primitives so clamping, guarding, and presentation stay in exactly one
 * place. Commands execute immediately against the video; presentation (toasts)
 * lives at the interaction sites that own their context.
 *
 * `scrubTo` is deliberately silent: it serves continuous drag streams, not
 * discrete commands, and the resulting position is already broadcast through
 * the regular timeupdate path.
 */
export function createMediaControls({ video }) {
  /**
   * Gate: every control stays inert until metadata is loaded (readyState
   * HAVE_METADATA, the point where duration is known). Before that the video
   * has no established timeline, so seeking/skipping is meaningless and a
   * play request could fight an in-flight load. Commands then no-op, so the
   * whole control surface - gestures, hotkeys, MediaSession OS keys - simply
   * does nothing until playback is ready.
   */
  const isReady = () => video.readyState >= 1;

  /**
   * A seekable timeline exists when metadata loaded (readyState >= HAVE_METADATA)
   * OR a finite positive duration is already established. MSE/streaming players
   * set duration (firing `durationchange`) while readyState is still
   * HAVE_NOTHING; seeking in that window is legal - per spec, setting
   * currentTime before metadata with a known duration parks the default
   * playback start position, which the browser honors when playback begins. So
   * a restore (resume) issued in the MSE window is never lost.
   */
  const canSeek = () => isReady() || (Number.isFinite(video.duration) && video.duration > 0);

  /** Canonical absolute-position clamp: inside duration when we know it. */
  const clampTarget = (time) => {
    if (!Number.isFinite(time)) {
      return 0;
    }
    return Number.isFinite(video.duration) && video.duration > 0
      ? clamp(time, 0, video.duration)
      : Math.max(0, time);
  };

  return {
    async play() {
      if (!isReady()) {
        return;
      }
      try {
        await video.play();
      } catch (err) {
        // Interruptions by new loads and autoplay-policy rejections are
        // ordinary; anything else is a real error worth surfacing.
        if (!isBenignMediaPolicyError(err)) {
          throw err;
        }
      }
    },

    pause() {
      if (!isReady()) {
        return;
      }
      video.pause();
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
    },

    /** Seek to an absolute position, clamped to the playable range. */
    seekTo(time) {
      if (!canSeek()) {
        return;
      }
      video.currentTime = clampTarget(time);
    },

    /** Silent seek alias for scrub drags - same clamp, no command chatter. */
    scrubTo(time) {
      this.seekTo(time);
    },

    /**
     * Latched scrub seek for an in-progress drag session. Readiness was
     * already verified and `duration` captured when the stroke latched, so
     * this skips the per-move isReady() gate and re-reading video.duration
     * (native getter) - the single most frequent user-facing path.
     */
    scrubToLatched(time, duration) {
      video.currentTime = Number.isFinite(duration) && duration > 0
        ? clamp(time, 0, duration)
        : Math.max(0, time);
    },

    skip(delta) {
      if (!isReady()) {
        return;
      }
      this.seekTo(video.currentTime + delta);
    },

    nudgeVolume(direction) {
      if (!isReady()) {
        return;
      }
      const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
      video.volume = clamp(video.volume + step, 0, 1);
    },

    setVolume(value) {
      if (!isReady()) {
        return;
      }
      video.volume = clamp(value, 0, 1);
    },

    toggleMute() {
      if (!isReady()) {
        return;
      }
      video.muted = !video.muted;
    },

    /** Hold-to-fast-forward pair; `speed` is restored verbatim on release. */
    beginBoost(speed) {
      if (!isReady()) {
        return;
      }
      video.playbackRate = speed;
    },

    /**
     * The one control that is NOT gated on isReady(), and the asymmetry is
     * deliberate: this is a RESTORE, not a command.
     *
     * Every other primitive no-ops before metadata because it needs a timeline
     * to act on. Writing playbackRate needs none - Gecko 157 accepts the write
     * at readyState 0 (measured: setting 1.0 on an emptied element sticks).
     * Gating it means a readiness drop DURING a hold strands the video at hold
     * speed permanently: an SDK that reassigns src or calls load() while the
     * user holds fires `emptied` (readyState 0), the release finds the gate
     * shut, and nothing ever puts the rate back - the user is left watching
     * everything at 2x with no control that explains it. That is the same
     * stranded-boost bug the keyboard hold path already had to be patched for
     * (see forge.js #resetKeyboardHold); this is the readiness-drop variant.
     */
    endBoost(speed) {
      video.playbackRate = speed;
    }
  };
}

/* - MediaSession facet - */

/** Media events that push position state to the OS surface. `timeupdate` is
 *  the media clock (fires ~4 Hz while the playhead advances), so OS/mediaSession
 *  progress stays live without a frame callback or a poll; the boundary events
 *  cover starts, stops, seeks, and metadata/duration changes. */
export const MEDIA_SESSION_SYNC_EVENTS = new Set([
  "play", "pause", "playing", "ended", "seeked", "durationchange", "ratechange",
  "volumechange", "loadedmetadata", "timeupdate"
]);

const SESSION_ACTIONS = ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"];
/** Cleared defensively on teardown: managers remember stale handlers. */
const CLEAR_ACTIONS = [...SESSION_ACTIONS, "previoustrack", "nexttrack"];

/** The bridge whose media currently owns navigator.mediaSession. */
let sessionOwner = null;
/**
 * Every bridge whose shell is still alive, in claim order.
 *
 * navigator.mediaSession is a single per-window global, so only one shell can
 * drive it at a time - but a displaced bridge is NOT dead. Its shell lives on,
 * its media keeps playing, and it can take the session back if the owner goes
 * away. This set is what makes that possible; `sessionOwner` alone would strand
 * every earlier shell with no way to reclaim.
 */
const liveBridges = new Set();

/**
 * Rich metadata for OS media surfaces: page title, host as artist, poster as
 * artwork. Returns null when there is nothing to show or the poster URL is
 * malformed.
 */
function buildSessionMetadata(video) {
  const artwork = video.poster && URL.canParse(video.poster, location.href)
    ? [{ src: new URL(video.poster, location.href).href }]
    : [];
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
  return MediaSessionBridge.claim({ session, controls, video, signal });
}

class MediaSessionBridge {
  /**
   * Install a new owner. Displaces rather than destroys the previous one: that
   * shell lives on and can reclaim the session if this owner goes away, and
   * clearing the global session on displacement would strip playbackState and
   * metadata for a frame before the successor rewrites them.
   */
  static claim({ session, controls, video, signal }) {
    sessionOwner?.#yieldHandlers();
    const bridge = new MediaSessionBridge(session, controls, video);
    sessionOwner = bridge;
    liveBridges.add(bridge);
    bridge.attach(signal);
    return bridge;
  }

  #session;
  #controls;
  #video;
  /** Disposal flag: guards sync/metadata refresh after release. */
  #scope = new Scope();
  /**
   * Pre-detected once at construction: setPositionState is absent on some
   * host surfaces, and sync() rides the ~4 Hz media clock - a hoisted boolean
   * keeps the hot path free of per-tick try/catch.
   */
  #canSetPositionState = false;

  constructor(session, controls, video) {
    this.#session = session;
    this.#controls = controls;
    this.#video = video;
    this.#canSetPositionState = typeof session?.setPositionState === "function";
  }

  /**
   * Register this shell's OS action handlers. Split out of attach() because a
   * displaced bridge re-runs it when it is promoted back to owner - the
   * handlers are what get handed over, not the bridge's lifecycle.
   */
  #registerHandlers() {
    const session = this.#session;
    const controls = this.#controls;
    const video = this.#video;
    session.setActionHandler("play", () => controls.play());
    session.setActionHandler("pause", () => controls.pause());
    session.setActionHandler("stop", () => controls.stop());
    session.setActionHandler("seekbackward", (details) => controls.skip(-(details?.seekOffset || 10)));
    session.setActionHandler("seekforward", (details) => controls.skip(details?.seekOffset || 10));
    session.setActionHandler("seekto", (details) => {
      if (details?.seekTime != null) {
        // fastSeek is a Gecko extension, not Baseline: it ships on the whole
        // 157 floor but is absent on the jsdom host (and would be on any host
        // that drops it). Calling it unguarded threw a TypeError straight into
        // the page's error channel from inside a UA action handler - and
        // Gecko DOES send seekto with fastSeek set from its own media keys.
        // Fall back to the clamped command-plane seek, which is the same
        // intent without the extension.
        if (details.fastSeek && typeof video.fastSeek === "function") {
          video.fastSeek(details.seekTime);
        } else {
          controls.seekTo(details.seekTime);
        }
      }
    });
  }

  /** Wire handlers, metadata refresh, and signal teardown. Called once by claim. */
  attach(signal) {
    this.#registerHandlers();
    // Initial state (playbackState + position) lands through sync(), which
    // also seeds the dedup cache - writing playbackState here would only
    // duplicate that first IPC.
    this.sync();
    // Posters often arrive with metadata; refresh once it exists.
    this.#video.addEventListener("loadedmetadata", () => this.#refreshMetadata(), { signal });
    this.#refreshMetadata();
    signal.addEventListener("abort", () => this.destroy(), { once: true });
    logger.log("media", "MediaSession claimed - handlers registered");
  }

  /**
   * Hand the session to a newer claim without ending this bridge: drop the OS
   * action handlers and stop self-promoting, but keep the scope, the media
   * listeners, and this shell's eligibility to take the session back.
   */
  #yieldHandlers() {
    if (this.#scope.disposed || sessionOwner !== this) {
      return;
    }
    for (const action of CLEAR_ACTIONS) {
      try {
        this.#session.setActionHandler(action, null);
      } catch {}
    }
  }

  /**
   * Reclaim the session after the previous owner went away. Forces a full
   * state push rather than trusting the dedup cache: the last thing this
   * bridge sent was before it was displaced, so every cached field is stale
   * against the live surface.
   */
  #takeOver() {
    if (this.#scope.disposed) {
      return;
    }
    sessionOwner = this;
    this.#registerHandlers();
    this.#sentPlaybackState = null;
    this.#sentDuration = NaN;
    this.#sentPlaybackRate = NaN;
    this.#refreshMetadata();
    this.sync();
    logger.log("media", "MediaSession handed to a surviving shell");
  }

  /** Reused scratch for setPositionState - the API copies the values, so a
   *  mutable object reused across sync() calls avoids a per-event allocation
   *  on the ~4 Hz media clock (same rationale as the forge's pooled event). */
  #positionState = { duration: 0, playbackRate: 0, position: 0 };
  /**
   * Last state actually handed to the session. sync() rides nine media
   * events (`timeupdate`, `volumechange`, `seeked`, ...), which routinely
   * arrive several per playback transition with IDENTICAL values - each
   * redundant write is a browser-process IPC for nothing. The position is
   * quantized before comparison so sub-frame currentTime jitter (which never
   * changes what the OS surface shows) cannot defeat the dedup.
   */
  #sentPlaybackState = null;
  #sentDuration = NaN;
  #sentPlaybackRate = NaN;
  /** Position dedup quantum in seconds - finer than any OS progress UI shows. */
  static #POSITION_EPSILON = 0.25;

  /** playbackState plus guarded position state; safe to call per event batch. */
  sync() {
    // Ownership gate, not just a disposal check: a displaced bridge keeps its
    // media listeners (its shell lives on), and navigator.mediaSession is one
    // global - two bridges writing it would have each player's state overwrite
    // the other's on every tick.
    if (this.#scope.disposed || sessionOwner !== this) {
      return;
    }
    const session = this.#session;
    const playbackState = this.#video.paused ? "paused" : "playing";
    if (playbackState !== this.#sentPlaybackState) {
      this.#sentPlaybackState = playbackState;
      session.playbackState = playbackState;
    }
    if (!this.#canSetPositionState) {
      return;
    }
    const { duration, playbackRate, currentTime } = this.#video;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }
    const position = currentTime < duration ? currentTime : duration;
    const quantum = MediaSessionBridge.#POSITION_EPSILON;
    const sentPosition = this.#positionState.position;
    if (
      duration === this.#sentDuration &&
      playbackRate === this.#sentPlaybackRate &&
      Math.abs(position - sentPosition) < quantum
    ) {
      return;
    }
    this.#sentDuration = duration;
    this.#sentPlaybackRate = playbackRate;
    const state = this.#positionState;
    state.duration = duration;
    state.playbackRate = playbackRate;
    state.position = position;
    session.setPositionState(state);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    liveBridges.delete(this);
    if (sessionOwner !== this) {
      // Already displaced. The global session belongs to the current owner and
      // this bridge has no handlers on it, so clearing playbackState/metadata
      // here would strip MediaSession from a shell that is still playing - and
      // from the page's point of view, silently.
      return;
    }
    sessionOwner = null;
    // Hand the session to the most recently claimed surviving shell. Only when
    // this was the last live bridge is the global genuinely finished with.
    let successor = null;
    for (const bridge of liveBridges) {
      if (!bridge.#scope.disposed) {
        successor = bridge;
      }
    }
    if (successor) {
      successor.#takeOver();
      return;
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
    if (this.#scope.disposed || sessionOwner !== this) {
      return;
    }
    try {
      this.#session.metadata = buildSessionMetadata(this.#video);
    } catch {}
  }
}
