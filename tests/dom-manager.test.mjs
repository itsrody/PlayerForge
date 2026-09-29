import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const { window } = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.MutationObserver = window.MutationObserver;
// jsdom validates addEventListener's `signal` against its own AbortSignal
// class; the deferred-flush visibility listener must resolve to it too.
globalThis.AbortController = window.AbortController;

const { onDomMutations, DOMManager, DomPool } = await import("../src/shared/dom-manager.js");
const { yield_ } = await import("../src/shared/scheduler.js");

/**
 * Wait for a scheduling boundary that is queued AFTER the observer's own
 * flush boundary: `await null` lets the mutation-notify microtask (which
 * posts yield_'s flush message) run first, then yield_() posts ours behind
 * it. MessageChannel messages run in post order, ahead of timers, so the
 * flush (or its deliberate absence) is always observable here.
 */
async function tick() {
  await null;
  await yield_();
}

/** A container attached to the document, for tests that assert removal. */
function host() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/** A bubbling click, so capture/delegation behaviour is exercised. */
function click(el) {
  el.dispatchEvent(new window.Event("click", { bubbles: true }));
}

test("fan-out delivers coalesced records to every subscriber", async () => {
  const seen = [];
  const offA = onDomMutations((records) => seen.push(["a", records.length]));
  const offB = onDomMutations((records) => seen.push(["b", records.length]));

  const div = document.createElement("div");
  document.body.appendChild(div);
  await tick();

  assert.equal(seen.filter(([who]) => who === "a").length, 1);
  assert.equal(seen.filter(([who]) => who === "b").length, 1);
  offA();
  offB();
});

test("multiple mutations in one task arrive as one batch", async () => {
  let calls = 0;
  let total = 0;
  const off = onDomMutations((records) => {
    calls++;
    total += records.length;
  });
  for (let i = 0; i < 5; i++) {
    document.body.appendChild(document.createElement("span"));
  }
  await tick();
  assert.equal(calls, 1);
  assert.ok(total >= 5);
  off();
});

test("unsubscribe tears the observer down when the last subscriber leaves", async () => {
  let calls = 0;
  const off = onDomMutations(() => {
    calls++;
  });
  off();

  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 0);

  // Re-subscribing after full teardown must observe again.
  let calls2 = 0;
  const off2 = onDomMutations(() => {
    calls2++;
  });
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls2, 1);
  off2();
});

test("a throwing subscriber never aborts delivery to its peers [uBO safeObserverHandler rule]", async () => {
  const delivered = [];
  const offBad = onDomMutations(() => {
    throw new Error("consumer bug");
  });
  const offGood = onDomMutations((records) => {
    delivered.push(records.length);
  });

  document.body.appendChild(document.createElement("span"));
  await tick();

  assert.ok(delivered.length >= 1, "the healthy peer still received the batch");

  offBad();
  offGood();
});

test("every flush delivers only its own batch (recycled buffers are drained)", async () => {
  const batches = [];
  const off = onDomMutations((records) => batches.push(records.length));
  // One mutation + flush per round: the pool swaps buffers between flushes, so
  // any buffer that is re-armed without being emptied re-delivers records from
  // an earlier round alongside the current one.
  for (let round = 0; round < 5; round++) {
    document.body.appendChild(document.createElement("span"));
    await tick();
  }
  off();
  assert.deepEqual(batches, [1, 1, 1, 1, 1]);
});

test("a signal-bound subscription drops out on abort", async () => {
  const ac = new AbortController();
  let calls = 0;
  onDomMutations(() => {
    calls++;
  }, { signal: ac.signal });

  ac.abort();
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 0);
});

test("compaction cannot let a stale unsubscribe tombstone a live peer [regression]", async () => {
  // Five subscribers, four leave: 5 slots for 1 live is past the 4:1 ratio, so
  // the next flush compacts and reindexes. An off() closure that captured an
  // INDEX would then target whatever landed in that slot instead of its own
  // entry, leaving the peer subscribed forever with a `live` count that never
  // reaches zero.
  const seen = [];
  const offs = [];
  for (let i = 0; i < 5; i++) {
    offs.push(onDomMutations(() => seen.push(i)));
  }
  for (let i = 0; i < 4; i++) offs[i]();

  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.deepEqual(seen, [4], "the surviving peer still received the batch");

  offs[4]();
  seen.length = 0;
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.deepEqual(seen, [], "the reindexed peer's off() reached its own slot");
});

test("a subscription made before the root element exists still receives [regression]", async () => {
  // A document-start userscript is evaluated before the parser has produced the
  // root element - the whole point of instant injection. The feed used to bail
  // out silently in that window with no retry, so this subscriber would have
  // been wired to nothing for the life of the page. It has to survive the root
  // element arriving afterwards.
  const root = document.documentElement;
  root.remove();
  assert.equal(document.documentElement, null, "the pre-parser window is modelled");

  let calls = 0;
  const off = onDomMutations(() => {
    calls++;
  });

  // The parser's own output lands now: root element, then body, then content.
  const fresh = document.createElement("html");
  document.appendChild(fresh);
  const body = document.createElement("body");
  fresh.appendChild(body);
  await tick();
  body.appendChild(document.createElement("div"));
  await tick();

  off();
  assert.ok(calls >= 2, `the feed was live through the rebuild (${calls} batches)`);
  assert.ok(document.body, "the document is usable again");
});

/* ==================================================================
   §2 — DOMManager
   ================================================================== */

test("listen() releases on the returned disposer and again on destroy", () => {
  const dom = new DOMManager();
  const el = host();
  let a = 0;
  let b = 0;
  const offA = dom.listen(el, "click", () => a++);
  dom.listen(el, "click", () => b++);

  click(el);
  assert.equal(a, 1);
  assert.equal(b, 1);

  offA();
  click(el);
  assert.equal(a, 1, "the early disposer detached one listener");
  assert.equal(b, 2);

  dom.destroy();
  click(el);
  assert.equal(b, 2, "destroy released the signal-bound listener");
  el.remove();
});

test("listen() keeps capture when given the boolean shorthand", () => {
  const dom = new DOMManager();
  const el = host();
  el.appendChild(document.createElement("span"));
  let seen = 0;
  dom.listen(el, "click", () => seen++, true);

  click(el.firstChild);
  assert.equal(seen, 1, "the capture-phase listener saw the event");
  dom.destroy();
  el.remove();
});

test("destroy() is idempotent and post-destroy registrations are inert", () => {
  const dom = new DOMManager();
  const el = host();
  dom.createElement("div", {}, el);
  assert.equal(el.children.length, 1);

  dom.destroy();
  dom.destroy();
  assert.equal(el.children.length, 0, "the created node was removed");
  assert.equal(dom.createElement("div", {}, el), null, "no node is created after destroy");

  let ran = 0;
  dom.onCleanup(() => ran++);
  assert.equal(ran, 1, "a cleanup registered after destroy runs at once");

  let calls = 0;
  dom.listen(el, "click", () => calls++);
  click(el);
  assert.equal(calls, 0, "listen() after destroy attaches nothing");
  el.remove();
});

test("onCleanup() runs in reverse registration order", () => {
  const dom = new DOMManager();
  const order = [];
  dom.onCleanup(() => order.push("first"));
  dom.onCleanup(() => order.push("second"));
  dom.onCleanup(() => order.push("third"));
  dom.destroy();
  assert.deepEqual(order, ["third", "second", "first"]);
});

test("createElement() binds on* handlers and drops them with the manager", () => {
  const dom = new DOMManager();
  const el = host();
  let clicks = 0;
  const node = dom.createElement("div", {
    class: "pf-x",
    style: { opacity: "0.5" },
    onClick: () => clicks++
  }, el);

  assert.equal(node.className, "pf-x");
  assert.equal(node.style.opacity, "0.5");
  click(node);
  assert.equal(clicks, 1, "onClick registered for 'click', not 'Click'");

  dom.destroy();
  click(node);
  assert.equal(clicks, 1, "the handler went with the manager's signal");
  el.remove();
});

test("own() adopts a tree built elsewhere", () => {
  const dom = new DOMManager();
  const el = host();
  const tree = document.createElement("div");
  tree.appendChild(document.createElement("span"));
  el.appendChild(tree);
  dom.own(tree);

  dom.destroy();
  assert.equal(el.children.length, 0, "the adopted subtree was removed");
  el.remove();
});

test("markAttribute() restores a present value and removes an absent one", () => {
  const dom = new DOMManager();
  const el = host();
  el.setAttribute("data-keep", "original");

  dom.markAttribute(el, "data-keep", "playerforge");
  dom.markAttribute(el, "data-new", "playerforge");
  assert.equal(el.getAttribute("data-keep"), "playerforge");

  dom.destroy();
  assert.equal(el.getAttribute("data-keep"), "original");
  assert.equal(el.getAttribute("data-new"), null, "an absent original is removed, not blanked");
  el.remove();
});

test("markStyle() restores the previous inline value and drops a new one", () => {
  const dom = new DOMManager();
  const el = host();
  el.style.setProperty("position", "absolute");

  dom.markStyle(el, "position", "relative");
  dom.markStyle(el, "opacity", "0.5");
  assert.equal(el.style.getPropertyValue("position"), "relative");

  dom.destroy();
  assert.equal(el.style.getPropertyValue("position"), "absolute");
  assert.equal(el.style.getPropertyValue("opacity"), "", "an unset original is removed");
  el.remove();
});

test("rollback is order-independent across two managers [regression]", () => {
  const el = host();
  const a = new DOMManager();
  const b = new DOMManager();

  a.markAttribute(el, "data-pf", "a");
  b.markAttribute(el, "data-pf", "b");
  a.markStyle(el, "position", "fixed");
  b.markStyle(el, "position", "relative");
  assert.equal(el.getAttribute("data-pf"), "b");
  assert.equal(el.style.getPropertyValue("position"), "relative");

  // The FIRST writer owns the restore. If each manager kept its own record,
  // the second would have captured the first manager's value as its
  // "original", and tearing the first down before the second would leave the
  // second one's value stranded on the element forever.
  a.destroy();
  b.destroy();
  assert.equal(el.getAttribute("data-pf"), null);
  assert.equal(el.style.getPropertyValue("position"), "");
  el.remove();
});

test("pool() is manager-owned: destroy removes checked-out nodes too [regression]", () => {
  const dom = new DOMManager();
  const el = host();
  const pool = dom.pool({ factory: () => el.appendChild(document.createElement("i")) });

  const first = pool.acquire();
  pool.acquire();
  assert.equal(el.children.length, 2);
  pool.release(first);
  assert.equal(pool.idle, 1);

  dom.destroy();
  assert.equal(el.children.length, 0, "the still-checked-out node was removed too");
  el.remove();
});

test("a double release cannot hand one node to two cards [regression]", () => {
  const dom = new DOMManager();
  const pool = dom.pool({ factory: () => document.createElement("i") });
  const node = pool.acquire();

  pool.release(node);
  pool.release(node);
  assert.equal(pool.idle, 1, "the second release was a no-op");

  const a = pool.acquire();
  const b = pool.acquire();
  assert.notEqual(a, b);
  assert.equal(pool.idle, 0);
  dom.destroy();
});

test("watch() routes to the shared feed and unsubscribes with the manager", async () => {
  const dom = new DOMManager();
  let calls = 0;
  dom.watch(() => calls++);

  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 1);

  dom.destroy();
  document.body.appendChild(document.createElement("div"));
  await tick();
  assert.equal(calls, 1, "no deliveries after destroy");
});

/* ==================================================================
   §3 — DomPool
   ================================================================== */

test("DomPool recycles pre-made elements, shrinks, and clears every node it produced", () => {
  let resets = 0;
  const el = host();
  const pool = new DomPool({
    initial: 2,
    factory: () => el.appendChild(document.createElement("i")),
    reset: (node) => {
      resets++;
      return node;
    }
  });
  assert.equal(pool.idle, 2);

  const a = pool.acquire();
  assert.equal(resets, 1, "a pre-made element was reused, not a fresh factory node");
  const b = pool.acquire();
  const c = pool.acquire();
  assert.equal(pool.idle, 0);
  assert.notEqual(a, b);

  pool.release(a);
  pool.release(b);
  pool.release(c);
  assert.equal(pool.idle, 3);
  pool.shrink(1);
  assert.equal(pool.idle, 1);

  pool.destroy();
  assert.equal(el.children.length, 0, "idle and checked-out nodes alike are gone");
  el.remove();
});
