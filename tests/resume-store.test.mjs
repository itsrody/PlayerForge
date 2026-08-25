import test from "node:test";
import assert from "node:assert/strict";

globalThis.GM_getValue = (key, fallback) => fallback;
globalThis.GM_setValue = () => {};

const { ResumeStore } = await import("../src/shell/resume.js");

const STORE_KEY = "pf:resume";

function installGm(initial) {
  let data = initial;
  const writes = [];
  globalThis.GM_getValue = (key, fallback) => {
    if (key !== STORE_KEY) {
      return fallback;
    }
    // Violentmonkey hands back a fresh deserialization per read - mimic it
    // so shared-reference bugs between "disk" and memory cannot hide.
    return data == null ? fallback : JSON.parse(JSON.stringify(data));
  };
  globalThis.GM_setValue = (key, value) => {
    if (key === STORE_KEY) {
      writes.push(value);
      data = value;
    }
  };
  return {
    writes,
    latest: () => data,
    /** Simulate an external writer (another tab / cloud sync) landing data. */
    writeExternal: (doc) => {
      data = JSON.parse(JSON.stringify(doc));
    }
  };
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

test("identical paths on different domains never share an entry", () => {
  installGm({ version: 1, entries: [] });
  const store = new ResumeStore();
  const a = store.createEntry("youtube", "/watch", "A", 600);
  const b = store.createEntry("vimeo", "/watch", "B", 600);
  assert.notEqual(a.id, b.id);
  assert.equal(store.findMatch("youtube", "/watch", 600)?.id, a.id);
  assert.equal(store.findMatch("vimeo", "/watch", 600)?.id, b.id);
});

test("legacy foreign-domain entry with a colliding legacy id is ignored", () => {
  // Pre-fix store: /watch@600 hashed WITHOUT domain - both sites got "x1".
  installGm({
    version: 1,
    entries: [{ ...entry(), id: "x1", domain: "vimeo", resume: 300 }]
  });
  const store = new ResumeStore();
  const mine = store.createEntry("youtube", "/watch", "T", 600);
  assert.notEqual(mine.id, "x1");
  assert.equal(mine.resume, 0);
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

test("persist adopts newer remote revisions of known ids", () => {
  const e = entry({ id: "mine" });
  const gm = installGm({ version: 1, entries: [e] });
  const store = new ResumeStore();
  // Remote write landed after our load, stamped in the future.
  gm.writeExternal({ version: 1, entries: [{ ...e, resume: 777, updatedAt: Date.now() + 10000 }] });
  store.updateResume("mine", 42);
  assert.equal(gm.latest().entries.find((x) => x.id === "mine").resume, 777);
});

test("persist keeps local revisions when they are newest", () => {
  const e = entry({ id: "mine" });
  const gm = installGm({ version: 1, entries: [e] });
  const store = new ResumeStore();
  // A stale cloud copy must not clobber our fresh position.
  gm.writeExternal({ version: 1, entries: [{ ...e, resume: 777, updatedAt: Date.now() - 60000 }] });
  store.updateResume("mine", 42);
  assert.equal(gm.latest().entries.find((x) => x.id === "mine").resume, 42);
});

test("value change listener hot-reloads foreign writes", () => {
  let fire;
  globalThis.GM_addValueChangeListener = (key, cb) => {
    fire = () => cb(key, null, null, true);
  };
  try {
    const gm = installGm({ version: 1, entries: [] });
    const store = new ResumeStore();
    gm.writeExternal({ version: 1, entries: [entry({ id: "remote-tab" })] });
    fire();
    assert.ok(store.findMatch("youtube", "/watch", 600));
  } finally {
    delete globalThis.GM_addValueChangeListener;
  }
});

test("foreign versions and malformed entries are adopted instead of reset", () => {
  const good = entry({ id: "keep" });
  const gm = installGm({ version: 99, note: "future writer", entries: [good, null, { broken: true }] });
  const store = new ResumeStore();
  assert.ok(store.findMatch("youtube", "/watch", 600));
  store.updateResume("keep", 10);
  assert.equal(gm.latest().version, 1);
  assert.equal(gm.latest().entries.length, 1);
});

test("cleanStale enforces the entry cap by evicting oldest", () => {
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 1005; i++) {
    many.push(entry({ id: `e${i}`, updatedAt: now - i * 1000 }));
  }
  const gm = installGm({ version: 1, entries: many });
  const store = new ResumeStore();
  store.cleanStale();
  const kept = gm.latest().entries;
  assert.equal(kept.length, 1000);
  assert.ok(!kept.some((e) => e.id === "e1004"));
  assert.ok(kept.some((e) => e.id === "e0"));
});

test("importData merges, dedupes, and rejects invalid documents", () => {
  installGm({ version: 1, entries: [] });
  const store = new ResumeStore();
  const doc = { version: 1, entries: [entry({ id: "a" }), entry({ id: "b" })] };
  assert.deepEqual(store.importData(JSON.stringify(doc)), { added: 2, updated: 0 });
  assert.deepEqual(store.importData(JSON.stringify(doc)), { added: 0, updated: 0 });
  doc.entries[0].resume = 555;
  doc.entries[0].updatedAt = Date.now() + 5000;
  assert.deepEqual(store.importData(JSON.stringify(doc)), { added: 0, updated: 1 });
  assert.equal(store.findMatch("youtube", "/watch", 600).resume, 555);
  assert.equal(store.importData("not json"), null);
  assert.equal(store.importData("{}"), null);
});
