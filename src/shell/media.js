import { logger, Scope } from "../shared/runtime.js";
import { clamp, isBenignMediaPolicyError } from "../shared/core.js";

/** Volume delta applied by nudgeVolume. */
const VOLUME_STEP = 0.1;

/**
 * Media command plane. Every way of controlling playback - gestures, hotkeys,
 * panel widgets, OS media keys through MediaSession - funnels through these
 * primitives so clamping, guarding, and presentation stay in exactly one
 * place. Commands execute immediately against the #video; presentation (toasts)
 * lives at the interaction sites that own their context.
 *
 * The scrub paths are deliberately silent: they serve continuous drag
 * streams, not discrete commands, and the resulting position is already
 * broadcast through the regular timeupdate path.
 */
class MediaControls {
  #video;

  constructor(video) {
    this.#video = video;
  }

  /**
   * Gate: every control stays inert until metadata is loaded (readyState
   * HAVE_METADATA, the point where duration is known). Before that the video
   * has no established timeline, so seeking/skipping is meaningless and a
   * play request could fight an in-flight load. Commands then no-op, so the
   * whole control surface - gestures, hotkeys, MediaSession OS keys - simply
   * does nothing until playback is ready.
   */
  #isReady() {
    return this.#video.readyState >= 1;
  }

  /**
   * A seekable timeline exists when metadata loaded (readyState >= HAVE_METADATA)
   * OR a finite positive duration is already established. MSE/streaming players
   * set duration (firing `durationchange`) while readyState is still
   * HAVE_NOTHING; seeking in that window is legal - per spec, setting
   * currentTime before metadata with a known duration parks the default
   * playback start position, which the browser honors when playback begins. So
   * a restore (resume) issued in the MSE window is never lost.
   */
  #canSeekNow() {
    return this.#isReady() || (Number.isFinite(this.#video.duration) && this.#video.duration > 0);
  }

  /** Canonical absolute-position clamp: inside duration when we know it. */
  #clampTarget(time) {
    if (!Number.isFinite(time)) {
      return 0;
    }
    return Number.isFinite(this.#video.duration) && this.#video.duration > 0
      ? clamp(time, 0, this.#video.duration)
      : Math.max(0, time);
  }

  /** True once the media has an established timeline (HAVE_METADATA+).
   *  Interaction layers consult this before emitting command feedback, so a
   *  gesture the command plane would no-op never shows a misleading toast. */
  get ready() {
    return this.#isReady();
  }

  /** True when a seek is legal (metadata, or an MSE-known duration). */
  get canSeek() {
    return this.#canSeekNow();
  }

  async play() {
    if (!this.#isReady()) {
      return;
    }
    try {
      await this.#video.play();
    } catch (err) {
      // Interruptions by new loads and autoplay-policy rejections are
      // ordinary; anything else is a real error worth surfacing.
      if (!isBenignMediaPolicyError(err)) {
        throw err;
      }
    }
  }

  pause() {
    if (!this.#isReady()) {
      return;
    }
    this.#video.pause();
  }

  togglePlay() {
    if (!this.#isReady()) {
      return;
    }
    if (this.#video.paused) {
      return this.play();
    }
    this.pause();
  }

  stop() {
    if (!this.#canSeekNow()) {
      return;
    }
    this.#video.pause();
    this.#video.currentTime = 0;
  }

  /** Seek to an absolute position, clamped to the playable range. */
  seekTo(time) {
    if (!this.#canSeekNow()) {
      return;
    }
    this.#video.currentTime = this.#clampTarget(time);
  }

  /**
   * Latched scrub seek for an in-progress drag session, silent (no command
   * chatter). Readiness was already verified and `duration` captured when
   * the stroke latched - and the capture is finite-positive by construction
   * (the latch bails before arming otherwise), so the clamp range is always
   * real. This is the commit loop's write - one call per compositor tick,
   * not per pointer move - so it skips media's readiness gate and any
   * duration re-read.
   */
  scrubToLatched(time, duration) {
    this.#video.currentTime = clamp(time, 0, duration);
  }

  skip(delta) {
    // Skip is a seek: gate on the same #canSeekNow() as seekTo so a known
    // duration is a usable timeline even in the MSE window (readyState 0),
    // matching the seekto MediaSession action instead of dropping it.
    if (!this.#canSeekNow()) {
      return;
    }
    this.seekTo(this.#video.currentTime + delta);
  }

  nudgeVolume(direction) {
    if (!this.#isReady()) {
      return;
    }
    const step = direction === "up" ? VOLUME_STEP : -VOLUME_STEP;
    this.#video.volume = clamp(this.#video.volume + step, 0, 1);
  }

  toggleMute() {
    if (!this.#isReady()) {
      return;
    }
    this.#video.muted = !this.#video.muted;
  }

  /** Native PiP availability: the browser's own always-on-top surface.
   *  pictureInPictureEnabled is runtime policy (an enterprise/embed can set
   *  it false), so the flag check stays; the method/typeof arms it once
   *  guarded were floor-dead (70) - a per-element disablePictureInPicture
   *  opt still rejects through the toggle's benign-policy catch. */
  pictureInPictureSupported() {
    return document.pictureInPictureEnabled;
  }

  /**
   * Toggle the native picture-in-picture window. Entering needs a user
   * gesture (hotkeys/panel qualify); the PiP window owns its own controls.
   * Returns whether PiP is active afterwards. Rejects that are ordinary
   * browser policy (AbortError/NotAllowedError) surface as `false`; real
   * failures throw for the caller to present.
   */
  async togglePictureInPicture() {
    if (!this.#isReady() || !this.pictureInPictureSupported()) {
      return false;
    }
    try {
      if (document.pictureInPictureElement === this.#video) {
        await document.exitPictureInPicture();
      } else {
        await this.#video.requestPictureInPicture();
      }
    } catch (err) {
      if (!isBenignMediaPolicyError(err)) {
        throw err;
      }
    }
    return document.pictureInPictureElement === this.#video;
  }

  /** Hold-to-fast-forward pair; `speed` is restored verbatim on release. */
  beginBoost(speed) {
    if (!this.#isReady()) {
      return;
    }
    this.#video.playbackRate = speed;
  }

  endBoost(speed) {
    // Never gated: releasing a hold must always restore the saved rate. If a
    // source swap drops readiness mid-hold, an #isReady() gate here would
    // leave the element stuck at the boosted playbackRate forever.
    this.#video.playbackRate = speed;
  }
}

export function createMediaControls({ video }) {
  return new MediaControls(video);
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
/** Cleared defensively on teardown - but ONLY actions this bridge registered.
 *  prev/next track were never ours: nulling them wiped the host page's own
 *  OS media controls on every shell teardown. */
const CLEAR_ACTIONS = SESSION_ACTIONS;

/**
 * The claim registry as one class: it owns the "whose MediaSession is it"
 * state, so a newest-claim-wins displacement and the disown-on-destroy dance
 * live in exactly one place. The module singleton wires the exported call
 * surface below.
 */
class MediaSessionOwner {
  /** The bridge whose media currently owns navigator.mediaSession. */
  #current = null;

  /**
   * Claim this window's MediaSession for one shell: action handlers ride the
   * command plane, position state follows playback events via sync(), and rich
   * metadata lands in OS controls. A newer claim displaces the previous owner;
   * teardown runs once when `signal` aborts. No-op (returns null) without a
   * MediaSession implementation.
   */
  claim({ controls, video, signal, session = navigator.mediaSession }) {
    if (!session) {
      return null;
    }
    this.#current?.destroy();
    const bridge = new MediaSessionBridge(this, session, controls, video);
    this.#current = bridge;
    bridge.attach(signal);
    return bridge;
  }

  /** Drop a released bridge from the registry; no-op if displaced first.
   *  Module-internal handoff (the bridge has its own private field, so the
   *  private-name rules bar a cross-class # method call). */
  disown(bridge) {
    if (this.#current === bridge) {
      this.#current = null;
    }
  }
}

const sessionOwner = new MediaSessionOwner();

/**
 * Rich metadata for OS media surfaces: page title, host as artist, poster as
 * artwork. Returns null when there is nothing to show or the poster URL is
 * malformed.
 */
function metadataOf(video) {
  // One-pass URL.parse returns null on malformed posters - the same guard
  // posture URL.canParse bought, without parsing the string twice.
  const artworkSrc = video.poster ? URL.parse(video.poster, location.href) : null;
  const artwork = artworkSrc
    // sizes="any": OS artwork pickers (Android lock screen, desktop thumbnail
    // surfaces) select by declared dimensions; an entry without sizes is the
    // weakest form and can be skipped outright.
    ? [{ src: artworkSrc.href, sizes: "any" }]
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
 * Fingerprint of the metadata inputs (title + poster). Empty when the DOM
 * realm is absent (test harness without a global document), which keeps the
 * staleness check and the stored key equal so refresh never loops there.
 */
function metadataKeyOf(video) {
  try {
    return `${document.title} ${video.poster}`;
  } catch {
    return "";
  }
}

export function claimMediaSession(options) {
  return sessionOwner.claim(options);
}

class MediaSessionBridge {
  #owner;
  #session;
  #controls;
  #video;
  /** Disposal flag: guards sync/metadata refresh after release. */
  #scope = new Scope();

  constructor(owner, session, controls, video) {
    this.#owner = owner;
    this.#session = session;
    this.#controls = controls;
    this.#video = video;
  }

  /** Wire handlers, metadata refresh, and signal teardown. Called once by claim. */
  attach(signal) {
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
        if (details.fastSeek) {
          video.fastSeek(details.seekTime);
        } else {
          controls.seekTo(details.seekTime);
        }
      }
    });
    // Metadata first so sync()'s staleness check (title/poster fingerprint)
    // finds a fresh key instead of re-refreshing on this very first call.
    this.#refreshMetadata();
    // Initial state (playbackState + position) lands through sync(), which
    // also seeds the dedup cache - writing playbackState here would only
    // duplicate that first IPC.
    this.sync();
    // Posters often arrive with metadata; refresh once it exists.
    this.#video.addEventListener("loadedmetadata", () => this.#refreshMetadata(), { signal });
    signal.addEventListener("abort", () => this.destroy(), { once: true });
    logger.log("media", "MediaSession claimed - handlers registered");
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
  /** Fingerprint of the metadata inputs (title + poster) at last refresh.
   *  Now-playing surfaces mutate document.title and video.poster without
   *  any metadata-load event; sync() rides the media clock, so a cheap string
   *  compare there re-arms OS surfaces the moment either changes. */
  #metadataKey = "";
  /** Position dedup quantum in seconds. timeupdate ticks at ~250 ms, so a
   *  finer quantum passed every tick (0.25 is not < 0.25) and pushed the
   *  write straight through: 4 browser IPCs/s during steady playback. 1 s
   *  dedups the whole tick stream to ~1 IPC/s - no OS progress UI renders
   *  finer - while duration/rate flips and pause still write immediately
   *  (their own guards bypass the quantum), and a seek catches up within a
   *  second of continuous playback. */
  static #POSITION_EPSILON = 1;

  /** playbackState plus guarded position state; safe to call per event batch. */
  sync() {
    if (this.#scope.disposed) {
      return;
    }
    // Now-playing surfaces mutate document.title and video.poster without
    // any metadata-load event; the ~4 Hz media clock already runs through
    // sync(), so a cheap string compare re-arms OS surfaces on either change.
    if (this.#metadataKey !== metadataKeyOf(this.#video)) {
      this.#refreshMetadata();
    }
    const session = this.#session;
    const playbackState = this.#video.paused ? "paused" : "playing";
    if (playbackState !== this.#sentPlaybackState) {
      this.#sentPlaybackState = playbackState;
      session.playbackState = playbackState;
    }
    const { duration, playbackRate, currentTime } = this.#video;
    // setPositionState (73) is floor-guaranteed on navigator.mediaSession,
    // which is the only session any claim hands over; the capability field
    // that once gated this write died with its "some host surfaces" premise.
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
    this.#owner.disown(this);
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
    if (this.#scope.disposed) {
      return;
    }
    try {
      this.#session.metadata = metadataOf(this.#video);
    } catch {}
    this.#metadataKey = metadataKeyOf(this.#video);
  }
}
