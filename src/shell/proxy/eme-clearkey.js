/**
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
import { SegmentError } from "./segment-manager.js";

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
    } catch (err) {
      await safeDetach(video);
      this.#video = null;
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
        } else {
          const requestBody = body && Array.isArray(body.kids)
            ? body
            : { kids: kidList, type: "temporary" };
          const resp = await this.#postJson(target, requestBody, { signal: null });
          license = toUint8(resp);
        }
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
          resolve(session);
        }
      } else if (statuses.some((status) => status === "expired" || status === "internal-error" || status === "output-restricted")) {
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
}