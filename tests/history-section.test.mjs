import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

globalThis.GM_getValue = () => undefined;
globalThis.GM_setValue = () => {};
globalThis.GM_addValueChangeListener = () => {};

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://www.youtube.com/watch?v=1" });
globalThis.window = dom.window;
globalThis.location = dom.window.location;
globalThis.document = dom.window.document;

const { addHistorySection } = await import("../src/shell/chrome/history.js");

let sectionRoot = null;
function makeFakePanel() {
  const node = (tag, attrs = {}, parent = null) => {
    const el = dom.window.document.createElement(tag);
    if (attrs.class) el.className = attrs.class;
    if (attrs.type) el.setAttribute("type", attrs.type);
    if (attrs.title !== undefined) el.setAttribute("title", attrs.title);
    if (attrs["aria-label"]) el.setAttribute("aria-label", attrs["aria-label"]);
    if (parent) parent.appendChild(el);
    return el;
  };
  return {
    el: (tag, attrs, parent) => node(tag, attrs, parent),
    addSection: (title, id) => {
      sectionRoot = node("div", { title });
      return sectionRoot;
    }
  };
}

function makeFakeShell() {
  let listener = null;
  const entries = [];
  return {
    entries,
    notify: (structural) => listener?.(structural),
    resume: {
      getEntries: () => entries,
      onChange: (cb) => {
        listener = cb;
        return () => { listener = null; };
      },
      resetEntry: () => {},
      removeEntry: () => {}
    },
    toast: () => {}
  };
}

test("History re-renders on structural store changes only", () => {
  const panel = makeFakePanel();
  const shell = makeFakeShell();
  addHistorySection(panel, shell);
  const list = sectionRoot.querySelector(".pf-history-list");
  const hint = sectionRoot.querySelector(".pf-panel-hint");

  assert.equal(list.querySelectorAll(".pf-history-card").length, 0, "empty store renders no cards");
  assert.equal(hint.hidden, false, "empty store shows the hint");

  shell.entries.push({ id: "e1", domain: "youtube", path: "/watch", title: "Show", duration: 300, resume: 0 });
  shell.notify(true);
  assert.equal(list.querySelectorAll(".pf-history-card").length, 1, "a new entry re-renders the list");
  assert.equal(hint.hidden, true, "hint hides once entries exist");
  assert.equal(list.querySelector(".pf-history-title")?.textContent, "Show");
  assert.ok(list.querySelector(".pf-history-meta")?.textContent.includes("Youtube"));
  assert.ok(list.querySelector(".pf-history-meta")?.textContent.includes("5:00"));
});

test("History ignores position-only store updates", () => {
  const panel = makeFakePanel();
  const shell = makeFakeShell();
  addHistorySection(panel, shell);
  const list = sectionRoot.querySelector(".pf-history-list");

  shell.entries.push({ id: "e1", domain: "youtube", path: "/watch", title: "Show", duration: 300 });
  shell.notify(true);
  assert.equal(list.querySelectorAll(".pf-history-card").length, 1);

  shell.entries[0].resume = 250;
  shell.notify(false);
  assert.equal(list.querySelectorAll(".pf-history-card").length, 1, "a position save leaves the list untouched");
  assert.equal(list.querySelector(".pf-history-title")?.textContent, "Show");
});

test("History restores the hint when the list empties", () => {
  const panel = makeFakePanel();
  const shell = makeFakeShell();
  addHistorySection(panel, shell);
  const list = sectionRoot.querySelector(".pf-history-list");
  const hint = sectionRoot.querySelector(".pf-panel-hint");

  shell.entries.push({ id: "e1", domain: "youtube", path: "/watch", title: "Show", duration: 300 });
  shell.notify(true);
  assert.equal(list.querySelectorAll(".pf-history-card").length, 1);

  shell.entries.length = 0;
  shell.notify(true);
  assert.equal(list.querySelectorAll(".pf-history-card").length, 0);
  assert.equal(hint.hidden, false, "removing the last entry shows the hint again");
});