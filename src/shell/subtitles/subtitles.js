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
import { logger, Scope, debounce } from "../../shared/runtime.js";
import { DOMManager } from "../../shared/dom.js";
import { getConfigValue, setConfigValue, gmRequestText } from "../../shared/store.js";
import { TUNING, fmtPercent, fmtEm, fmtPercentOrOff, signedSeconds } from "../../shared/core.js";
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
 * surrogates, which the VTTCue/USVString sink does for in-band cues anyway).
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

  /** Whether this environment could use a Worker at all (source + surface). */
  available() {
    return (
      workerSource() !== null &&
      typeof globalThis.Worker === "function" &&
      typeof globalThis.Blob === "function" &&
      typeof globalThis.URL?.createObjectURL === "function" &&
      typeof globalThis.URL?.revokeObjectURL === "function"
    );
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

  #reportWorkerJank(data) {
    // LoAF attribution in workers is Chromium 153+; only debug runs warrant
    // the noise - the one-message-per-janky-frame perf channel is the whole
    // debug-story, and only a resident worker ever lives to post it.
    if (logger.enabled) {
      logger.warn(
        "perf",
        `worker LoAF ${data.durationMs}ms (forced style+layout ${data.forcedMs}ms)`
      );
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
    if (data.type === "perf") {
      this.#reportWorkerJank(data);
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
    return new Promise((resolve) => {
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
    });
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

/** Exported for the harness: whether this environment could use a Worker. */
export function workerParseAvailable() {
  return transport.available();
}

/* - Track renderer - */
const STACK_OVERLAP_EM = 1.6;
const MAX_SLOTS = 8;
/** The native TextTrack label this renderer owns; reuse, never append. */
const TRACK_LABEL = "PlayerForge Subtitles";

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
 * Subtitle track backed by the browser's native TextTrack for timing and a
 * custom DOM surface for rendering. The browser owns cue scheduling (fires
 * cuechange at exact enter/exit boundaries), while this class owns the visual
 * output: pooled caption slots, CSS custom-property-based styling, and
 * per-cue stacking for simultaneous lines.
 */
export class ForgeTrack {
  #cueLayer;
  #cueLayerStyle;
  #track;
  #slots = [];
  /** DOM lifecycle manager: cue slot elements auto-removed on destroy. */
  #dom = new DOMManager();
  /** Fixed, shape-stable scratch per slot (pooled, never reallocated on
   *  render); #lastActive mirrors which slots currently hold a live cue so a
   *  `null` entry never needs to be stored. Same discipline as the forge's
   *  pooled scrub payload: mutate in place, read immediately. */
  #lastRender = [];
  #lastActive = [];
  /** Zero-offset cue base the native cues were built from; drives setOffset. */
  #baseCues = null;
  /** Offset already applied to the native cues (setOffset no-ops on a repeat). */
  #offset = 0;
  /** Global placement overrides from the panel's V/H steppers (0-100), or
   *  null to keep each cue's own line/position (default until the user moves
   *  a stepper). Applied per render, so a change re-lays active slots. */
  #lineOverride = null;
  #positionOverride = null;
  /** Records the bound cuechange so destroy can unregister it. */
  #onCueChange = null;
  /** Whether the player is currently on screen. Defaults true so a host
   *  without IntersectionObserver (or before the first observation lands)
   *  renders unconditionally; the observer only ever suppresses off-screen
   *  churn and re-renders on re-entry. */
  #onScreen = true;
  /** Disposal flag; cuechange itself has no signal form (spec-forced). */
  #scope = new Scope();

  constructor(video, cueLayer) {
    this.#cueLayer = cueLayer;
    this.#cueLayerStyle = cueLayer?.style;
    // Preallocate the pooled per-slot scratch now so cuechange renders (the
    // hot subtitle path) stay completely allocation-free.
    for (let i = 0; i < MAX_SLOTS; i++) {
      this.#lastRender[i] = { text: null, top: null, left: null, x: null, prevLine: NaN, prevPosition: NaN, prevI: -1 };
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
    // Reuse a PlayerForge-owned native track instead of calling addTextTrack
    // on every toggle cycle: textTracks is append-only (no spec API removes a
    // track), so a fresh track per load would accumulate leaks across cycles.
    // A page track with this exact label is collision-safe - the renderer owns
    // it exclusively once created.
    const owned = Array.from(video?.textTracks ?? []).find(
      (track) => track.kind === "subtitles" && track.label === TRACK_LABEL
    );
    this.#track = owned ?? video?.addTextTrack?.("subtitles", TRACK_LABEL, "en");
    if (!this.#track) {
      throw new Error("This element cannot host a subtitle track");
    }
    this.#track.mode = "hidden";
    this.#onCueChange = () => {
      this.#render();
    };
    this.#track.addEventListener("cuechange", this.#onCueChange);
    // Off-screen players still fire cuechange; suppress the slot churn until
    // the player is visibly on screen and re-render once when it scrolls back.
    // getBoundingClientRect is the element guard: a non-element videoLike
    // (test double, detached stub) never gets observed.
    if (video && typeof IntersectionObserver === "function" && typeof video.getBoundingClientRect === "function") {
      const observer = new IntersectionObserver(([entry]) => {
        if (this.#scope.disposed) {
          return;
        }
        const was = this.#onScreen;
        this.#onScreen = entry.isIntersecting;
        if (this.#onScreen && !was) {
          this.#render();
        }
      });
      observer.observe(video);
      this.#scope.onDispose(() => observer.disconnect());
    }
  }

  /**
   * Replace all cues on the track. Accepts plain cue objects from forgevtt.
   * `offset` is applied while building, and the plain cues are remembered as
   * the zero-offset base so later sync nudges can shift the native cues in
   * place (see setOffset) instead of draining and rebuilding the list.
   *
   * Cues the old offsetCues()+load() path dropped entirely (shifted end <= 0,
   * i.e. wholly before t=0) are kept as zero-length cues at t=0 instead: they
   * can never satisfy start <= t < end, so they never enter the active set -
   * but keeping every base cue keeps `track.cues` positionally aligned with
   * the base array, which is what lets setOffset walk the two by index.
   */
  load(cues, offset = 0) {
    if (this.#scope.disposed) {
      return;
    }
    const track = this.#track;
    // Drain from the back: the cue list is a live array, so popping the last
    // index avoids shifting the remaining entries on every removal (the
    // front-drain was O(n²) memmove for an n-cue track).
    for (let i = track.cues.length - 1; i >= 0; i--) {
      track.removeCue(track.cues[i]);
    }
    for (const cue of cues) {
      const vtt = new VTTCue(shiftTime(cue.start, offset), shiftTime(cue.end, offset), cue.text);
      vtt.line = cue.line;
      vtt.position = cue.position;
      if (cue.align) {
        vtt.align = cue.align;
      }
      track.addCue(vtt);
    }
    this.#baseCues = cues;
    this.#offset = offset;
  }

  /**
   * Shift every loaded cue by a new sync offset, in place. Two property
   * writes per cue replaces the old full re-offset (n plain objects) plus a
   * drain and rebuild of the native VTTCue list: no intermediate array, no
   * VTTCue construction, no cue-list churn. Every write re-derives from the
   * zero-offset base, so clamping stays exact across a back-and-forth drag
   * (no accumulated drift), and the engine repositions mutated cues itself
   * (Blink's cueWillChange/cueDidChange path re-sorts the cue list and
   * re-inserts into the interval tree), so active-cue scheduling stays
   * correct.
   */
  setOffset(offset) {
    if (this.#scope.disposed || offset === this.#offset) {
      return;
    }
    const base = this.#baseCues;
    const cues = this.#track.cues;
    if (!base) {
      return;
    }
    if (cues.length !== base.length) {
      // Defensive: the list can only diverge if a load raced this call.
      // Rebuild rather than walk a mismatched pairing.
      this.load(base, offset);
      return;
    }
    for (let i = 0; i < base.length; i++) {
      const src = base[i];
      const cue = cues[i];
      // TextTrackCue's writable timing attributes are startTime/endTime - the
      // plain `start`/`end` names only exist on forgevtt's own cue objects.
      // Writing `cue.start` would just create an own data property that
      // shadows nothing: the engine keeps scheduling on the untouched
      // startTime/endTime and activeCues would never move.
      const start = shiftTime(src.start, offset);
      if (cue.startTime !== start) {
        cue.startTime = start;
      }
      const end = shiftTime(src.end, offset);
      if (cue.endTime !== end) {
        cue.endTime = end;
      }
    }
    this.#offset = offset;
  }

  #render() {
    if (this.#scope.disposed || !this.#cueLayer || !this.#onScreen) {
      return;
    }
    const active = this.#track.activeCues;
    const count = Math.min(active.length, MAX_SLOTS);
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
      // per cuechange on the hot subtitle path.
      const lineChanged = line !== prev.prevLine || i !== prev.prevI;
      const positionChanged = position !== prev.prevPosition;
      if (lineChanged) {
        const top = `calc(${line}% - ${i * STACK_OVERLAP_EM}em)`;
        if (prev.top !== top) {
          slot.style.setProperty("--pf-cue-top", top);
        }
        prev.top = top;
        prev.prevLine = line;
        prev.prevI = i;
      }
      if (positionChanged) {
        const left = `${position}%`;
        if (prev.left !== left) {
          slot.style.setProperty("--pf-cue-left", left);
        }
        prev.left = left;
        prev.prevPosition = position;
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

  clear() {
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
    // Unregister our native cuechange listener: the track survives (the spec
    // has no removal API) and would otherwise keep firing this renderer's
    // slot-node logic against a torn-down pool forever.
    this.#track.removeEventListener?.("cuechange", this.#onCueChange);
    this.#track.mode = "disabled";
    while (this.#track.cues.length > 0) {
      this.#track.removeCue(this.#track.cues[0]);
    }
    // DOMManager removes all cue slot elements.
    this.#dom.destroy();
    this.#slots = [];
    this.#lastActive = [];
    this.#baseCues = null;
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
  line: "subtitles.position.line",
  horizontal: "subtitles.position.horizontal",
  syncOffset: "subtitles.sync.offset"
};

/**
 * Shell-owned subtitles section: loads .srt/.vtt files onto a video and renders
 * cues through the shell's cue layer, with caption styling, manual positioning,
 * and sync offset.
 */
export class SubtitlesSection {
  #shell;
  #forgeTrack = null;
  #trackMeta = null;
  /** Cue layer the shell owns; ForgeTrack renders its slots here. */
  #cueLayer = null;
  /** Sync offset currently in effect; applied by ForgeTrack at load time. */
  #syncOffset = 0;
  /** Stored V/H placement overrides (0-100) or null until first customized;
   *  applied to the track on load and on every stepper change. */
  #cueLine = null;
  #cuePosition = null;
  #fileInput = null;
  #hintEl = null;
  #loadButton = null;
  #removeButton = null;
  #urlButton = null;
  #styleControls = null;
  #positionControls = null;
  #resetBtn = null;
  /** Debounced sync-offset apply; cancelled on destroy so no trailing write lands. */
  #scheduleSyncOffset = null;
  #scope = new Scope();

  constructor(shell) {
    this.#shell = shell;
    this.#syncOffset = Number(getConfigValue(SETTING_KEYS.syncOffset, 0)) || 0;
    const storedLine = Number(getConfigValue(SETTING_KEYS.line, null));
    const storedPos = Number(getConfigValue(SETTING_KEYS.horizontal, null));
    this.#cueLine = Number.isFinite(storedLine) ? storedLine : null;
    this.#cuePosition = Number.isFinite(storedPos) ? storedPos : null;
    this.#cueLayer = shell.shellDom?.cueLayer || null;
    this.#fileInput = this.#createFileInput(shell);
    this.#buildPanelUi(shell);
    this.#startListening();
    logger.log("subtitles", `Ready (${shell.sdk.name})`);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#scope.dispose();
    this.#scheduleSyncOffset?.cancel();
    this.#scheduleSyncOffset = null;
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#hintEl = null;
    this.#loadButton = null;
    this.#removeButton = null;
    this.#urlButton = null;
    this.#styleControls = null;
    this.#positionControls = null;
    this.#resetBtn = null;
    this.#trackMeta = null;
    this.#cueLayer = null;
  }

  #startListening() {
    const { signal } = this.#scope;
    const video = this.#shell.video;
    video?.addEventListener("ended", () => this.#forgeTrack?.clear(), { signal, passive: true });
  }

  #buildPanelUi(shell) {
    const panel = shell.panel;
    const panelBody = panel?.body;
    if (!panelBody) {
      return;
    }
    const sectionRoot = panel.addSection("Subtitles", "captions");
    if (!sectionRoot) {
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
        this.#toastInfo("captions", "Drop a .srt or .vtt file", "subtitles");
        return;
      }
      for (const file of files) {
        this.load(file);
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
      onClick: () => this.#removeTrack()
    });

    this.#hintEl = panel.addHint(loadRow, "Upload your file");

    // Caption style + position grid: size / color / shadow / sync / V / H.
    const styleSection = panel.el("div", { class: "pf-panel-section" }, sectionRoot);
    const styleHead = panel.el("div", { class: "pf-panel-section-head" }, styleSection);
    panel.addLabel(styleHead, "Style & Position");
    const styleGrid = panel.el("div", { class: "pf-panel-grid pf-panel-grid-compact" }, styleSection);

    const applyCueSize = (v) => this.#setCueVar("--pf-cue-font-size", `${v}em`);
    const sizeStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Size",
      min: 0.6,
      max: 3,
      step: 0.1,
      value: getConfigValue(SETTING_KEYS.size, 1.2),
      format: fmtEm,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.size, v);
        applyCueSize(v);
      }
    });
    applyCueSize(sizeStepper.getValue());

    const colorField = panel.addControl(styleGrid, {
      type: "color",
      label: "Color",
      value: getConfigValue(SETTING_KEYS.color, "#ffffff"),
      onChange: (hex) => {
        setConfigValue(SETTING_KEYS.color, hex);
        this.#setCueVar("--pf-cue-color", hex);
      }
    });
    this.#setCueVar("--pf-cue-color", colorField.getValue());

    const applyCueShadow = (strength) => this.#setCueVar("--pf-cue-text-shadow", strength
      ? `1px 1px ${Math.round(strength / 6)}px rgba(0, 0, 0, ${(0.4 + strength / 100 * 0.6).toFixed(2)})`
      : "none");
    const shadowStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Shadow",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.shadow, 40),
      format: fmtPercentOrOff,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.shadow, v);
        applyCueShadow(v);
      }
    });
    applyCueShadow(shadowStepper.getValue());

    this.#scheduleSyncOffset = debounce((offset) => {
      if (this.#trackMeta) {
        // Re-offset the loaded cues in place: two property writes per native
        // cue instead of a full re-offset (n plain objects) plus a drain and
        // rebuild of the track's VTTCue list.
        this.#forgeTrack?.setOffset(offset);
      }
      setConfigValue(SETTING_KEYS.syncOffset, offset);
    }, TUNING.subtitles.syncDebounceMs);
    const syncStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "Sync",
      min: -20,
      max: 20,
      step: 0.25,
      value: this.#syncOffset,
      format: signedSeconds,
      onChange: (offset) => {
        this.#syncOffset = offset;
        this.#scheduleSyncOffset(offset);
      }
    });

    const verticalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "V",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.line, 85),
      format: fmtPercent,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.line, v);
        this.#cueLine = v;
        this.#applyPlacement();
      }
    });
    const horizontalStepper = panel.addControl(styleGrid, {
      type: "stepper",
      label: "H",
      min: 0,
      max: 100,
      step: 5,
      value: getConfigValue(SETTING_KEYS.horizontal, 50),
      format: fmtPercent,
      onChange: (v) => {
        setConfigValue(SETTING_KEYS.horizontal, v);
        this.#cuePosition = v;
        this.#applyPlacement();
      }
    });

    this.#styleControls = { size: sizeStepper, color: colorField, shadow: shadowStepper, sync: syncStepper };
    this.#positionControls = { vertical: verticalStepper, horizontal: horizontalStepper };

    this.#resetBtn = panel.addControl(styleHead, {
      type: "button",
      icon: "reload",
      title: "Reset all",
      ariaLabel: "Reset all",
      ghost: true,
      onClick: () => {
        sizeStepper.setValue(1.2);
        colorField.setValue("#ffffff");
        shadowStepper.setValue(40);
        syncStepper.setValue(0);
        verticalStepper.setValue(85);
        horizontalStepper.setValue(50);
        flashElement(this.#resetBtn);
        this.#shell?.toastFlash("reload", "Subtitle Style Reset", "subtitles");
      }
    });

    this.#refreshHint();
  }

  #setCueVar(prop, value) {
    this.#forgeTrack?.setVar(prop, value);
  }

  /** Push the stored V/H overrides onto the live track (no-op without one -
   *  track creation applies them at load time instead). */
  #applyPlacement() {
    this.#forgeTrack?.setPlacement({ line: this.#cueLine, position: this.#cuePosition });
  }

  #toastInfo(icon, text, group) {
    this.#shell?.toastInfo(icon, text, group);
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
        this.load(file);
      }
      input.value = "";
    }, { signal: this.#scope.signal });
    return input;
  }

  async load(file) {
    if (this.#scope.disposed) {
      return;
    }
    try {
      const rawText = await file.text();
      await this.#ingest(file.name, rawText);
    } catch (err) {
      this.#handleLoadError("load", file.name, err);
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
      this.#handleLoadError("fetch", url, err);
      return;
    }
    try {
      await this.#ingest(this.#nameFromUrl(response.finalUrl || url), response.responseText);
    } catch (err) {
      this.#handleLoadError("parse", url, err);
    }
  }

  #handleLoadError(verb, target, err) {
    logger.error("subtitles", `Failed to ${verb} ${target}:`, err);
    this.#toastInfo("captions", `Failed to ${verb} subtitles`, "subtitles");
  }

  #promptForUrl() {
    // The sandbox forwards prompt() to the page; a hostile page can stub it,
    // in which case the dialog misbehaves and file loading stays untouched.
    const url = window.prompt("Subtitle URL (.srt / .vtt)");
    if (url) {
      this.loadFromUrl(url);
    }
  }

  /** Last path segment as a display name, defaulted to .vtt when unknown. */
  #nameFromUrl(url) {
    if (!URL.canParse(url)) {
      return "subtitles.vtt";
    }
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    if (!last) {
      return "subtitles.vtt";
    }
    return SUBTITLE_EXT_RE.test(last) ? last : `${last}.vtt`;
  }

  async #ingest(name, rawText) {
    if (this.#scope.disposed) {
      return;
    }
    const normalizedText = /\.srt$/i.test(name) ? srtToVtt(rawText) : ensureVttHeader(rawText);
    // Cooperative parse: yields to the browser on large tracks so ingesting a
    // big VTT never blocks playback (see forgevtt.parseSubtitlesAsync), and
    // offloads multi-megabyte tracks to a dedicated Worker. The cues are
    // loaded at the current sync offset in a single build pass; later sync
    // nudges shift the native cues in place (ForgeTrack.setOffset).
    const cues = await parseSubtitlesAsync(normalizedText, 0);
    // Cooperative parse yields to the browser; the section may have been torn
    // down mid-await, so re-check before touching the track/slots.
    if (this.#scope.disposed) {
      return;
    }
    if (!cues.length) {
      this.#toastInfo("captions", "No cues found", "subtitles");
      return;
    }
    if (!this.#forgeTrack) {
      this.#forgeTrack = new ForgeTrack(this.#shell.video, this.#cueLayer);
      this.#applyPlacement();
    }
    this.#trackMeta = { name };
    this.#forgeTrack.load(cues, this.#syncOffset);
    this.#refreshHint();
    this.#toastInfo("captions", name, "subtitles");
    logger.log("subtitles", `Loaded ${name}`);
  }

  #refreshHint() {
    if (this.#hintEl) {
      this.#hintEl.textContent = this.#trackMeta ? this.#trackMeta.name : "Upload your file";
    }
    const hasTrack = !!this.#trackMeta;
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

  #removeTrack() {
    this.#forgeTrack?.destroy();
    this.#forgeTrack = null;
    this.#trackMeta = null;
    this.#refreshHint();
  }
}
