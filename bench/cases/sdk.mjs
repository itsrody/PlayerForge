import { define } from "../lib.mjs";
import { resolvePlayer } from "../../src/kernel/sdk.js";

/**
 * Selector-satisfying fake node - enough surface for fillComposedChain():
 * nodeType, parentNode/host, and matches(). The grouped `:is()` pre-check
 * is answered from a precomputed flag so the harness cost stays out of the
 * measured region; per-anchor selectors answer from the set directly.
 */
function fakeNode(selectors, parent) {
  const set = new Set(selectors);
  return {
    nodeType: 1,
    parentNode: parent,
    host: null,
    matches: (selector) => {
      if (set.has(selector)) {
        return true;
      }
      if (selector.startsWith(":is(")) {
        for (const s of set) {
          if (selector.includes(s)) {
            return true;
          }
        }
      }
      return false;
    }
  };
}

/**
 * Typical Plyr-style tree: video nested under ".plyr__video-wrapper", with
 * decoy anchors above it that other templates would claim at a longer hop
 * distance. parentNode points UP the real DOM way - ancestry walks
 * video -> root, and fewest hops wins.
 */
function buildTree() {
  const root = fakeNode(["[data-vjs-player]", "[data-player]"], null);
  const container = fakeNode([".video-js"], root);
  const plyr = fakeNode([".plyr", "[data-plyr]"], container);
  const wrapper = fakeNode([".plyr__video-wrapper"], plyr);
  const video = fakeNode([], wrapper);
  return { video, winner: wrapper };
}

const { video, winner } = buildTree();

/** Unmemoized twin of `video` - fresh identity per full-scan iteration. */
const freshVideo = () => buildTree().video;

// Warm the WeakMap memo once so the repeat-query case measures hits only.
resolvePlayer(video);

export default [
  define("resolvePlayer full scan (Plyr tree)", () => {
    let sink;
    return () => {
      // Fresh identity per iteration defeats the memo; hops === 1 proves
      // the nearest anchor won (each fresh tree has its own wrapper, so
      // identity cannot be asserted here).
      sink = resolvePlayer(freshVideo());
      if (!sink || sink.hops !== 1) throw new Error("unexpected winner");
    };
  }),

  define("resolvePlayer repeat query (memo hit)", () => {
    let sink;
    return () => {
      sink = resolvePlayer(video);
      if (!sink || sink.container !== winner) throw new Error("memo lost");
    };
  }),

  define("resolvePlayer miss (generic markup)", () => {
    // ".player" is deliberately unregistered - generic player markup stays unrecognized.
    const div = fakeNode([".player"], null);
    const bareVideo = fakeNode([], div);
    let sink;
    return () => {
      sink = resolvePlayer(bareVideo);
      if (sink !== null) throw new Error("expected miss");
    };
  })
];
