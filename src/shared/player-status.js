import { logger } from "./diagnostics.js";
import { fs, subscribeFullscreen } from "./shadow.js";

/**
 * L2 - PlayerStatus: what this player *is*, stated as one queryable value
 * instead of being re-derived at every call site.
 *
 * Today each `createActivity` site authors its own `isActive()` closure
 * (`src/shell/shell.js`, `src/shell/resume.js`, `src/shared/shadow.js`), so
 * nothing answers "what is this player's status right now". Those closures are
 * deliberately left in place as the compatibility shim while this sits beside
 * them; nothing here drives behaviour yet.
 *
 * Orthogonal axes rather than one large enum, so adding an axis never
 * multiplies states - 6 x 3 x 5 x 2 combinations are reachable by stating each
 * axis once.
 *
 * STATUS IS OBSERVED, NEVER OPTIMISTIC
 * ------------------------------------
 * There is no public setter for any of this, which is the point rather than an
 * omission: a keypress may ask the engine to play, but it must not be able to
 * say `Playback.PLAYING` on the engine's behalf. Only the media element's own
 * events write status, because `video.play()` returns a promise that rejects
 * when autoplay policy blocks it - an optimistic status would render a playing
 * icon for a video that never started. The same holds for a seek the element
 * clamps, and for fullscreen the user dismisses.
 *
 * Construction reads the element's properties exactly once to seed a state
 * that predates this observer. After that the value only moves on an event, and
 * every transition carries the name of the event that caused it (`cause`), so
 * an audit of "did anything decide this for itself?" is a lookup, not a review.
 *
 * ONE TRANSITION, ONE SCHEDULED COMMIT
 * ------------------------------------
 * Transitions are applied synchronously - a read right after an event sees the
 * new value - but delivery is deferred to a single microtask, so N transitions
 * produced in one tick are delivered as one batch. A `volumechange` that moves
 * both `volume` and `muted` is two transitions and one commit; without the
 * batch that is two renders of the same frame.
 */

/**
 * The four orthogonal status axes.
 *
 * `Presence` is what the design notes call `Scope`. The name changed because
 * `Scope` is already this codebase's disposal primitive (`src/shared/scope.js`,
 * the thing an activity mints on entry), and every file that needs both would
 * otherwise import two different meanings of one word.
 */
export const Playback = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  PLAYING: "playing",
  PAUSED: "paused",
  ENDED: "ended"
});

export const Buffer = Object.freeze({
  NONE: "none",
  WAITING: "waiting",
  SEEKING: "seeking"
});

/**
 * `BACKGROUND` and `VISIBLE` are driven by `visibilitychange`; `OCCLUDED` by
 * the IntersectionObserver in `#wire()`, which is the only way to learn "the
 * player scrolled out of the viewport" without polling a rect. `DETACHED` and
 * `PIP` are named but still not driven: detach has no event to observe
 * (`isConnected` would need a MutationObserver to notice a change, and
 * inject.js's watchdog owns re-attachment), and this fork ships no
 * picture-in-picture surface at all. Both stay in the enum so the axis is
 * complete rather than growing a value per phase.
 */
export const Presence = Object.freeze({
  DETACHED: "detached",
  VISIBLE: "visible",
  OCCLUDED: "occluded",
  BACKGROUND: "background",
  PIP: "pip"
});

export const Screen = Object.freeze({
  NONE: "none",
  FULLSCREEN: "fullscreen"
});

/**
 * CustomEvent name for the realm-crossing subscriber channel.
 *
 * `subscribe()` reaches anyone importing this module; this reaches anyone
 * holding the element, which includes a page in another realm. Bubbles false:
 * a status change is about the video, so it is delivered to listeners on the
 * video rather than to every ancestor on the page.
 */
export const STATUS_EVENT = "pf:status";

/** Seed the playback axis from properties: the state predates this observer. */
function seedPlayback(video) {
  if (video.ended) {
    return Playback.ENDED;
  }
  if (!video.paused) {
    return Playback.PLAYING;
  }
  if (video.readyState >= 1) {
    return Playback.READY;
  }
  return video.currentSrc ? Playback.LOADING : Playback.IDLE;
}

function countTextTracks(video) {
  const list = video?.textTracks;
  return list ? list.length : 0;
}

function errorDetail(error) {
  if (!error) {
    return null;
  }
  return { code: error.code ?? null, message: error.message ?? "" };
}

/**
 * A change to report. `kind` separates an axis flip from a scalar move;
 * `cause` is the event that produced it.
 *
 * @typedef {{seq:number, kind:"axis"|"scalar", name:string, from:*, to:*, cause:string}} StatusChange
 */

/**
 * One player's status, observed from its `<video>`.
 *
 * Not a store: there is no `set()` to call, no optimistic write path, and no
 * way to express intent through it. Requests (play, seek, mute) stay outside
 * this module with the code that issues them; what lands here is only what the
 * element actually did.
 */
export class PlayerStatus {
  #target;
  #doc;
  #signal;
  #listeners = new Set();
  /** Transitions waiting for the single scheduled commit. */
  #pending = [];
  #flushScheduled = false;
  #disposed = false;
  #seq = 0;
  /** Teardown thunks: signal-backed where one exists, explicit where not. */
  #teardown = [];

  /** Values live in plain objects: `#set` addresses them by axis/key name, and
   *  a private field cannot be named dynamically the way a getter can. */
  #axis;
  #scalar;
  /**
   * Last report from the IntersectionObserver. Starts true because the seed
   * cannot know better: a rect is not readable without a layout, and reading
   * one during construction would be a forced synchronous layout on the boot
   * path. The observer's first callback - posted as a task, after this
   * constructor has returned - corrects it if the player really was off-screen.
   */
  #intersecting = true;

  /**
   * @param {{target: HTMLMediaElement, doc?: Document, signal?: AbortSignal}} options
   */
  constructor({ target, doc = document, signal } = {}) {
    this.#target = target;
    this.#doc = doc;
    this.#signal = signal;

    this.#axis = {
      playback: seedPlayback(target),
      // Buffer has no readable "what is happening" property beyond `seeking`,
      // so seed from the one that exists and let the edges correct the rest.
      buffer: target.seeking ? Buffer.SEEKING : Buffer.NONE,
      presence: this.#presence(),
      // `fs` is shadow.js's fullscreen SOL: read the value the gate already
      // observed instead of adding a second fullscreenchange listener, which is
      // the bug that module exists to prevent.
      screen: fs ? Screen.FULLSCREEN : Screen.NONE
    };
    this.#scalar = {
      duration: Number.isFinite(target.duration) ? target.duration : NaN,
      currentTime: Number.isFinite(target.currentTime) ? target.currentTime : 0,
      // `playbackRate`, not `rate` - HTMLMediaElement has no `rate` property,
      // so the old read was always undefined, the fallback pinned this axis to
      // 1, and the ratechange handler (same wrong read) never moved it: the
      // whole rate axis was invisible on pf:status for the element's life.
      rate: Number.isFinite(target.playbackRate) ? target.playbackRate : 1,
      volume: Number.isFinite(target.volume) ? target.volume : 1,
      muted: !!target.muted,
      hasTextTrack: countTextTracks(target) > 0,
      error: errorDetail(target.error)
    };

    this.#wire();
  }

  get playback() { return this.#axis.playback; }
  get buffer() { return this.#axis.buffer; }
  get presence() { return this.#axis.presence; }
  get screen() { return this.#axis.screen; }

  get duration() { return this.#scalar.duration; }
  get currentTime() { return this.#scalar.currentTime; }
  get rate() { return this.#scalar.rate; }
  get volume() { return this.#scalar.volume; }
  get muted() { return this.#scalar.muted; }
  get hasTextTrack() { return this.#scalar.hasTextTrack; }
  get error() { return this.#scalar.error; }

  /**
   * Receive every change, one typed event each, in order. Delivery is batched
   * to a microtask; the value itself has already changed by the time the event
   * was produced.
   *
   * @param {(change: StatusChange) => void} cb
   * @param {AbortSignal} [signal]
   * @returns {() => void} unsubscribe
   */
  subscribe(cb, signal) {
    this.#listeners.add(cb);
    if (signal) {
      signal.addEventListener("abort", () => this.#listeners.delete(cb), { once: true });
    }
    return () => this.#listeners.delete(cb);
  }

  dispose() {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#pending.length = 0;
    this.#listeners.clear();
    for (const teardown of this.#teardown) {
      teardown();
    }
    this.#teardown.length = 0;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  /** Apply an observed edge. A no-op when the value did not actually move. */
  #set(kind, name, to, cause) {
    const store = kind === "axis" ? this.#axis : this.#scalar;
    const from = store[name];
    if (Object.is(from, to)) {
      return;
    }
    store[name] = to;
    this.#queue({ seq: ++this.#seq, kind, name, from, to, cause });
  }

  /** `timeupdate` moves the clock ~4 Hz: a read, not a state change. */
  #setClock(value) {
    if (Number.isFinite(value)) {
      this.#scalar.currentTime = value;
    }
  }

  /**
   * Fold the two presence inputs into one axis value.
   *
   * `BACKGROUND` is checked first and deliberately wins: a hidden tab shows
   * nothing whatever the geometry says, and the `visibilitychange` edge has to
   * be able to move the axis in both directions without depending on whether a
   * rect has been read since. Treating background as visible would instead
   * re-attach the HUD on tab-hide only for IntersectionObserver to detach it
   * again on return - the same answer reached by two writes.
   */
  #presence() {
    if (this.#doc.visibilityState === "hidden") {
      return Presence.BACKGROUND;
    }
    return this.#intersecting ? Presence.VISIBLE : Presence.OCCLUDED;
  }

  #queue(change) {
    this.#pending.push(Object.freeze(change));
    if (this.#flushScheduled) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => this.#flush());
  }

  /**
   * The scheduled commit: one per tick, delivering each transition exactly
   * once. Subscribers are snapshotted and isolated for the same reasons the
   * fullscreen fan-out is - a listener may unsubscribe from inside its own
   * callback, and a throw from one must not take out the rest.
   */
  #flush() {
    this.#flushScheduled = false;
    const batch = this.#pending;
    this.#pending = [];
    if (this.#disposed) {
      return;
    }
    const listeners = this.#listeners;
    for (const change of batch) {
      this.#dispatch(change);
      for (const cb of [...listeners]) {
        try {
          cb(change);
        } catch (err) {
          logger.error("status", "Status subscriber threw during dispatch", err);
        }
      }
    }
  }

  /**
   * Publish across the realm boundary.
   *
   * Two realm rules, both learned the hard way. The constructor comes from the
   * element's own realm, because jsdom rejects a foreign one. And `detail` is
   * *built* there too: a page holding this node can store a reference to an
   * object from this module's realm but cannot read its properties off it, so
   * handing the change over as-is would make the channel arrive and then fail
   * on the first field access. Nested values (the `error` shape) are rebuilt
   * the same way; primitives are copied as they are, so NaN survives.
   *
   * Degrades to `subscribe()` only where the host has no CustomEvent at all.
   */
  #dispatch(change) {
    if (typeof globalThis.CustomEvent !== "function") {
      return;
    }
    const win = this.#target.ownerDocument?.defaultView;
    const Ctor = win?.CustomEvent ?? globalThis.CustomEvent;
    const detail = win ? new win.Object() : {};
    for (const key of Object.keys(change)) {
      const value = change[key];
      detail[key] =
        value !== null && typeof value === "object" ? win.JSON.parse(JSON.stringify(value)) : value;
    }
    this.#target.dispatchEvent(new Ctor(STATUS_EVENT, { bubbles: false, detail }));
  }

  /** Attach every source. Stored so dispose works with or without a signal. */
  #wire() {
    const target = this.#target;
    const doc = this.#doc;
    const signal = this.#signal;

    const on = (node, type, handler) => {
      node.addEventListener(type, handler, { signal, passive: true });
      this.#teardown.push(() => node.removeEventListener(type, handler));
    };

    const setPlayback = (to, cause) => this.#set("axis", "playback", to, cause);
    const setBuffer = (to, cause) => this.#set("axis", "buffer", to, cause);

    on(target, "loadstart", () => {
      setPlayback(Playback.LOADING, "loadstart");
      setBuffer(Buffer.NONE, "loadstart");
    });
    on(target, "emptied", () => {
      setPlayback(Playback.IDLE, "emptied");
      setBuffer(Buffer.NONE, "emptied");
    });
    // READY only when the element really is stopped with media in hand: while a
    // play() is in flight `paused` is already false, so the LOADING -> PLAYING
    // path stays honest and never steps through a READY it has not reached.
    on(target, "loadedmetadata", () => {
      if (target.paused && !target.ended) {
        setPlayback(Playback.READY, "loadedmetadata");
      }
    });
    on(target, "canplay", () => {
      setBuffer(Buffer.NONE, "canplay");
      if (target.paused && !target.ended) {
        setPlayback(Playback.READY, "canplay");
      }
    });
    // `play` means the request was accepted, not that a frame was rendered. It
    // only earns a transition when leaving ENDED, where staying behind would
    // misreport a restart as still finished.
    on(target, "play", () => {
      if (this.#axis.playback === Playback.ENDED) {
        setPlayback(Playback.LOADING, "play");
      }
    });
    on(target, "playing", () => {
      setPlayback(Playback.PLAYING, "playing");
      setBuffer(Buffer.NONE, "playing");
    });
    on(target, "pause", () => {
      setPlayback(target.ended ? Playback.ENDED : Playback.PAUSED, "pause");
    });
    on(target, "ended", () => {
      setPlayback(Playback.ENDED, "ended");
      setBuffer(Buffer.NONE, "ended");
    });
    on(target, "waiting", () => setBuffer(Buffer.WAITING, "waiting"));
    on(target, "seeking", () => setBuffer(Buffer.SEEKING, "seeking"));
    on(target, "seeked", () => setBuffer(Buffer.NONE, "seeked"));

    on(target, "durationchange", () => {
      this.#set("scalar", "duration", Number.isFinite(target.duration) ? target.duration : NaN, "durationchange");
    });
    on(target, "ratechange", () => {
      this.#set("scalar", "rate", Number.isFinite(target.playbackRate) ? target.playbackRate : 1, "ratechange");
    });
    on(target, "volumechange", () => {
      this.#set("scalar", "volume", Number.isFinite(target.volume) ? target.volume : 1, "volumechange");
      this.#set("scalar", "muted", !!target.muted, "volumechange");
    });
    on(target, "timeupdate", () => this.#setClock(target.currentTime));
    on(target, "error", () => this.#set("scalar", "error", errorDetail(target.error), "error"));

    const textTracks = target.textTracks;
    // A host may expose the list without making it an EventTarget (jsdom does),
    // so listen only when the thing can actually announce a change. Each event
    // keeps its own name as the cause: "addtrack" and "removetrack" are what
    // fired, and a cause nobody fired would read as a discovered state.
    if (typeof textTracks?.addEventListener === "function") {
      const onTracks = (event) =>
        this.#set("scalar", "hasTextTrack", countTextTracks(target) > 0, event.type);
      on(textTracks, "addtrack", onTracks);
      on(textTracks, "removetrack", onTracks);
    }

    on(doc, "visibilitychange", () => {
      this.#set("axis", "presence", this.#presence(), "visibilitychange");
    });

    // L1's visibility signal, and the only source `OCCLUDED` ever has. There
    // is no event for "the player scrolled out of the viewport", and polling a
    // rect would be precisely the periodic work this design rules out (§1), so
    // the observation is the platform's: one IntersectionObserver on the
    // target. Its callbacks are posted as a task after layout, which is
    // correct here - HUD occlusion is not frame-critical (§7).
    //
    // Absent on a host without it, the gate simply never opens and presence
    // stays VISIBLE or BACKGROUND. That is the safe direction: nothing is
    // lost except the idle-cost win. The probe is guarded so a missing API
    // degrades instead of throwing during construction, the same shape
    // `resume.js` uses for its own off-screen save gate.
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(([entry]) => {
        this.#intersecting = !!entry?.isIntersecting;
        this.#set("axis", "presence", this.#presence(), "intersection");
      });
      io.observe(target);
      // Explicit rather than signal-backed: IntersectionObserverInit has no
      // `signal` member, so the disconnect cannot ride the options object the
      // way a listener can.
      this.#teardown.push(() => io.disconnect());
    }

    // Screen comes from shadow.js's single gate, not a second listener. Its
    // edge is still fullscreenchange, so the transition reports that cause.
    this.#teardown.push(
      subscribeFullscreen(
        (active) => this.#set("axis", "screen", active ? Screen.FULLSCREEN : Screen.NONE, "fullscreenchange"),
        signal
      )
    );
  }
}
