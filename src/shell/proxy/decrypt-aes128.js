/**
 * HLS AES-128 clear-key decryption (§11.2). Pure IV derivation per RFC 8216
 * plus a per-URI key cache and the WebCrypto AES-CBC pipeline behind an
 * injectable `subtle` seam, so the whole pipe runs headless with a fake
 * `crypto.subtle` and no key ever leaves the process.
 *
 * Decrypt is all-or-nothing: on any failure this module rejects with a
 * non-retryable `SegmentError` and the flow manager skips the segment. An
 * AES-128 segment is therefore never half-appended to MSE - corrupted
 * ciphertext can never reach a source buffer (§11.2).
 */

import { SegmentError } from "./segment-manager.js";

/** Parse an explicit `IV="0x…"` tag attribute into its 16 bytes. A missing,
 *  malformed, or non-128-bit value is a hard failure (fail-to-skip). */
export function parseHexIv(hex) {
  const raw = String(hex ?? "").trim();
  const body = raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{32}$/.test(body)) {
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
      }
    }
    if (!key) {
      throw new SegmentError(`no AES-128 key available for ${keyUri}`, { retryable: false });
    }
    const iv = deriveIv({ ivHex, sequence });
    let imported;
    try {
      imported = await this.#subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
    } catch (err) {
      throw new SegmentError(`AES-128 importKey failed: ${err?.name ?? "error"}`, { retryable: false, cause: err });
    }
    let plain;
    try {
      plain = await this.#subtle.decrypt({ name: "AES-CBC", iv }, imported, toBytes(data));
    } catch (err) {
      throw new SegmentError(`AES-128 decrypt failed: ${err?.name ?? "error"}`, { retryable: false, cause: err });
    }
    return plain instanceof Uint8Array ? plain : new Uint8Array(plain);
  }
}