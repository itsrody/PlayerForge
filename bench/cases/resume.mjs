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
    const freshStore = new ResumeStore();
    return () => {
      for (let i = 0; i < 20; i++) {
        freshStore.updateResume(`e${180 + i}`, 100 + i);
      }
    };
  })
];
