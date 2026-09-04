import test from "node:test";
import assert from "node:assert/strict";
import { ClearKeyEme, CLEARKEY_SYSTEM, DEFAULT_KEY_SYSTEM_CONFIG, parseCencInitData } from "../src/shell/proxy/eme-clearkey.js";
import { SegmentError } from "../src/shell/proxy/segment-manager.js";

const CLEARKEY_PSSH_SYSTEM_ID = "edef8ba979d64ace-a3c827dcd51d21ed".replace(/-/g, "");

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const KID_1 = "4c0218eb55e1a0acad7c778d26da584e";
const KID_2 = "8a7cf02f8a1a4c8a8c1d9c79ea8c1d1a";

function psshBoxV1(kidHexes, systemIdHex = CLEARKEY_PSSH_SYSTEM_ID) {
  const size = 32 + kidHexes.length * 16;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size);
  buf.set([0x70, 0x73, 0x73, 0x68], 4); // 'pssh'
  buf[8] = 1; // fullbox version byte (v1: kids present)
  buf.set(hexToBytes(systemIdHex), 12);
  dv.setUint32(28, kidHexes.length);
  let off = 32;
  for (const kid of kidHexes) {
    buf.set(hexToBytes(kid), off);
    off += 16;
  }
  return buf;
}

class FakeKeyStatuses {
  constructor(map) {
    this.map = map;
  }
  values() {
    return this.map.values();
  }
}

class FakeSession {
  constructor() {
    this.listeners = {};
    this.keyStatuses = new FakeKeyStatuses(new Map());
    this.updated = null;
    this.closed = false;
    this.generateRequests = [];
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  emit(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this, ...event });
  }

  async generateRequest(initDataType, initData) {
    this.generateRequests.push({ initDataType, initData });
  }

  emitMessage(jsonText, { messageType = "license-request" } = {}) {
    this.emit("message", { message: new TextEncoder().encode(jsonText).buffer, messageType });
  }

  setKeyStatus(status) {
    this.keyStatuses = new FakeKeyStatuses(new Map([["0", status]]));
    this.emit("keystatuseschange");
  }

  async update(license) {
    this.updated = license;
    this.setKeyStatus("usable");
  }

  async close() {
    this.closed = true;
  }
}

function buildHarness({ postJson } = {}) {
  const session = new FakeSession();
  const mediaKeys = { createSession: () => session };
  const access = { createMediaKeys: async () => mediaKeys };
  const requests = [];
  const navigator = {
    requestMediaKeySystemAccess: async (system, configs) => {
      requests.push({ system, configs });
      return access;
    }
  };
  const video = { setMediaKeysCalls: [], setMediaKeys: async (keys) => { video.setMediaKeysCalls.push(keys); } };
  const posts = [];
  const eme = new ClearKeyEme({
    navigator,
    postJson: postJson ?? (async (url, body) => {
      posts.push({ url, body });
      return new TextEncoder().encode(JSON.stringify({
        keys: [{
          kty: "oct",
          k: "Y2xlYXJrZXl0ZXN0a2V5MDE=",
          kid: KID_1
        }]
      }));
    })
  });
  return { session, mediaKeys, access, navigator, video, posts, requests, eme };
}

const LAURL = "https://license.example/clearkey";

test("parseCencInitData extracts ClearKey kids (base64url) and systemId from a v1 pssh", () => {
  const box = psshBoxV1([KID_1, KID_2]);
  const { systemId, kids } = parseCencInitData(box);
  assert.equal(systemId, CLEARKEY_PSSH_SYSTEM_ID);
  assert.deepEqual(kids, [
    Buffer.from(KID_1, "hex").toString("base64url"),
    Buffer.from(KID_2, "hex").toString("base64url")
  ]);
});

test("parseCencInitData tolerates junk and v0 boxes (no kids)", () => {
  assert.deepEqual(parseCencInitData(new Uint8Array([1, 2, 3, 4])), { systemId: "", kids: [] });
  const v0 = new Uint8Array(20 + 16);
  const dv = new DataView(v0.buffer);
  dv.setUint32(0, v0.length);
  v0.set([0x70, 0x73, 0x73, 0x68], 4);
  dv.setUint32(8, 0); // v0: no kid count
  v0.set(hexToBytes(CLEARKEY_PSSH_SYSTEM_ID), 12);
  const parsed = parseCencInitData(v0);
  assert.equal(parsed.systemId, CLEARKEY_PSSH_SYSTEM_ID);
  assert.deepEqual(parsed.kids, []);
});

test("attach() requests org.w3.clearkey access, creates MediaKeys, wires setMediaKeys", async () => {
  const { eme, navigator, video, requests } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  assert.equal(requests[0].system, CLEARKEY_SYSTEM);
  assert.deepEqual(requests[0].configs[0].initDataTypes, DEFAULT_KEY_SYSTEM_CONFIG.initDataTypes);
  assert.deepEqual(requests[0].configs[0].sessionTypes, ["temporary"]);
  assert.equal(video.setMediaKeysCalls.length, 1);
  assert.ok(video.setMediaKeysCalls[0], "MediaKeys instance attached");
  assert.equal(eme.attached, true);
  assert.equal(eme.laurl, LAURL);
});

test("attach() failure detaches the video and throws a non-retryable SegmentError", async () => {
  const { video } = buildHarness();
  const navigator = { requestMediaKeySystemAccess: async () => { throw new Error("no clearkey"); } };
  const eme = new ClearKeyEme({ navigator });
  await assert.rejects(
    eme.attach(video),
    (err) => err instanceof SegmentError && err.retryable === false && /attach failed/.test(err.message)
  );
  assert.deepEqual(video.setMediaKeysCalls, [null], "video detached cleanly");
  assert.equal(eme.attached, false);
});

test("attach() refuses a video without setMediaKeys", async () => {
  const { eme } = buildHarness();
  await assert.rejects(
    eme.attach({}),
    (err) => err instanceof SegmentError && err.retryable === false && /setMediaKeys/.test(err.message)
  );
});

test("handleEncrypted() without attach refuses non-retryably", async () => {
  const { eme } = buildHarness();
  assert.throws(
    () => eme.handleEncrypted({ initData: psshBoxV1([KID_1]) }),
    (err) => err instanceof SegmentError && err.retryable === false && /not attached/.test(err.message)
  );
});

test("full ClearKey exchange: parse -> generateRequest -> laurl POST -> update -> usable", async () => {
  const { eme, video, session, posts } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  const box = psshBoxV1([KID_1]);

  const ready = eme.handleEncrypted({ initData: box, initDataType: "cenc" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(session.generateRequests[0].initDataType, "cenc");
  assert.deepEqual([...session.generateRequests[0].initData], [...box]);

  session.emitMessage(JSON.stringify({ kids: [Buffer.from(KID_1, "hex").toString("base64url")], type: "temporary" }));
  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(posts.length, 1, "laurl POST happened");
  assert.equal(posts[0].url, LAURL);
  assert.deepEqual(posts[0].body.type, "temporary");
  assert.ok(session.updated, "license handed to update()");
  const s = await ready;
  assert.equal(s, session);
});

test("a license-bearing message skips the laurl POST and updates directly", async () => {
  const { eme, video, session, posts } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  const ready = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  await Promise.resolve();
  await Promise.resolve();

  session.emitMessage(JSON.stringify({ keys: [{ kty: "oct", k: "eA==", kid: "AQID" }] }));
  for (let i = 0; i < 10; i++) await Promise.resolve();

  assert.equal(posts.length, 0, "no license POST on a direct-license message");
  assert.ok(session.updated);
  await ready;
});

test("duplicate encrypted events reuse the in-flight session (no second session)", async () => {
  const { eme, video, session, posts } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  const a = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  await Promise.resolve();
  const b = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  assert.equal(session.generateRequests.length, 1, "generateRequest fired once for both events");

  session.emitMessage(JSON.stringify({ kids: [Buffer.from(KID_1, "hex").toString("base64url")], type: "temporary" }));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(posts.length, 1, "single license exchange for both events");
  assert.equal(await a, session);
  assert.equal(await b, session);
  assert.equal(posts.length, 1);
});

test("an expired key status fails non-retryably and detaches the CDM", async () => {
  const { eme, video, session } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  const ready = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  await Promise.resolve();
  await Promise.resolve();
  session.setKeyStatus("expired");
  await assert.rejects(
    ready,
    (err) => err instanceof SegmentError && err.retryable === false && /key status expired/.test(err.message)
  );
  assert.deepEqual(video.setMediaKeysCalls, [mediaKeysOf(video), null]);
});

function mediaKeysOf(video) {
  return video.setMediaKeysCalls[0];
}

test("a failed license POST rejects non-retryably and detaches", async () => {
  const { eme, video, session } = buildHarness({
    postJson: async () => { throw new Error("network down"); }
  });
  await eme.attach(video, { laurl: LAURL });
  const ready = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  await Promise.resolve();
  session.emitMessage(JSON.stringify({ kids: ["AQIDBA"], type: "temporary" }));
  await assert.rejects(
    ready,
    (err) => err instanceof SegmentError && err.retryable === false && /license exchange failed/.test(err.message)
  );
  assert.deepEqual(video.setMediaKeysCalls, [mediaKeysOf(video), null]);
});

test("detach() closes the session, nulls MediaKeys, and settles a pending exchange", async () => {
  const { eme, video, session } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  const ready = eme.handleEncrypted({ initData: psshBoxV1([KID_1]) });
  await Promise.resolve();
  await eme.detach();
  assert.equal(session.closed, true);
  assert.deepEqual(video.setMediaKeysCalls, [mediaKeysOf(video), null]);
  await assert.rejects(ready, (err) => err?.name === "AbortError");
  assert.equal(eme.attached, false);
});

test("detach() is idempotent", async () => {
  const { eme, video } = buildHarness();
  await eme.attach(video, { laurl: LAURL });
  await eme.detach();
  await eme.detach();
  assert.deepEqual(video.setMediaKeysCalls, [mediaKeysOf(video), null]);
});