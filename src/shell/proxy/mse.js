/**
 * MSE sink (§7.2).
 *
 * One MediaSource per <video>, one SourceBuffer lane per mime type, appended
 * in strict sequence order with optional appendWindowStart/End for accurate
 * seeking, and `updating`/buffer.full backpressure. Only cleartext bytes ever
 * reach appendBuffer — the SegmentManager decrypts (or passes through
 * unencrypted) before handing data here.
 *
 * The sink is deterministic-testable: MediaSource/URL and the scheduler are
 * injectable seams, so the append chain, ordering guard, and teardown are
 * exercised headlessly without a real MSE stack.
 */
import { logger } from "../../shared/logger.js";
import { SegmentError } from "./segment-manager.js";

export class MSEFactory {
  /**
   * @param {object} [seams]
   * @param {object} [seams.mediaSource]      MediaSource class/constructor (browser default).
   * @param {Function} [seams.createObjectURL]  (ms) => string (default URL.createObjectURL).
   * @param {Function} [seams.revokeObjectURL]  (url) => void (default URL.revokeObjectURL).
   * @param {Function} [seams.isTypeSupported] (mime) => boolean - mime the
   *                                    engine can demux (default the injected
   *                                    MediaSource's static / native static).
   * @param {Function} [seams.delay]            (ms) => Promise — backpressure wait (default setTimeout).
   */
  constructor({ mediaSource = globalThis.MediaSource, createObjectURL, revokeObjectURL, delay, isTypeSupported } = {}) {
    const ctor = typeof mediaSource;
    if (ctor !== "function" && ctor !== "object") {
      throw new TypeError("MSEFactory requires a MediaSource class or instance");
    }
    this.mediaSource = mediaSource;
    this.isTypeSupported = isTypeSupported ?? mediaSource?.isTypeSupported ?? null;
    this.createObjectURL = (ms) => (createObjectURL ?? URL.createObjectURL.bind(URL))(ms);
    this.revokeObjectURL = (url) => (revokeObjectURL ?? URL.revokeObjectURL.bind(URL))(url);
    this.delay = (ms) => (delay ?? ((d) => new Promise((r) => { setTimeout(r, d); })))(ms);
  }

  /**
   * Open a MediaSource and attach its object URL to the video.
   * Resolves once `sourceopen` fires.
   * @returns {Promise<MediaSink>}
   */
  async create({ video, mimeType, onStateChange }) {
    const mediaSource = typeof this.mediaSource === "function" ? new this.mediaSource() : this.mediaSource;
    const objectURL = this.createObjectURL(mediaSource);
    const sink = new MediaSink({
      mediaSource,
      objectURL,
      mimeType,
      seams: this,
      onStateChange
    });
    if (video) {
      try {
        video.src = objectURL;
      } catch (err) {
        sink.destroy();
        logger.error("proxy", "mse", "attach failed", err?.message ?? err);
        throw new SegmentError(`attaching MediaSource failed: ${err?.message ?? err}`, { retryable: false });
      }
    }
    await sink.waitForOpen();
    logger.log("proxy", "mse", "opened", { mimeType, objectURL });
    return sink;
  }
}

export class MediaSink {
  #mediaSource;
  #objectURL;
  #mimeType;
  #seams;
  #onStateChange;
  #destroyed = false;
  #ended = false;
  #lanes = new Map();
  /** A fragment container needs its init segment ('ftyp'+'moov' for fMP4)
   *  appended before the first media fragment on its SourceBuffer. Keyed by
   *  mimeType; the value is the init byte payload (an opaque reference).
   *  `setInit` with new bytes re-arms the lane so the next media append is
   *  preceded by the fresh init (variant/codec switch re-init). */
  #inits = new Map();

  get readyState() {
    return this.#mediaSource.readyState;
  }

  get objectURL() {
    return this.#objectURL;
  }

  get mediaSource() {
    return this.#mediaSource;
  }

  get destroyed() {
    return this.#destroyed;
  }

  constructor({ mediaSource, objectURL, mimeType, seams, onStateChange }) {
    this.#mediaSource = mediaSource;
    this.#objectURL = objectURL;
    this.#mimeType = mimeType;
    this.#seams = seams;
    this.#onStateChange = onStateChange;
  }

  /**
   * Declare a lane's init segment. `bytes` are appended immediately before
   * the first media fragment on that lane (and again whenever the init
   * changes). Setting null clears the lane's init expectation.
   * @param {Uint8Array} bytes
   * @param {object} [opts] { mimeType? } lane to target (default the sink's).
   */
  setInit(bytes, { mimeType = this.#mimeType } = {}) {
    if (this.#destroyed) {
      return;
    }
    if (bytes == null) {
      this.#inits.delete(mimeType);
    } else {
      this.#inits.set(mimeType, bytes);
    }
    logger.log("proxy", "mse", "setInit", mimeType, bytes?.byteLength ?? bytes?.length ?? 0, "bytes");
  }

  /** Resolve once the MediaSource reports readyState "open" (or errors). */
  async waitForOpen() {
    if (this.#mediaSource.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onOpen = () => resolve();
      const onError = () =>
        reject(new SegmentError("MediaSource failed to open", { retryable: false }));
      if (typeof this.#mediaSource.addEventListener === "function") {
        this.#mediaSource.addEventListener("sourceopen", onOpen, { once: true });
        this.#mediaSource.addEventListener("error", onError, { once: true });
      } else {
        resolve();
      }
    });
  }

  /**
   * Append one segment to its lane, in sequence order. Resolves when the
   * append lands (its `updateend` fired).
   * @param {number} seq     Segment sequence number (strictly ascending per lane).
   * @param {Uint8Array} bytes Cleartext bytes.
   * @param {object} [opts]  { startTime?, endTime?, mimeType? } - mimeType
   *                          selects a lane (audio/video SourceBuffers);
   *                          default the sink's configured mimeType.
   */
  async enqueue(seq, bytes, { startTime, endTime, mimeType = this.#mimeType } = {}) {
    if (this.#destroyed) throw new SegmentError("sink destroyed", { retryable: false });
    const lane = this.#lane(mimeType);
    const tail = lane.pending[lane.pending.length - 1];
    if (tail && seq <= tail.seq) {
      throw new SegmentError(
        tail.seq === seq ? "duplicate segment" : "out-of-order segment",
        { retryable: false }
      );
    }
    // A pending init for this lane goes in ahead of this media segment.
    const init = this.#inits.get(mimeType);
    const initTask =
      init != null && lane.appliedInit !== init
        ? { seq: -1, bytes: init, init: true, startTime: null, endTime: null }
        : null;
    if (initTask) {
      lane.pending.push(initTask);
      lane.appliedInit = init;
    }
    const task = { seq, bytes, startTime, endTime, init: false };
    lane.pending.push(task);
    logger.log("proxy", "mse", "enqueue", seq, bytes?.byteLength ?? bytes?.length ?? 0, "bytes");
    const appends = initTask ? [initTask, task] : [task];
    const job = appends.reduce(
      (chain, t) => chain.then(() => this.#append(lane, t)),
      lane.chain ?? Promise.resolve()
    );
    lane.chain = job.catch(() => {}); // swallowed copy: lane errors surface to the enqueue's await
    await job;
  }

  /** Mark end-of-stream once every lane has flushed (no-op if unsupported). */
  end() {
    if (this.#ended || this.#destroyed) return;
    if (typeof this.#mediaSource.endOfStream === "function") {
      this.#mediaSource.endOfStream();
    }
    this.#ended = true;
    logger.log("proxy", "mse", "end of stream");
  }

  /** Release the MediaSource: revoke the object URL and stop all lanes. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    logger.log("proxy", "mse", "destroyed", this.#objectURL);
    this.#seams.revokeObjectURL(this.#objectURL);
    this.#lanes.forEach((lane) => {
      lane.pending.length = 0;
      if (typeof lane.sourceBuffer.abort === "function") {
        try {
          lane.sourceBuffer.abort();
        } catch {}
      }
    });
    this.#onStateChange?.({ type: "destroyed" });
  }

  #lane(mimeType = this.#mimeType) {
    let lane = this.#lanes.get(mimeType);
    if (!lane) {
      if (this.#seams.isTypeSupported && !this.#seams.isTypeSupported(mimeType)) {
        logger.log("proxy", "mse", "unsupported mime type", mimeType);
        throw new SegmentError(`unsupported mime type: ${mimeType}`, { retryable: false });
      }
      let sourceBuffer;
      try {
        sourceBuffer = this.#mediaSource.addSourceBuffer(mimeType);
      } catch (err) {
        logger.error("proxy", "mse", "addSourceBuffer failed", mimeType, err?.message ?? err);
        throw new SegmentError(
          `addSourceBuffer(${mimeType}) failed: ${err?.message ?? err}`,
          { retryable: false }
        );
      }
      lane = { mimeType, sourceBuffer, pending: [], chain: null, appliedInit: null };
      this.#lanes.set(mimeType, lane);
    }
    return lane;
  }

  async #append(lane, task) {
    if (this.#destroyed) return;
    const buffer = lane.sourceBuffer;
    const lastSeq = task.seq;
    await this.#waitUntilIdle(buffer);
    if (this.#destroyed) return;

    let backoffMs = 2;
    for (;;) {
      if (this.#destroyed) return;
      try {
        if (!task.init) {
          this.#setWindow(buffer, task);
        }
        buffer.appendBuffer(task.bytes);
        break;
      } catch (err) {
        if (err?.name !== "QuotaExceededError") {
          throw new SegmentError(`appendBuffer failed: ${err?.message ?? err}`, { retryable: false });
        }
        logger.log("proxy", "mse", "quota backoff", task.seq, `${backoffMs}ms`);
        await this.#seams.delay(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 512);
      }
    }
    await this.#waitUntilIdle(buffer);
    if (!task.init) {
      this.#resetWindow(buffer, task);
      this.#onStateChange?.({ type: "appended", seq: lastSeq });
    }
    logger.log("proxy", "mse", task.init ? "init appended" : "appended", lastSeq);
  }

  async #waitUntilIdle(buffer) {
    while (buffer.updating && !this.#destroyed) {
      if (typeof buffer.addEventListener === "function") {
        await new Promise((resolve) => {
          const onSettle = () => resolve();
          buffer.addEventListener("updateend", onSettle, { once: true });
          buffer.addEventListener("abort", onSettle, { once: true });
          buffer.addEventListener("error", onSettle, { once: true });
        });
      } else {
        await this.#seams.delay(0);
      }
    }
  }

  #setWindow(buffer, task) {
    if (task.startTime != null) buffer.appendWindowStart = task.startTime;
    if (task.endTime != null) buffer.appendWindowEnd = task.endTime;
  }

  #resetWindow(buffer, task) {
    if (task.startTime != null) buffer.appendWindowStart = 0;
    if (task.endTime != null) buffer.appendWindowEnd = Infinity;
  }
}