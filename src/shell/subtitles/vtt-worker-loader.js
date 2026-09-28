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
import { parseSubtitlesAsync as parseInBand } from "./forgevtt.js";
import { logger } from "../../shared/logger.js";

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

let worker = null;
let workerUrl = null;
/** CSP-blocked pages never gain a Worker - latch so each ingest doesn't re-pay the failed spawn. */
let workerBroken = false;
let requestSeq = 0;
/**
 * In-flight requests by id. The worker processes messages in order, so this
 * is the whole concurrency story: no busy flag, no queue of our own - a
 * second large ingest waits on the worker's loop instead of degrading to the
 * main thread.
 * Each entry: { resolve, fallback } - fallback re-runs the cooperative
 * in-band parse with this request's own text.
 */
const pending = new Map();

function workerCapable() {
  return (
    workerSource() !== null &&
    typeof globalThis.Worker === "function" &&
    typeof globalThis.Blob === "function" &&
    typeof globalThis.URL?.createObjectURL === "function" &&
    typeof globalThis.URL?.revokeObjectURL === "function"
  );
}

/** Spawn the resident worker once; null when unavailable or CSP-latched. */
function ensureWorker() {
  if (worker !== null) {
    return worker;
  }
  if (workerBroken) {
    return null;
  }
  let url = null;
  try {
    url = globalThis.URL.createObjectURL(
      new globalThis.Blob([workerSource()], { type: "text/javascript" })
    );
    // Pages with a worker-src CSP block blob Workers by throwing here; the
    // blob URL must be revoked before the synchronous throw escapes, or every
    // blocked load would leak one URL.
    worker = new globalThis.Worker(url, { name: "playerforge-vtt" });
  } catch (err) {
    if (url !== null) {
      globalThis.URL.revokeObjectURL(url);
    }
    workerBroken = true;
    logger.warn("subtitles", "Blob worker blocked (page CSP?), staying in-band", err);
    return null;
  }
  workerUrl = url;
  worker.onmessage = onWorkerMessage;
  worker.onerror = onWorkerError;
  return worker;
}

/**
 * Tear down the resident worker and settle every in-flight request through
 * its in-band fallback. Called on a worker crash or when a request's
 * watchdog fires (a hung worker would otherwise wedge every later ingest);
 * the next eligible parse respawns fresh.
 */
function killWorker() {
  const inflight = [...pending.values()];
  pending.clear();
  const doomed = worker;
  worker = null;
  if (doomed !== null) {
    doomed.onmessage = null;
    doomed.onerror = null;
    doomed.terminate();
    globalThis.URL.revokeObjectURL(workerUrl);
    workerUrl = null;
  }
  for (const entry of inflight) {
    entry.fallback();
  }
}

function onWorkerError() {
  killWorker();
}

function reportWorkerJank(data) {
  // LoAF attribution in workers exists only on hosts that ship it (not
  // Firefox); only debug runs warrant the
  // noise - the one-message-per-janky-frame perf channel is the whole
  // debug-story, and only a resident worker ever lives to post it.
  if (logger.enabled) {
    logger.warn(
      "perf",
      `worker LoAF ${data.durationMs}ms (forced style+layout ${data.forcedMs}ms)`
    );
  }
}

/** Rebuild cue objects from the worker's packed frame (engine field order). */
function unpackCues(data) {
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

function onWorkerMessage(event) {
  const data = event.data ?? {};
  if (data.pfWorker !== 1) {
    return;
  }
  if (data.type === "perf") {
    reportWorkerJank(data);
    return;
  }
  const entry = pending.get(data.id);
  if (entry === undefined) {
    // Already settled (watchdog/crash) or a foreign message - never let a
    // stale reply resolve a request that already fell back.
    return;
  }
  pending.delete(data.id);
  if (data.error !== undefined || !(data.times instanceof Float64Array)) {
    entry.fallback();
    return;
  }
  entry.resolve(unpackCues(data));
}

function runInWorker(w, text) {
  const id = ++requestSeq;
  return new Promise((resolve) => {
    pending.set(id, {
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
        if (pending.has(id)) {
          killWorker();
        }
      },
      { once: true }
    );
    try {
      const bytes = ENCODER.encode(text);
      w.postMessage({ pfWorker: 1, id, bytes }, [bytes.buffer]);
    } catch (err) {
      const entry = pending.get(id);
      if (entry !== undefined) {
        pending.delete(id);
        entry.fallback();
      }
      logger.warn("subtitles", "Worker postMessage failed, falling back in-band", err);
    }
  });
}

/**
 * Cooperative subtitle parse, offloaded to a dedicated Worker only when the
 * track is large enough to make the round trip worthwhile and a Worker is
 * available. `throughWorker` is a test/tune knob that bypasses the size gate;
 * production callers never pass it.
 */
export async function parseSubtitlesAsync(text, offset = 0, throughWorker = false) {
  const eligible =
    offset === 0 &&
    workerCapable() &&
    (throughWorker || text.length >= WORKER_MIN_CHARS);
  if (!eligible) {
    return parseInBand(text, offset);
  }
  const w = ensureWorker();
  if (w === null) {
    return parseInBand(text, offset);
  }
  return runInWorker(w, text);
}

/** Exported for the harness: whether this environment could use a Worker. */
export function workerParseAvailable() {
  return workerCapable();
}
