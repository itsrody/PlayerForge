import { define } from "../lib.mjs";

const STORE_KEY = "pf:resume";
let backing = {};

globalThis.GM_getValue = (key, fallback) => (key === STORE_KEY && backing[STORE_KEY] != null ? JSON.parse(JSON.stringify(backing[STORE_KEY])) : fallback);
globalThis.GM_setValue = (key, value) => {
  if (key === STORE_KEY) {
    backing[STORE_KEY] = JSON.parse(JSON.stringify(value));
  }
};

// Dynamic import so the GM_* stubs above exist before resume.js's
// transitive config/storage chain runs its module-level reads.
const { ResumeStore } = await import("../../src/shell/resume.js");

/** 200-entry store, mixed domains, one fuzzy candidate near the end. */
function seed(n = 200) {
  const entries = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `e${i}`,
      domain: i % 2 ? "youtube" : `site${i % 17}.tld`,
      path: `/watch/${i}`,
      title: `Video ${i}`,
      duration: 600 + i,
      resume: 42,
      updatedAt: Date.now()
    });
  }
  return { version: 1, entries };
}

const seeded = new ResumeStore();
backing = { [STORE_KEY]: seed() };

export default [
  define("resume findMatch over 200 entries", () => {
    let sink;
    return () => {
      for (let i = 0; i < 20; i++) {
        sink = seeded.findMatch("youtube", `/watch/${180 + i}`, 600);
      }
      if (sink === undefined) throw new Error();
    };
  }),

  define("resume createEntry fresh store (hash+persist)", () => {
    return () => {
      backing = { [STORE_KEY]: { version: 1, entries: [] } };
      const store = new ResumeStore();
      for (let i = 0; i < 10; i++) {
        store.createEntry(`site${i}.tld`, `/watch/${i}`, `T${i}`, 600);
      }
    };
  }),

  define("resume updateResume persist+merge (200 entries)", () => {
    // Seed and force the lazy load HERE, in the factory. Every factory in
    // this file runs at import time, before any body executes - and the
    // previous case replaces `backing` with a 10-entry store on its way past.
    // Loading lazily inside the measured body therefore found 10 hashed ids,
    // `updateResume("e180")` matched nothing, and the whole body was skipped:
    // the row measured 20 no-op lookups, never touching merge or persist.
    // Forcing the load now pins the 200 seeded entries in memory.
    backing = { [STORE_KEY]: seed() };
    const store = new ResumeStore();
    store.getEntries();
    return () => {
      for (let i = 0; i < 20; i++) {
        store.updateResume(`e${180 + i}`, 100 + i);
      }
    };
  })
];
