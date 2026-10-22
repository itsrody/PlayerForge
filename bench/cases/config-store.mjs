import { measure } from "../lib.mjs";

const STORE_KEY = "pf:configs";
let backing = { [STORE_KEY]: { version: 1 } };

globalThis.GM_getValue = (key, fallback) => (key === STORE_KEY && backing[STORE_KEY] != null ? JSON.parse(JSON.stringify(backing[STORE_KEY])) : fallback);
globalThis.GM_setValue = (key, value) => {
  if (key === STORE_KEY) {
    backing[STORE_KEY] = JSON.parse(JSON.stringify(value));
  }
};

// The Settings cache is module-state; every dynamic import shares one store.
const { setSetting, getSetting } = await import("../../src/shell/chrome/config.js");

const KEYS = [
  "panel.position",
  "panel.opacity",
  "gestures.scrub.length",
  "subtitles.style.size",
  "resume.saveEpsilonSeconds"
];

export default [
  measure("config setSetting (copy-on-write per dotted path)", () => {
    let i = 0;
    return () => {
      setSetting(KEYS[i++ % KEYS.length], i % 7);
    };
  }),

  measure("config getSetting (doc cached at most once)", () => {
    let sink = 0;
    return () => {
      for (let i = 0; i < 50; i++) {
        sink = getSetting(KEYS[i % KEYS.length], i);
      }
      if (typeof sink !== "number" && typeof sink !== "object") {
        throw new Error();
      }
    };
  })
];
