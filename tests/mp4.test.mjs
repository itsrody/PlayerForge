import test from "node:test";
import assert from "node:assert/strict";
import { isMp4StreamUrl, isMp4ContentType, mediaSafeType, Mp4Router } from "../src/kernel/proxy/stream-transport.js";
import { interposeFetch, interposeXhrPrototype } from "../src/kernel/proxy/manifest-pipe.js";

const GET_VIDEO_URL =
  "https://streamtape.com/get_video?id=VzGml9j9zMsKvxx&expires=1788640920&ip=F0INKRSUEy9XKxR&token=H6V4Z60CJoCK&stream=1";

const TAPECONTENT_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/bFe6MQ9sc8pdfb0ObTOMm43Is42cjnPHmYqgpwyT4heJjZ1zWjeiinApr6kcr4AQdLMz-6HguehCQqlY-dDX2ylLcXut0gFWvHjXv6GZMsnWlDSwyAWVWODAp0YRVok0Isd-Qb6CAWnbLwOXr02-cnomCFGM16_98B1tUuR1yUTgJCzZ70CY4yk-dEsmPmvwJmCrIhfzBwHDWOyeSzjCzXjPWrO0V_1-ydWGhwFJEPfdf3zdpEaTaBa_bjqyotcu12B2RK3KAib-jR3-u-uWdFZOTxdYoj--Ys85vg/supjav.com%40SNOS-153-UB.mp4";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("isMp4StreamUrl matches progressive MP4 shapes only", () => {
  assert.equal(isMp4StreamUrl("https://x/video.mp4"), true);
  assert.equal(isMp4StreamUrl("https://x/video.mp4?stream=1"), true);
  assert.equal(isMp4StreamUrl("https://x/VIDEO.MP4"), true);
  assert.equal(isMp4StreamUrl(GET_VIDEO_URL), true);
  assert.equal(isMp4StreamUrl("https://x/MOVIE.mp4"), true);
  assert.equal(isMp4StreamUrl("https://x/MOVIE.mp4?play"), true);
  assert.equal(isMp4StreamUrl("https://x/player.js?get_video=1"), true);
  assert.equal(isMp4StreamUrl(TAPECONTENT_URL), true, "StreamTape redirects land on tokenized tapecontent/radosgw .mp4 URLs");
  assert.equal(isMp4StreamUrl("https://861134084.tapecontent.net/radosgw/token/MOVIE.mp4?X-Amz-Signature=sig"), true);
  assert.equal(isMp4StreamUrl("https://861134084.tapecontent.net/assets/logo.svg"), false, "plain shard assets stay native");
  assert.equal(isMp4StreamUrl("https://x/get_video?id=abc"), true);
  assert.equal(isMp4StreamUrl("https://x/watch?id=abc&stream=1"), true);
  assert.equal(isMp4StreamUrl("https://x/play?stream=1"), true);
  assert.equal(isMp4StreamUrl("https://x/master.m3u8"), false);
  assert.equal(isMp4StreamUrl("https://x/manifest.mpd"), false);
  assert.equal(isMp4StreamUrl("https://x/seg.ts"), false);
  assert.equal(isMp4StreamUrl("https://x/master.mp4/"), false);
  assert.equal(isMp4StreamUrl("https://x/style.css"), false);
  assert.equal(isMp4StreamUrl("blob:null/uuid"), false);
  assert.equal(isMp4StreamUrl(""), false);
});

test("isMp4ContentType matches video/mp4 with codec params", () => {
  assert.equal(isMp4ContentType("video/mp4"), true);
  assert.equal(isMp4ContentType('video/mp4; codecs="avc1.640028,mp4a.40.2"'), true);
  assert.equal(isMp4ContentType("VIDEO/MP4"), true);
  assert.equal(isMp4ContentType("application/octet-stream"), false);
  assert.equal(isMp4ContentType("video/webm"), false);
  assert.equal(isMp4ContentType(""), false);
});

test("mediaSafeType coerces only non-media labels", () => {
  assert.equal(mediaSafeType("video/mp4"), "video/mp4");
  assert.equal(mediaSafeType("audio/mp4"), "audio/mp4");
  assert.equal(mediaSafeType("application/octet-stream"), "video/mp4");
  assert.equal(mediaSafeType("binary/octet-stream"), "video/mp4");
  assert.equal(mediaSafeType(""), "video/mp4");
  assert.equal(mediaSafeType(undefined), "video/mp4");
});

test("Mp4Router rejects a missing provider", () => {
  assert.throws(() => new Mp4Router({}), TypeError);
});

test("Mp4Router.routeRequest issues the proxy GET and fabricates the page Response", async () => {
  const fetched = [];
  const router = new Mp4Router({
    provider: {
      fetch: async (url) => {
        fetched.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([1, 2, 3]) } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  const out = await router.routeRequest(GET_VIDEO_URL);
  assert.deepEqual(fetched, [GET_VIDEO_URL], "the originating GET is the proxy's");
  assert.equal(out.status, 200);
  assert.equal(out.init.headers["content-type"], "video/mp4");
  assert.deepEqual([...out.body], [1, 2, 3], "the page receives the proxied bytes");
});

test("routeRequest with stream:true passes a native ReadableStream body through", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([3, 2, 1]));
      controller.close();
    }
  });
  const router = new Mp4Router({
    provider: {
      fetch: async (url, opts) => {
        assert.equal(opts.stream, true, "the router asks the provider for a passthrough stream");
        return { via: "fetch", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: stream, streamed: true } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  const out = await router.routeRequest(GET_VIDEO_URL, { stream: true });
  assert.equal(out.status, 200);
  assert.ok(typeof out.body?.getReader === "function", "the page-facing response streams the native body");
  const reader = out.body.getReader();
  const { value } = await reader.read();
  assert.deepEqual([...value], [3, 2, 1]);
});

test("routeRequest without stream keeps the buffered-whole model (bytes, not a stream)", async () => {
  let requested = null;
  const router = new Mp4Router({
    provider: {
      fetch: async (url, opts) => {
        requested = opts;
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([5]) } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  await router.routeRequest(GET_VIDEO_URL);
  assert.equal(requested.stream, false, "the default route is the whole-file model");
});

test("Mp4Router coerces an octet-stream label to a playable media type", async () => {
  const router = new Mp4Router({
    provider: {
      fetch: async () => ({ via: "gm", resp: { status: 200, headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(1) } })
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  const out = await router.routeRequest(GET_VIDEO_URL);
  assert.equal(out.init.headers["content-type"], "video/mp4", "the fabricated Response declares video/mp4");
});

test("Mp4Router follows a redirect chain to the real mp4 through the proxy", async () => {
  const urlLog = [];
  const router = new Mp4Router({
    provider: {
      fetch: async (url) => {
        urlLog.push(url);
        if (!url.includes("-final.mp4")) {
          return {
            via: "gm",
            resp: { status: 302, headers: { location: "https://cdn.example/real-5cd1-final.mp4?tk=77" }, body: new Uint8Array(0) }
          };
        }
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([1, 2, 3]) } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  const out = await router.routeRequest(GET_VIDEO_URL);
  assert.deepEqual(urlLog, [GET_VIDEO_URL, "https://cdn.example/real-5cd1-final.mp4?tk=77"], "the 3xx is peeled, the real file is the proxied GET");
  assert.equal(out.status, 200);
  assert.equal(out.init.headers["content-type"], "video/mp4");
  assert.deepEqual([...out.body], [1, 2, 3]);
});

test("Mp4Router gives up a redirect loop and keeps the native wire", async () => {
  let fetches = 0;
  const router = new Mp4Router({
    provider: {
      fetch: async () => {
        fetches += 1;
        return { via: "gm", resp: { status: 302, headers: { Location: "https://cdn.example/loop.mp4" }, body: new Uint8Array(0) } };
      }
    },
    enabledFor: () => true
  });
  const out = await router.routeRequest(GET_VIDEO_URL);
  assert.equal(out, null);
  assert.ok(fetches <= 6, `redirects bounded (was ${fetches})`);
});

test("Mp4Router redirect without a Location keeps the native wire", async () => {
  const router = new Mp4Router({
    provider: { fetch: async () => ({ via: "gm", resp: { status: 302, headers: {}, body: new Uint8Array(0) } }) },
    enabledFor: () => true
  });
  assert.equal(await router.routeRequest(GET_VIDEO_URL), null);
});

test("Mp4Router.routeRequest stays on the native wire when declined or failed", async () => {
  const never = new Mp4Router({
    provider: { fetch: async () => { throw new Error("unused"); } },
    enabledFor: () => false
  });
  assert.equal(await never.routeRequest(GET_VIDEO_URL), null, "out-of-policy keeps the wire");

  const failed = new Mp4Router({
    provider: { fetch: async () => { throw new TypeError("boom"); } },
    enabledFor: () => true
  });
  assert.equal(await failed.routeRequest(GET_VIDEO_URL), null, "wire failure keeps the wire");

  const nonOk = new Mp4Router({
    provider: { fetch: async () => ({ via: "gm", resp: { status: 404, headers: {}, body: new Uint8Array() } }) },
    enabledFor: () => true
  });
  assert.equal(await nonOk.routeRequest(GET_VIDEO_URL), null, "a non-2xx keeps the wire");
});

test("routeRequest threads an abort signal and progress railway into the provider", async () => {
  const seen = [];
  const router = new Mp4Router({
    provider: {
      fetch: async (url, opts) => {
        seen.push(opts);
        return { via: "gm", resp: { status: 200, headers: {}, body: new Uint8Array([1, 2]) } };
      }
    },
    enabledFor: () => true
  });
  const signal = new AbortController().signal;
  const onProgress = () => {};
  const out = await router.routeRequest("https://x/MOVIE.mp4", { signal, onProgress });
  assert.ok(out, "routed normally");
  assert.equal(seen[0].signal, signal, "the caller's signal reaches the wire");
  assert.equal(seen[0].onProgress, onProgress, "the caller's progress railway reaches the wire");
});

test("interposed fetch routes an MP4 fetch through the wire before the page fetch", async () => {
  const routed = [];
  const wrapper = interposeFetch({
    fetch: async (uri) => {
      routed.push(`native:${uri}`);
      return { ok: true };
    },
    shouldCapture: (url) => url === GET_VIDEO_URL,
    rewrite: (url, text) => ({ text, decision: "native" }),
    route: async (url) => {
      routed.push(`proxy:${url}`);
      return { proxyResponse: true };
    },
    onOutcome: () => {}
  });
  const out = await wrapper(GET_VIDEO_URL);
  assert.deepEqual(routed, [`proxy:${GET_VIDEO_URL}`], "the proxy GET is the only request");
  assert.equal(out.proxyResponse, true);
});

test("interposed fetch keeps the native wire when routing declines", async () => {
  const routed = [];
  const wrapper = interposeFetch({
    fetch: async (uri) => {
      routed.push(`native:${uri}`);
      return { native: true };
    },
    shouldCapture: (url) => url === GET_VIDEO_URL,
    rewrite: (url, text) => ({ text, decision: "native" }),
    isManifest: () => false,
    route: async () => null,
    onOutcome: () => {}
  });
  const out = await wrapper(GET_VIDEO_URL);
  assert.deepEqual(routed, [`native:${GET_VIDEO_URL}`]);
  assert.equal(out.native, true);
});

test("routeRequest byShape routes a segment-shaped URL the caller classified", async () => {
  const fetched = [];
  const router = new Mp4Router({
    provider: {
      fetch: async (url, opts) => {
        fetched.push({ url, stream: opts?.stream });
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp2t" }, body: new Uint8Array([9]) } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  assert.equal(await router.routeRequest("https://cdn.example/seg/1.ts"), null, "the progressive-MP4 shape gate blocks a .ts by default");
  const out = await router.routeRequest("https://cdn.example/seg/1.ts", { byShape: true, stream: true });
  assert.deepEqual(fetched, [{ url: "https://cdn.example/seg/1.ts", stream: true }]);
  assert.equal(out.status, 200);
  assert.deepEqual([...out.body], [9]);
});

test("routeRequest byShape still honors the policy gate", async () => {
  const never = new Mp4Router({ provider: { fetch: async () => { throw new Error("unused"); } }, enabledFor: () => false });
  assert.equal(await never.routeRequest("https://cdn.example/seg/1.ts", { byShape: true }), null);
});

test("routeContent bypasses the URL-shape gate for content-type-armed callers", async () => {
  const fetched = [];
  const router = new Mp4Router({
    provider: {
      fetch: async (url) => {
        fetched.push(url);
        return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([7]) } };
      }
    },
    enabledFor: () => true,
    makeResponse: (body, init) => ({ status: init.status, body, init })
  });
  assert.equal(
    await router.routeRequest("https://x/v?e=abc123"),
    null,
    "URL-shape routing leaves a shapeless URL on the native wire"
  );
  const out = await router.routeContent("https://x/v?e=abc123");
  assert.deepEqual(fetched, ["https://x/v?e=abc123"]);
  assert.equal(out.status, 200);
  assert.equal(out.init.headers["content-type"], "video/mp4");
});

test("a shapeless URL returning video/mp4 is re-routed through the proxy", async () => {
  const calls = [];
  const wrapper = interposeFetch({
    fetch: async () => {
      calls.push("native");
      return new Response(new Uint8Array([1]), { headers: { "content-type": "video/mp4" } });
    },
    shouldCapture: () => false,
    rewrite: (url, text) => ({ text, decision: "native" }),
    routeContent: async (url) => {
      calls.push(`proxy:${url}`);
      return { proxied: true };
    },
    onOutcome: () => {}
  });
  const out = await wrapper("https://x/v?e=abc123");
  assert.deepEqual(calls, ["native", "proxy:https://x/v?e=abc123"], "content-type arms the proxy GET");
  assert.equal(out.proxied, true);
});

test("a shapeless non-mp4 response stays fully native", async () => {
  const calls = [];
  const wrapper = interposeFetch({
    fetch: async () => {
      calls.push("native");
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    shouldCapture: () => false,
    rewrite: (url, text) => ({ text, decision: "native" }),
    routeContent: async (url) => {
      calls.push(`proxy:${url}`);
      return { proxied: true };
    },
    onOutcome: () => {}
  });
  const out = await wrapper("https://x/api/info");
  assert.deepEqual(calls, ["native"], "routeContent is never consulted for non-video content");
  assert.equal(await out.text(), "{}");
});

test("XHR captures a video/mp4 response even from a shapeless URL", () => {
  const captures = [];
  const proto = { send() {} };
  const xhr = {
    url: "https://x/vpl",
    responseURL: "https://x/vpl",
    getResponseHeader: () => "video/mp4",
    responseType: "",
    addEventListener: (name, fn) => {
      xhr._onload = fn;
    },
    send() {
      return proto.send.call(this);
    }
  };
  interposeXhrPrototype(proto, {
    shouldCapture: () => false,
    rewrite: () => ({ text: "", decision: "rewrite" }),
    isManifest: () => false,
    onCapture: (record) => captures.push(record)
  });
  xhr.send();
  const onloadFn = xhr._onload;
  xhr.responseText = "not a manifest";
  onloadFn();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, "https://x/vpl");
  assert.equal(captures[0].contentType, "video/mp4");
  assert.equal(xhr.responseText, "not a manifest", "content-type captures are never text-rewritten");
});

test("XHR captures an MP4 response but never rewrites its text", () => {
  const captures = [];
  const proto = { send() {} };
  const xhr = {
    url: GET_VIDEO_URL,
    responseURL: GET_VIDEO_URL,
    getResponseHeader: () => "video/mp4",
    responseType: "",
    addEventListener: (name, fn) => {
      xhr._onload = fn;
    },
    send() {
      return proto.send.call(this);
    }
  };
  interposeXhrPrototype(proto, {
    shouldCapture: (url) => url === GET_VIDEO_URL,
    rewrite: (url, body) => ({ text: body, decision: "rewrite" }),
    isManifest: () => false,
    onCapture: (record) => captures.push(record)
  });
  xhr.send();
  const onloadFn = xhr._onload;
  xhr.responseText = "not a manifest";
  onloadFn();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].url, GET_VIDEO_URL);
  assert.equal(xhr.responseText, "not a manifest", "an mp4 capture never has its text rewritten");
});