/**
 * decrypt-eme.js — the decrypt/MSE seams at the media sink (consolidated from
 * `decrypt-aes128.js` + `eme-clearkey.js` + `mse.js`).
 *
 * Three seams the take-over wires between a SegmentManager and the element:
 * - `Aes128Decrypter` — HLS AES-128 clear-key (§11.2): pure IV derivation per
 *   RFC 8216 plus a per-URI key cache and a WebCrypto AES-CBC pipeline behind
 *   an injectable `subtle` seam. Decrypt is all-or-nothing: any failure
 *   rejects with a non-retryable `SegmentError` and the flow manager skips
 *   the segment; corrupted ciphertext can never reach a source buffer.
 * - `ClearKeyEme` — DASH ClearKey (CCP) via EME (§11.3): CENC/CBCS media
 *   bytes stay encrypted (the CDM decrypts at decode time), so the only extra
 *   work is key-session setup. Attach, `encrypted` → license exchange, detach.
 * - `MSEFactory`/`MediaSink` — the MSE sink (§7.2): one MediaSource per
 *   <video>, one SourceBuffer lane per mime type, appended in strict sequence
 *   order with init-before-media, appendWindowStart/End for accurate seeking,
 *   and `updating`/buffer.full backpressure.
 *
 * All three run headless: MediaSource/URL, `subtle`, navigator/video, and the
 * scheduler are injectable seams.
 */
import { logger } from "../../shared/logger.js";
import { SegmentError } from "./segment-flow.js";

/** A 32-hex-digit (128-bit, no `0x`) IV literal. Hoisted - a regex literal
 *  would re-allocate for every AES-128 segment key. */
const HEX_IV_RE = /^[0-9a-fA-F]{32}$/;

/** Parse an explicit `IV="0x…"` tag attribute into its 16 bytes. A missing,
 *  malformed, or non-128-bit value is a hard failure (fail-to-skip). */
export function parseHexIv(hex) {
  const raw = String(hex ?? "").trim();
  const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!HEX_IV_RE.test(body)) {
    throw new SegmentError("AES-128 IV must be a 128-bit hex value", { retryable: false });
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The per-segment IV (§11.2 step 2): the tag's explicit `IV=` when present,
 *  else the media sequence number - a 128-bit value whose low-order 64 bits
 *  hold the sequence, big-endian (RFC 8216 §5.2). */
export function deriveIv({ ivHex = null, sequence = null } = {}) {
  if (ivHex != null && String(ivHex) !== "") {
    return parseHexIv(ivHex);
  }
  const n = Number(sequence);
  if (sequence == null || !Number.isFinite(n) || n < 0) {
    throw new SegmentError("AES-128 requires an explicit IV or a media sequence number", { retryable: false });
  }
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(8, BigInt(Math.floor(n)));
  return out;
}

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new SegmentError("AES-128 key must be bytes", { retryable: false });
}

/**
 * Key store + WebCrypto AES-CBC pipeline.
 *
 *   keyLoader(uri) -> Promise<bytes|null>   optional transport seam (Phase 3
 *                                           GM_xmlhttpRequest) used on cache
 *                                           miss; a miss stays retryable so a
 *                                           token refresh can heal it.
 *
 * `setKey`/`dropKey` are the rotation surface (§11.2 step 4): a changed
 * `#EXT-X-KEY` URI is a new cache slot; a same-URI key rotation replaces in
 * place (never partial).
 */
export class Aes128Decrypter {
  #subtle;
  #keyLoader;
  #keys = new Map();

  constructor({ subtle = globalThis.crypto?.subtle, keyLoader = null } = {}) {
    if (!subtle || typeof subtle.importKey !== "function" || typeof subtle.decrypt !== "function") {
      throw new TypeError("Aes128Decrypter requires a WebCrypto subtle seam");
    }
    this.#subtle = subtle;
    this.#keyLoader = typeof keyLoader === "function" ? keyLoader : null;
  }

  /** Cache (or rotate) the 16-byte key for `uri`. */
  setKey(uri, bytes) {
    this.#keys.set(String(uri), toBytes(bytes));
  }

  /** Invalidate a key URI (rotation / teardown). */
  dropKey(uri) {
    this.#keys.delete(String(uri));
  }

  /** Current cached key bytes for `uri`, or null on a cache miss. */
  cachedKey(uri) {
    return this.#keys.get(String(uri)) ?? null;
  }

  /**
   * Decrypt one whole segment.
   *   data      ciphertext bytes
   *   keyUri    the `#EXT-X-KEY` URI (cache slot + transport target)
   *   ivHex     explicit `IV=` attribute when present
   *   sequence  media sequence number (sequence-IV fallback)
   * Returns the cleartext `Uint8Array`, never a partial result.
   */
  async decrypt({ data, keyUri = null, ivHex = null, sequence = null } = {}) {
    if (!keyUri) {
      throw new SegmentError("AES-128 segment decrypt requires a key URI", { retryable: false });
    }
    let key = this.#keys.get(keyUri);
    if (!key && this.#keyLoader) {
      // Cache miss pays the transport seam once; a null/throw means the key
      // is genuinely unavailable (no healing by retry).
      let fetched = null;
      try {
        fetched = await this.#keyLoader(keyUri);
      } catch {}
      if (fetched != null) {
        key = toBytes(fetched);
        this.#keys.set(keyUri, key);
        logger.log("proxy", "aes128", "key loaded", keyUri);
      } else {
        logger.warn("proxy", "aes128", "key unavailable", keyUri);
      }
    }
    if (!key) {
      throw new SegmentError(`no AES-128 key available for ${keyUri}`, { retryable: false });
    }
    const iv = deriveIv({ ivHex, sequence });
    logger.log("proxy", "aes128", "decrypting", { keyUri, ivHex, sequence });
    let imported;
    try {
      imported = await this.#subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    } catch (err) {
      logger.warn("proxy", "aes128", "importKey failed", err?.name ?? "error");
      throw new SegmentError(`AES-128 importKey failed: ${err?.name ?? "error"}`, { retryable: false, cause: err });
    }
    let plain;
    try {
      plain = await this.#subtle.decrypt({ name: "AES-CBC", iv }, imported, toBytes(data));
    } catch (err) {
      logger.warn("proxy", "aes128", "decrypt failed", err?.name ?? "error");
      throw new SegmentError(`AES-128 decrypt failed: ${err?.name ?? "error"}`, { retryable: false, cause: err });
    }
    const out = plain instanceof Uint8Array ? plain : new Uint8Array(plain);
    logger.log("proxy", "aes128", "decrypted", out.byteLength, "bytes");
    return out;
  }
}/**
 * DASH ClearKey (CCP) via EME (§11.3).
 *
 * ClearKey streams are CENC/CBCS: the media bytes MSE feeds stay encrypted
 * (the CDM decrypts at decode time), so the *only* extra work versus plain
 * routing is key-session setup — our "DECRYPTING" lane is `MediaKeys`/
 * `session`, not per-segment crypto.
 *
 * Flow:
 *   1. `attach(video)` — `requestMediaKeySystemAccess("org.w3.clearkey")` →
 *      `createMediaKeys` → `video.setMediaKeys`. Any failure detaches and
 *      throws a non-retryable SegmentError so the caller degrades to native.
 *   2. `handleEncrypted(initData)` — parse the CENC `pssh` kids, open one
 *      `temporary` session, POST the `{ kids, type }` license request to the
 *      laurl (cross-origin seam, token-aware like every other routed fetch),
 *      then feed the JSON license to `session.update()`.
 *   3. `detach()` — close the session and `setMediaKeys(null)`: never leave a
 *      half-attached CDM behind.
 *
 * The EME surfaces (navigator, video, license transport) are injectable so the
 * flow is exercised headlessly with stubs; the wire contract mirrors §12.2.
 */
export const CLEARKEY_SYSTEM = "org.w3.clearkey";

export const DEFAULT_KEY_SYSTEM_CONFIG = Object.freeze({
  initDataTypes: ["cenc", "cbcs"],
  videoCapabilities: [{ contentType: "video/mp4" }],
  audioCapabilities: [{ contentType: "audio/mp4" }],
  persistentState: "optional",
  sessionTypes: ["temporary"]
});

export class ClearKeyEme {
  #navigator;
  #config;
  #postJson;
  #video = null;
  #mediaKeys = null;
  #session = null;
  #laurl = "";
  #ready = null;
  #resolveReady = null;
  #rejectReady = null;

  /**
   * @param {object} [seams]
   * @param {object}   [seams.navigator]  navigator with requestMediaKeySystemAccess.
   * @param {object}   [seams.config]     MediaKeySystemAccess config (DEFAULT_*).
   * @param {Function} [seams.postJson]   (url, body, { signal }) => Uint8Array license.
   */
  constructor({ navigator = globalThis.navigator, config = DEFAULT_KEY_SYSTEM_CONFIG, postJson } = {}) {
    this.#navigator = navigator;
    this.#config = config;
    this.#postJson = typeof postJson === "function" ? postJson : defaultPostJson();
  }

  get attached() {
    return this.#video !== null && this.#mediaKeys !== null;
  }

  get laurl() {
    return this.#laurl;
  }

  /**
   * Attach ClearKey MediaKeys to the video. On any failure the video is
   * detached (`setMediaKeys(null)`) before a non-retryable error escapes, so
   * the caller can degrade toward native playback.
   */
  async attach(video, { laurl = "" } = {}) {
    if (!video || typeof video.setMediaKeys !== "function") {
      throw new SegmentError("ClearKey requires a video with setMediaKeys()", { retryable: false });
    }
    if (this.#video && this.#video !== video) {
      await this.detach();
    }
    this.#video = video;
    this.#laurl = laurl;
    try {
      const access = await this.#navigator.requestMediaKeySystemAccess(CLEARKEY_SYSTEM, [this.#config]);
      this.#mediaKeys = await access.createMediaKeys();
      await video.setMediaKeys(this.#mediaKeys);
      logger.log("proxy", "clearkey", "attached", { laurl: this.#laurl || "none" });
    } catch (err) {
      await safeDetach(video);
      this.#video = null;
      logger.error("proxy", "clearkey", "attach failed", err?.message ?? err);
      throw new SegmentError(`ClearKey media keys attach failed: ${err?.message ?? err}`, { retryable: false });
    }
    return this;
  }

  /**
   * Drive one key session for an `encrypted` event. Parses the CENC `pssh`
   * kids (or accepts them directly), opens a temporary session, exchanges the
   * laurl license, and resolves when the session reports a usable key — or
   * rejects non-retryably and detaches.
   */
  handleEncrypted({ initData, initDataType = "cenc", kids, laurl } = {}) {
    if (!this.#mediaKeys) {
      throw new SegmentError("ClearKey not attached before encrypted event", { retryable: false });
    }
    if (this.#ready) {
      return this.#ready;
    }
    const kidList = kids ?? parseCencInitData(initData).kids;
    const session = this.#mediaKeys.createSession();
    this.#session = session;
    const target = laurl ?? this.#laurl;
    logger.log("proxy", "clearkey", "session created", { kids: kidList });

    this.#ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    const ready = this.#ready;

    const fail = (err) => {
      if (!this.#rejectReady) return;
      const wrapped = err instanceof SegmentError
        ? err
        : new SegmentError(`ClearKey license exchange failed: ${err?.message ?? err}`, { retryable: false });
      const reject = this.#rejectReady;
      const video = this.#video;
      this.#resolveReady = null;
      this.#rejectReady = null;
      safeDetach(video).finally(() => reject(wrapped));
    };

    session.addEventListener("message", (event) => {
      const run = async () => {
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(event.message));
        } catch {
          body = null;
        }
        let license;
        if (body && Array.isArray(body.keys)) {
          // The CDM handed us the license directly; nothing to POST.
          license = toUint8(event.message);
          logger.log("proxy", "clearkey", "direct license from CDM");
        } else {
          const requestBody = body && Array.isArray(body.kids)
            ? body
            : { kids: kidList, type: "temporary" };
          logger.log("proxy", "clearkey", "license POST", target);
          const resp = await this.#postJson(target, requestBody, { signal: null });
          license = toUint8(resp);
        }
        logger.log("proxy", "clearkey", "session.update", license.byteLength, "bytes");
        await session.update(license);
      };
      run().catch(fail);
    });

    session.addEventListener("keystatuseschange", () => {
      const statuses = [];
      if (typeof session.keyStatuses?.values === "function") {
        for (const status of session.keyStatuses.values()) statuses.push(status);
      }
      if (statuses.some((status) => status === "usable" || status === "usable-out-of-origin")) {
        if (this.#resolveReady) {
          const resolve = this.#resolveReady;
          this.#resolveReady = null;
          this.#rejectReady = null;
          logger.log("proxy", "clearkey", "key usable", statuses[0]);
          resolve(session);
        }
      } else if (statuses.some((status) => status === "expired" || status === "internal-error" || status === "output-restricted")) {
        logger.warn("proxy", "clearkey", "key status failure", statuses[0]);
        fail(new SegmentError(`ClearKey key status ${statuses[0]}`, { retryable: false }));
      }
    });

    return session
      .generateRequest(initDataType, initData)
      .catch(fail)
      .then(() => ready);
  }

  /** Close the session and detach the CDM; safe to call repeatedly. */
  detach() {
    logger.log("proxy", "clearkey", "detach");
    const session = this.#session;
    const reject = this.#rejectReady;
    this.#session = null;
    this.#mediaKeys = null;
    this.#ready = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
    if (reject) reject(new DOMException("ClearKey detached", "AbortError"));
    const done = [];
    if (session) {
      done.push(Promise.resolve().then(() => session.close()).catch(() => {}));
    }
    if (this.#video) {
      const video = this.#video;
      this.#video = null;
      done.push(safeDetach(video));
    }
    return Promise.all(done);
  }
}

/**
 * Parse the ISO-BMFF `pssh` box(es) a CENC `encrypted` event delivers and
 * return the ClearKey "kids" (base64url, unpadded) plus the systemId.
 * v0 boxes omit the kidCount/kids arrays and yield no kids.
 */
export function parseCencInitData(initData) {
  const bytes = toUint8(initData);
  let offset = 0;
  let systemId = "";
  const kids = [];
  while (offset + 16 <= bytes.length) {
    const size = readU32(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    if (type !== "pssh" || size < 20 || offset + size > bytes.length) {
      offset += size > 0 ? size : 1;
      continue;
    }
    const version = bytes[offset + 8];
    systemId = bytesToHex(bytes, offset + 12, 16);
    if (version === 1 && size >= 28) {
      const kidCount = readU32(bytes, offset + 28);
      let k = offset + 32;
      for (let i = 0; i < kidCount && k + 16 <= offset + size; i++) {
        kids.push(byteArrayToBase64Url(bytes, k, 16));
        k += 16;
      }
    }
    offset += size;
  }
  return { systemId, kids };
}

function defaultPostJson() {
  return async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new SegmentError(`license POST ${res.status} for ${url}`, { retryable: false });
    }
    return new Uint8Array(await res.arrayBuffer());
  };
}

function safeDetach(video) {
  if (!video || typeof video.setMediaKeys !== "function") return Promise.resolve();
  return Promise.resolve()
    .then(() => video.setMediaKeys(null))
    .catch(() => {});
}

function readU32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function bytesToHex(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += bytes[offset + i].toString(16).padStart(2, "0");
  return out;
}

function byteArrayToBase64Url(bytes, offset, length) {
  let bits = 0;
  let value = 0;
  let out = "";
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < length; i++) {
    value = (value << 8) | bytes[offset + i];
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += CHARS[(value >> bits) & 0x3f];
    }
  }
  if (bits > 0) out += CHARS[(value << (6 - bits)) & 0x3f];
  return out;
}

function toUint8(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new Uint8Array(Array.from(value, (c) => c.charCodeAt(0) & 0xff));
  return new Uint8Array(0);
}/**
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