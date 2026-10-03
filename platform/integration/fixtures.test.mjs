/**
 * Fixture coverage: the five embed shapes, each with real media.
 *
 * Every shape here already had a fixture. What they all lacked was a video src,
 * so a shell was created and nothing media-dependent could be asserted anywhere
 * off the top document: readyState 0, duration NaN, and the resume tracker skips
 * a video it cannot time. The fixtures proved the kernel adopts a frame's video;
 * they could not prove anything about what PF then does with it.
 *
 * The five shapes, and what each is uniquely for:
 *
 *   direct            top document, no frame. Proves the baseline every other
 *                     shape is compared against.
 *   same-origin iframe PF can read window.top directly, so the frame bridge is
 *                     never used. This is the case where a broken bridge would
 *                     go unnoticed, because the fallback path is not the only
 *                     path here.
 *   cross-origin      window.top throws. The bridge is the ONLY way this frame
 *                     learns the top page's domain and path, and getPageContext
 *                     inherits them rather than reporting its own.
 *   nested            parent -> relay -> video, the video frame same-origin with
 *                     the relay but not with the top. Two hops, so a relay that
 *                     forwards but does not relay the ANSWER back is a distinct
 *                     failure from a relay that never receives the request.
 *   switchboard       N cross-origin cards, one live iframe at a time, the rest
 *                     placeholders. Tested in both placeholder strategies,
 *                     because the realm dies in both and only the ELEMENT
 *                     differs - see the parked test for what that does and
 *                     does not buy.
 *
 * A placeholder is asserted as a NEGATIVE case in two forms, because they are
 * different claims: a frame element that never received a src must produce no
 * shell, and a frame whose src was cleared must stop being counted as live.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FirefoxDriver,
  createTestPage,
  createTestMedia,
  createIframeChildPage,
  createIframeParentPage,
  createNestedIframePages,
  createMultiOriginServersN,
  createSwitchboardChildPage,
  createNestedSwitchboardChildPage,
  createSwitchboardPage,
} from "../harness/firefox.mjs";

const MEDIA_SECONDS = 90;

let driver;
let servers;

/**
 * Start every test from an empty store.
 *
 * All eight share one driver, so the store carries over: without this the
 * direct test's entry is still entries[0] when the cross-origin test runs, and
 * the test asserts the direct page's path is inherited by a frame - which is
 * false, and for a reason that has nothing to do with the frame.
 */
const freshStore = async () => {
  await driver.gmRemoteDelete("pf:resume");
};

/** Poll until ready, rather than sleeping a fixed guess. */
async function until(fn, timeout = 10000, step = 100) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, step));
  }
  return last;
}

test.before(async () => {
  // Five origins on five ports. Same domain key, five genuinely distinct
  // origins, which is what makes the cross-origin shapes real rather than
  // simulated with sandbox or document.domain.
  servers = await createMultiOriginServersN(5);
  driver = await FirefoxDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  for (const s of servers ?? []) await s.stop();
});

/**
 * What a frame's video can actually tell us, read from inside that frame.
 *
 * The id is an argument, not a closure, because executeScript re-serializes the
 * function and runs it in the page: anything captured by an enclosing scope
 * arrives as `undefined` and a default parameter is gone too. Anything a page
 * function needs has to come in through `arguments`.
 *
 * The switchboard fixtures give each card a DISTINCT video id on purpose: one
 * shared #test-video across every card makes "card 2 loaded" and "card 1 never
 * went away" indistinguishable.
 */
const readVideo = (id) => {
  const v = document.getElementById(id || "test-video");
  return {
    hasShell: !!document.querySelector(".pf-shell"),
    marked: !!v?.hasAttribute("data-pf-shell"),
    readyState: v?.readyState ?? -1,
    duration: Number.isFinite(v?.duration) ? v.duration : null,
  };
};

test("direct: real media in the top document", async () => {
  await freshStore();
  const url = createTestPage(servers[0], {
    videoSrc: createTestMedia(servers[0], MEDIA_SECONDS),
  });
  await driver.navigate(url);
  await driver.injectScript();

  const st = await until(async () => {
    const r = await driver.eval(readVideo, undefined);
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "a shell is built for the top-document player");
  assert.ok(st.marked, "the video is marked with data-pf-shell");
  assert.ok(st.readyState > 0, `media is loaded, readyState=${st.readyState}`);
  assert.equal(st.duration, MEDIA_SECONDS, "duration is real, so resume can time this video");
});

test("same-origin iframe: media loads and the frame is adopted", async () => {
  await freshStore();
  // Media is served by the CHILD's own server, which here is the same server.
  // A relative path would have worked in this one case and broken in every
  // cross-origin case, so the fixtures take absolute URLs throughout.
  const child = createIframeChildPage(servers[1], {
    videoSrc: createTestMedia(servers[1], MEDIA_SECONDS),
  });
  const parent = createIframeParentPage(servers[1], child, { iframeId: "child-frame" });

  await driver.navigate(parent);
  await driver.injectScript();
  await driver.injectScriptInFrame("child-frame");

  const st = await until(async () => {
    const r = await driver.evalInFrame("child-frame", readVideo);
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "the frame's video is adopted");
  assert.ok(st.readyState > 0, `media loads in the frame, readyState=${st.readyState}`);
  assert.equal(st.duration, MEDIA_SECONDS, "duration is real inside the frame");
});

test("cross-origin iframe: the bridge supplies the top page's context", async () => {
  await freshStore();
  // Video on serverB, parent on serverA. window.top throws from the child, so
  // getPageContext can only reach the top page's domain and path over
  // postMessage. The resume entry written must therefore carry the TOP page's
  // path, not the child's - that inheritance is the whole point of the bridge.
  const child = createIframeChildPage(servers[2], {
    videoSrc: createTestMedia(servers[2], MEDIA_SECONDS),
  });
  const parent = createIframeParentPage(servers[0], child, {
    iframeId: "child-frame",
    title: "Cross-Origin Parent",
  });

  await driver.navigate(parent);
  await driver.injectScript();
  await driver.injectScriptInFrame("child-frame");

  const st = await until(async () => {
    const r = await driver.evalInFrame("child-frame", readVideo);
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "a cross-origin frame is adopted");

  // The cross-origin proof: the child genuinely cannot read its own ancestor.
  const canReadTop = await driver.evalInFrame("child-frame", () => {
    try {
      return { ok: true, path: window.top.location.pathname };
    } catch (e) {
      // e.name, not e.constructor.name: SecurityError is a DOMException
      // SUBTYPE, so the constructor reports the interface ("DOMException") and
      // only name carries the specific code. Asserting the constructor name here
      // fails on a genuinely cross-origin frame, which is backwards.
      return { ok: false, name: e.name, isDomException: e instanceof DOMException };
    }
  });
  assert.equal(canReadTop.ok, false, "the child really is cross-origin from the top page");
  assert.equal(canReadTop.name, "SecurityError", "and it fails with SecurityError, not a soft failure");
  assert.ok(canReadTop.isDomException, "the failure is a DOMException, i.e. a real access denial");

  // The child inherited the top page's path through the bridge, so the resume
  // entry is keyed to the embedder rather than to the frame's own URL.
  const stored = await driver.gmStorage();
  const entries = stored["pf:resume"]?.entries ?? [];
  assert.ok(entries.length > 0, "the frame's player wrote a resume entry");
  assert.equal(
    entries[0].path,
    new URL(parent).pathname,
    `the entry inherits the TOP page's path over the bridge, got ${entries[0].path}`
  );
});

test("nested iframe: the video frame inherits context through a relay", async () => {
  await freshStore();
  // parent -> relay -> video. The video frame is same-origin with the relay and
  // cross-origin with the top, so it needs both hops to succeed: a relay that
  // forwards the request but never returns the ANSWER fails here while still
  // working in a single-hop test.
  const { parentUrl } = createNestedIframePages(servers[0], servers[3], {
    depth: 3,
    videoSrc: createTestMedia(servers[3], MEDIA_SECONDS),
  });

  await driver.navigate(parentUrl);
  await driver.injectScript();
  // ["outer-frame", "inner-frame"], not two one-hop calls: frame ids resolve
  // against the current context, so the second call would search the top
  // document for an element that only exists inside the outer frame.
  await driver.injectScriptInFramePath(["outer-frame", "inner-frame"]);

  const st = await until(async () => {
    const r = await driver.evalInFramePath(["outer-frame", "inner-frame"], readVideo);
    return r.hasShell && r.readyState > 0 ? r : null;
  }, 15000);
  assert.ok(st?.hasShell, "the innermost frame's video is adopted");
  assert.ok(st.readyState > 0, `media loads two frames deep, readyState=${st.readyState}`);

  const stored = await driver.gmStorage();
  const entries = stored["pf:resume"]?.entries ?? [];
  assert.ok(entries.length > 0, "the nested player wrote a resume entry");
  assert.equal(
    entries[0].path,
    new URL(parentUrl).pathname,
    "context reaches the innermost frame through the relay, so the path is the top page's"
  );
});

test("nested iframe at depth 2 needs no relay", async () => {
  await freshStore();
  // parent -> video directly, with the video frame cross-origin. Distinct from
  // depth 3 above: one hop, so this is the case a relay bug cannot explain.
  const { parentUrl } = createNestedIframePages(servers[0], servers[3], {
    depth: 2,
    videoSrc: createTestMedia(servers[3], MEDIA_SECONDS),
  });

  await driver.navigate(parentUrl);
  await driver.injectScript();
  await driver.injectScriptInFrame("outer-frame");

  const st = await until(async () => {
    const r = await driver.evalInFrame("outer-frame", readVideo);
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "a single cross-origin hop is adopted");
  assert.ok(st.readyState > 0, `media loads one frame deep, readyState=${st.readyState}`);
});

test("switchboard: one live cross-origin card, the rest placeholders", async () => {
  await freshStore();
  // Three cards on three origins. Exactly one iframe exists at a time, and
  // __getLoadedCount() === 1 is what proves teardown is real: when a card
  // unloads, its realm, GM listener, shell and bridge ports die with the frame.
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const s = servers[i];
    cards.push({
      name: `Server ${i}`,
      url: createSwitchboardChildPage(s, {
        name: `Server ${i}`,
        videoSrc: createTestMedia(s, MEDIA_SECONDS),
        id: `video-${i}`,
      }),
    });
  }
  const parent = createSwitchboardPage(servers[0], cards, { placeholderMode: "swap" });

  await driver.navigate(parent);
  await driver.injectScript();

  const initial = await driver.eval(() => window.__getLoadedCount());
  assert.equal(initial, 0, "nothing is loaded before a card is clicked");

  const allPlaceholder = await driver.eval(() =>
    Array.from(document.querySelectorAll(".server-card")).every((c) =>
      c.classList.contains("placeholder")
    )
  );
  assert.ok(allPlaceholder, "every card starts as a placeholder");

  // Card 1 live, with real media in it.
  assert.equal(await driver.eval(() => window.__loadIframe(1)), true, "card 1 activated");
  await until(() => driver.eval(() => window.__waitForIframeLoad(1).catch(() => false)));
  await driver.injectScriptInFrame("active-frame");
  const st = await until(async () => {
    const r = await driver.evalInFrame("active-frame", readVideo, "video-1");
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "the loaded card's video is adopted");
  assert.ok(st.readyState > 0, `the loaded card has real media, readyState=${st.readyState}`);
  assert.equal(
    await driver.eval(() => window.__getLoadedCount()),
    1,
    "exactly one frame is live"
  );
  // __getPlaceholderCount is defined in both modes, so a swap-mode caller gets
  // a number rather than a ReferenceError. In swap mode the frame is gone
  // entirely, so the count comes from the card state.
  assert.equal(
    await driver.eval(() => window.__getPlaceholderCount()),
    2,
    "swap mode counts placeholder cards, and the two inactive ones qualify"
  );

  // Switching must leave no second frame behind.
  assert.equal(await driver.eval(() => window.__switchTo(2)), true, "card 2 activated");
  await until(() => driver.eval(() => window.__waitForIframeLoad(2).catch(() => false)));
  assert.equal(
    await driver.eval(() => window.__getLoadedCount()),
    1,
    "switching does not accumulate frames"
  );
  assert.equal(await driver.eval(() => window.__getActiveIndex()), 2, "the new card is active");

  // Unloading the live card returns to all-placeholder.
  assert.equal(await driver.eval(() => window.__unloadIframe()), true, "the live card unloaded");
  assert.equal(await driver.eval(() => window.__getLoadedCount()), 0, "unloading leaves nothing live");
  const backToPlaceholder = await driver.eval(() =>
    Array.from(document.querySelectorAll(".server-card")).every((c) =>
      c.classList.contains("placeholder")
    )
  );
  assert.ok(backToPlaceholder, "every card is a placeholder again");
});

test("switchboard parked mode: persistent src-less frames stay inert", async () => {
  await freshStore();
  // Each card owns a real <iframe> that simply has no src yet, and activation
  // assigns src to that same element instead of creating a new one. This asserts
  // the negative case a swap fixture structurally cannot: a frame that never
  // received a src must produce NO shell, before anything is clicked.
  //
  // What this mode does NOT do is keep the frame's realm alive. A src assignment
  // is a navigation, so the document and everything in it die exactly as they do
  // in swap mode - verified, not assumed. What persists is the element and its
  // box, which is why this test asserts element reuse and not realm survival.
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const s = servers[i];
    cards.push({
      name: `Parked ${i}`,
      url: createSwitchboardChildPage(s, {
        name: `Parked ${i}`,
        videoSrc: createTestMedia(s, MEDIA_SECONDS),
        id: `video-${i}`,
      }),
    });
  }
  const parent = createSwitchboardPage(servers[0], cards, { placeholderMode: "parked" });

  await driver.navigate(parent);
  await driver.injectScript();

  const parked = await driver.eval(() => ({
    frames: document.querySelectorAll(".server-card iframe").length,
    withSrc: Array.from(document.querySelectorAll(".server-card iframe")).filter(
      (f) => f.getAttribute("src")
    ).length,
    placeholderCount: window.__getPlaceholderCount(),
  }));
  assert.equal(parked.frames, 3, "every card holds a real parked frame");
  assert.equal(parked.withSrc, 0, "none of them has a src yet");
  assert.equal(parked.placeholderCount, 3, "all three are counted as placeholders");

  // Give the userscript a chance to do something wrong to those empty frames.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(
    await driver.eval(() => document.querySelectorAll(".pf-shell").length),
    0,
    "a frame that never received a src must not get a shell"
  );

  // The realm does NOT survive activation. A src assignment is a navigation, so
  // the document is torn down and PF's registrations with it - this is NOT a
  // mode where a frame's realm is kept alive.
  //
  // Card 0 is the only one readable from the top document: it is served by the
  // same origin as the parent. This runs BEFORE card 1 is activated, and asserts
  // the return value, because __loadIframe returns false when a card is already
  // live - a silent no-op that leaves a stamp in place and makes this assertion
  // pass for entirely the wrong reason.
  const stamp = await driver.eval(() => {
    const w = document.getElementById("parked-frame-0").contentWindow;
    w.__stamp = "before-activation";
    return w.__stamp;
  });
  assert.equal(stamp, "before-activation", "the parked frame's window was reachable");
  assert.equal(await driver.eval(() => window.__loadIframe(0)), true, "card 0 activated");
  await until(() => driver.eval(() => window.__waitForIframeLoad(0).catch(() => false)));
  assert.equal(
    await driver.eval(() => {
      const w = document.getElementById("parked-frame-0").contentWindow;
      return w.__stamp ?? null;
    }),
    null,
    "activation navigates the frame, so its realm is torn down just as in swap mode"
  );
  assert.equal(await driver.eval(() => window.__unloadIframe()), true, "card 0 unloaded");
  assert.equal(
    await driver.eval(() => window.__getPlaceholderCount()),
    3,
    "unloading returns every card to the placeholder state"
  );

  // Tag the element the fixture is about to activate. If activation replaced it
  // rather than assigning to it, the tag is gone - which is the whole difference
  // between this fixture and the swap one, and the easiest thing to get wrong
  // while still reporting a live frame and the right placeholder count.
  await driver.eval(() => {
    document.getElementById("parked-frame-1").dataset.probe = "original-element";
  });

  // Activating assigns src to the existing element; the frame is reused.
  assert.equal(await driver.eval(() => window.__loadIframe(1)), true, "card 1 activated");
  await until(() => driver.eval(() => window.__waitForIframeLoad(1).catch(() => false)));
  await driver.injectScriptInFrame("parked-frame-1");
  const st = await until(async () => {
    const r = await driver.evalInFrame("parked-frame-1", readVideo, "video-1");
    return r.hasShell && r.readyState > 0 ? r : null;
  });
  assert.ok(st?.hasShell, "the activated parked frame is adopted");
  assert.ok(st.readyState > 0, `and it has real media, readyState=${st.readyState}`);

  const sameElement = await driver.eval(() => ({
    stillTagged: document.getElementById("parked-frame-1")?.dataset.probe === "original-element",
    totalFrames: document.querySelectorAll(".server-card iframe").length,
  }));
  assert.equal(
    sameElement.stillTagged,
    true,
    "activation reused the parked element instead of creating a new iframe"
  );
  assert.equal(sameElement.totalFrames, 3, "still three frames, so none was replaced");

  // Unloading clears src rather than removing the element.
  await driver.eval(() => window.__unloadIframe());
  const after = await driver.eval(() => ({
    frames: document.querySelectorAll(".server-card iframe").length,
    withSrc: Array.from(document.querySelectorAll(".server-card iframe")).filter(
      (f) => f.getAttribute("src")
    ).length,
    stillTagged: document.getElementById("parked-frame-1")?.dataset.probe === "original-element",
  }));
  assert.equal(after.frames, 3, "the frames persist through an unload");
  assert.equal(after.withSrc, 0, "clearing src means no frame is live");
  assert.equal(
    after.stillTagged,
    true,
    "the same element survives the unload, so a re-activation is not a fresh frame"
  );
});

test("switchboard nested: a relay deep enough to break a shallow one", async () => {
  await freshStore();
  // Each card is two cross-origin hops from the top page. Distinct from the
  // single-hop cards above: if a relay only forwards the request and never
  // returns the answer, these fail while the shallow cards still pass.
  const parentServer = servers[0];
  const cards = [];
  for (let i = 0; i < 2; i++) {
    const relay = servers[1 + i];
    const video = servers[3 + (i % 2)];
    cards.push({
      name: `Nested ${i}`,
      url: createNestedSwitchboardChildPage(relay, video, {
        name: `Nested ${i}`,
        videoSrc: createTestMedia(video, MEDIA_SECONDS),
        id: `video-${i}`,
      }),
    });
  }
  const parent = createSwitchboardPage(parentServer, cards, { placeholderMode: "swap" });

  await driver.navigate(parent);
  await driver.injectScript();

  assert.equal(await driver.eval(() => window.__loadIframe(0)), true, "card 0 activated");
  await until(() => driver.eval(() => window.__waitForIframeLoad(0).catch(() => false)));
  await driver.injectScriptInFramePath(["active-frame", "inner-frame"]);

  const st = await until(async () => {
    const r = await driver.evalInFramePath(["active-frame", "inner-frame"], readVideo, "video-0");
    return r.hasShell && r.readyState > 0 ? r : null;
  }, 15000);
  assert.ok(st?.hasShell, "a video two cross-origin hops down is adopted");
  assert.ok(st.readyState > 0, `and it has real media, readyState=${st.readyState}`);

  const stored = await driver.gmStorage();
  assert.ok((stored["pf:resume"]?.entries ?? []).length > 0, "the nested card wrote a resume entry");
});
