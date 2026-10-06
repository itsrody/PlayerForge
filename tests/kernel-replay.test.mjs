import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = () => undefined;
globalThis.GM_setValue = () => {};
globalThis.GM_deleteValue = () => {};
if (typeof globalThis.GM_addValueChangeListener !== "function") {
  globalThis.GM_addValueChangeListener = () => 0;
}
if (typeof globalThis.GM_removeValueChangeListener !== "function") {
  globalThis.GM_removeValueChangeListener = () => {};
}

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.location = dom.window.location;
globalThis.document = dom.window.document;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.AbortController = dom.window.AbortController;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { logger } = await import("../src/shared/diagnostics.js");
logger.disable();

const { Kernel } = await import("../src/kernel/kernel.js");
const { FRAMEWORK_TUNING } = await import("../src/kernel/contract.js");

function makeHarness() {
  const body = document.body;
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  body.appendChild(wrapper);
  // jsdom has no layout: force the admission gate's rect so the still-connected
  // player is size-qualified exactly like a rendered 640x360 element.
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  const created = [];
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video: v, container, sdk }) {
      return { video: v, container, sdk, ready: Promise.resolve(), destroy() {} };
    }
  });
  return { kernel, video, created };
}

test("kernel.init() adopts a video already present in the parsed DOM", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  const deadline = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("shell not created in time")), 2000);
    const poll = () => {
      if (created.length) {
        clearTimeout(t);
        resolve();
      } else {
        setTimeout(poll, 5);
      }
    };
    poll();
  });
  await deadline;
  assert.equal(created.length, 1, "the pre-existing video got a shell without any media event");
  assert.equal(created[0].video, video);
  assert.equal(created[0].sdk.name, "JW Player");
});

async function waitFor(cond, ms = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("removal watch reanchors after a parent swap and still detects removal", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  // This kernel adopts every video in the document (the previous test's is
  // still mounted), so wait for OUR shell specifically.
  await waitFor(() => created.some((shell) => shell.video === video));
  const shell = created.find((entry) => entry.video === video);
  let destroyed = false;
  shell.destroy = () => { destroyed = true; };

  // Reparent the VIDEO itself: its anchor chain goes stale, so the removal
  // observer must disconnect and re-observe from the new roots. (MutationObserver
  // has no unobserve(): the old loop called a method that does not exist, threw
  // inside the callback, and stranded the anchors on the original parents.)
  const swap = document.createElement("div");
  document.body.appendChild(swap);
  swap.appendChild(video);
  await new Promise((resolve) => setTimeout(resolve, 20)); // MutationObserver delivery

  // Removal from the NEW location is only noticed if reanchor re-observed it;
  // a stranded watcher would silently miss this childList record.
  video.remove();
  await waitFor(() => destroyed, 3000);
  assert.ok(destroyed, "the shell was torn down after removal from the swapped parent");
});

test("reconnect cancels the pending grace - a fresh one measures from the current disconnect", async () => {
  const graceMs = FRAMEWORK_TUNING.removalGraceMs;
  FRAMEWORK_TUNING.removalGraceMs = 700;
  try {
    const { kernel, video, created } = makeHarness();
    kernel.init();
    await waitFor(() => created.some((shell) => shell.video === video));
    const shell = created.find((entry) => entry.video === video);
    const wrapper = video.parentElement;
    let destroyedAt = 0;
    shell.destroy = () => { destroyedAt = Date.now(); };

    video.remove();                        // disconnect #1 -> grace armed (fires t0+700)
    await new Promise((r) => setTimeout(r, 50));
    wrapper.appendChild(video);            // reconnect: the event cancels the stale grace
    await new Promise((r) => setTimeout(r, 50));
    const removeAt = Date.now();
    video.remove();                        // disconnect #2 -> fresh grace (fires removeAt+700)
    await waitFor(() => destroyedAt > 0, 3000);

    // The stale grace from disconnect #1 would have fired ~600ms after
    // disconnect #2; a grace always measured from the CURRENT disconnect
    // cannot complete earlier than graceMs.
    assert.ok(
      destroyedAt - removeAt >= graceMs,
      `grace ran ${destroyedAt - removeAt}ms after the current disconnect - stale timer was not cancelled`
    );
  } finally {
    FRAMEWORK_TUNING.removalGraceMs = graceMs;
  }
});
test("a shell that fails to boot is retried exactly once, then abandoned", async () => {
  // Fresh video so the counter is ours alone: every kernel in this file adopts
  // every video in the shared body, and the earlier harnesses are still live.
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  document.body.appendChild(wrapper);
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  let attempts = 0;
  const kernel = new Kernel();
  kernel.registerShellProvider({
    create({ video: v, container, sdk }) {
      if (v === video) {
        attempts++;
      }
      return {
        video: v,
        container,
        sdk,
        ready: Promise.reject(new Error("boot boom")),
        destroy() {}
      };
    }
  });
  kernel.init();
  await waitFor(() => attempts >= 1, 3000);

  // The shell rolls its own DOM back, so the video is unmarked and adoptable
  // again. A media event is the real re-discovery signal: the mutation feed
  // only visits videos in ADDED nodes, so it would never re-offer a video that
  // is already sitting in the DOM - which is the whole point of the re-arm.
  const nudge = () => video.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));
  for (let i = 0; i < 60 && attempts < 2; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 2, "the failed video was re-armed for exactly one retry");

  // Unbounded re-arming would spin on every event, so a deterministically
  // throwing boot has to be final on its second failure.
  for (let i = 0; i < 24; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 2, "a boot that keeps throwing does not spin on the discovery tap");
});

test("a bfcache pagehide keeps shell-created listeners live for the restored page", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));

  // persisted: true is the bfcache case. The kernel must NOT tear down here -
  // the page is coming back, so whoever registered a shell-created listener
  // still has to hear about the next shell. (A real pagehide is the branch
  // that releases the set; clearing it unconditionally would break exactly
  // this restore path.)
  const hide = new dom.window.Event("pagehide");
  hide.persisted = true;
  dom.window.dispatchEvent(hide);

  const before = created.length;
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const late = document.createElement("video");
  wrapper.appendChild(late);
  document.body.appendChild(wrapper);
  late.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  late.checkVisibility = () => true;
  late.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));

  await waitFor(() => created.length > before, 3000);
  assert.equal(created.length, before + 1, "the restored page still notifies its shell-created listener");
});

test("removal watch observes one node ABOVE the walked range [regression]", async () => {
  // MutationObserver only reports mutations of the nodes it observes, so
  // removing the OUTERMOST watched anchor was a childList change on its parent
  // - one level further out, and unobserved. No record was delivered,
  // checkAnchors never ran, and the video stayed claimed forever: shell alive,
  // listeners attached, marker set, #seenVideos entry held. Nothing could
  // reclaim it, because that same missing record is what a re-anchor needs.
  //
  // The guarantee is bounded by design (MAX_REMOVAL_DEPTH=8, no subtree
  // observation on a big page), so this pins the boundary case: the walked
  // range PLUS the one sentinel level above it.
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  // Nest well past the cap so the walk stops on its depth limit, not on the
  // end of the chain - otherwise the sentinel is never needed (the document
  // itself ends up observed and everything is caught).
  const MAX_REMOVAL_DEPTH = 8; // mirrors the cap in src/kernel/kernel.js
  let node = wrapper;
  for (let i = 0; i < 14; i++) {
    const layer = document.createElement("div");
    node.appendChild(layer);
    node = layer;
  }
  node.appendChild(video);
  document.body.appendChild(wrapper);

  const ancestors = [];
  for (let n = video.parentElement; n; n = n.parentElement) {
    ancestors.push(n);
  }
  assert.ok(
    ancestors.length > MAX_REMOVAL_DEPTH,
    `chain must exceed the cap for this to test anything, got ${ancestors.length}`
  );

  const created = [];
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video: v, container, sdk }) {
      return { video: v, container, sdk, ready: Promise.resolve(), destroy() {} };
    }
  });
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  const shell = created.find((entry) => entry.video === video);
  let destroyed = false;
  shell.destroy = () => { destroyed = true; };

  // The outermost WATCHED anchor. Detaching it is a mutation on its parent,
  // which only the sentinel level makes observable.
  const outermostWatched = ancestors[MAX_REMOVAL_DEPTH - 1];
  outermostWatched.remove();
  await new Promise((resolve) => setTimeout(resolve, 20)); // MutationObserver delivery
  await waitFor(() => destroyed, 3000);
  assert.ok(
    destroyed,
    "the shell was torn down after the outermost watched anchor was detached"
  );
});

test("two players in one document: removing either tears down only that shell", async () => {
  // The registry used to be a single slot, so the second registration evicted
  // the first and getByVideo() could no longer find it. Removing the FIRST
  // player then destroyed nothing at all: its hotkey listeners, its observers
  // and its pf:resume subscription stayed live.
  const body = document.body;
  const addPlayer = (id) => {
    const wrapper = document.createElement("div");
    wrapper.className = "jwplayer";
    const video = document.createElement("video");
    video.id = id;
    wrapper.appendChild(video);
    body.appendChild(wrapper);
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
    video.checkVisibility = () => true;
    return { wrapper, video };
  };

  const first = addPlayer("first");
  const second = addPlayer("second");

  const created = [];
  const destroyed = [];
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video, container, sdk, onDestroy }) {
      return {
        video,
        container,
        sdk,
        ready: Promise.resolve(),
        destroy() {
          destroyed.push(video.id);
          onDestroy?.();
        }
      };
    }
  });
  kernel.init();

  // Scoped to THIS test's videos: earlier cases in this file leave their
  // players in the shared document.body, and kernel.init() adopts whatever it
  // finds, so counting the whole list can be satisfied by someone else's shell.
  const mine = () => created.filter((s) => s.video === first.video || s.video === second.video);
  await waitFor(() => mine().length === 2);
  assert.equal(mine().length, 2, "both players in one document get a shell");

  // Remove the FIRST player. It is not the most recent, so this is exactly the
  // lookup the single slot could not answer.
  first.video.remove();
  await waitFor(() => destroyed.includes("first"));
  assert.deepEqual(
    destroyed.filter((id) => id === "first" || id === "second"),
    ["first"],
    "the removed player's shell is torn down"
  );

  // The survivor is untouched and still registered.
  assert.equal(second.video.isConnected, true);
  assert.equal(mine().length, 2, "the survivor's shell is still live");

  // And the reverse order, so the fix is not just "the last one survives".
  second.video.remove();
  await waitFor(() => destroyed.includes("second"));
  assert.deepEqual(
    destroyed.filter((id) => id === "first" || id === "second"),
    ["first", "second"],
    "the survivor tears down on its own removal"
  );
});

test("a video detached during settle and reattached inside the grace is re-adopted", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  // Adoption runs synchronously with init: the claim is placed, the settle
  // quiet window starts, the removal watch arms - and the discovery tap
  // downgrades on this first adoption.
  await new Promise((r) => setTimeout(r, 20));
  const wrapper = video.parentElement;
  video.remove(); // inside the 50ms settle window; also re-arms it (direct child)
  // The settle now completes against a detached video: shell creation is
  // skipped but the claim stands. If the video is reattached AFTER the grace
  // fires, the claim is released and re-discovery is a documented
  // media-event path; reattached INSIDE the grace - the case below - the
  // reconnect cancels the only re-check there is, and without the
  // reconnect-re-adoption edge the video stays claimed with no shell for the
  // life of the document (MO tap downgraded, media tap refuses a claim).
  await new Promise((r) => setTimeout(r, 80));
  // Prior tests' videos are still mounted in the shared body and every
  // kernel in this file adopts all of them - count ours alone.
  assert.ok(
    !created.some((entry) => entry.video === video),
    "the settle skipped: no shell while detached"
  );
  wrapper.appendChild(video);
  await waitFor(() => created.some((entry) => entry.video === video), 3000);
});
