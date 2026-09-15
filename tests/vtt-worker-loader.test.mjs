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
      target: ["chrome150"],
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

test("worker path: fake Worker, size/offset gating, cleanup, error fallback", async () => {
  const realWorker = globalThis.Worker;
  const realCreateObjectURL = globalThis.URL.createObjectURL;
  const realRevokeObjectURL = globalThis.URL.revokeObjectURL;

  let created = 0;
  let terminated = 0;
  let revoked = 0;
  let blobCapture = null;

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
    #script = null;
    #self = null;
    constructor() {
      created += 1;
    }
    set onmessage(fn) {
      this.#handlers.message = fn;
    }
    set onerror(fn) {
      this.#handlers.error = fn;
    }
    postMessage(payload) {
      // Classic-worker semantics: compile the script once (registering
      // self.onmessage), then deliver the caller's message to it.
      (async () => {
        if (this.#script === null) {
          this.#script = await blobCapture.text();
          this.#self = {
            postMessage: (msg) => this.#handlers.message({ data: msg })
          };
          // eslint-disable-next-line no-new-func
          Function("self", this.#script)(this.#self);
        }
        this.#self.onmessage({ data: payload });
      })();
    }
    terminate() {
      terminated += 1;
    }
  }
  globalThis.Worker = FakeWorker;

  try {
    // Size gate: small tracks never spawn a worker.
    const small = await parseSubtitlesAsync(VTT, 0);
    assert.deepEqual(small, parseSubtitles(VTT));
    assert.equal(created, 0);

    // Offset gate applies even when forced through the worker path.
    const shifted = await parseSubtitlesAsync(VTT, 2, true);
    assert.deepEqual(shifted, parseSubtitles(VTT, 2));
    assert.equal(created, 0);

    // Forced worker parse: identical cues, full cleanup of Worker + blob URL.
    const workerCues = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(workerCues, parseSubtitles(VTT));
    assert.equal(created, 1);
    // The loader defers termination by one macrotask so the worker's trailing
    // perf message lands first - flush the loop before asserting cleanup ran.
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(terminated, 1);
    assert.equal(revoked, 1);

    // A worker that dies on construction (page CSP) falls back to in-band
    // with no leak of the object URL.
    globalThis.Worker = class FailingWorker {
      constructor() {
        created += 1;
        throw new Error("blob worker blocked by CSP");
      }
    };
    const failing = await parseSubtitlesAsync(VTT, 0, true);
    assert.deepEqual(failing, parseSubtitles(VTT));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(created, 2);
    assert.equal(revoked, 2);
  } finally {
    delete globalThis.__VTT_WORKER_SOURCE__;
    globalThis.Worker = realWorker;
    globalThis.URL.createObjectURL = realCreateObjectURL;
    globalThis.URL.revokeObjectURL = realRevokeObjectURL;
  }
});