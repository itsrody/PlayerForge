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
const { FRAMEWORK_TUNING, SHELL_MARKER } = await import("../src/kernel/contract.js");

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
    create({ video: v, container, sdk, onDestroy }) {
      // destroy() must unregister like the real shell does (shell.js:557):
      // the container-move re-adopt path destroys the stale shell and then
      // relies on the registry slot being free before adoption runs again.
      return { video: v, container, sdk, ready: Promise.resolve(), destroy() { onDestroy?.(); } };
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

test("a video moved to a new container gets a fresh shell in the new location", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  // This kernel adopts every video in the document (the previous test's is
  // still mounted), so wait for OUR shell specifically.
  await waitFor(() => created.some((shell) => shell.video === video));
  const oldShell = created.find((entry) => entry.video === video);
  const oldDestroy = oldShell.destroy;
  let oldDestroyed = false;
  oldShell.destroy = () => { oldDestroyed = true; oldDestroy(); };

  // Reparent the VIDEO itself into a second player. The host was injected
  // into the OLD container (inject.js:88), so the live shell is stranded
  // over the emptied slot while the session claim would refuse the new
  // location for the life of the document - measured live: at +799ms the
  // host was still in the old slot, zero hosts in the new location,
  // data-pf-shell still set even after the old slot died. The movedOut edge
  // must destroy the stale shell (destroy unregisters), release the claim
  // and adopt against the CURRENT ancestry.
  const swap = document.createElement("div");
  swap.className = "jwplayer";
  document.body.appendChild(swap);
  swap.appendChild(video);
  await waitFor(() => created.filter((entry) => entry.video === video).length === 2, 3000);
  assert.ok(oldDestroyed, "the shell stranded in the old container was destroyed");
  const replacements = created.filter((entry) => entry.video === video);
  assert.equal(replacements[1].container, swap, "the replacement shell targets the container the video now lives in");

  // The watch re-anchored to the new chain, so removal from the NEW location
  // still reaches the grace and tears the replacement down.
  const newShell = replacements[1];
  const newDestroy = newShell.destroy;
  let newDestroyed = false;
  newShell.destroy = () => { newDestroyed = true; newDestroy(); };
  video.remove();
  await waitFor(() => newDestroyed, 3000);
  assert.ok(newDestroyed, "the replacement shell is torn down when the video leaves the new container too");
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

test("a transient boot failure does not spend the defect retry", async () => {
  // The mount proof trips on mid-boot timing (a CSS scale-in moves boxes
  // between the snapshot and the verify) - noise, not a defect. It releases
  // on its own budget: attempt 1 fails transient, attempts 2-3 fail defect,
  // and the defect retry the transient would have spent is still granted.
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
      const err = new Error(attempts === 1 ? "placement shifted under prep" : "boot boom");
      if (attempts === 1) {
        err.transient = true;
      }
      return { video: v, container, sdk, ready: Promise.reject(err), destroy() {} };
    }
  });
  kernel.init();
  await waitFor(() => attempts >= 1, 3000);

  const nudge = () => video.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));
  for (let i = 0; i < 120 && attempts < 3; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 3, "the transient failure left the defect retry intact");

  for (let i = 0; i < 24; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 3, "the spent defect budget still abandons the video");
});

test("an always-transient boot stands down on its own budget", async () => {
  // Timing noise that never clears (a persistently shifting mount) must not
  // spin on every media event either: past TRANSIENT_BOOT_LIMIT consecutive
  // misses the video stands down claimed, exactly like a spent defect retry.
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
      const err = new Error("placement shifted under prep");
      err.transient = true;
      return { video: v, container, sdk, ready: Promise.reject(err), destroy() {} };
    }
  });
  kernel.init();
  await waitFor(() => attempts >= 1, 3000);

  const nudge = () => video.dispatchEvent(new dom.window.Event("loadeddata", { bubbles: true }));
  // TRANSIENT_BOOT_LIMIT transient failures, then silence.
  for (let i = 0; i < 150 && attempts < 3; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 3, "the transient budget caps re-arms like the defect one");

  for (let i = 0; i < 24; i++) {
    nudge();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(attempts, 3, "a stood-down transient does not spin on the discovery tap");
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
  // listeners attached, marker set, session claim held. Nothing could
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

test("moving the whole player subtree re-roots the removal watch", async () => {
  // The video's own parent never changes here - the page moves the PLAYER,
  // one level above the watched anchors. The move itself still delivers a
  // record (it is a mutation of an observed old node), but parent looks
  // unchanged; only the full-chain + sentinel compare notices that the upper
  // range shifted. Without the re-root, the teardown below is a mutation on
  // the NEW chain, outside every old root: no record, no grace, an orphaned
  // shell pinned in the registry with its listeners alive (measured live:
  // host still in the detached tree at +903ms; a control mutation on an
  // observed old root destroyed it at +708ms).
  const body = document.body;
  const l1 = document.createElement("div");
  const l2 = document.createElement("div");
  const wrapper = document.createElement("div");
  wrapper.className = "jwplayer";
  const video = document.createElement("video");
  wrapper.appendChild(video);
  l2.appendChild(wrapper);
  l1.appendChild(l2);
  body.appendChild(l1);
  video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
  video.checkVisibility = () => true;

  const created = [];
  let destroyed = false;
  const kernel = new Kernel();
  kernel.onShellCreated((shell) => created.push(shell));
  kernel.registerShellProvider({
    create({ video: v, container, sdk, onDestroy }) {
      const shell = { video: v, container, sdk, ready: Promise.resolve(), destroy() { onDestroy?.(); } };
      if (v === video) {
        shell.destroy = () => { destroyed = true; onDestroy?.(); };
      }
      return shell;
    }
  });
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  assert.equal(destroyed, false, "shell up before the move");

  const swap = document.createElement("div");
  body.appendChild(swap);
  swap.appendChild(wrapper); // video.parentElement (wrapper) unchanged
  await new Promise((r) => setTimeout(r, 20)); // MO delivery of the move record
  swap.remove(); // teardown on the NEW chain - only a re-rooted watch sees it
  await waitFor(() => destroyed, 3000);
  assert.ok(destroyed, "the shell was torn down after the new chain's removal");
});

test("a video moved to another container during settle boots against the new container", async () => {
  const { kernel, video, created } = makeHarness();
  kernel.init();
  await new Promise((r) => setTimeout(r, 20)); // inside the settle quiet window
  const swap = document.createElement("div");
  swap.className = "jwplayer";
  document.body.appendChild(swap);
  swap.appendChild(video); // movedOut edge runs first: no shell yet, watch re-roots
  // The ORIGINAL settle now completes with container = the old wrapper while
  // the video lives in `swap`. Without the contains() guard it boots a shell
  // against the abandoned container, and registry.getByVideo then refuses
  // the correct location forever; with it, the one-shot offer re-enters
  // adoption on the next observed edge (the nudge below).
  await new Promise((r) => setTimeout(r, 120)); // original settle quiet completes
  assert.ok(
    !created.some((entry) => entry.video === video),
    "no shell boots against the abandoned container"
  );
  swap.appendChild(document.createElement("i")); // next observed edge
  await waitFor(() => created.some((entry) => entry.video === video), 3000);
  const shell = created.find((entry) => entry.video === video);
  assert.equal(shell.container, swap, "the shell boots against the container the video lives in");
});

test("a video carrying a cloned shell marker is still adopted", async () => {
  const { kernel, video, created } = makeHarness();
  // cloneNode(true) copies attributes: a clone of a managed video arrives
  // WITH the marker but owned by no shell. Ownership is decided JS-side
  // (seen-set, registry slot), so the attribute must not veto adoption -
  // otherwise the clone is refused for the life of the document.
  video.setAttribute(SHELL_MARKER, "");
  kernel.init();
  await waitFor(() => created.some((shell) => shell.video === video));
  assert.equal(
    created.find((shell) => shell.video === video).sdk.name,
    "JW Player",
    "the marker is observable state, not an adoption veto"
  );
});

test("the settle watch observes the container subtree, not just its children", async () => {
  const { kernel, video, created } = makeHarness();
  // SDKs build their chrome nested several levels down; a childList-only
  // settle never re-arms for those, fires mid-build, and the SDK's next
  // innerHTML wipe takes the host out again. Spy the observe() calls and
  // require the settle's subtree flag on our container.
  const RealMO = globalThis.MutationObserver;
  const observed = [];
  globalThis.MutationObserver = class extends RealMO {
    observe(target, options) {
      observed.push({ target, options });
      return super.observe(target, options);
    }
  };
  try {
    kernel.init();
    await waitFor(() => created.some((shell) => shell.video === video));
  } finally {
    globalThis.MutationObserver = RealMO;
  }
  const container = video.parentElement;
  assert.ok(
    observed.some((entry) => entry.target === container && entry.options?.subtree === true),
    "the settle re-arms on nested SDK builds, not only direct children"
  );
});

/** A playing, sized video in a plain wrapper: no registry record owns it. */
function makeGenericVideo() {
  const wrapper = document.createElement("div");
  const video = document.createElement("video");
  wrapper.appendChild(video);
  document.body.appendChild(wrapper);
  const box = { width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 };
  wrapper.getBoundingClientRect = () => ({ ...box });
  video.getBoundingClientRect = () => ({ ...box });
  video.checkVisibility = () => true;
  Object.defineProperty(video, "paused", { value: false, configurable: true });
  Object.defineProperty(video, "ended", { value: false, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  return { wrapper, video };
}

function withActivatedPage(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userActivation: { hasBeenActive: true, isActive: false } },
    writable: true,
    configurable: true
  });
  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
    } else {
      delete globalThis.navigator;
    }
  }
}

async function withGenericEnabled(fn) {
  const { configStore } = await import("../src/shared/storage.js");
  configStore.adopt({ version: 1, detection: { genericPlayers: true } });
  try {
    return await fn();
  } finally {
    configStore.adopt({ version: 1 });
  }
}

test("an unrecognized player is adopted with the generic path enabled", async () => {
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  await withGenericEnabled(async () => {
    await withActivatedPage(async () => {
      kernel.init();
      await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
    });
  });
  const shell = created.find((entry) => entry.video === generic.video);
  assert.equal(shell.sdk.name, "Custom player", "the slow path adopted what no record owns");
  assert.equal(shell.container, generic.wrapper, "placement is the player-like wrapper");
});

test("an unrecognized player is left alone with the fallback explicitly off", async () => {
  const { configStore } = await import("../src/shared/storage.js");
  configStore.adopt({ version: 1, detection: { genericPlayers: false } });
  try {
    const { kernel, created } = makeHarness();
    const generic = makeGenericVideo();
    await withActivatedPage(async () => {
      kernel.init();
      // Longer than any settle window: nothing will ever offer this video.
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    assert.ok(
      !created.some((shell) => shell.video === generic.video),
      "explicit false keeps the registry the only path"
    );
  } finally {
    configStore.adopt({ version: 1 });
  }
});

/** Swap the module-top GM stubs for a writable per-test store. */
function withWritableStore() {
  const saved = {
    get: globalThis.GM_getValue,
    set: globalThis.GM_setValue
  };
  const stored = {};
  globalThis.GM_getValue = (key, fallback) => (key in stored ? stored[key] : fallback);
  globalThis.GM_setValue = (key, value) => {
    stored[key] = value;
  };
  return {
    stored,
    restore() {
      globalThis.GM_getValue = saved.get;
      globalThis.GM_setValue = saved.set;
    }
  };
}

test("a generic adoption persists a print for the hostname", async () => {
  const { stored, restore } = withWritableStore();
  try {
    const { kernel, created } = makeHarness();
    const generic = makeGenericVideo();
    await withGenericEnabled(async () => {
      await withActivatedPage(async () => {
        kernel.init();
        await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
      });
    });
    const doc = stored["pf:sdk-prints"];
    assert.ok(doc, "learning wrote a prints document");
    const prints = doc[window.location.hostname];
    assert.equal(prints.length, 1, "one shape learned");
    assert.equal(prints[0].tag, "div");
    assert.equal(prints[0].depth, 1);
  } finally {
    restore();
  }
});

test("a learned print adopts on the next visit without re-measuring", async () => {
  const { stored, restore } = withWritableStore();
  try {
    const generic = makeGenericVideo();
    await withGenericEnabled(async () => {
      await withActivatedPage(async () => {
        // First visit: the slow path adopts and learns.
        const first = makeHarness();
        first.kernel.init();
        await waitFor(
          () => first.created.some((shell) => shell.video === generic.video),
          3000
        );
        assert.equal(
          first.created.find((shell) => shell.video === generic.video).sdk.source,
          "generic"
        );
        // Second visit, fresh kernel, same document and store: the print
        // answers instead of the behavioral gates re-measuring placement.
        const second = makeHarness();
        second.kernel.init();
        await waitFor(
          () => second.created.some((shell) => shell.video === generic.video),
          3000
        );
        const shell = second.created.find((entry) => entry.video === generic.video);
        assert.equal(shell.sdk.source, "learned", "the print fired, not the slow path");
        assert.equal(shell.container, generic.wrapper);
      });
    });
    assert.ok(stored["pf:sdk-prints"], "the doc survived both visits");
  } finally {
    restore();
  }
});

test("learned prints stay dormant with the switch off", async () => {
  const { stored, restore } = withWritableStore();
  const { configStore } = await import("../src/shared/storage.js");
  configStore.adopt({ version: 1, detection: { genericPlayers: false } });
  try {
    // A print learned earlier (or hand-seeded): the video matches it, but
    // the single switch governs learned matching exactly like the slow path.
    stored["pf:sdk-prints"] = {
      [window.location.hostname]: [{ tag: "div", cls: [], id: null, depth: 1 }]
    };
    const { kernel, created } = makeHarness();
    const generic = makeGenericVideo();
    await withActivatedPage(async () => {
      kernel.init();
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    assert.ok(
      !created.some((shell) => shell.video === generic.video),
      "dormant prints adopt nothing"
    );
  } finally {
    configStore.adopt({ version: 1 });
    restore();
  }
});

test("the fallback is on unless the user opts out", async () => {
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  // No withGenericEnabled: the default carries this adoption.
  await withActivatedPage(async () => {
    kernel.init();
    await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
  });
  assert.equal(
    created.find((shell) => shell.video === generic.video).sdk.source,
    "generic",
    "an unrecognized player adopts with no opt-in"
  );
});

test("a late SDK class re-offers the video", async () => {
  const { trackedObserverLabels } = await import("../src/shared/dom-manager.js");
  // Labels are document-global and earlier videos hold their own watches;
  // assert per-label relative deltas, not absolute presence.
  const upgrades = () => trackedObserverLabels().filter((label) => label === "upgrade-watch").length;
  const removals = () => trackedObserverLabels().filter((label) => label === "removal-watch").length;
  const u0 = upgrades();
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  // No activation: the fallback cannot adopt, so the offer ends unclaimed
  // and arms the upgrade watch instead.
  kernel.init();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const armed = upgrades();
  assert.ok(armed > u0, "unclaimed structural videos arm their upgrade watches");
  const riding = removals();
  // The SDK chrome arrives late, as a class on the wrapper.
  generic.wrapper.classList.add("dplayer");
  await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
  const shell = created.find((entry) => entry.video === generic.video);
  assert.equal(shell.sdk.source, "registry", "the late anchor wins, not a re-measure");
  assert.equal(upgrades(), armed - 1, "adoption disarms exactly the watch it rode in on");
  assert.equal(removals(), riding + 1, "and the session watch takes over one-for-one");
});

test("a removed video disarms its upgrade watch", async () => {
  const { trackedObserverLabels } = await import("../src/shared/dom-manager.js");
  const upgrades = () => trackedObserverLabels().filter((label) => label === "upgrade-watch").length;
  const removals = () => trackedObserverLabels().filter((label) => label === "removal-watch").length;
  const u0 = upgrades();
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  kernel.init();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const armed = upgrades();
  assert.ok(armed > u0, "unclaimed structural videos arm their upgrade watches");
  const riding = removals();
  generic.video.remove();
  generic.wrapper.classList.add("dplayer");
  await waitFor(
    () => upgrades() === armed - 1,
    3000,
    "detach ends the watch instead of re-offering a dead subtree"
  );
  assert.ok(
    !created.some((shell) => shell.video === generic.video),
    "a detached video adopts nothing"
  );
  assert.equal(removals(), riding, "no session watch for a video that never adopted");
});

test("kernel.init accepts probe hints and adopts through the same path", async () => {
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  // Hints arrive as survey records; the kernel offers them before its own
  // replay sweep, through identical gates (settle, size, verify).
  const hints = [{ video: generic.video, shadow: false, hasSrc: false, playing: true }];
  await withActivatedPage(async () => {
    kernel.init(hints);
    await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
  });
  const shell = created.find((entry) => entry.video === generic.video);
  assert.equal(shell.sdk.source, "generic");
  assert.equal(shell.container, generic.wrapper, "hints change order, never placement");
});

test("churn bursts stand the upgrade watch down; media re-arms it", async () => {
  const { trackedObserverLabels } = await import("../src/shared/dom-manager.js");
  const upgrades = () => trackedObserverLabels().filter((label) => label === "upgrade-watch").length;
  const { kernel, created } = makeHarness();
  const generic = makeGenericVideo();
  // No activation, so every offer ends unclaimed and the watch stays armed.
  kernel.init();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const armed = upgrades();
  assert.ok(armed > 0, "unclaimed structural videos arm their upgrade watches");

  // Three fruitless churns, each in its own observer batch: class changes
  // that complete no anchor. Framework re-renders must not meter resolves
  // forever.
  for (const cls of ["junk-a", "junk-b", "junk-c"]) {
    generic.wrapper.classList.add(cls);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await waitFor(
    () => upgrades() === armed - 1,
    3000,
    "the miss budget stands a churning watch down"
  );
  assert.ok(
    !created.some((shell) => shell.video === generic.video),
    "churn alone adopts nothing"
  );

  // Stood down is not terminal: the next media offer re-arms fresh, misses
  // reset, so a genuinely late upgrade arriving with playback still lands.
  // Only the upgrade observer can surface a pure class change (the feed
  // ignores attributes, no media event fires here), so adoption below
  // proves the re-arm - no label counting needed.
  generic.video.dispatchEvent(new window.Event("play"));
  generic.wrapper.classList.add("dplayer");
  await waitFor(() => created.some((shell) => shell.video === generic.video), 3000);
  assert.equal(
    created.find((shell) => shell.video === generic.video).sdk.source,
    "registry",
    "a post-stand-down upgrade still adopts once anything re-offers"
  );
});

test("a late custom-element upgrade re-surveys its subtree", async () => {
  // The tag is undefined at boot and carries no video yet: nothing matches,
  // and no record can fire - the video only exists once the upgrade builds
  // the shadow tree around it. customElements.whenDefined is the only native
  // edge for the upgrade - no polling, no extra observer.
  const resolvers = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "customElements");
  globalThis.customElements = {
    whenDefined: (tag) => new Promise((resolve) => resolvers.set(tag, resolve))
  };
  try {
    const { kernel, created } = makeHarness();
    const player = document.createElement("video-js");
    const wrapper = document.createElement("div");
    player.appendChild(wrapper);
    document.body.appendChild(player);

    kernel.init();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(resolvers.has("video-js"), "the registry tag is watched at boot");
    const before = created.length;
    assert.ok(before > 0, "the harness video adopted normally first");

    // The upgrade attaches shadow chrome with the video inside it - a shape
    // the document feed structurally cannot see (no record fires for nodes
    // entering a fresh shadow root).
    const shadow = player.attachShadow({ mode: "open" });
    const slot = document.createElement("div");
    const video = document.createElement("video");
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
    video.checkVisibility = () => true;
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    slot.appendChild(video);
    shadow.appendChild(slot);
    // jsdom's contains() does not pierce shadow boundaries (the spec says
    // it is shadow-including; Gecko agrees). The settle guard asks exactly
    // that question, so the fixture answers it the spec way - the same class
    // of stub as the rect and checkVisibility shims above.
    const realContains = player.contains.bind(player);
    player.contains = (other) => {
      let node = other;
      while (node) {
        if (node === player) {
          return true;
        }
        node = node.parentNode ?? node.host ?? null;
      }
      return realContains(other);
    };
    resolvers.get("video-js")();
    // Identity, not count: settle completions for earlier videos can land
    // in the same poll window, skipping an exact length past us - while a
    // shell for this video, once created, stays created.
    await waitFor(() => created.some((shell) => shell.video === video), 3000);
    assert.equal(
      created.find((shell) => shell.video === video).sdk.source,
      "registry",
      "the upgrade adopts through the normal path"
    );
  } finally {
    if (saved) {
      Object.defineProperty(globalThis, "customElements", saved);
    } else {
      delete globalThis.customElements;
    }
  }
});

test("a custom-element upgrade after teardown adopts nothing", async () => {
  const resolvers = new Map();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "customElements");
  globalThis.customElements = {
    whenDefined: (tag) => new Promise((resolve) => resolvers.set(tag, resolve))
  };
  try {
    const { kernel, created } = makeHarness();
    const player = document.createElement("video-js");
    document.body.appendChild(player);

    kernel.init();
    await new Promise((resolve) => setTimeout(resolve, 200));
    kernel.destroy();
    const shadow = player.attachShadow({ mode: "open" });
    const video = document.createElement("video");
    video.getBoundingClientRect = () => ({ width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360 });
    video.checkVisibility = () => true;
    shadow.appendChild(video);
    resolvers.get("video-js")();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(
      !created.some((shell) => shell.video === video),
      "a torn-down kernel ignores late upgrades"
    );
  } finally {
    if (saved) {
      Object.defineProperty(globalThis, "customElements", saved);
    } else {
      delete globalThis.customElements;
    }
  }
});
