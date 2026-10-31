/**
 * Long-lived dedicated Worker that owns large subtitle parses.
 *
 * The parse engine is this package's source of truth - forgevtt.js is bundled
 * straight in, so the worker can never drift from the main-thread parser. The
 * worker is spawned once per page (vtt-worker-loader.js keeps it resident) and
 * handles every large ingest in message order, so the renderer thread never
 * pays for the multi-megabyte parse of a .srt/.vtt mid-playback.
 *
 * Transport is bytes, both directions: the request arrives as a transferred
 * UTF-8 buffer (TextDecoder, no string structured-clone) and the result goes
 * back as a packed frame - two transferable Float64Arrays (start/end and
 * line/position) plus two cloned arrays (texts, aligns) - instead of a clone
 * of thousands of cue objects, which measures ~3x more expensive for a
 * 5000-cue track.
 *
 * Chromium 153 extends Long Animation Frames to workers, but probed live on
 * the 159 floor, Firefox ships the worker entry type in neither realm where
 * this chunk runs - the former perf-diag channel is retired: a diagnostic
 * that could never fire on the only shipping platform was dead weight, and
 * a return would be a redesign decision with its own measurement. No GM_*
 * grants exist in a Worker - this file stays pure.
 */
import { parseSubtitles } from "./forgevtt.js";

const DECODER = new TextDecoder();

/**
 * Flatten cues into the wire frame: numeric fields land in two interleaved
 * Float64Arrays (exact round-trip, transferred zero-copy), text-bearing fields
 * stay as arrays of primitives (structured-cloned, but two flat arrays instead
 * of one object graph). Order is already sorted by the engine and preserved.
 */
function packCues(cues) {
  const n = cues.length;
  const times = new Float64Array(n * 2);
  const nums = new Float64Array(n * 2);
  const texts = new Array(n);
  const aligns = new Array(n);
  for (let i = 0; i < n; i++) {
    const cue = cues[i];
    const j = i * 2;
    times[j] = cue.start;
    times[j + 1] = cue.end;
    nums[j] = cue.line;
    nums[j + 1] = cue.position;
    texts[i] = cue.text;
    aligns[i] = cue.align;
  }
  return { times, nums, texts, aligns };
}

self.onmessage = (event) => {
  const { id, bytes } = event.data ?? {};
  if (typeof id !== "number" || !(bytes instanceof Uint8Array)) {
    return;
  }
  try {
    const cues = parseSubtitles(DECODER.decode(bytes), 0);
    const { times, nums, texts, aligns } = packCues(cues);
    self.postMessage(
      { pfWorker: 1, id, times, nums, texts, aligns },
      [times.buffer, nums.buffer]
    );
  } catch (err) {
    // The caller falls back to an in-band cooperative parse on any worker
    // error, so a hostile cue payload never takes subtitles down.
    self.postMessage({
      pfWorker: 1,
      id,
      error: String((err && err.message) || err)
    });
  }
};
