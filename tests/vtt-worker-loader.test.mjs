import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  parseSubtitlesAsync,
  workerParseAvailable
} from "../src/shell/subtitles/vtt-worker-loader.js";
import { parseSubtitles } from "../src/shell/subtitles/forgevtt.js";

const VTT = [
  "WEBVTT",
  "",
  "NOTE a comment",
  "",
  "00:00:01.000 --> 00:00:02.000",
  "first &amp; foremost",
  "",
  "00:00:03.000 --> 00:00:04.000 line:10% position:25% align:start",
  "second"
].join("\n");

// The harness loads the loader module directly (no esbuild defines), so the
// worker chunk is unavailable by default and the loader stays in-band. This
// builds the real vtt-worker.js entry the same way esbuild.config.mjs does,
// so the fake-worker test below exercises the shipped worker, not a copy.
let workerChunkText = null;
async function workerChunk() {
  if (workerChunkText === null) {
    const result = await build({
      entryPoints: ["src/shell/subtitles/vtt-worker.js"],
      bundle: true,
      format: "iife",
      target: ["firefox156"],
      minify: true,
      write: false,
      logLevel: "silent"
    });
    workerChunkText = result.outputFiles[0].text;
  }
  return workerChunkText;
}

test("under Node (no Worker global) the loader is in-band and matches the engine", async () => {
  assert.equal(workerParseAvailable(), false);
  const cues = await parseSubtitlesAsync(VTT, 0);
  assert.deepEqual(cues, parseSubtitles(VTT));
});

test("resident worker: byte transport, packed cues, reuse, queueing, crash/CSP fallback", async () => {
  const realWorker = globalThis.Worker;
  const realCreateObjectURL = globalThis.URL.createObjectURL;
  const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

  let created = 0;
  let terminated = 0;
  let revoked = 0;
  let blobCapture = null;
  let lastWorker = null;

  // Arm the loader with the real, esbuild-bundled worker chunk (production
  // gets it via the __VTT_WORKER_SOURCE__ define).
  globalThis.__VTT_WORKER_SOURCE__ = await workerChunk();

  // Emulate the Worker/host surface the loader guards on so the worker branch
  // is reachable under Node. The fake classic worker executes the blob script
  // with a minimal `self` and routes postMessage back to the loader handler.
  globalThis.URL.createObjectURL = (blob) => {
    blobCapture = blob;
    return "blob:fake-vtt";
  };
  globalThis.URL.revokeObjectURL = () => {
    revoked += 1;
  };
  class FakeWorker {
    #handlers = { message: null, error: null };
    #self = null;
    #scriptReady = null;
    #dead = false;
    constructor() {
      created += 1;
      lastWorker = this;
    }
    set onmessage(fn) {
      this.#handlers.message = fn;
    }
    set onerror(fn) {
      this.#handlers.error = fn;
    }
    postMessage(payload) {
      // Classic-worker semantics: compile the script once (registering
      // self.onmessage), then deliver each caller message to it in order.
      this.#scriptReady ??= blobCapture.text().then((script) => {
        this.#self = {
          postMessage: (msg) => {
            if (!this.#dead) {
              this.#handlers.message?.({ data: msg });
            }
          }
        };
        // eslint-disable-next-line no-new-func
        Function("self", script)(this.#self);
      });
      this.#scriptReady.then(() => {
        if (!this.#dead) {
          this.#self.onmessage({ data: payload });
        }
      });
    }
    terminate() {
      this.#dead = true;
      terminated += 1;
    }
    triggerError() {
      this.#handlers.error?.(new Error("worker crashed"));
    }
  }
  globalThis.Worker = FakeWorker;

  // Large enough to pass the production size gate (WORKER_MIN_CHARS) with
  // thousands of cues, so the packed-frame round trip is exercised at scale.
  function buildBigVtt(cueCount) {
    const blocks = [];
    for (let i = 0; i < cueCount; i++) {
      const m = String(Math.floor(i / 60)).padStart(2, "0");
      const s = String(i % 60).padStart(2, "0");
      blocks.push(
        `00:${m}:${s}.000 --> 00:${m}:${s}.500 line:85\nCue number ${i} with some &amp; entity text and <b>tags</b> here`
      );
    }
    return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
  }

  try {
    // Size gate: small tracks never spawn a worker.
    const small = await parseSubtitlesAsync(VTT, 0);
    assert.deepEqual(small, parseSubtitles(VTT));
    assert.equal(created, 0);

    // Offset gate applies even when forced through the worker path.
    const shifted = await parseSubtitlesAsync(VTT, 2, true);
    assert.deepEqual(shifted, parseSubtitles(VTT, 2));
    assert.equal(created, 0);

    // Forced worker parse: identical cues via the packed frame (numbers,
    // strings and align round-trip exactly), worker stays resident with its
    // object URL (revoked only when the worker dies).
    const workerCues = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(workerCues, parseSubtitles(VTT));
    assert.equal(created, 1);
    assert.equal(terminated, 0);
    assert.equal(revoked, 0);

    // Reuse: a second parse rides the resident worker - no respawn, no
    // per-load blob/compile/terminate.
    const again = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(again, parseSubtitles(VTT));
    assert.equal(created, 1);

    // Empty result packs/unpacks as an empty frame.
    const empty = await parseSubtitlesAsync("WEBVTT\n", 0, true);
    assert.deepEqual(empty, parseSubtitles("WEBVTT\n"));
    assert.equal(created, 1);

    // Concurrent ingests queue in the worker's message loop (no single-flight
    // degradation to the main thread) and settle independently.
    const [first, second] = await Promise.all([
      parseSubtitlesAsync(VTT, 0, true),
      parseSubtitlesAsync(VTT, 0, true)
    ]);
    assert.deepEqual(first, parseSubtitles(VTT));
    assert.deepEqual(second, parseSubtitles(VTT));
    assert.equal(created, 1);

    // Natural (not forced) spawn path: a track over the production size gate
    // rides the already-resident worker; the big packed round trip must
    // match the engine cue-for-cue.
    const bigVtt = buildBigVtt(5200);
    assert.ok(bigVtt.length >= 1 << 19, "fixture clears WORKER_MIN_CHARS");
    const bigCues = await parseSubtitlesAsync(bigVtt, 0);
    assert.equal(bigCues.length, 5200);
    assert.deepEqual(bigCues, parseSubtitles(bigVtt));

    // A worker crash settles the in-flight request in-band (matching cues),
    // tears the dead worker down, and the next ingest respawns fresh.
    const crashing = parseSubtitlesAsync(VTT, 0, true);
    lastWorker.triggerError();
    const recovered = await crashing;
    assert.deepEqual(recovered, parseSubtitles(VTT));
    assert.equal(terminated, 1);
    assert.equal(revoked, 1);
    const afterCrash = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(afterCrash, parseSubtitles(VTT));
    assert.equal(created, 2);

    // A worker that dies on construction (page CSP) falls back in-band with
    // no leak of the object URL, and the failure latches: later ingests
    // never re-attempt the blocked spawn. The resident worker must be gone
    // first - while it lives, reuse rightly bypasses the spawn entirely.
    lastWorker.triggerError();
    assert.equal(terminated, 2);
    assert.equal(revoked, 2);
    globalThis.Worker = class FailingWorker {
      constructor() {
        created += 1;
        throw new Error("blob worker blocked by CSP");
      }
    };
    const failing = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(failing, parseSubtitles(VTT));
    assert.equal(created, 3);
    assert.equal(revoked, 3);
    const latched = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(latched, parseSubtitles(VTT));
    assert.equal(created, 3, "CSP failure latched - no retry spawn");
    assert.equal(revoked, 3);
  } finally {
    delete globalThis.__VTT_WORKER_SOURCE__;
    globalThis.Worker = realWorker;
    globalThis.URL.createObjectURL = realCreateObjectURL;
    globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  }
});
