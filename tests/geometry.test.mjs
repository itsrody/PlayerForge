import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { screenSize, writeReferenceBox, referenceWidth } = await import("../src/shared/geometry.js");
const { initFsGate, setFullscreen } = await import("./fs-gate.mjs");

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://www.youtube.com/watch?v=1"
});
globalThis.window = dom.window;
// Wire the shared fs gate to this environment so the geometry rule reads the
// same fullscreen boolean production does, through the real mechanism.
initFsGate(dom);

const savedScreen = globalThis.screen;
function withScreen(value, fn) {
  if (value === undefined) {
    delete globalThis.screen;
  } else {
    globalThis.screen = value;
  }
  try {
    return fn();
  } finally {
    if (savedScreen === undefined) {
      delete globalThis.screen;
    } else {
      globalThis.screen = savedScreen;
    }
  }
}

test("inline reference box reads the container", () => {
  setFullscreen(dom, null);
  const box = writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, { width: 0, height: 0 });
  assert.deepEqual(box, { width: 400, height: 300 });
});

test("fullscreen reference box is the physical screen", () => {
  withScreen({ width: 1080, height: 2400 }, () => {
    setFullscreen(dom, dom.window.document.body);
    try {
      assert.deepEqual(
        writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, { width: 0, height: 0 }),
        { width: 1080, height: 2400 }
      );
      assert.equal(referenceWidth(400), 1080);
    } finally {
      setFullscreen(dom, null);
    }
  });
});

test("fullscreen without a screen falls back to the container instead of throwing", () => {
  withScreen(undefined, () => {
    setFullscreen(dom, dom.window.document.body);
    try {
      // The old shell copy read a bare `screen.width` here and threw
      // ReferenceError on a screen-less host; the rule now degrades to the
      // container, which is the safe direction.
      assert.deepEqual(
        writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, { width: 0, height: 0 }),
        { width: 400, height: 300 }
      );
    } finally {
      setFullscreen(dom, null);
    }
  });
});

test("a zeroed screen reports presence without geometry, so it is not a screen", () => {
  withScreen({ width: 0, height: 0 }, () => {
    assert.deepEqual(screenSize(), { width: 0, height: 0 });
    setFullscreen(dom, dom.window.document.body);
    try {
      assert.deepEqual(
        writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, { width: 0, height: 0 }),
        { width: 400, height: 300 }
      );
    } finally {
      setFullscreen(dom, null);
    }
  });
});

test("inline keeps raw zeros — the nonzero fallback lives downstream, not here", () => {
  setFullscreen(dom, null);
  // Scrub gain (`|| 640`) and computeCoverScale (0 means skip) own the
  // fallback; guessing innerWidth here would silently renormalize gestures.
  assert.deepEqual(
    writeReferenceBox({ clientWidth: 0, clientHeight: 0 }, { width: 9, height: 9 }),
    { width: 0, height: 0 }
  );
});

test("width-only form falls back to the window when the zone reports no size", () => {
  setFullscreen(dom, null);
  withScreen(undefined, () => {
    assert.equal(referenceWidth(0), globalThis.window.innerWidth);
    assert.equal(referenceWidth(400), 400);
  });
});

test("the pooled box is rewritten in place across fullscreen flips", () => {
  const box = { width: 0, height: 0 };
  withScreen({ width: 1080, height: 2400 }, () => {
    setFullscreen(dom, null);
    assert.equal(writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, box), box);
    assert.deepEqual(box, { width: 400, height: 300 });
    setFullscreen(dom, dom.window.document.body);
    try {
      assert.equal(writeReferenceBox({ clientWidth: 400, clientHeight: 300 }, box), box);
      assert.deepEqual(box, { width: 1080, height: 2400 });
    } finally {
      setFullscreen(dom, null);
    }
  });
});
