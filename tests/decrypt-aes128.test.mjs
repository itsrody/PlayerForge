import test from "node:test";
import assert from "node:assert/strict";
import {
  parseHexIv,
  deriveIv,
  Aes128Decrypter
} from "../src/shell/proxy/decrypt-aes128.js";
import { SegmentError } from "../src/shell/proxy/segment-manager.js";

const subtle = globalThis.crypto?.subtle;

// A padded AES-128-CBC known-answer vector (OpenSSL-generated, frozen literal):
// a 61-byte plaintext whose PKCS#7 final block makes this WebCrypto-friendly,
// unlike the unpadded NIST single-block ciphertexts. Decrypting the literal
// below MUST reproduce the plaintext - a pure regression anchor.
const VEC_KEY = "000102030405060708090a0b0c0d0e0f";
const VEC_IV = "101112131415161718191a1b1c1d1e1f";
const VEC_PLAIN_TEXT = "PlayerForge AES-128 clear-key vector (RFC 8216 whole-segment)";
const VEC_PLAIN_HEX = "506c61796572466f726765204145532d31323820636c6561722d6b657920766563746f72202852464320383231362077686f6c652d7365676d656e7429";
const VEC_CIPHER = "a8559ddfadbc9667ef2fa2308cf34c46a32853c3a4b71aecb54717df592f1b262d5ca02b4ef4545aa11b8fc5da8d1fe37b7f9a47ac27723ec2583e9f4026039d";

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("decrypts the known AES-128-CBC vector (explicit IV)", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/enc.key";
  decrypter.setKey(keyUri, hexToBytes(VEC_KEY));
  const clear = await decrypter.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, ivHex: "0x" + VEC_IV, sequence: 0 });
  assert.equal(Buffer.from(clear).toString("utf8"), VEC_PLAIN_TEXT);
});

test("a mismatched IV yields garbage, not the plaintext (IV integrity)", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/enc.key";
  decrypter.setKey(keyUri, hexToBytes(VEC_KEY));
  const garbled = await decrypter.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, sequence: 0 });
  assert.notEqual(Buffer.from(garbled).toString("utf8"), VEC_PLAIN_TEXT, "wrong IV must not reproduce the plaintext");
});

test("explicit hex IV is honored and sequence-IV is its lower-64-bit form", async () => {
  const seq0 = deriveIv({ sequence: 0 });
  assert.deepEqual(bytesToHex(seq0), "00000000000000000000000000000000");
  assert.equal(bytesToHex(deriveIv({ sequence: 971 })), "000000000000000000000000000003cb");
  const clazz = deriveIv({ ivHex: "0x" + VEC_IV, sequence: 971 });
  assert.deepEqual(bytesToHex(clazz), VEC_IV, "explicit IV wins over sequence");
  assert.deepEqual(
    deriveIv({ ivHex: "0x00000000000000000000000000000005" }),
    deriveIv({ sequence: 5 }),
    "sequence IV is identical to its long-form hex"
  );
});

test("malformed hex IV and missing IV/sequence fail to skip, never partial", () => {
  assert.throws(() => parseHexIv("0x1a2b"), SegmentError, "short hex refuses");
  assert.throws(() => parseHexIv("0xzz00112233445566778899aabbccddeeff"), SegmentError, "non-hex refuses");
  assert.throws(() => deriveIv({}), SegmentError, "no IV and no sequence refuses");
  assert.throws(() => deriveIv({ sequence: -1 }), SegmentError, "negative sequence refuses");
  const caught = (() => {
    try {
      deriveIv({ ivHex: "0x1234" });
    } catch (err) {
      return err;
    }
  })();
  assert.equal(caught.retryable, false, "an IV defect is not healed by retry");
});

test("cache miss with no loader is non-retryable; keyLoader fills the slot on demand", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/a.key";
  await assert.rejects(
    decrypter.decrypt({ data: new Uint8Array([1]), keyUri, sequence: 0 }),
    (err) => err instanceof SegmentError && err.retryable === false && /no AES-128 key/.test(err.message)
  );

  let calls = 0;
  const withLoader = new Aes128Decrypter({
    subtle,
    keyLoader: async () => {
      calls++;
      return hexToBytes(VEC_KEY);
    }
  });
  const first = await withLoader.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, ivHex: "0x" + VEC_IV, sequence: 0 });
  assert.equal(Buffer.from(first).toString("utf8"), VEC_PLAIN_TEXT);
  const second = await withLoader.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, ivHex: "0x" + VEC_IV, sequence: 1 });
  assert.equal(Buffer.from(second).toString("utf8"), VEC_PLAIN_TEXT);
  assert.equal(calls, 1, "second decrypt hits the cache, loader untouched");
});

test("key rotation replaces in place; dropKey invalidates", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/rot.key";
  decrypter.setKey(keyUri, hexToBytes(VEC_KEY));
  assert.equal(
    Buffer.from(await decrypter.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, ivHex: "0x" + VEC_IV, sequence: 0 })).toString("utf8"),
    VEC_PLAIN_TEXT
  );
  decrypter.setKey(keyUri, hexToBytes("00000000000000000000000000000000"));
  await assert.rejects(
    decrypter.decrypt({ data: hexToBytes(VEC_CIPHER), keyUri, ivHex: "0x" + VEC_IV, sequence: 0 }),
    SegmentError,
    "rotated key yields garbage padding -> fails, never partial"
  );
  decrypter.dropKey(keyUri);
  assert.equal(decrypter.cachedKey(keyUri), null, "dropKey empties the slot");
});

test("corrupted ciphertext surfaces a non-retryable SegmentError (no SSE skip loop)", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/c.key";
  decrypter.setKey(keyUri, hexToBytes(VEC_KEY));
  await assert.rejects(
    decrypter.decrypt({ data: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), keyUri, sequence: 0 }),
    (err) => err instanceof SegmentError && err.retryable === false && /decrypt failed/.test(err.message)
  );
});

test("importKey path failure is non-retryable too (red-key case)", async () => {
  const decrypter = new Aes128Decrypter({ subtle });
  const keyUri = "https://x/keys/bad.key";
  decrypter.setKey(keyUri, new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(
    decrypter.decrypt({ data: new Uint8Array(16), keyUri, sequence: 0 }),
    (err) => err instanceof SegmentError && err.retryable === false && /importKey failed/.test(err.message)
  );
});

test("the WebCrypto seam is exercised with the AES-CBC contract (injectable subtle)", async () => {
  const calls = [];
  const fakeSubtle = {
    importKey: async (format, key, alg, extractable, usages) => {
      calls.push({ op: "import", alg, extractable, usages, keyLen: key.length });
      return { kind: "CryptoKey", length: key.length };
    },
    decrypt: async (alg, imported, data) => {
      calls.push({ op: "decrypt", alg: { name: alg.name }, iv: bytesToHex(alg.iv), dataLen: data.length, importedKind: imported.kind });
      return hexToBytes(VEC_PLAIN_HEX);
    }
  };
  const decrypter = new Aes128Decrypter({ subtle: fakeSubtle });
  decrypter.setKey("https://x/keys/k.key", hexToBytes(VEC_KEY));
  const out = await decrypter.decrypt({ data: new Uint8Array([7, 7, 7]), keyUri: "https://x/keys/k.key", ivHex: "0x" + VEC_IV });
  assert.equal(bytesToHex(out), VEC_PLAIN_HEX);
  assert.deepEqual(calls, [
    { op: "import", alg: { name: "AES-CBC" }, extractable: false, usages: ["decrypt"], keyLen: 16 },
    { op: "decrypt", alg: { name: "AES-CBC" }, iv: VEC_IV, dataLen: 3, importedKind: "CryptoKey" }
  ]);
});

test("constructor refuses a missing subtle seam", () => {
  assert.throws(() => new Aes128Decrypter({ subtle: null }), TypeError);
});