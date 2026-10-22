import { measure } from "../lib.mjs";

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
// Lazy first load would read backing AS LEFT BY THE PREVIOUS CASE (the
// createEntry case exits with a 10-entry store), silently benching an empty
// id space. Cases that read disk state pin it eagerly here.
seeded.updateResume("e0", 0);

export default [
  measure("resume findMatch over 200 entries", () => {
    let sink;
    return () => {
      for (let i = 0; i < 20; i++) {
        sink = seeded.findMatch("youtube", `/watch/${180 + i}`, 600);
      }
      if (sink === undefined) throw new Error();
    };
  }),

  measure("resume createEntry fresh store (hash+persist)", () => {
    return () => {
      backing = { [STORE_KEY]: { version: 1, entries: [] } };
      const store = new ResumeStore();
      for (let i = 0; i < 10; i++) {
        store.createEntry(`site${i}.tld`, `/watch/${i}`, `T${i}`, 600);
      }
    };
  }),

  measure("resume updateResume persist+merge (200 entries)", () => {
    // Own backing + eager load: see the seeded-store note above.
    backing = { [STORE_KEY]: seed() };
    const freshStore = new ResumeStore();
    freshStore.updateResume("e0", 1);
    let pos = 100;
    return () => {
      // A monotonically advancing position: every tick is a real persist.
      // Repeating a fixed per-batch cycle would re-hit the identical-position
      // no-op guard and bench the guard instead of the persist path.
      for (let i = 0; i < 20; i++) {
        freshStore.updateResume(`e${180 + i}`, pos++ * 0.5);
      }
    };
  }),

  measure("resume getEntries sorted fetch (snapshot cached)", () => {
    // Own backing + eager load.
    backing = { [STORE_KEY]: seed() };
    const freshStore = new ResumeStore();
    freshStore.getEntries();
    let sink;
    return () => {
      // 10 sequential fetches: the first sorts once, the other nine must hit
      // the cached snapshot (query the regression that would catch a change
      // re-spreading + re-sorting per call).
      for (let i = 0; i < 10; i++) {
        sink = freshStore.getEntries();
      }
      if (sink === undefined) throw new Error();
    };
  }),

  measure("resume positional tick (echo-certified fast path)", () => {
    // Fresh store per invocation: the cache-split design keeps byId/byPath
    // live across position-only persists, so tick cost must be measured in a
    // warm, cached state - the whole point of the invalidation split.
    backing = { [STORE_KEY]: seed() };
    const warm = new ResumeStore();
    warm.updateResume("e0", 1);
    let sink;
    return () => {
      // One position-only persist per invocation: disk read + echo-certified
      // skip + bounds + write. This is the heartbeat of steady-state playback.
      warm.updateResume("e0", 200 + (sink = (sink === undefined ? 249 : sink) + 1));
      if (sink > 2500) {
        sink = 0;
      }
    };
  })
];
