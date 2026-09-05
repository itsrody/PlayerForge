import test from "node:test";
import assert from "node:assert/strict";
import { Mp4Router } from "../src/shell/proxy/mp4.js";
import { routeProgressiveSource, disposeElementSource } from "../src/shell/proxy/element-route.js";

const GET_VIDEO_URL =
  "https://streamtape.com/get_video?id=VzGml9j9zMsKvxx&expires=1788640920&ip=F0INKRSUEy9XKxR&token=H6V4Z60CJoCK&stream=1";

const TAPECONTENT_URL =
  "https://861134084.tapecontent.net/radosgw/gPrwpBklmGSqb2D/bFe6MQ9sc8pdfb0ObTOMm43Is42cjnPHmYqgpwyT4heJjZ1zWjeiinApr6kcr4AQdLMz/token/supjav.com%40SNOS-153-UB.mp4";

const MP4_BYTES = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function makeRouter(handler) {
  return new Mp4Router({
    provider: { fetch: handler },
    enabledFor: () => true
  });
}

function makeHarness(overrides = {}) {
  const state = { objectUrls: [], revoked: [], routes: [] };
  const video = { currentSrc: "", src: overrides.src ?? GET_VIDEO_URL };
  const harness = {
    video,
    state,
    result: null
  };
  harness.run = () =>
    routeProgressiveSource({
      video,
      router: overrides.router ?? makeRouter(overrides.handler),
      getSetting: overrides.getSetting ?? (() => true),
      enabledFor: overrides.enabledFor ?? (() => true),
      baseUrl: overrides.baseUrl ?? "https://player.example/watch",
      makeObjectUrl: (blob) => {
        state.objectUrls.push(blob);
        return `blob:pf-${state.objectUrls.length}`;
      },
      revokeObjectUrl: (url) => state.revoked.push(url),
      onRoute: (record) => state.routes.push(record)
    });
  return harness;
}

test("routes a video.src MP4 through the proxy and swaps the element src to an object URL", async () => {
  const h = makeHarness({
    src: "https://cdn.example/MOVIE.mp4",
    handler: async () => ({
      via: "gm",
      resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES }
    })
  });
  h.result = await h.run();
  assert.ok(h.result, "the src was routed");
  assert.equal(h.result.url, "https://cdn.example/MOVIE.mp4");
  assert.equal(h.result.bytes, MP4_BYTES.byteLength);
  assert.equal(h.video.src, "blob:pf-1", "the element now plays the proxied bytes");
  const blob = h.state.objectUrls[0];
  assert.equal(blob.size, MP4_BYTES.byteLength);
  assert.equal(blob.type, "video/mp4", "media-safe content-type is preserved on the blob");
  assert.equal(h.state.routes.length, 1);
});

test("routes a StreamTape get_video src by peeling the redirect to the tokenized tapecontent file", async () => {
  const h = makeHarness({
    src: GET_VIDEO_URL,
    handler: async (url) => {
      if (url === GET_VIDEO_URL) {
        return {
          via: "gm",
          resp: { status: 302, headers: { location: TAPECONTENT_URL }, body: new Uint8Array(0) }
        };
      }
      return {
        via: "gm",
        resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES }
      };
    }
  });
  h.result = await h.run();
  assert.ok(h.result, "redirect-peeled element route succeeded");
  assert.equal(h.result.bytes, MP4_BYTES.byteLength);
  assert.equal(h.video.src, "blob:pf-1");
});

test("keeps the native wire for a blob: src", async () => {
  const h = makeHarness({
    src: "blob:https://player.example/eeee0f74-b0c2-4a9e-9e64-38f1b1e5c8f0",
    handler: async () => {
      throw new Error("unused");
    }
  });
  h.result = await h.run();
  assert.equal(h.result, null);
  assert.equal(h.video.src, "blob:https://player.example/eeee0f74-b0c2-4a9e-9e64-38f1b1e5c8f0", "blob src never touched");
  assert.equal(h.state.objectUrls.length, 0);
});

test("keeps the native wire for non-MP4 srcs (manifests and plain assets)", async () => {
  for (const src of [
    "https://x/master.m3u8",
    "https://x/man.mpd",
    "https://x/logo.svg",
    "https://x/style.css"
  ]) {
    const h = makeHarness({
      src,
      handler: async () => {
        throw new Error(`unused for ${src}`);
      }
    });
    h.result = await h.run();
    assert.equal(h.result, null, `${src} must stay native`);
    assert.equal(h.video.src, src);
  }
});

test("keeps the native wire when the mp4Fallback switch is off", async () => {
  const h = makeHarness({
    getSetting: (key) => key === "features.mp4Fallback" ? false : true,
    handler: async () => {
      throw new Error("unused");
    }
  });
  h.result = await h.run();
  assert.equal(h.result, null);
  assert.equal(h.video.src, GET_VIDEO_URL);
});

test("keeps the native wire when the router declines and when the wire fails", async () => {
  const declined = makeHarness({
    router: new Mp4Router({ provider: { fetch: async () => ({ via: "gm", resp: { status: 404, headers: {}, body: new Uint8Array() } }) }, enabledFor: () => true })
  });
  assert.equal(await declined.run(), null, "a non-2xx keeps the native wire");
  assert.equal(declined.video.src, GET_VIDEO_URL);

  const failed = makeHarness({
    router: new Mp4Router({ provider: { fetch: async () => { throw new TypeError("boom"); } }, enabledFor: () => true })
  });
  assert.equal(await failed.run(), null, "a wire failure keeps the native wire");
  assert.equal(failed.video.src, GET_VIDEO_URL);
});

test("keeps the native wire when the region declines the element", async () => {
  const h = makeHarness({
    enabledFor: () => false,
    handler: async () => {
      throw new Error("unused");
    }
  });
  h.result = await h.run();
  assert.equal(h.result, null);
  assert.equal(h.video.src, GET_VIDEO_URL);
});

test("keeps the native wire when object URL creation is unavailable", async () => {
  const router = makeRouter(async () => ({
    via: "gm",
    resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES }
  }));
  const result = await routeProgressiveSource({
    video: { currentSrc: "", src: "https://cdn.example/MOVIE.mp4" },
    router,
    getSetting: () => true,
    makeObjectUrl: () => null,
    baseUrl: "https://player.example/watch"
  });
  assert.equal(result, null, "no object URL = no swap");
});

test("re-routing an already-routed element is skipped and its object URL stays live", async () => {
  const h = makeHarness({
    src: "https://cdn.example/A.mp4",
    handler: async () => ({
      via: "gm",
      resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES }
    })
  });
  h.result = await h.run();
  assert.ok(h.result);
  const second = await h.run();
  assert.equal(second, null, "already-routed element is skipped");
  assert.equal(h.state.objectUrls.length, 1, "no second blob");
  assert.equal(h.state.revoked.length, 0, "the first object URL stays live");
});

test("disposeElementSource revokes the routed object URL", async () => {
  const h = makeHarness({
    handler: async () => ({
      via: "gm",
      resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES }
    })
  });
  h.result = await h.run();
  assert.ok(h.result);
  disposeElementSource(h.video, { revokeObjectUrl: (url) => h.state.revoked.push(url) });
  assert.deepEqual(h.state.revoked, ["blob:pf-1"]);
  assert.equal(h.video.src, "blob:pf-1", "dispose revokes the URL, it does not clear the element src");
});

test("keeps the native wire when an oversized whole-file route is reported", async () => {
  const probes = [];
  const router = makeRouter(async (url, opts) => {
    probes.push(opts);
    // The seam's progress railway reports the total; the seam aborts; the
    // wire observes the aborted signal and stops instead of downloading 10GiB.
    opts.onProgress?.({ loaded: 2048, total: 10 * 1024 * 1024 * 1024 });
    if (opts.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array(0) } };
  });
  const result = await routeProgressiveSource({
    video: { currentSrc: "", src: "https://cdn.example/HUGE.mp4" },
    router,
    getSetting: () => true,
    maxBytes: 1024,
    makeObjectUrl: () => "blob:pf-should-not-happen"
  });
  assert.equal(result, null, "oversized route stays native");
  assert.equal(probes.length, 1, "the proxied GET was attempted");
  assert.ok(probes[0].signal, "the seam passed its abort signal");
});

test("oversized delivery after an abort race is never swapped", async () => {
  let callWithOptions;
  const router = makeRouter(async (url, opts) => {
    callWithOptions = opts;
    return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: new Uint8Array([0, 0, 0, 0]) } };
  });
  const result = await routeProgressiveSource({
    video: { currentSrc: "", src: "https://cdn.example/HUGE.mp4" },
    router,
    getSetting: () => true,
    maxBytes: 3,
    makeObjectUrl: () => "blob:pf-should-not-happen"
  });
  assert.equal(result, null, "an oversized final blob never becomes a swap");
  assert.ok(callWithOptions.onProgress, "the seam wired the progress railway");
});

test("a scheme-relative src resolves against the frame before routing", async () => {
  const seen = [];
  const h = makeHarness({
    src: "//streamtape.com/get_video?id=abc&stream=1",
    baseUrl: "https://player.example/watch",
    handler: async (url) => {
      seen.push(url);
      return { via: "gm", resp: { status: 200, headers: { "content-type": "video/mp4" }, body: MP4_BYTES } };
    }
  });
  h.result = await h.run();
  assert.ok(h.result);
  assert.equal(seen[0], "https://streamtape.com/get_video?id=abc&stream=1", "the provider gets an absolute URL");
});