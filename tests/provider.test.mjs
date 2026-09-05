import test from "node:test";
import assert from "node:assert/strict";
import { ProxyProvider } from "../src/shell/proxy/provider.js";
import { logger } from "../src/shared/logger.js";

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
  assert.equal(calls[0].timeout, undefined, "default fetch must not send an explicit 0ms timeout");
});

test("a real requested timeout is forwarded to GM; zero is omitted", async () => {
  const { gmFetch, calls } = fakeGMHarness();
  const nativeSpy = { fetch: async () => { throw new Error("should not fall back"); } };
  const provider = new ProxyProvider({ gmFetch, native: nativeSpy });
  await provider.fetch("https://x/seg/5.ts", { timeoutMs: 15000 });
  assert.equal(calls[0].timeout, 15000);
  await provider.fetch("https://x/seg/6.ts", { timeoutMs: 0 });
  assert.equal(calls[1].timeout, undefined);
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

test("GM whole-file progress is logged at the first byte and once per 64MiB", async () => {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args);
  logger.enable();
  try {
    const mb = 1024 * 1024;
    const gmFetch = (req, callbacks) => {
      callbacks.onprogress({ loaded: 1024, total: 256 * mb });
      callbacks.onprogress({ loaded: 64 * mb + 2048, total: 256 * mb });
      callbacks.onprogress({ loaded: 64 * mb + 2053, total: 256 * mb });
      callbacks.onprogress({ loaded: 128 * mb + 2048, total: 256 * mb });
      setImmediate(() => callbacks.onload?.({ status: 200, responseHeaders: "", response: new Uint8Array(0) }));
      return { abort() {} };
    };
    const provider = new ProxyProvider({ gmFetch, native: { fetch: async () => { throw new Error("unused"); } } });
    const { via, resp } = await provider.fetch("https://x/big.mp4");
    assert.equal(via, "gm");
    assert.equal(resp.status, 200);
    const progress = [];
    for (const args of lines) {
      const gi = args.indexOf("GM progress");
      if (gi > 0) {
        progress.push({ uri: String(args[gi + 1]), text: String(args[gi + 2]) });
      }
    }
    assert.equal(progress.length, 3, "first byte, 64MiB and 128MiB steps only - sub-step deltas stay silent");
    assert.equal(progress[0].uri, "https://x/big.mp4", "first progress reports the uri");
    assert.match(progress[0].text, /0MiB of 256MiB/);
    assert.match(progress[1].text, /64MiB of 256MiB/);
    assert.match(progress[2].text, /128MiB of 256MiB/);
  } finally {
    console.log = realLog;
    logger.disable();
  }
});

test("onProgress forwards GM progress to the caller (oversize railway)", async () => {
  const seen = [];
  const gmFetch = (req, callbacks) => {
    setImmediate(() => {
      callbacks.onprogress?.({ loaded: 1024, total: 4096 });
      callbacks.onprogress?.({ loaded: 2048, total: 4096 });
      callbacks.onload?.({ status: 200, responseHeaders: "", response: new Uint8Array(0) });
    });
    return { abort() {} };
  };
  const provider = new ProxyProvider({ gmFetch, native: { fetch: async () => { throw new Error("unused"); } } });
  await provider.fetch("https://x/big.mp4", { onProgress: (ev) => seen.push(ev) });
  assert.deepEqual(seen, [
    { loaded: 1024, total: 4096 },
    { loaded: 2048, total: 4096 }
  ]);
});

test("native fetch streams the body and forwards chunked progress (oversize railway)", async () => {
  const seen = [];
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.enqueue(new Uint8Array([4, 5]));
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } });
      }
    }
  });
  const { via, resp } = await provider.fetch("https://x/big.mp4", {
    onProgress: (ev) => seen.push(ev)
  });
  assert.equal(via, "fetch");
  assert.deepEqual([...resp.body], [1, 2, 3, 4, 5], "streamed chunks merge to the same bytes as a whole-body read");
  assert.deepEqual(seen, [
    { loaded: 3, total: 0 },
    { loaded: 5, total: 0 }
  ]);
});

test("a response without a streamable body keeps the arrayBuffer fallback", async () => {
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => fakeFetchResponse({ status: 206, body: Uint8Array.from([4, 5, 6]) })
    }
  });
  const { via, resp } = await provider.fetch("https://x/seg/9.ts", { byteRange: "0-99" });
  assert.equal(via, "fetch");
  assert.deepEqual([...resp.body], [4, 5, 6]);
});

test("aborting a native-streamed fetch mid-body rejects and cancels the reader", async () => {
  const controller = new AbortController();
  const cancelled = [];
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        const stream = new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(16));
          },
          cancel(reason) {
            cancelled.push(reason?.name ?? "cancel");
          }
        });
        return new Response(stream, { status: 200 });
      }
    }
  });
  const pending = provider.fetch("https://x/big.mp4", {
    signal: controller.signal,
    onProgress: () => controller.abort()
  });
  await assert.rejects(pending, (err) => err?.name === "AbortError");
  assert.equal(cancelled.length, 1, "the native body read was cancelled instead of partial-buffered");
});

test("a single-chunk streamed body passes through without a copy", async () => {
  const chunk = new Uint8Array([7, 8, 9]);
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          }
        });
        return new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } });
      }
    }
  });
  const { resp } = await provider.fetch("https://x/single.mp4");
  assert.deepEqual([...resp.body], [7, 8, 9]);
  assert.equal(resp.body, chunk, "the single read is returned without a copy");
});

test("a requested timeout aborts the native-wire fetch too", async () => {
  const passedSignals = [];
  const provider = new ProxyProvider({
    native: {
      fetch: async (uri, opts) => {
        passedSignals.push(opts.signal);
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }
    }
  });
  await assert.rejects(
    provider.fetch("https://x/big.mp4", { timeoutMs: 25 }),
    (err) => err?.name === "AbortError",
    "the fallback wire honors the caller's timeout via a composed signal"
  );
  assert.equal(passedSignals.length, 1, "the native wire received the composed timeout signal");
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