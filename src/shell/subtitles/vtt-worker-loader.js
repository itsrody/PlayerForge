/**
 * Threshold-gated subtitle parse offloader.
 *
 * Subtitle ingests for tiny tracks stay on the main thread: spawning a Worker,
 * structured-cloning a megabyte of text out, and cloning the cue array back
 * costs more than the parse itself. Only large loads earn the round trip - the
 * renderer thread never eats a multi-megabyte normalize/split/regex storm
*  mid-playback (dedicated workers, where the parse just runs).
 *
 * Every failure mode - no Worker, page CSP blocking blob workers, the parse
 * throwing in the worker, a hung worker, teardown mid-await - degrades to the
 * cooperative in-band parse (forgevtt.parseSubtitlesAsync), so the worker is
 * strictly an optimization and the two paths can never produce different cues
 * for the same text: they share the same engine.
 *
 * The worker chunk is injected at build time by esbuild (define
 * __VTT_WORKER_SOURCE__). Keeping this module loadable by the Node test
 * harness is worth one trade-off: esbuild substitutes the identifier into the
 * typeof guard too, so the ~3KB chunk is embedded twice in the minified
 * bundle (~2.5%) - never worth splitting the parser for.
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

let workerBusy = false;
let requestSeq = 0;

function workerCapable() {
  return (
    workerSource() !== null &&
    typeof globalThis.Worker === "function" &&
    typeof globalThis.Blob === "function" &&
    typeof globalThis.URL?.createObjectURL === "function" &&
    typeof globalThis.URL?.revokeObjectURL === "function"
  );
}

function reportWorkerJank(data) {
  // LoAF attribution in workers is Chromium 153+; only debug runs warrant the
  // noise - the one-per-load perf message is the whole debug-story.
  if (logger.enabled) {
    logger.warn(
      "perf",
      `worker LoAF ${data.durationMs}ms (forced style+layout ${data.forcedMs}ms)`
    );
  }
}

function runInWorker(text) {
  const requestId = ++requestSeq;
  const objectUrl = globalThis.URL.createObjectURL(
    new globalThis.Blob([workerSource()], { type: "text/javascript" })
  );
  let worker;
  try {
    // Pages with a worker-src CSP block blob Workers by throwing here; the
    // blob URL must be revoked before the synchronous throw escapes, or every
    // blocked load would leak one URL.
    worker = new globalThis.Worker(objectUrl, { name: "playerforge-vtt" });
  } catch (err) {
    globalThis.URL.revokeObjectURL(objectUrl);
    throw err;
  }
  workerBusy = true;

  return new Promise((resolve) => {
    let settled = false;
    let watchTimer = 0;

    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      workerBusy = false;
      clearTimeout(watchTimer);
      worker.terminate();
      globalThis.URL.revokeObjectURL(objectUrl);
    };

    // Worker death (spawn error, page CSP, uncaught throw) is never fatal:
    // hand the text back to the cooperative in-band parser and keep the
    // exact same signature/result shape the caller expects.
    const fallback = () => {
      cleanup();
      parseInBand(text).then(resolve);
    };

    watchTimer = setTimeout(fallback, WORKER_TIMEOUT_MS);

    worker.onerror = () => fallback();

    worker.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.pfWorker !== 1 || data.id !== requestId) {
        return;
      }
      if (data.type === "perf") {
        reportWorkerJank(data);
        return;
      }
      if (data.error) {
        fallback();
        return;
      }
      const cues = data.cues;
      // Defer termination by one macrotask so the worker's trailing perf
      // message (posted right after the cues) lands and gets logged first;
      // termination always runs, no matter what.
      setTimeout(cleanup, 0);
      resolve(cues);
    };

    worker.postMessage({ id: requestId, text });
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
    !workerBusy &&
    (throughWorker || text.length >= WORKER_MIN_CHARS);
  if (!eligible) {
    return parseInBand(text, offset);
  }
  try {
    return await runInWorker(text);
  } catch (err) {
    // Never fail a track load because the worker path hiccuped.
    logger.warn("subtitles", "Worker parse failed, falling back in-band", err);
    return parseInBand(text, offset);
  }
}

/** Exported for the harness: whether this environment could use a Worker. */
export function workerParseAvailable() {
  return workerCapable();
}