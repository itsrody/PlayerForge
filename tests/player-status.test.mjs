import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");
const { PlayerStatus, Playback, Buffer, Presence, Screen, STATUS_EVENT } = await import(
  "../src/shared/player-status.js"
);
// Kept as the namespace: destructuring an awaited import snapshots the value,
// and `fs` is a live `export let` this test needs to read after the gate moves.
const shadow = await import("../src/shared/shadow.js");

/**
 * L2's contract is negative before it is positive: what must NOT be able to
 * write status matters more than any single value. These tests therefore
 * mostly assert silence - that an edge nobody announced produces nothing - and
 * then that the edges which did fire are attributed to their cause.
 */

function makeRealm() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  globalThis.CustomEvent = dom.window.CustomEvent;
  // jsdom rejects a foreign-realm AbortSignal in listener options.
  globalThis.AbortController = dom.window.AbortController;
  initFsGate(dom);
  const video = dom.window.document.createElement("video");
  dom.window.document.body.appendChild(video);
  return { dom, video, doc: dom.window.document };
}

/** One microtask turn - the batch PlayerStatus schedules its commit on. */
const tick = () => new Promise((resolve) => queueMicrotask(resolve));

const fire = (node, type) => node.dispatchEvent(new globalThis.Event(type));

/** Flip the document's visibility, which jsdom only exposes as a prototype getter. */
function setVisibility(doc, hidden) {
  Object.defineProperty(doc, "visibilityState", {
    value: hidden ? "hidden" : "visible",
    configurable: true
  });
  Object.defineProperty(doc, "hidden", { value: hidden, configurable: true });
  fire(doc, "visibilitychange");
}

function harness(t) {
  const realm = makeRealm();
  const changes = [];
  const owner = new globalThis.AbortController();
  const status = new PlayerStatus({ target: realm.video, doc: realm.doc, signal: owner.signal });
  status.subscribe((change) => changes.push(change));
  t.after(() => status.dispose());
  return { ...realm, status, changes, owner };
}

/**
 * A controllable IntersectionObserver, installed before any PlayerStatus is
 * constructed so `#wire()`'s probe sees this rather than the loader's no-op
 * shim. The shim pins the seed path (never reports, so presence stays what
 * construction guessed); this pins the path that corrects the guess.
 *
 * Instances are shared rather than per-status: `resume.js` observes the same
 * video for its save gate, and a shell test registers both. Driving every live
 * observer is what a real scroll does anyway.
 */
const observers = new Set();

globalThis.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb;
    this.targets = [];
    observers.add(this);
  }

  observe(target) {
    this.targets.push(target);
  }

  unobserve(target) {
    this.targets = this.targets.filter((t) => t !== target);
  }

  disconnect() {
    observers.delete(this);
  }

  /** Report one entry to every observer that has a target. */
  fire(isIntersecting) {
    if (!this.targets.length) {
      return;
    }
    this.cb(
      [{ isIntersecting, intersectionRatio: isIntersecting ? 1 : 0, target: this.targets[0] }],
      this
    );
  }
};

const setIntersecting = (isIntersecting) => {
  for (const io of [...observers]) {
    io.fire(isIntersecting);
  }
};

test("construction seeds from the element and emits nothing", async (t) => {
  const { status, changes, video } = harness(t);

  assert.equal(status.playback, Playback.IDLE, "a jsdom video with no src starts idle");
  assert.equal(status.buffer, Buffer.NONE);
  assert.equal(status.presence, Presence.VISIBLE);
  assert.equal(status.screen, Screen.NONE);
  assert.equal(status.muted, false);

  await tick();
  assert.deepEqual(changes, [], "the state that predates the observer is not a transition");
  assert.equal(video.readyState, 0, "the harness really is pre-metadata");
});

test("an announced edge is the only writer: 'playing' moves playback with its cause", async (t) => {
  const { status, changes, video } = harness(t);

  fire(video, "playing");
  await tick();

  assert.equal(status.playback, Playback.PLAYING);
  assert.deepEqual(
    changes.map((c) => [c.name, c.from, c.to, c.cause]),
    [["playback", Playback.IDLE, Playback.PLAYING, "playing"]]
  );
});

test("a play() that never started changes nothing - status is not optimistic", async (t) => {
  const { status, changes, video } = harness(t);

  // The request reached the element (the event fired) but no frame rendered:
  // exactly the case where an optimistic status would show a pause icon for a
  // video that never started. Only `playing` earns PLAYING.
  fire(video, "play");
  await tick();

  assert.deepEqual(changes, [], "'play' is a request reaching the element, not playback");
  assert.equal(status.playback, Playback.IDLE);
});

test("pause and ended land from the element's own edges", async (t) => {
  const { changes, video } = harness(t);

  fire(video, "playing");
  await tick();
  fire(video, "pause");
  await tick();
  fire(video, "ended");
  await tick();

  assert.deepEqual(
    changes.map((c) => [c.to, c.cause]),
    [
      [Playback.PLAYING, "playing"],
      [Playback.PAUSED, "pause"],
      [Playback.ENDED, "ended"]
    ]
  );
});

test("the buffer axis tracks its own edges, independent of playback", async (t) => {
  const { status, changes, video } = harness(t);

  fire(video, "waiting");
  await tick();
  fire(video, "seeking");
  await tick();
  fire(video, "seeked");
  await tick();

  assert.equal(status.buffer, Buffer.NONE, "a settled seek leaves no buffer state behind");
  assert.deepEqual(
    changes.map((c) => [c.to, c.cause]),
    [
      [Buffer.WAITING, "waiting"],
      [Buffer.SEEKING, "seeking"],
      [Buffer.NONE, "seeked"]
    ]
  );
});

test("loadedmetadata reaches READY because the element is genuinely stopped", async (t) => {
  const { status, video } = harness(t);
  assert.equal(video.paused, true, "the harness element is paused, so READY is honest");

  fire(video, "loadstart");
  await tick();
  fire(video, "loadedmetadata");
  await tick();

  assert.equal(status.playback, Playback.READY);
});

test("one event commits both its changes together, and a change raised during that commit lands in a later one", async (t) => {
  const { status, video } = harness(t);

  Object.defineProperty(video, "volume", { value: 0.5, configurable: true });
  Object.defineProperty(video, "muted", { value: true, configurable: true });

  // Delivery inside a commit is synchronous, so a flag parked on the microtask
  // queue from the first delivery separates "same run" from "later run"
  // without depending on how many await turns a given Node turns out to need.
  const seen = [];
  let inThisRun = true;
  let armed = false;
  status.subscribe((change) => {
    seen.push(`${change.name}:${inThisRun}`);
    if (!armed) {
      armed = true;
      queueMicrotask(() => {
        inThisRun = false;
      });
    }
    if (change.name === "volume") {
      fire(video, "waiting");
    }
  });

  fire(video, "volumechange");
  assert.deepEqual(seen, [], "the commit is scheduled, not delivered inline from the event");

  await tick();

  assert.deepEqual(
    seen,
    ["volume:true", "muted:true", "buffer:false"],
    "one edge's two changes share a commit; the edge raised from inside it gets its own"
  );
  assert.equal(status.volume, 0.5);
  assert.equal(status.muted, true);
  assert.equal(status.buffer, Buffer.WAITING);
});

test("every transition names the event that produced it", async (t) => {
  const { changes, video } = harness(t);
  const announced = ["playing", "waiting", "seeked", "pause", "durationchange"];

  for (const type of announced) {
    fire(video, type);
    await tick();
  }

  assert.ok(changes.length > 0, "the sequence actually moved");
  for (const change of changes) {
    assert.ok(
      announced.includes(change.cause),
      `a transition claimed cause ${change.cause}, which nothing announced`
    );
  }
});

test("the clock advances silently: timeupdate is a read, not a state change", async (t) => {
  const { status, changes, video } = harness(t);
  Object.defineProperty(video, "currentTime", { value: 12, writable: true, configurable: true });

  fire(video, "timeupdate");
  await tick();

  assert.equal(status.currentTime, 12, "the scalar still tracks the element");
  assert.deepEqual(changes, [], "a ~4 Hz read is not a transition");
});

test("there is no way to write status: no setter API, and the getters refuse", (t) => {
  const { status } = harness(t);

  assert.equal(
    Object.getOwnPropertyNames(PlayerStatus.prototype).some((name) => /^set/i.test(name)),
    false,
    "the class exposes no setter at all"
  );
  assert.throws(() => {
    status.playback = Playback.PLAYING;
  }, TypeError);
  assert.equal(status.playback, Playback.IDLE, "the refused write left nothing behind");
});

test("a delivered change is frozen, so a subscriber cannot rewrite what it was told", async (t) => {
  const { changes, video } = harness(t);
  fire(video, "playing");
  await tick();

  assert.equal(Object.isFrozen(changes[0]), true);
  assert.equal(changes[0].name, "playback");
  assert.equal(typeof changes[0].seq, "number");
});

test("fullscreen comes from the shared gate, and PlayerStatus opens no second listener", async () => {
  const realm = makeRealm();

  const added = [];
  const original = globalThis.document.addEventListener;
  globalThis.document.addEventListener = (type, ...rest) => {
    added.push(type);
    return original.call(globalThis.document, type, ...rest);
  };

  let status;
  try {
    status = new PlayerStatus({ target: realm.video, doc: realm.doc });
  } finally {
    globalThis.document.addEventListener = original;
  }

  assert.equal(
    added.includes("fullscreenchange"),
    false,
    "shadow.js owns that event; a second listener is the bug it exists to prevent"
  );

  setFullscreen(realm.dom, realm.video);
  await tick();

  assert.equal(status.screen, Screen.FULLSCREEN, "the gate's truth reached the axis");
  assert.equal(shadow.fs, true, "the SOL and the axis agree");
  status.dispose();
});

test("the presence axis follows the document it was given", async (t) => {
  const { status, changes, doc } = harness(t);

  Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
  fire(doc, "visibilitychange");
  await tick();

  assert.equal(status.presence, Presence.BACKGROUND);
  assert.deepEqual(changes.map((c) => c.cause), ["visibilitychange"]);
});

test("the pf:status event carries the change to an outer-realm listener", async (t) => {
  const { status, video } = harness(t);
  const received = [];
  video.addEventListener(STATUS_EVENT, (event) => received.push(event.detail));

  fire(video, "playing");
  await tick();

  assert.equal(received.length, 1, "one event per transition");
  assert.equal(received[0].name, "playback");
  assert.equal(received[0].to, Playback.PLAYING);
  assert.equal(received[0].cause, "playing");
});

test("dispose detaches every source, so a late edge changes nothing", async (t) => {
  const { status, changes, video, doc } = harness(t);

  Object.defineProperty(doc, "visibilityState", { value: "hidden", configurable: true });
  status.dispose();
  fire(video, "playing");
  fire(video, "pause");
  fire(doc, "visibilitychange");
  await tick();

  assert.deepEqual(changes, [], "no listener survived dispose");
  assert.equal(status.playback, Playback.IDLE);
  assert.equal(status.presence, Presence.VISIBLE, "the presence listener went too");
});

test("an owner abort tears status down without an explicit dispose", async (t) => {
  const { status, changes, video, owner } = harness(t);

  owner.abort();
  fire(video, "playing");
  await tick();

  assert.deepEqual(changes, [], "the signal is enough");
  assert.equal(status.playback, Playback.IDLE);
});

test("a subscriber that throws does not take out the ones after it", async (t) => {
  const { status, video } = harness(t);
  const reached = [];
  status.subscribe(() => {
    throw new Error("bad subscriber");
  });
  status.subscribe((change) => reached.push(change.name));

  fire(video, "playing");
  await tick();

  assert.deepEqual(reached, ["playback"]);
});

test("unsubscribing stops delivery; a second unsubscribe is a no-op", async (t) => {
  const { status, changes, video } = harness(t);
  const seen = [];
  const off = status.subscribe((change) => seen.push(change.name));

  fire(video, "waiting");
  await tick();
  off();
  off();
  fire(video, "seeked");
  await tick();

  assert.deepEqual(seen, ["buffer"]);
  assert.equal(changes.length, 2, "the earlier subscriber still saw both");
});

test("the presence axis reports OCCLUDED when the player leaves the viewport", async (t) => {
  const { status, changes } = harness(t);

  setIntersecting(false);
  await tick();

  assert.equal(status.presence, Presence.OCCLUDED);
  const last = changes.at(-1);
  assert.equal(last.kind, "axis");
  assert.equal(last.name, "presence");
  assert.equal(last.from, Presence.VISIBLE);
  assert.equal(last.to, Presence.OCCLUDED);
  assert.equal(last.cause, "intersection", "the cause names the observation, not a guessed event");
});

test("the observer's first report corrects a seed that guessed visible", async (t) => {
  const { status, changes } = harness(t);
  // A rect is not readable without a layout, and reading one here would be a
  // forced synchronous layout on the boot path - so construction guesses and
  // the observer, which runs after it, corrects.
  assert.equal(status.presence, Presence.VISIBLE);

  setIntersecting(false);
  await tick();
  assert.equal(status.presence, Presence.OCCLUDED);
  assert.equal(changes.length, 1, "one correction");

  setIntersecting(false);
  await tick();
  assert.equal(changes.length, 1, "a repeat report of the same geometry is not a transition");
});

test("a hidden document wins over an off-screen player", async (t) => {
  const { status, doc } = harness(t);

  setIntersecting(false);
  await tick();
  assert.equal(status.presence, Presence.OCCLUDED);

  setVisibility(doc, true);
  await tick();
  assert.equal(status.presence, Presence.BACKGROUND);

  setIntersecting(true);
  await tick();
  assert.equal(status.presence, Presence.BACKGROUND, "geometry cannot outrank a hidden tab");

  setVisibility(doc, false);
  await tick();
  assert.equal(status.presence, Presence.VISIBLE, "and the edge that returns re-reads the geometry too");
});

test("disposing the status stops the observer", async (t) => {
  const { status } = harness(t);

  status.dispose();
  setIntersecting(false);
  await tick();

  assert.equal(status.presence, Presence.VISIBLE, "a torn-down status observes nothing");
});
