/**
 * The PlayerForge subtitles feature, main-thread side: the ingest transport
 * (threshold-gated Worker offloader), the track renderer (ForgeTrack), and
 * the shell panel section that drives them (SubtitlesSection) - the three
 * layers that only ever run on the main thread, in dependency order.
 *
 * Parsing itself is forgevtt.js: the engine both transport paths share and
 * the only module the worker chunk (vtt-worker.js) bundles straight in, so
 * the two paths can never drift. This file stays out of the worker build -
 * the chunk imports the engine, never the feature.
 */
import { parseSubtitlesAsync as parseInBand, srtToVtt, ensureVttHeader } from "./forgevtt.js";
import { logger, Scope, debounce, Fan } from "../../shared/runtime.js";
import { DOMManager } from "../../shared/dom.js";
import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/store.js";
import { TUNING, clamp, fmtPercent, fmtEm, fmtPercentOrOff, signedSeconds } from "../../shared/core.js";
import { GESTURE_EVENTS } from "../../kernel/contract.js";
import { flashElement, el } from "../chrome/ui.js";

/* - Ingest transport - */

/**
 * Threshold-gated subtitle parse offloader.
 *
 * Large tracks parse on a long-lived dedicated Worker: spawn cost and engine
 * compile are paid once per page, concurrent ingests queue natively in the
 * worker's message loop (request ids settle them independently - no
 * single-flight flag, no per-load spawn/terminate dance), and both directions
 * move bytes the native way: the UTF-8 payload is transferred (TextEncoder +
 * transfer list, no string structured-clone) and the cues return as a packed
 * frame - two transferable Float64Arrays plus two cloned string arrays - which
 * measures ~3x cheaper than cloning the cue object graph for a 5000-cue
 * track. Small tracks stay in-band: for them the round trip costs more than
 * the parse itself.
 *
 * Every failure mode - no Worker, page CSP blocking blob workers, a crashed
 * worker, a wedged worker, teardown mid-await - degrades to the cooperative
 * in-band parse (forgevtt.parseSubtitlesAsync), so the worker is strictly an
 * optimization and the two paths produce the same cues for the same text:
 * they share the same engine (the byte transport only normalizes unpaired
 * surrogates, which the string sink ForgeTrack's build pass anyway avoids).
 * A CSP-blocked page latches out of the worker path - retrying would only
 * re-pay the failure - while a crashed or hung worker is torn down and the
 * next ingest respawns fresh.
 *
 * The worker chunk is injected at build time by esbuild (define
 * __VTT_WORKER_SOURCE__). Keeping this module loadable by the Node test
 * harness is worth one trade-off: esbuild substitutes the identifier into the
 * typeof guard too, so the chunk's string literal appears in the bundle once
 * (the constant-folded guard discards the null arm) - never worth splitting
 * the parser for.
 */

const BUILTIN_WORKER_SOURCE =
  typeof __VTT_WORKER_SOURCE__ === "string" ? __VTT_WORKER_SOURCE__ : null;

/**
 * The worker chunk either comes from the build-time define (production bundle)
 * or, under the test harness, from an injected global - both resolve to the
 * same esbuild output of vtt-worker.js, so the executed engine is the real one.
 * Reading it dynamically (not at import) keeps the module Node-importable and
 * lets tests arm the worker path after the static import.
 */
function workerSource() {
  if (BUILTIN_WORKER_SOURCE !== null) {
    return BUILTIN_WORKER_SOURCE;
  }
  return typeof globalThis.__VTT_WORKER_SOURCE__ === "string"
    ? globalThis.__VTT_WORKER_SOURCE__
    : null;
}

/** Below this, the cooperative in-band path is strictly cheaper than a spawn. */
const WORKER_MIN_CHARS = 1 << 19;
/** Failsafe: no sane VTT ingest takes this long. */
const WORKER_TIMEOUT_MS = 60_000;

const ENCODER = new TextEncoder();

/**
 * The worker transport - one owner of the resident worker's whole lifecycle.
 * The state it needs used to be five loose module variables (worker, url,
 * CSP latch, request sequence, in-flight map); they are private fields here
 * so that spawn/latch/watchdog/settle is one object's story instead of a
 * module's. Parse eligibility and the cooperative in-band fallback keep the
 * exact contracts; only the ownership moved.
 */
class WorkerTransport {
  #worker = null;
  #workerUrl = null;
  /** CSP-blocked pages never gain a Worker - latch so each ingest doesn't re-pay the failed spawn. */
  #workerBroken = false;
  #requestSeq = 0;
  /**
   * In-flight requests by id. The worker processes messages in order, so this
   * is the whole concurrency story: no busy flag, no queue of our own - a
   * second large ingest waits on the worker's loop instead of degrading to
   * the main thread.
   * Each entry: { resolve, fallback } - fallback re-runs the cooperative
   * in-band parse with this request's own text.
   */
  #pending = new Map();

  /**
   * Whether this environment could ride a Worker. Only the source matters:
   * Worker/Blob/URL members are unconditional on the 159 page and worker
   * realms (and the Node import smoke never calls this), while the genuine
   * refusal - a worker-src CSP blocking blob Workers - stages at spawn in
   * #ensureWorker's try/catch latch. The former layered typeof census
   * belonged to the removed element-capability family.
   */
  available() {
    return workerSource() !== null;
  }

  /** Spawn the resident worker once; null when unavailable or CSP-latched. */
  #ensureWorker() {
    if (this.#worker !== null) {
      return this.#worker;
    }
    if (this.#workerBroken) {
      return null;
    }
    let url = null;
    try {
      url = globalThis.URL.createObjectURL(
        new globalThis.Blob([workerSource()], { type: "text/javascript" })
      );
      // Pages with a worker-src CSP block blob Workers by throwing here; the
      // blob URL must be revoked before the synchronous throw escapes, or
      // every blocked load would leak one URL.
      const worker = new globalThis.Worker(url, { name: "playerforge-vtt" });
      this.#worker = worker;
      worker.onmessage = (event) => this.#onWorkerMessage(event);
      worker.onerror = () => this.#killWorker();
      this.#workerUrl = url;
      return worker;
    } catch (err) {
      if (url !== null) {
        globalThis.URL.revokeObjectURL(url);
      }
      this.#workerBroken = true;
      logger.warn("subtitles", "Blob worker blocked (page CSP?), staying in-band", err);
      return null;
    }
  }

  /**
   * Tear down the resident worker and settle every in-flight request through
   * its in-band fallback. Called on a worker crash or when a request's
   * watchdog fires (a hung worker would otherwise wedge every later ingest);
   * the next eligible parse respawns fresh.
   */
  #killWorker() {
    const inflight = [...this.#pending.values()];
    this.#pending.clear();
    const doomed = this.#worker;
    const doomedUrl = this.#workerUrl;
    this.#worker = null;
    this.#workerUrl = null;
    if (doomed !== null) {
      doomed.onmessage = null;
      doomed.onerror = null;
      doomed.terminate();
      if (doomedUrl !== null) {
        globalThis.URL.revokeObjectURL(doomedUrl);
      }
    }
    for (const entry of inflight) {
      entry.fallback();
    }
  }

  /** Rebuild cue objects from the worker's packed frame (engine field order). */
  #unpackCues(data) {
    const texts = data.texts;
    const n = texts.length;
    const times = data.times;
    const nums = data.nums;
    const aligns = data.aligns;
    const cues = new Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 2;
      cues[i] = {
        start: times[j],
        end: times[j + 1],
        text: texts[i],
        line: nums[j],
        position: nums[j + 1],
        align: aligns[i]
      };
    }
    return cues;
  }

  #onWorkerMessage(event) {
    const data = event.data ?? {};
    if (data.pfWorker !== 1) {
      return;
    }
    const entry = this.#pending.get(data.id);
    if (entry === undefined) {
      // Already settled (watchdog/crash) or a foreign message - never let a
      // stale reply resolve a request that already fell back.
      return;
    }
    this.#pending.delete(data.id);
    if (data.error !== undefined || !(data.times instanceof Float64Array)) {
      entry.fallback();
      return;
    }
    entry.resolve(this.#unpackCues(data));
  }

  #runInWorker(worker, text) {
    const id = ++this.#requestSeq;
    const { promise, resolve } = Promise.withResolvers();
    this.#pending.set(id, {
      resolve,
      fallback: () => {
        parseInBand(text).then(resolve);
      }
    });
    // Failsafe for a wedged worker: drop it (settling every in-flight
    // request in-band) so one hang can't stack up behind it. The listener
    // becomes a no-op once the request settles any other way.
    AbortSignal.timeout(WORKER_TIMEOUT_MS).addEventListener(
      "abort",
      () => {
        if (this.#pending.has(id)) {
          this.#killWorker();
        }
      },
      { once: true }
    );
    try {
      const bytes = ENCODER.encode(text);
      worker.postMessage({ pfWorker: 1, id, bytes }, [bytes.buffer]);
    } catch (err) {
      const entry = this.#pending.get(id);
      if (entry !== undefined) {
        this.#pending.delete(id);
        entry.fallback();
      }
      logger.warn("subtitles", "Worker postMessage failed, falling back in-band", err);
    }
    return promise;
  }

  /**
   * Cooperative subtitle parse, offloaded to the dedicated Worker only when
   * the track is large enough to make the round trip worthwhile and a
   * Worker is available. `throughWorker` is a test/tune knob that bypasses
   * the size gate; production callers never pass it.
   */
  parse(text, offset = 0, throughWorker = false) {
    const eligible =
      offset === 0 &&
      this.available() &&
      (throughWorker || text.length >= WORKER_MIN_CHARS);
    if (!eligible) {
      return parseInBand(text, offset);
    }
    const worker = this.#ensureWorker();
    if (worker === null) {
      return parseInBand(text, offset);
    }
    return this.#runInWorker(worker, text);
  }
}

const transport = new WorkerTransport();

/** Cooperative parse - the façade over the transport's worker offload. */
export function parseSubtitlesAsync(text, offset = 0, throughWorker = false) {
  return transport.parse(text, offset, throughWorker);
}

/* - Track renderer - */
/* Tuning rides the shared TUNING table (forge-style aliases); the local
 * literals it replaced lived only beside their renderer. */
const STACK_OVERLAP_EM = TUNING.subtitles.cueStackOverlapEm;
const MAX_SLOTS = TUNING.subtitles.cueSlots;

/** Px writer for picture-anchored values: one decimal, no float exhaust. */
function fmtPx(value) {
  return Math.round(value * 100) / 100;
}

/* - Parse memo - */
/**
 * The content-hash parse memo as one class (the DomainKeyCache shape): the
 * Map, the cap, and the FIFO eviction walk are private members of the
 * instance, so the remember/evict steps ride one object instead of being
 * replayed inline in every memo consumer. `memoizedParse()` stays the thin
 * consumer function the load path calls.
 */
class ParseMemo {
  /** Parsed-track cap (by track count): one cue array is small (strings only),
   *  eight covers a session of thumb-loading without any eviction math. */
  #limit = 8;
  /** contentHash -> parsed cues, so a reload of the same subtitle text (panel
   *  re-open, SPA re-adopt, URL subs again after boot) skips the parse entirely. */
  #cues = new Map();

  /** FNV-1a over the normalized text - collision risk is far below the
   *  wrong-cue-set threshold for subtitle-sized inputs, and the hash is one
   *  pass (no crypto latency) on the ingest path. */
  #hash(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash;
  }

  /**
   * Parse with a content-hash memo: identical normalized text resolves to the
   * cached cue array (the same plain objects the sampler schedules; the load
   * path's build pass copies entries into its own shifted list, so the
   * cached array stays immutable).
   */
  load(text) {
    const hash = this.#hash(text);
    const hit = this.#cues.get(hash);
    if (hit) {
      return Promise.resolve(hit);
    }
    return parseSubtitlesAsync(text, 0).then((cues) => {
      if (cues.length) {
        if (this.#cues.size >= this.#limit) {
          this.#cues.delete(this.#cues.keys().next().value);
        }
        this.#cues.set(hash, cues);
      }
      return cues;
    });
  }
}

const parseMemo = new ParseMemo();

/** Parse with a content-hash memo: identical normalized text resolves to the
 *  cached cue array (see ParseMemo). */
function memoizedParse(text) {
  return parseMemo.load(text);
}

/**
 * Shift a base cue time by a sync offset, clamped at t=0 - the exact time the
 * offsetCues() pass used to bake into a fresh copy of the cue list. Negative
 * or past-the-origin times collapse to 0, so a cue wholly before t=0 becomes a
 * zero-length cue at 0 (never active) instead of being dropped.
 */
function shiftTime(time, offset) {
  const shifted = time + offset;
  return shifted < 0 ? 0 : shifted;
}

/**
 * Subtitle track with a custom DOM surface and OUR OWN cue scheduling: no
 * native TextTrack exists anywhere along this path - the file never enters
 * the video element's track list - so a hostile host can never list, restyle,
 * or mode-flip the captions (its CC menu stays clean, `::cue` css cannot
 * reach them, and a site that disables foreign text tracks mid-play cannot
 * kill ours). The floor makes the law cheap to keep honestly: even the
 * native realtime cue-observer shape is incomplete here (`oncuechange` is
 * absent from TextTrack.prototype on the 159 floor, probed), and the
 * check's custody row pins the empty track list beside a visible slot. Parsing is forgevtt (below); a TrackListRenderer owns
 * scheduling after that: per-frame `currentTime` sample on the video
 * element's own media clock - the compositor's rAF is the crank, sampled
 * like the forge's scrub commits, never a poll timer - and the active set
 * derives from a sorted-start walk with an amortized dead floor (ends are
 * not sorted, so the floor only advances while head-adjacent entries are
 * dead; a backward seek resets it, one-off O(n)). The active set is the W3C
 * relation, start <= t < end; the visual output (pooled slots, custom
 * properties, per-cue stacking) is unchanged.
 *
 * Cue positions are PICTURE-anchored, not layer-relative: the Universal
 * rect is the shell's one fill-box identity (ReferenceBox, see dom.js - the
 * same box scrub gain, edge zones and the fill transform read), and the
 * displayed video picture inside it derives from the video's own box +
 * intrinsic aspect + object-fit (the audited computeCoverScale relation,
 * owned by pinch-to-fill, read the other way: a fill-mode transform makes
 * the picture BE the ReferenceBox rect, a containing video letterboxes
 * inside it). Percent cue fields then mean what W3C cue positioning means -
 * a fraction of the PAINTED picture - which the layer-relative resolution
 * got wrong on stages whose video doesn't span them (object-fit letterbox,
 * pillarbox, a container carrying a control bar), and wrong relative to the
 * fill transform on every stage. Slots stay positioned in the cue layer's
 * own coordinate space (the env-inset visible stage) - the layer keeps its
 * CSS env insets and clip, so caption paint never enters the cutout - and
 * the picture rect is expressed in that space per render. Unreadable
 * geometry (zero rects) leaves the layer-relative resolution standing -
 * the @property initial-values and prior slot values answer.
 *
 * Stage-change re-anchoring rides the ReferenceBox's change ticks (its
 * owned invalidation sources: container RO, fs re-target, orientation,
 * scroll); no duplicate fs/RO/orientation of ours. Video-relative marks -
 * the video's own box moving inside an unmoved stage, and its intrinsic
 * size changing - are this class's own RO + the media element's resize
 * event, both signal-scoped.
 */
export class ForgeTrack {
  #cueLayer;
  #cueLayerStyle;
  #video;
  #reference;
  #slots = [];
  /** DOM lifecycle manager: cue slot elements auto-removed on destroy. */
  #dom = new DOMManager();
  /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
   *  render); #lastActive mirrors which slots currently hold a live cue so a
   *  `null` entry never needs to be stored. Same discipline as the forge's
   *  pooled scrub payload: mutate in place, read immediately. */
  #lastRender = [];
  #lastActive = [];
  /** Zero-offset cue base the render list was built from; drives setOffset. */
  #baseCues = null;
  /** Offset already applied to the render list (setOffset no-ops on a
   *  repeat). */
  #offset = 0;
  /** The SHIFTED cue list this sampler schedules, sorted by start (ties by
   *  end). Plain objects - the same shape parseSubtitles yields, with the
   *  offset baked - so no native cue type ever appears on this path. */
  #cues = null;
  /** First list index whose entries may still activate; entries before it
   *  are dead (end <= t) and re-tested only after a backward seek. */
  #floor = 0;
  /** Last sampled time; a sample at the same time reuses the walked answer. */
  #lastTime = -1;
  /** The active cue set in list order (start ascending), pooled: mutated in
   *  place per sample, read immediately by the slot diff - no per-frame
   *  allocation on the hot path. */
  #activePool = [];
  /** Pending rAF frame handle; 0 disarmed. The crank stops with the element:
   *  a paused/static video stops painting, so the sampler idles with it. */
  #rafId = 0;
  /** Global placement overrides from the panel's V/H steppers (0-100), or
   *  null to keep each cue's own line/position (default until the user moves
   *  a stepper). Applied per render, so a change re-lays active slots. */
  #lineOverride = null;
  #positionOverride = null;
  /** The displayed picture in layer coordinates, re-derived per render. A
   *  sequence bump (only when the rect actually moves) is what the per-slot
   *  dirty checks test, so a still picture stays allocation-free on the
   *  steady path. */
  #picture = null;
  #pictureSeq = 0;
  /** The crank handle shape bound at construction so destroy cancels one
   *  pending frame deterministically. */
  #onFrame = null;
  /** Whether the player is currently on screen. Defaults true so the time
   *  before the first observation lands renders unconditionally; the
   *  observer only ever suppresses off-screen churn and re-renders on
   *  re-entry. */
  #onScreen = true;
  /** Disposal flag; rAF cancellation is manual (the pending frame id is not
   *  signal-shaped). */
  #scope = new Scope();

  constructor(video, cueLayer, reference = null) {
    this.#cueLayer = cueLayer;
    this.#cueLayerStyle = cueLayer?.style;
    this.#video = video;
    this.#reference = reference;
    // Preallocate the pooled per-slot scratch now so sampler renders (the
    // hot subtitle path) stay completely allocation-free.
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.#lastRender[i] = { text: null, top: null, left: null, x: null, maxW: null, prevLine: NaN, prevPosition: NaN, prevPictureSeq: -1 };
      this.#lastActive[i] = false;
    }
    // Pre-allocate all cue slot elements upfront for zero first-show latency.
    // Slots are hidden by default and toggled visible by #render().
    // DOMManager tracks them for automatic removal on destroy.
    if (cueLayer) {
      for (let i = 0; i < MAX_SLOTS; i++) {
        this.#slots[i] = this.#dom.createElement("div", { class: "pf-cue", role: "caption" }, cueLayer);
      }
    }
    // Deferred crank wiring: pending frame handle bound at construction so
    // #armLoop can re-arm strictly and destroy cancels one id.
    const observer = new IntersectionObserver(([entry]) => {
      if (this.#scope.disposed) {
        return;
      }
      const was = this.#onScreen;
      this.#onScreen = entry.isIntersecting;
      if (this.#onScreen && !was) {
        this.#schedule();
      }
    });
    observer.observe(video);
    this.#scope.onDispose(() => observer.disconnect());
    // The fill box's change tick re-renders here (the re-anchor on fs flips,
    // stage resizes, orientation); the pool owner keeps the arming. A
    // stage-still video-relative move is ours: the video box itself (SDK
    // resizing the element inside a constant container) and its intrinsic
    // size (the media element's own resize signal + the first metadata
    // moment the picture math can finally see an aspect).
    reference?.subscribe(() => this.#schedule(), { signal: this.#scope.signal });
    const videoRo = new ResizeObserver(() => {
      this.#schedule();
    });
    videoRo.observe(video);
    this.#scope.onDispose(() => videoRo.disconnect());
    video.addEventListener("resize", () => this.#schedule(), { signal: this.#scope.signal, passive: true });
    video.addEventListener("loadedmetadata", () => this.#schedule(), { signal: this.#scope.signal });
    // The crank: a stable bound field so the pending frame holds the
    // instance and destroy cancels one id.
    this.#onFrame = () => this.#tick();
  }

  /**
   * Replace all cues. Accepts plain cue objects from forgevtt; `offset` is
   * baked into the render list at build time (see the class docstring). The
   * unshifted list is remembered as the zero-offset base so later sync
   * nudges can rebuild instead of re-parsing (see setOffset).
   */
  load(cues, offset = 0) {
    if (this.#scope.disposed) {
      return;
    }
    this.#baseCues = cues;
    this.#offset = offset;
    this.#applyBase(offset);
  }

  /**
   * Rebuild the shifted cue list from the zero-offset base. Sort by start
   * (ties by end - sort stability is spec-mandated so this holds on every
   * engine): the walk's early exit reads list starts, and
   * the stack order follows - the active set collects in list order, so an
   * earlier-start overlap takes the lower slot, the deterministic shape the
   * native insertion order approximated in practice.
   */
  #applyBase(offset) {
    const base = this.#baseCues;
    const out = new Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const src = base[i];
      out[i] = {
        start: shiftTime(src.start, offset),
        end: shiftTime(src.end, offset),
        text: src.text,
        line: src.line,
        position: src.position,
        align: src.align
      };
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end);
    this.#cues = out;
    this.#floor = 0;
    this.#lastTime = -1;
    // An immediate sample re-answers the active set the frame the list
    // exists, before the next crank - the load-path mirror of the boundary
    // timing the native engine once provided.
    this.#schedule();
    this.#armLoop();
  }

  /**
   * Rebuild the shifted list under a new sync offset. The whole rebuild
   * replaces the native track's in-place startTime/endTime walk: no cue
   * object survives the old list, so the order question the old setOffset
   * carried (a large negative shift can cross starts, and the native engine
   * re-sorted list by index) cannot even arise - the fresh sort re-answers
   * it. The steppers debounce commits (150ms), so O(n log n) per commit
   * rides at most ~7 rebuilds a second over at most a few thousand cues.
   */
  setOffset(offset) {
    if (this.#scope.disposed || offset === this.#offset || !this.#baseCues) {
      return;
    }
    this.#offset = offset;
    this.#applyBase(offset);
  }

  /**
   * One frame of scheduling: sample the media clock, advance the dead floor,
   * collect the active set, hand the pooled list to the slot diff. The
   * active relation is the W3C one, start <= t < end - end EXCLUSIVE, so a
   * cue ends the frame its end time passes, and two cues sharing a boundary
   * swap inside one sample instead of coexisting.
   */
  #schedule(t = (this.#video?.currentTime ?? -1)) {
    if (this.#scope.disposed || !this.#cueLayer || !this.#onScreen || !this.#cues) {
      return;
    }
    const cues = this.#cues;
    if (t < this.#lastTime) {
      // Backward time jump (a seek, a media re-adopt, a ratechange-driven
      // restore): the dead floor re-opens from the list head - one-off O(n),
      // amortized to nothing on the forward cadence the plan rides.
      this.#floor = 0;
    }
    this.#lastTime = t;
    let floor = this.#floor;
    // Dead-floor advance: ends are not sorted, so an entry with a later end
    // may sit before an already-dead one; the floor only advances while the
    // head-adjacent entry is actually behind the clock, and a previously
    // passed entry is never revisited unless the jump above reset the floor.
    while (floor < cues.length && cues[floor].end <= t) {
      floor++;
    }
    this.#floor = floor;
    let count = 0;
    const pool = this.#activePool;
    for (let i = floor; i < cues.length; i++) {
      const cue = cues[i];
      // Sorted by start, so the first starts-ahead entry ends the scan -
      // everything spawned after it cannot be active at t.
      if (cue.start > t) {
        break;
      }
      if (cue.end > t) {
        pool[count++] = cue;
      }
    }
    pool.length = count;
    this.#render(pool);
  }

  #armLoop() {
    if (!this.#rafId && !this.#scope.disposed && this.#cues?.length) {
      this.#rafId = requestAnimationFrame(this.#onFrame);
    }
  }

  #tick() {
    this.#rafId = 0;
    if (this.#scope.disposed) {
      return;
    }
    const t = this.#video?.currentTime ?? -1;
    if (t !== this.#lastTime) {
      // A sample that moved the clock re-runs the walk; a still sample (the
      // video paused, the tab throttled) needs nothing - the last active
      // set already paints it.
      this.#schedule(t);
    }
    this.#armLoop();
  }

  #render(active) {
    if (this.#scope.disposed || !this.#cueLayer || !this.#onScreen) {
      return;
    }
    const count = Math.min(active.length, MAX_SLOTS);
    const picture = this.#derivePicture();
    if (picture) {
      const prevBox = this.#picture;
      if (!prevBox || prevBox.x !== picture.x || prevBox.y !== picture.y
        || prevBox.width !== picture.width || prevBox.height !== picture.height) {
        this.#pictureSeq++;
        this.#picture = picture;
      }
    }
    for (let i = 0; i < count; i++) {
      const slot = this.#slots[i];
      if (!slot) {
        continue;
      }
      const cue = active[i];
      const line = this.#lineOverride ?? cue.line;
      const position = this.#positionOverride ?? cue.position;
      const align = cue.align || "center";
      const prev = this.#lastRender[i];
      // Numeric dirty checks: skip string construction when values match
      // the previous render — avoids template-literal allocation per slot
      // per sample on the hot subtitle path. The picture sequence joins
      // the guards: a moved picture re-lays every anchored slot on the next
      // render (the tick-driven re-anchor) even when both percentages held.
      const boxMoved = prev.prevPictureSeq !== this.#pictureSeq;
      const lineChanged = boxMoved || line !== prev.prevLine;
      const positionChanged = boxMoved || position !== prev.prevPosition;
      if (lineChanged) {
        const top = picture
          ? `calc(${fmtPx(picture.y + (line / 100) * picture.height)}px - ${i * STACK_OVERLAP_EM}em)`
          : `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`;
        if (prev.top !== top) {
          slot.style.setProperty("--pf-cue-top", top);
        }
        prev.top = top;
        prev.prevLine = line;
      }
      if (positionChanged) {
        const left = picture
          ? `${fmtPx(picture.x + (position / 100) * picture.width)}px`
          : `${position}%`;
        if (prev.left !== left) {
          slot.style.setProperty("--pf-cue-left", left);
        }
        prev.left = left;
        prev.prevPosition = position;
      }
      // The 80% width cap rides the picture too: a pillarboxed picture must
      // not invite a cue wider than the picture. Layer-relative stages
      // (picture unreadable) keep the sheet's 80% fallback - clear the
      // inline value once.
      const maxW = picture ? `${fmtPx(0.8 * picture.width)}px` : null;
      if (prev.maxW !== maxW) {
        if (maxW) {
          slot.style.maxWidth = maxW;
        } else {
          slot.style.removeProperty("max-width");
        }
        prev.maxW = maxW;
      }
      const x = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
      if (prev.x !== x) {
        slot.style.setProperty("--pf-cue-x", x);
      }
      if (prev.text !== cue.text) {
        slot.textContent = cue.text;
      }
      if (slot.hidden) {
        slot.hidden = false;
      }
      prev.text = cue.text;
      prev.x = x;
      prev.prevPictureSeq = this.#pictureSeq;
      this.#lastActive[i] = true;
    }
    for (let i = count; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastActive[i] = false;
      }
    }
  }

  /**
   * The displayed video picture in the cue layer's coordinate space, or
   * null when the geometry cannot be read honestly (zero rects - the
   * layer-relative resolution stands; see the class docstring). Both rects
   * are read in the same pass (GBCR viewport coords, each fresh per call),
   * so the deltas stay truthful under any ancestor transform; object-fit
   * resolves per pass against the element (site-set styles included).
   */
  #derivePicture() {
    const layer = this.#cueLayer;
    const video = this.#video;
    if (!layer || !video) {
      return null;
    }
    const layerBox = layer.getBoundingClientRect();
    if (!layerBox.width || !layerBox.height) {
      return null;
    }
    const vBox = video.getBoundingClientRect();
    if (!vBox.width || !vBox.height) {
      return null;
    }
    let width = vBox.width;
    let height = vBox.height;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      // object-fit letterbox/pillarbox/cover of the stream inside the
      // element box - the exact relation pinch-to-fill's cover scale owns
      // from the other side. Centered: object-position honors its 50% 50%
      // default the shipped CSS never overrides (an inline style from the
      // page would shift the box yet still cancel in the layer-relative
      // deltas only if the layer moves with it - the centering answer stays
      // the honest default).
      const boxAspect = vBox.width / vBox.height;
      const vidAspect = vw / vh;
      const fit = getComputedStyle(video).objectFit || "contain";
      if (fit === "contain" || fit === "scale-down") {
        if (boxAspect > vidAspect) {
          width = height * vidAspect;
        } else {
          height = width / vidAspect;
        }
        // scale-down never upscales: the intrinsic size wins when smaller.
        if (fit === "scale-down" && vw <= width && vh <= height) {
          width = vw;
          height = vh;
        }
      } else if (fit === "cover") {
        if (boxAspect > vidAspect) {
          height = width / vidAspect;
        } else {
          width = height * vidAspect;
        }
      } else if (fit === "none") {
        width = vw;
        height = vh;
      }
      // "fill": stretch to the element box, exactly as the rect reads.
    }
    const centerX = vBox.x + (vBox.width - width) / 2;
    const centerY = vBox.y + (vBox.height - height) / 2;
    // Universal clip: the picture ends at the one fill-box (the ReferenceBox
    // rect; its fallback answer covers the shell-less defensive read). Fill
    // mode makes the transform-scaled stream span the box and the clip is a
    // no-op there; letterbox modes leave the black bars OUT of the anchor.
    const ref = this.#reference?.get();
    const stage = ref && ref.width > 0 && ref.height > 0
      ? ref
      : { x: layerBox.x, y: layerBox.y, width: layerBox.width, height: layerBox.height };
    const left = Math.max(centerX, stage.x);
    const top = Math.max(centerY, stage.y);
    const right = Math.min(centerX + width, stage.x + stage.width);
    const bottom = Math.min(centerY + height, stage.y + stage.height);
    if (right - left <= 0 || bottom - top <= 0) {
      // Video and stage stopped sharing any viewport region (a stale stage
      // under a scroll the cache missed, a service-wide toggled layout) —
      // that is unreadable geometry, not a zero-area picture at the stage
      // origin: the collapsed clip computed exact 0s and every slot
      // anchored at the layer's own top-left. The layer-relative percent
      // resolution stands, as for the zero rects above.
      return null;
    }
    return {
      x: left - layerBox.x,
      y: top - layerBox.y,
      width: right - left,
      height: bottom - top
    };
  }

  clear() {
    // Ended-content hiding: hide every live slot without touching the cue
    // lists - the crank keeps running and a later seek re-derives normally.
    if (this.#scope.disposed || !this.#lastActive.some(Boolean)) {
      return;
    }
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[i];
      if (!slot.hidden) {
        slot.hidden = true;
        this.#lastActive[i] = false;
      }
    }
  }

  setVar(prop, value) {
    this.#cueLayerStyle?.setProperty(prop, value);
  }

  /**
   * Global caption placement (panel V/H steppers): 0-100 percentages, or null
   * to fall back to each cue's own line/position. Re-renders active slots so
   * the move lands immediately instead of at the next cue change.
   */
  setPlacement({ line = null, position = null } = {}) {
    if (this.#scope.disposed || (line === this.#lineOverride && position === this.#positionOverride)) {
      return;
    }
    this.#lineOverride = line;
    this.#positionOverride = position;
    this.#render();
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    // Cancel the pending frame FIRST: the crank must not re-arm against the
    // torn-down pool (dispose already blocks the tick body; the explicit
    // cancel keeps nothing scheduled anywhere).
    if (this.#rafId) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = 0;
    }
    // DOMManager removes all cue slot elements.
    this.#dom.destroy();
    this.#slots = [];
    this.#lastActive = [];
    this.#baseCues = null;
    this.#cues = null;
    this.#floor = 0;
    this.#lastTime = -1;
    this.#activePool.length = 0;
    this.#offset = 0;
  }
}

/* - Shell section - */
const SUBTITLE_FILE_ACCEPT = ".srt,.vtt";
const SUBTITLE_EXT_RE = /\.(srt|vtt)$/i;

const SETTING_KEYS = {
  size: "subtitles.style.size",
  color: "subtitles.style.color",
  shadow: "subtitles.style.shadow",
  font: "subtitles.style.font",
  stroke: "subtitles.style.stroke",
  line: "subtitles.position.line",
  horizontal: "subtitles.position.horizontal",
  syncOffset: "subtitles.sync.offset"
};

/** The steppers' display defaults. The STATE itself carries null ("cue
 *  authoring wins") for untouched placement, so these belong to the display
 *  layer only - seed and reset read this one constant instead of re-spelling
 *  the literals beside a raw storage read. */
const PLACE_DEFAULTS = { line: 85, position: 50 };

/** The cue-style defaults: the five control seeds and the reset read this one
 *  constant (the stylesheet's own var fallback lines stay CSS-owned - that is
 *  its internal business, not this vocabulary). */
const STYLE_DEFAULTS = { size: 1.2, color: "#ffffff", shadow: 40, font: "", stroke: 0 };

/** Curated caption family stacks; "" keeps the embed's own family. */
const CUE_FONT_OPTIONS = [
  ["Inherit", ""],
  ["System", "ui-sans-serif, system-ui, sans-serif"],
  ["Serif", "ui-serif, serif"],
  ["Mono", "ui-monospace, monospace"],
  ["Rounded", "ui-rounded, system-ui"]
];

const SYNC_STEP = TUNING.subtitles.nudgeStepSeconds;
const SYNC_BOUNDS = TUNING.subtitles.syncMaxOffset;

/**
 * The sync-offset state machine as a per-frame singleton.
 *
 * The offset has TWO persistence grains: per-entry (the resume tracker's
 * `subOffset` field - remembering the offset the video that needed it) and
 * the legacy global key (the only available grain until a resume entry
 * adopts, which also keeps pre-tracker sessions working unchanged). The
 * section, the keyboard nudge, and the menu reset all drive this one object:
 * the section may not even be built when a nudge arrives (panel sections are
 * lazy), so the state cannot live in the section.
 *
 * A user commit marks the state dirty, which freezes the auto-resolution:
 * a late entry adoption must not overwrite a nudge the user already made
 * against the fallback grain - their nudge was directed at the video in
 * front of them, and a subsequent set() migrates it to the entry grain.
 */
class SubtitleSyncState {
  /** Resolved current value; null until first resolution or bind attempt. */
  #value = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
  #identity = false;
  #dirty = false;
  #tracker = null;
  /** State audience on the shared Fan (the ONE plain-fan-out owner). */
  #audience = new Fan("sync");
  #schedulePersist = debounce(() => this.#write(), TUNING.subtitles.syncDebounceMs);

  get offset() {
    return this.#value;
  }

  /**
   * Bind the sync state to the shell: the tracker (entry grain) and the
   * shell's toast surface (nudge feedback), plus the host gesture listeners
   * (keyboard nudge, menu reset) so they work before - and without - the
   * panel section. `signal` is the shell's lifecycle signal; the listeners
   * die with it.
   */
  bindShell(shell, signal) {
    const host = shell.shellHost;
    if (!host) {
      return;
    }
    this.#tracker = shell.resume ?? null;
    // Every adoption announcement resolves the grain (one resolution succeeds
    // iff the entry changed): the store's own-echo filter swallows our own
    // save notifications, which means the findMatch adoption path - silent,
    // it persists nothing - only reaches us through the tracker's announce().
    if (this.#tracker) {
      this.#resolve();
      this.#tracker.onChange(() => this.#resolve(), { signal });
    }
    host.addEventListener(GESTURE_EVENTS.subSync, ({ detail }) => {
      this.set(this.#value + (detail?.direction === "left" ? -SYNC_STEP : SYNC_STEP));
      shell.toastFlash("captions", `Sync ${signedSeconds(this.#value)}`, "sync");
    }, { signal });
    host.addEventListener(GESTURE_EVENTS.syncReset, () => {
      this.set(0);
      shell.toastFlash("captions", "Sync Reset", "sync");
    }, { signal });
  }

  /** One resolution: read the best available grain into #value. */
  #resolve() {
    const tracker = this.#tracker;
    this.#identity = !!tracker?.entryId;
    const target = this.#identity
      ? tracker.subOffset
      : (Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0);
    if (!this.#dirty && target !== this.#value) {
      this.#value = target;
      this.#emit();
    }
  }

  set(offset) {
    const next = clamp(offset, -SYNC_BOUNDS, SYNC_BOUNDS);
    if (next === this.#value) {
      return;
    }
    this.#value = next;
    this.#dirty = true;
    this.#schedulePersist(next);
    this.#emit();
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  #write() {
    this.#schedulePersist.cancel();
    if (this.#identity && this.#tracker) {
      this.#tracker.setSubOffset(this.#value);
    } else {
      setConfigValue(SETTING_KEYS.syncOffset, this.#value);
    }
  }

  #emit() {
    this.#audience.emit(this.#value);
  }
}

/** The per-frame sync singleton: bound by shell.js before the section builds. */
export const subtitleSync = new SubtitleSyncState();

/** The placement seed read: a stored number is the override; anything else is
 *  "cue-authored" (null) - the exact normalization both halves of the feature
 *  previously re-derived at their own boot (rule: one owner per read). */
function readPlacement(key) {
  // Number(null) is 0, not NaN: a falsy default would have read the ABSENT
  // placement as an override of 0 — line/top 0 and position/left 0, the
  // field-reported top-left corner. An absent key must answer null (no
  // override; each cue's own fields apply).
  const stored = getConfigValue(key, null);
  if (stored === null || stored === undefined || stored === "") {
    return null;
  }
  const value = Number(stored);
  return Number.isFinite(value) ? value : null;
}

/**
 * The cue-placement state machine as a per-frame singleton: one write-point
 * owner for the V/H overrides that both halves read - the session at track
 * load, the (lazy) panel section's steppers at render - with no mirror fields
 * and no section-to-session transport hop.
 *
 * Persistence keeps the stepper cadence placement has always had: one direct
 * write per commit (the stepper quantizes; placement edits carry no drag
 * stream like the sync offset, so there is nothing to trail-persist). The
 * bound session applies each commit live through its track; track load asks
 * for `current` in the same build pass over the base cues.
 */
class SubtitlePlacementState {
  /** Stored overrides (0-100) or null until first customized. */
  #line = readPlacement(SETTING_KEYS.line);
  #position = readPlacement(SETTING_KEYS.horizontal);
  /** State audience on the shared Fan (the ONE plain-fan-out owner). */
  #audience = new Fan("placement");

  get line() {
    return this.#line;
  }

  get position() {
    return this.#position;
  }

  /** The live override pair; track load reads this in its build pass. */
  get current() {
    return { line: this.#line, position: this.#position };
  }

  /**
   * Bind to the shell's session: every committed change applies live through
   * the session's track (or at the next load). The stored grain re-reads at
   * each bind - a shell rebuild (SPA nav) must see newer storage exactly as
   * the per-shell seeds it replaces did (the seed is per-bind, not the
   * module-eval one). One registration - this state has no gesture events
   * and no grain adoption (placement is global style, not per-entry), so
   * there is nothing else to resolve.
   */
  bindSession(session, signal) {
    this.#line = readPlacement(SETTING_KEYS.line);
    this.#position = readPlacement(SETTING_KEYS.horizontal);
    this.#audience.subscribe(() => session.setPlacement(this.current), { signal });
  }

  setLine(value) {
    const next = clamp(Number(value) || 0, 0, 100);
    if (next === this.#line) {
      return;
    }
    this.#line = next;
    setConfigValue(SETTING_KEYS.line, next);
    this.#emit();
  }

  setPosition(value) {
    const next = clamp(Number(value) || 0, 0, 100);
    if (next === this.#position) {
      return;
    }
    this.#position = next;
    setConfigValue(SETTING_KEYS.horizontal, next);
    this.#emit();
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  #emit() {
    this.#audience.emit(this.current);
  }
}

export const subtitlePlacement = new SubtitlePlacementState();

/** One style seed read: storage per key, the font stringify carried from the
 *  session boot's exact normalization (rule: one owner per read). */
function readStyleValues() {
  return {
    size: getConfigValue(SETTING_KEYS.size, STYLE_DEFAULTS.size),
    color: getConfigValue(SETTING_KEYS.color, STYLE_DEFAULTS.color),
    shadow: getConfigValue(SETTING_KEYS.shadow, STYLE_DEFAULTS.shadow),
    font: String(getConfigValue(SETTING_KEYS.font, STYLE_DEFAULTS.font) || ""),
    stroke: getConfigValue(SETTING_KEYS.stroke, STYLE_DEFAULTS.stroke)
  };
}

/**
 * The cue-style state machine as a per-frame singleton: one owner of the five
 * style values (size/color/shadow/font/stroke) - the panel section's steppers
 * and the session's boot application both read here, with the per-key var
 * mapping this class carries (the applyCue* closures the section used to keep
 * were the second copy of the same math).
 *
 * Like placement: seeds re-read at every bind (a shell rebuild sees newer
 * storage exactly as the per-shell seeds it replaces), and persistence keeps
 * the stepper cadence - one direct write per commit, the stepper quantizes.
 * Binding applies ALL five values to the cue layer: the former boot path
 * covered only font/stroke, which left a stored custom size/color/shadow
 * unapplied until the section built - the two-owner seam this owner closes.
 * Writing the font "" family keeps today's panel-build semantics (the cue
 * style recovers to the stylesheet's inherit through the var, as the section
 * already wrote it on every build).
 */
class SubtitleStyleState {
  /** The five style values; keys mirror the section's control table. */
  #values = readStyleValues();
  /** The bound session; one shell per frame (ShellSlot destroys displaced
   *  shells), so the last bind wins and the previous session dropped its
   *  own signal first. */
  #session = null;
  /** State audience on the shared Fan (the ONE plain-fan-out owner). */
  #audience = new Fan("style");

  /** Control-table key order; the boot apply walks it. */
  static #KEYS = ["size", "color", "shadow", "font", "stroke"];

  value(key) {
    return this.#values[key];
  }

  /**
   * Bind to the shell's session: re-seed from storage, then apply all five
   * values - the boot application, now complete (font/stroke's former
   * partial path rode this same seam). No signal: this state subscribes
   * nothing (the held session ref is the only channel), the commit path is
   * state -> session, like the sync grain's #-tracker.
   */
  bindSession(session) {
    this.#values = readStyleValues();
    this.#session = session;
    for (const key of SubtitleStyleState.#KEYS) {
      this.#apply(key);
    }
  }

  /** One style commit: the persist, the live var, and the fan-out ride one
   *  path (the section's stepper cascades wrote three of these by hand). */
  set(key, value) {
    if (this.#values[key] === value) {
      return;
    }
    this.#values[key] = value;
    setConfigValue(SETTING_KEYS[key], value);
    this.#apply(key);
    this.#emit(key);
  }

  /** Reset to the defaults; per-key equality stops the no-op writes. */
  reset() {
    for (const key of SubtitleStyleState.#KEYS) {
      this.set(key, STYLE_DEFAULTS[key]);
    }
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  #apply(key) {
    const session = this.#session;
    if (!session) {
      return;
    }
    const v = this.#values[key];
    if (key === "size") {
      session.setVar("--pf-cue-font-size", `${v}em`);
    } else if (key === "color") {
      session.setVar("--pf-cue-color", v);
    } else if (key === "shadow") {
      session.setVar("--pf-cue-text-shadow", v
        ? `1px 1px ${Math.round(v / 6)}px rgba(0, 0, 0, ${(0.4 + v / 100 * 0.6).toFixed(2)})`
        : "none");
    } else if (key === "font") {
      session.setVar("--pf-cue-font-family", v);
    } else if (key === "stroke") {
      session.setVar("--pf-cue-stroke", `${v}px`);
    }
  }

  #emit(key) {
    this.#audience.emit({ key, value: this.#values[key] });
  }
}

export const subtitleStyle = new SubtitleStyleState();

/**
 * Subtitle track state for one shell, constructed at boot - not with the
 * panel. Track ownership and the ingest paths (file, URL) must be live before
 * the user ever opens a panel, because a video whose entry remembers a
 * subtitle URL has to bring the track back silently on the next playthrough,
 * and the sync keyboard nudge applies without any panel open.
 *
 * Cue presentation is style-on-the-cue-layer: the vars live on the layer the
 * shell injected once (which survives cue list rebuilds), so setVar
 * is a plain style write whether or not a track exists yet.
 */
export class SubtitleSession {
  #shell;
  #forgeTrack = null;
  #trackMeta = null;
  #cueLayer = null;
  /** The last URL a restore attempted to load. The store notifies on every
   *  save, so without this dedupe a failed (or looping) fetch would be
   *  re-armed on each progress persist. */
  #restoreAttemptedUrl = "";
  #scope = new Scope();
  /** Presentation-state audience on the shared Fan. */
  #audience = new Fan("subtitle-state");

  constructor(shell) {
    this.#shell = shell;
    this.#cueLayer = shell.shellDom?.cueLayer ?? null;
    // Cue placement rides its own singleton state (like the sync grain): the
    // session holds no placement fields - track load reads the state, commits
    // apply live through the bound emit below.
    subtitlePlacement.bindSession(this, this.#scope.signal);
    // Cue style rides its own state: the bind applies ALL five values to the
    // cue layer here (the boot apply - it used to cover only font/stroke,
    // which left a stored custom size/color/shadow unapplied until the panel
    // section built), and every later commit lands live the same way.
    subtitleStyle.bindSession(this);
    // Sync offset rides its own singleton state: every commit rebuilds the
    // shifted cue list (setOffset), load-time application reads the
    // current offset in the same build pass over the base cues.
    subtitleSync.onState((offset) => this.#applySyncOffset(offset), { signal: this.#scope.signal });
    // The restore watch: the store announces only on adoption, so the
    // subscription fires once per entry identity (not per save).
    shell.resume?.onChange?.(() => this.#tryRestore(), { signal: this.#scope.signal });
    this.#tryRestore();
    // Off-screen cue job: captions end with the content they belong to.
    shell.video?.addEventListener("ended", () => this.#forgeTrack?.clear(), {
      signal: this.#scope.signal,
      passive: true
    });
    logger.log("subtitles", `Session ready (${shell.sdk.name})`);
  }

  /** Name of the loaded track, or null with none. */
  get trackName() {
    return this.#trackMeta?.name ?? null;
  }

  /** True while a track owns the cue layer. */
  get active() {
    return !!this.#trackMeta;
  }

  onState(listener, { signal } = {}) {
    return this.#audience.subscribe(listener, { signal });
  }

  /** Cue-layer presentation var; safe with no track (steppers stay disabled
   *  until one loads, so nothing writes early). */
  setVar(prop, value) {
    this.#cueLayer?.style.setProperty(prop, value);
  }

  /** Live placement application. The state is owned by `subtitlePlacement`
   *  entirely - this surface carries no fields, it only forwards to the live
   *  track (track creation applies `subtitlePlacement.current` instead). */
  setPlacement({ line = null, position = null } = {}) {
    this.#forgeTrack?.setPlacement({ line, position });
  }

  async load(file) {
    if (this.#scope.disposed) {
      return;
    }
    try {
      const rawText = await file.text();
      // A file load does not remove the entry's saved URL (still useful next
      // playthrough), but a file TRACK feeds no URL-restore loop either.
      await this.#ingest(file.name, rawText, "");
    } catch (err) {
      this.#fail("load", file.name, err);
    }
  }

  /** Fetch a subtitle file from the web through the manager's xhr. */
  async loadFromUrl(rawUrl) {
    if (this.#scope.disposed) {
      return;
    }
    const url = String(rawUrl || "").trim();
    if (!url) {
      return;
    }
    let response;
    try {
      response = await gmRequestText(url);
    } catch (err) {
      this.#fail("fetch", url, err);
      return;
    }
    try {
      await this.#ingest(this.#nameFromUrl(response.finalUrl || url), response.responseText, url);
    } catch (err) {
      this.#fail("parse", url, err);
    }
  }

  remove() {
    if (this.#scope.disposed) {
      return;
    }
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#trackMeta = null;
    this.#setSubsUrl("");
    // Allow a future identical URL to restore again.
    this.#restoreAttemptedUrl = "";
    this.#notifyListeners();
  }

  async #ingest(name, rawText, savedUrl) {
    if (this.#scope.disposed) {
      return;
    }
    const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    // Content-hash memo: a re-ingest of the same text (rebooted entry's URL,
    // panel re-attach) skips the parse and reuses the same cue array; big
    // multi-megabyte tracks first offload to the worker (see memoizedParse).
    const cues = await memoizedParse(normalizedText);
    // Parsing yields; the session may be destroyed mid-await.
    if (this.#scope.disposed) {
      return;
    }
    if (!cues.length) {
      this.#shell?.toastInfo("captions", "No cues found", "subtitles");
      return;
    }
    if (!this.#forgeTrack) {
      // The shell's ReferenceBox rides along: the renderer anchors its slots
      // to the displayed video picture within the one fill-box identity and
      // re-renders on its change ticks (see ForgeTrack).
      this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer, this.#shell.reference);
      this.#forgeTrack.setPlacement(subtitlePlacement.current);
    }
    this.#trackMeta = { name };
    this.#forgeTrack.load(cues, subtitleSync.offset);
    if (savedUrl !== undefined) {
      this.#setSubsUrl(savedUrl);
    }
    this.#notifyListeners();
    this.#shell?.toastInfo("captions", name, "subtitles");
    logger.log("subtitles", `Loaded ${name}`);
  }

  /** Delivery the watch guard defers to: silence after one attempt per URL. */
  #tryRestore() {
    if (this.#trackMeta) {
      return;
    }
    const url = this.#shell.resume?.subsUrl;
    if (!url || url === this.#restoreAttemptedUrl) {
      return;
    }
    this.#restoreAttemptedUrl = url;
    this.loadFromUrl(url);
  }

  /** Last path segment as a display name, defaulted to .vtt when unknown. */
  #nameFromUrl(url) {
    const parsed = URL.parse(url);
    if (!parsed) {
      return "subtitles.vtt";
    }
    const last = decodeURIComponent(parsed.pathname.split("/").pop() || "");
    if (!last) {
      return "subtitles.vtt";
    }
    return SUBTITLE_EXT_RE.test(last) ? last : `${last}.vtt`;
  }

  #setSubsUrl(url) {
    // Skip-identical in the store: a same-URL loop from the drop-file button
    // would otherwise rewrite the entry (and bump LWW timestamps) per load.
    this.#shell.resume?.setSubsUrl(url);
  }

  #applySyncOffset(offset) {
    if (!this.#scope.disposed) {
      this.#forgeTrack?.setOffset(offset);
    }
  }

  #fail(verb, target, err) {
    logger.error("subtitles", `Failed to ${verb} ${target}:`, err);
    this.#shell?.toastInfo("captions", `Failed to ${verb} subtitles`, "subtitles");
  }

  #notifyListeners() {
    this.#audience.emit(this);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#trackMeta = null;
    this.#cueLayer = null;
  }
}

/**
 * Shell-owned subtitles section (panel): the load buttons, drag-drop target,
 * and the style grids. Track and ingest state lives in SubtitleSession,
 * constructed with the shell; every control here drives it.
 */
export class SubtitlesSection {
  #shell;
  #session;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #styleControls = null;
  #positionControls = null;
  #resetBtn = null;
  #scope = new Scope();

  constructor(shell) {
    this.#shell = shell;
    this.#session = shell.subtitles;
    this.#fileInput = this.#createFileInput(shell);
    this.#buildPanelUi(shell);
    this.#session?.onState(() => this.#refreshHint(), { signal: this.#scope.signal });
    this.#refreshHint();
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#urlButton = null;
    this.#styleControls = null;
    this.#positionControls = null;
    this.#resetBtn = null;
    this.#session = null;
  }

  #buildPanelUi(shell) {
    const panel = shell.panel;
    const panelBody = panel?.body;
    if (!panelBody) {
      return;
    }
    const sectionRoot = panel.addSection("Subtitles", "captions");
    if (!sectionRoot) {
      this.#refreshHint();
      return;
    }
    const dragCounter = { count: 0 };
    const hasFiles = (event) => event.dataTransfer?.types?.includes("Files") ?? false;
    const isSubtitleFile = (file) => SUBTITLE_EXT_RE.test(file?.name || "");
    const { signal } = this.#scope;

    sectionRoot.addEventListener("dragenter", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        dragCounter.count++;
        sectionRoot.classList.add("pf-drop-active");
      }
    }, { signal });
    sectionRoot.addEventListener("dragover", (event) => {
      if (hasFiles(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }
    }, { signal });
    sectionRoot.addEventListener("dragleave", () => {
      dragCounter.count--;
      if (dragCounter.count <= 0) {
        dragCounter.count = 0;
        sectionRoot.classList.remove("pf-drop-active");
      }
    }, { signal });
    sectionRoot.addEventListener("drop", (event) => {
      event.preventDefault();
      dragCounter.count = 0;
      sectionRoot.classList.remove("pf-drop-active");
      const files = [...(event.dataTransfer?.files || [])].filter(isSubtitleFile);
      if (!files.length) {
        shell.toastInfo("captions", "Drop a .srt or .vtt file", "subtitles");
        return;
      }
      for (const file of files) {
        this.#session?.load(file);
      }
    }, { signal });

    // Load row: upload button, remove button, hint text.
    const loadSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const loadRow = panel.el("div", { class: "pf-panel-load-row" }, loadSection);
    const actions = panel.el("div", { class: "pf-panel-actions" }, loadRow);

    this.#loadButton = panel.addControl(actions, {
      type: "button",
      icon: "upload",
      title: "Load subtitles (.srt / .vtt)",
      ariaLabel: "Load subtitles",
      onClick: () => this.#fileInput?.click()
    });

    this.#urlButton = panel.addControl(actions, {
      type: "button",
      icon: "link",
      title: "Load subtitles from URL",
      ariaLabel: "Load subtitles from URL",
      ghost: true,
      onClick: () => this.#promptForUrl()
    });

    this.#removeButton = panel.addControl(actions, {
      type: "button",
      icon: "trash",
      title: "Remove subtitles",
      ariaLabel: "Remove subtitles",
      ghost: true,
      onClick: () => this.#session?.remove()
    });

    this.#hintEl = panel.addHint(loadRow, "Upload your file");

    // Load + Style grid: size / color / shadow / font / stroke / sync.
    const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
    panel.addLabel(styleHead, "Style & Sync");
    const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const sizeStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Size",
      min: 0.6,
      max: 3,
      step: 0.1,
      value: subtitleStyle.value("size"),
      format: fmtEm,
      onChange: (v) => subtitleStyle.set("size", v)
    });

    const colorField = panel.addControl(styleGrid, {
      type: "color",
      label: "Color",
      value: subtitleStyle.value("color"),
      onChange: (hex) => subtitleStyle.set("color", hex)
    });

    const shadowStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Shadow",
      min: 0,
      max: 100,
      step: 5,
      value: subtitleStyle.value("shadow"),
      format: fmtPercentOrOff,
      onChange: (v) => subtitleStyle.set("shadow", v)
    });

    const fontSelect = panel.addControl(styleGrid, {
      type: "select",
      label: "Font",
      options: CUE_FONT_OPTIONS,
      value: subtitleStyle.value("font"),
      onChange: (font) => subtitleStyle.set("font", font)
    });

    const strokeStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Stroke",
      min: 0,
      max: 4,
      step: 0.5,
      value: subtitleStyle.value("stroke"),
      format: (v) => v ? `${v}px` : "Off",
      onChange: (v) => subtitleStyle.set("stroke", v)
    });

    const syncStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Sync",
      min: -SYNC_BOUNDS,
      max: SYNC_BOUNDS,
      step: SYNC_STEP,
      value: subtitleSync.offset,
      format: signedSeconds,
      onChange: (offset) => {
        subtitleSync.set(offset);
      }
    });
    // Nudges that arrive through the keyboard or a menu propagate here - the
    // stepper shows the state even when it was not its own edit that moved it.
    subtitleSync.onState((offset) => syncStepper.setValue(offset), { signal: this.#scope.signal });

    // Caption placement grid: V / H.
    const positionHead = panel.el("div", { class: "pf-panel-section-head" }, sectionRoot);
    panel.addLabel(positionHead, "Position");
    const positionGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, sectionRoot);

    const verticalStepper = panel.addControl(positionGrid, {
      type: "stepper",
      label: "V",
      min: 0,
      max: 100,
      step: 5,
      value: subtitlePlacement.line ?? PLACE_DEFAULTS.line,
      format: fmtPercent,
      onChange: (v) => {
        subtitlePlacement.setLine(v);
      }
    });
    const horizontalStepper = panel.addControl(positionGrid, {
      type: "stepper",
      label: "H",
      min: 0,
      max: 100,
      step: 5,
      value: subtitlePlacement.position ?? PLACE_DEFAULTS.position,
      format: fmtPercent,
      onChange: (v) => {
        subtitlePlacement.setPosition(v);
      }
    });

    this.#styleControls = { size: sizeStepper, color: colorField, shadow: shadowStepper, font: fontSelect, stroke: strokeStepper, sync: syncStepper };
    this.#positionControls = { vertical: verticalStepper, horizontal: horizontalStepper };
    // State display: every commit echoes back into its own controls
    // (including state-driven commits - reset - the cascade no longer
    // drives). The placement display keeps the null split: unset placement
    // still shows the display defaults while the state carries "authored".
    subtitleStyle.onState(({ key, value }) => this.#styleControls?.[key]?.setValue(value), { signal: this.#scope.signal });
    subtitlePlacement.onState((cur) => {
      this.#positionControls.vertical?.setValue(cur.line ?? PLACE_DEFAULTS.line);
      this.#positionControls.horizontal?.setValue(cur.position ?? PLACE_DEFAULTS.position);
    }, { signal: this.#scope.signal });

    this.#resetBtn = panel.addControl(styleHead, {
      type: "button",
      icon: "reload",
      title: "Reset style & sync",
      ariaLabel: "Reset style & sync",
      ghost: true,
      onClick: () => {
        // One write path per state: the style grain resets all five (each
        // control cascades through its own onState echo), the sync grain
        // cascades through its existing stepper subscription, and the
        // placement steppers ride the state the same way.
        subtitleStyle.reset();
        subtitleSync.set(0);
        subtitlePlacement.setLine(PLACE_DEFAULTS.line);
        subtitlePlacement.setPosition(PLACE_DEFAULTS.position);
        flashElement(this.#resetBtn);
        this.#shell?.toastFlash("reload", "Subtitle Style Reset", "subtitles");
      }
    });

    this.#refreshHint();
  }

  #createFileInput(shell) {
    const input = el("input", {
      type: "file",
      accept: SUBTITLE_FILE_ACCEPT,
      style: { display: "none" }
    }, shell.container);
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) {
        this.#session?.load(file);
      }
      input.value = "";
    }, { signal: this.#scope.signal });
    return input;
  }

  #promptForUrl() {
    // The sandbox forwards prompt() to the page; a hostile page can stub it,
    // in which case the dialog misbehaves and file loading stays untouched.
    const url = window.prompt("Subtitle URL (.srt / .vtt)");
    if (url) {
      this.#session?.loadFromUrl(url);
    }
  }

  #refreshHint() {
    const hasTrack = !!this.#session?.active;
    if (this.#hintEl) {
      this.#hintEl.textContent = hasTrack ? this.#session.trackName : "Upload your file";
    }
    if (this.#loadButton) {
      this.#loadButton.disabled = hasTrack;
    }
    if (this.#urlButton) {
      this.#urlButton.disabled = hasTrack;
    }
    if (this.#removeButton) {
      this.#removeButton.disabled = !hasTrack;
    }
    if (this.#styleControls) {
      const disabled = !hasTrack;
      this.#styleControls.size.setDisabled(disabled);
      this.#styleControls.color.input.disabled = disabled;
      this.#styleControls.shadow.setDisabled(disabled);
      this.#styleControls.font.disabled = disabled;
      this.#styleControls.stroke.setDisabled(disabled);
      this.#styleControls.sync.setDisabled(disabled);
    }
    if (this.#positionControls) {
      this.#positionControls.vertical.setDisabled(!hasTrack);
      this.#positionControls.horizontal.setDisabled(!hasTrack);
    }
    if (this.#resetBtn) {
      this.#resetBtn.disabled = !hasTrack;
    }
  }
}
