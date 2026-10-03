import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://example.com/"
});
globalThis.window = window;
globalThis.document = window.document;

const { ToastManager } = await import("../src/shell/chrome/toast.js");

/** The shell hands ToastManager a real DOMManager; only own() is used here. */
function makeManager() {
  const hudLayer = document.createElement("div");
  document.body.appendChild(hudLayer);
  const mgr = new ToastManager(hudLayer, { own: (el) => el });
  return { mgr, hudLayer, toast: hudLayer.querySelector("pf-toast") };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("the first show renders icon, text and visibility", () => {
  const { mgr, toast } = makeManager();
  assert.ok(!toast.classList.contains("pf-visible"));

  mgr.show({ icon: "play", text: "Hello" });

  assert.ok(toast.classList.contains("pf-visible"));
  assert.equal(toast.querySelector(".pf-toast-text").textContent, "Hello");
  assert.equal(toast.querySelector(".pf-toast-text").hidden, false);
  assert.ok(toast.querySelector(".pf-toast-icon svg"));
  assert.equal(toast.querySelector(".pf-toast-icon").hidden, false);
});

test("the icon slot is hidden whenever there is no icon", () => {
  const { mgr, toast } = makeManager();
  const slot = () => toast.querySelector(".pf-toast-icon");

  // First show with no icon: the slot starts visible, so the initial apply
  // has to hide it rather than leaving an empty pill.
  mgr.show({ text: "Hello" });
  assert.equal(slot().hidden, true);
  assert.equal(slot().children.length, 0);

  mgr.show({ icon: "play", text: "Hello" });
  assert.equal(slot().hidden, false);
  assert.ok(slot().querySelector("svg"));

  mgr.show({ text: "Hello" });
  assert.equal(slot().hidden, true);
  assert.equal(slot().children.length, 0);
});

test("a repeated identical show is byte-identical and rebuilds nothing", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ icon: "play", text: "Hello", group: "g" });

  const before = toast.outerHTML;
  const iconChild = toast.querySelector(".pf-toast-icon").firstElementChild;
  const textChild = toast.querySelector(".pf-toast-text").firstChild;
  assert.ok(iconChild, "the icon rendered");
  assert.ok(textChild, "the text rendered");

  mgr.show({ icon: "play", text: "Hello", group: "g" });

  assert.equal(toast.outerHTML, before);
  assert.equal(toast.querySelector(".pf-toast-icon").firstElementChild, iconChild);
  assert.equal(toast.querySelector(".pf-toast-text").firstChild, textChild);
});

test("changing only the colour leaves the icon and text nodes untouched", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ icon: "play", text: "Hello" });
  const before = toast.outerHTML;
  const iconChild = toast.querySelector(".pf-toast-icon").firstElementChild;
  const textChild = toast.querySelector(".pf-toast-text").firstChild;

  mgr.show({ icon: "play", text: "Hello", color: "#ff0000" });

  assert.ok(toast.style.color, "the colour landed");
  assert.notEqual(toast.outerHTML, before);
  assert.equal(toast.querySelector(".pf-toast-icon").firstElementChild, iconChild);
  assert.equal(toast.querySelector(".pf-toast-text").firstChild, textChild);
});

test("changing only the text keeps the icon node", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ icon: "play", text: "Hello" });
  const iconChild = toast.querySelector(".pf-toast-icon").firstElementChild;

  mgr.show({ icon: "play", text: "Hello world" });

  assert.equal(toast.querySelector(".pf-toast-text").textContent, "Hello world");
  assert.equal(toast.querySelector(".pf-toast-icon").firstElementChild, iconChild);
});

test("hide removes only the visibility class", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ icon: "play", text: "Hello" });

  mgr.hide();

  assert.ok(!toast.classList.contains("pf-visible"));
  assert.equal(toast.querySelector(".pf-toast-text").textContent, "Hello");
  assert.ok(toast.querySelector(".pf-toast-icon svg"), "the icon survived");
});

test("re-showing after a hide restores visibility without rebuilding content", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ icon: "play", text: "Hello" });
  const iconChild = toast.querySelector(".pf-toast-icon").firstElementChild;

  mgr.hide();
  mgr.show({ icon: "play", text: "Hello" });

  assert.ok(toast.classList.contains("pf-visible"));
  assert.equal(toast.querySelector(".pf-toast-icon").firstElementChild, iconChild);
  assert.equal(toast.querySelector(".pf-toast-text").textContent, "Hello");
});

test("a group-tagged hide only clears its own group", () => {
  const { mgr, toast } = makeManager();
  mgr.show({ text: "A", group: "fs" });

  mgr.hide("volume");
  assert.ok(toast.classList.contains("pf-visible"));

  mgr.hide("fs");
  assert.ok(!toast.classList.contains("pf-visible"));
});

test("a mutated and re-applied producer object still repaints", () => {
  const { mgr, toast } = makeManager();
  // The scrub hint re-uses and mutates one object every ~100ms tick. show()
  // must normalise it into a fresh snapshot, or the reconciler's identity
  // fast path swallows every repaint after the first.
  const payload = { icon: "left-arrows", text: "1.00 / 2.00", group: "scrub" };
  mgr.show(payload);
  const iconHtml = toast.querySelector(".pf-toast-icon").innerHTML;
  assert.equal(toast.querySelector(".pf-toast-text").textContent, "1.00 / 2.00");

  payload.icon = "right-arrows";
  payload.text = "1.50 / 2.00";
  mgr.show(payload);

  assert.equal(toast.querySelector(".pf-toast-text").textContent, "1.50 / 2.00");
  assert.notEqual(toast.querySelector(".pf-toast-icon").innerHTML, iconHtml);
  assert.equal(toast.querySelectorAll(".pf-toast-icon svg").length, 1);
});

test("actions render buttons, fire callbacks, and clear on the next bare show", () => {
  const { mgr, toast } = makeManager();
  let clicked = 0;
  mgr.show({
    text: "Resumed",
    actions: [{ label: "Go", onClick: () => { clicked += 1; } }]
  });

  const actions = toast.querySelector(".pf-toast-actions");
  assert.equal(actions.hidden, false);
  assert.equal(toast.style.pointerEvents, "auto");
  const btn = actions.querySelector("button");
  assert.equal(btn.textContent, "Go");

  btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(clicked, 1);

  mgr.show({ text: "Resumed" });
  assert.equal(actions.textContent, "");
  assert.equal(actions.hidden, true);
  assert.equal(toast.style.pointerEvents, "");
});

test("the auto-hide timer hides through the same visibility field", async () => {
  const { mgr, toast } = makeManager();
  mgr.show({ text: "bye", duration: 5 });
  assert.ok(toast.classList.contains("pf-visible"));

  await waitFor(() => !toast.classList.contains("pf-visible"));
  assert.equal(toast.querySelector(".pf-toast-text").textContent, "bye");

  mgr.show({ text: "bye" });
  assert.ok(toast.classList.contains("pf-visible"));
});
