import test from "node:test";
import assert from "node:assert/strict";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { ResumeStore } = await import("../src/shell/resume.js");

const STORE_KEY = "pf:resume";

function installGm(initial) {
  let data = initial;
  const writes = [];
  globalThis.GM_getValue = (key, fallback) => (key === STORE_KEY ? data ?? fallback : fallback);
  globalThis.GM_setValue = (key, value) => {
    if (key === STORE_KEY) {
      writes.push(value);
      data = value;
    }
  };
  return { writes, latest: () => data };
}

let seq = 0;
function entry(overrides = {}) {
  return {
    id: `e${++seq}`,
    domain: "youtube",
    path: "/watch",
    title: "",
    duration: 600,
    resume: 0,
    pending: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  };
}

test("missing or corrupt store resets to an empty versioned doc", () => {
  const gm = installGm({ oops: true });
  const store = new ResumeStore();
  assert.deepEqual(store.findMatch("youtube", "/watch", 600), null);
  assert.equal(gm.latest().entries.length, 0);
  assert.equal(gm.latest().version, 1);
});

test("pending entries are dropped on first load", () => {
  const gm = installGm({
    version: 1,
    entries: [entry({ pending: true }), entry({ id: "keep" })]
  });
  const store = new ResumeStore();
  const found = store.findMatch("youtube", "/watch", 600);
  assert.equal(found?.id, "keep");
  assert.equal(gm.latest().entries.length, 1);
});

test("findMatch requires the exact path", () => {
  installGm({ version: 1, entries: [entry()] });
  const store = new ResumeStore();
  assert.equal(store.findMatch("youtube", "/watch?v=other", 600), null);
  assert.ok(store.findMatch("youtube", "/watch", 600));
});

test("duration differences beyond the fuzz setting are rejected", () => {
  installGm({ version: 1, entries: [entry({ duration: 603 })] });
  const store = new ResumeStore();
  assert.equal(store.findMatch("youtube", "/watch", 600), null);
  assert.ok(store.findMatch("youtube", "/watch", 602));
});

test("closer durations outrank fuzzier ones at equal domain class", () => {
  installGm({
    version: 1,
    entries: [entry({ id: "far", duration: 602 }), entry({ id: "near", duration: 601 })]
  });
  const store = new ResumeStore();
  assert.equal(store.findMatch("youtube", "/watch", 600)?.id, "near");
});

test("exact domain keys outrank boundary-related ones", () => {
  installGm({
    version: 1,
    entries: [
      entry({ id: "boundary", domain: "tv.apple" }),
      entry({ id: "exact" })
    ]
  });
  const store = new ResumeStore();
  assert.equal(store.findMatch("youtube", "/watch", 600)?.id, "exact");
  assert.equal(store.findMatch("apple", "/watch", 600)?.id, "boundary");
});

test("createEntry dedupes by hash id and by fuzzy match", () => {
  installGm({ version: 1, entries: [] });
  const store = new ResumeStore();
  const first = store.createEntry("youtube", "/watch", "T", 600);
  const sameId = store.createEntry("youtube", "/watch", "T", 600);
  const fuzzy = store.createEntry("youtube", "/watch", "T", 601);
  assert.equal(sameId, first);
  assert.equal(fuzzy, first);
});

test("updateResume persists position and timestamp", () => {
  const e = entry();
  const gm = installGm({ version: 1, entries: [e] });
  const store = new ResumeStore();
  store.updateResume(e.id, 123.5);
  const persisted = gm.latest().entries[0];
  assert.equal(persisted.resume, 123.5);
  assert.ok(persisted.updatedAt >= Date.now() - 1000);
});

test("persist merges foreign entries written by concurrent tabs", () => {
  const gm = installGm({ version: 1, entries: [entry({ id: "mine" })] });
  const store = new ResumeStore();
  gm.latest().entries.push(entry({ id: "theirs" }));
  store.updateResume("mine", 42);
  const ids = gm.latest().entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ["mine", "theirs"]);
  assert.equal(gm.latest().entries.find((e) => e.id === "mine").resume, 42);
});

test("cleanStale drops old entries and persists the pruning", () => {
  const day = 86400000;
  const gm = installGm({
    version: 1,
    entries: [
      entry({ id: "old", updatedAt: Date.now() - 20 * day }),
      entry({ id: "fresh" })
    ]
  });
  const store = new ResumeStore();
  store.cleanStale(14);
  const ids = gm.latest().entries.map((e) => e.id);
  assert.deepEqual(ids, ["fresh"]);
});
