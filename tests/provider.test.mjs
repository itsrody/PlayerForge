import test from "node:test";
import assert from "node:assert/strict";
import { ProxyProvider } from "../src/shell/proxy/provider.js";

function fakeFetchResponse({ status = 200, headers = new Map([["content-type", "video/mp4"]]), body = Uint8Array.from([1, 2, 3]) } = {}) {
  return {
    status,
    headers: { forEach: (cb) => headers.forEach((v, k) => cb(v, k)) },
    arrayBuffer: async () => body.buffer
  };
}

function fakeGMHarness({ behavior, responseHeaders = "content-type: video/mp4\r\nx-seg: 7" } = {}) {
  const calls = [];
  const gmFetch = (req, callbacks) => {
    calls.push(req);
    const request = {
      abort() {
        callbacks.onabort?.();
      }
    };
    setImmediate(() => {
      if (behavior === "fail") {
        callbacks.onerror?.({ error: "boom" });
      } else if (behavior === "timeout") {
        callbacks.ontimeout?.();
      } else {
        callbacks.onload?.({
          status: behavior?.status ?? 200,
          responseHeaders,
          response: Uint8Array.from([9, 8, 7])
        });
      }
    });
    return request;
  };
  return { gmFetch, calls };
}

test("native fetch is the transport when no GM seam exists", async () => {
  const nativeCalls = [];
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        nativeCalls.push({ uri, opts });
        return fakeFetchResponse({ status: 206, body: Uint8Array.from([4, 5, 6]) });
      }
    }
  });
  const { via, resp } = await provider.fetch("https://x/seg/1.ts", { headers: { Range: "bytes=0-99" } });
  assert.equal(via, "fetch");
  assert.equal(resp.status, 206);
  assert.equal(resp.headers["content-type"], "video/mp4");
  assert.deepEqual([...resp.body], [4, 5, 6]);
  assert.equal(nativeCalls[0].uri, "https://x/seg/1.ts");
  assert.equal(nativeCalls[0].opts.headers.Range, "bytes=0-99");
});

test("GM is the primary transport; headers and binary payload survive", async () => {
  const { gmFetch, calls } = fakeGMHarness();
  const nativeSpy = { fetch: async () => { throw new Error("should not fall back"); } };
  const provider = new ProxyProvider({ gmFetch, native: nativeSpy });
  const { via, resp } = await provider.fetch("https://x/seg/2.ts", { headers: { Referer: "https://player/" } });
  assert.equal(via, "gm");
  assert.equal(resp.status, 200);
  assert.equal(resp.headers["content-type"], "video/mp4");
  assert.equal(resp.headers["x-seg"], "7");
  assert.deepEqual([...resp.body], [9, 8, 7]);
  assert.equal(calls[0].url, "https://x/seg/2.ts");
  assert.equal(calls[0].headers.Referer, "https://player/");
  assert.equal(calls[0].responseType, "arraybuffer");
});

test("byteRange param becomes a Range header on both GM and native paths", async () => {
  const { gmFetch, calls } = fakeGMHarness();
  const gmProvider = new ProxyProvider({ gmFetch, native: { fetch: async () => { throw new Error("unused"); } } });
  await gmProvider.fetch("https://x/seg/1.m4s", { byteRange: { start: 720, end: 1439 } });
  assert.equal(calls[0].headers.Range, "bytes=720-1439");

  const nativeCalls = [];
  const nativeProvider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        nativeCalls.push(opts);
        return fakeFetchResponse({ status: 206 });
      }
    }
  });
  await nativeProvider.fetch("https://x/seg/2.m4s", { byteRange: "1200-1679" });
  assert.equal(nativeCalls[0].headers.Range, "bytes=1200-1679");
});

test("operator-supplied Range header wins over no byteRange; byteRange overrides both cleanly", async () => {
  const nativeCalls = [];
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        nativeCalls.push(opts);
        return fakeFetchResponse({ status: 206 });
      }
    }
  });
  await provider.fetch("https://x/seg/3.m4s", { headers: { Range: "bytes=0-9" } });
  assert.equal(nativeCalls[0].headers.Range, "bytes=0-9", "caller headers still pass through");
  await provider.fetch("https://x/seg/4.m4s", { byteRange: { start: 1, end: 2 } });
  assert.equal(nativeCalls[1].headers.Range, "bytes=1-2");
});

test("GM wire failure falls back to native fetch", async () => {
  const { gmFetch } = fakeGMHarness({ behavior: "fail" });
  const provider = new ProxyProvider({
    gmFetch,
    native: { fetch: async (uri) => fakeFetchResponse({ status: 200, body: Uint8Array.from([1, 1, 1]) }) }
  });
  const { via, resp } = await provider.fetch("https://x/seg/3.ts");
  assert.equal(via, "fetch");
  assert.equal(resp.status, 200);
});

test("GM timeout falls back to native fetch too", async () => {
  const { gmFetch } = fakeGMHarness({ behavior: "timeout" });
  const provider = new ProxyProvider({
    gmFetch,
    native: { fetch: async () => fakeFetchResponse({ status: 204 }) }
  });
  const { via, resp } = await provider.fetch("https://x/seg/4.ts");
  assert.equal(via, "fetch");
  assert.equal(resp.status, 204);
});

test("an HTTP 403 from GM surfaces as a status, not an exception (token path)", async () => {
  const { gmFetch } = fakeGMHarness({ behavior: { status: 403 } });
  const provider = new ProxyProvider({ gmFetch, native: { fetch: async () => { throw new Error("no fallback for status"); } } });
  const { via, resp } = await provider.fetch("https://x/seg/5.ts");
  assert.equal(via, "gm");
  assert.equal(resp.status, 403, "403 must reach the caller so the token manager can refresh");
});

test("a pre-aborted signal rejects immediately without touching any transport", async () => {
  const controller = new AbortController();
  controller.abort();
  const gmSpy = { gmFetch: async () => { throw new Error("should not be called"); } };
  const provider = new ProxyProvider({
    ...gmSpy,
    native: { fetch: async () => { throw new Error("should not be called"); } }
  });
  await assert.rejects(provider.fetch("https://x/seg/6.ts", { signal: controller.signal }), (err) => err?.name === "AbortError");
});

test("aborting mid-GM cancels the request and never spawns a fallback fetch", async () => {
  const aborted = [];
  const { gmFetch, calls } = fakeGMHarness({ behavior: () => {} });
  const provider = new ProxyProvider({
    gmFetch,
    gmAbort: (req) => aborted.push(req),
    native: { fetch: async () => { throw new Error("no fallback after abort"); } }
  });
  const controller = new AbortController();
  const pending = provider.fetch("https://x/seg/7.ts", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (err) => err?.name === "AbortError");
  assert.equal(aborted.length, 1, "the GM request was told to abort");
});

test("constructor refuses a broken native fetch seam", () => {
  assert.throws(() => new ProxyProvider({ native: { fetch: null } }), TypeError);
});

test("provider constructor default seams do not crash on construction", () => {
  const provider = new ProxyProvider({ native: { fetch: () => {} } });
  assert.ok(provider);
});

test("an HTTP 410 from GM surfaces as a status too", async () => {
  const { gmFetch } = fakeGMHarness({ behavior: { status: 410 } });
  const provider = new ProxyProvider({
    gmFetch,
    native: { fetch: async () => { throw new Error("no fallback"); } }
  });
  const { via, resp } = await provider.fetch("https://x/seg/8.ts");
  assert.equal(via, "gm");
  assert.equal(resp.status, 410);
});