import { measure } from "../lib.mjs";
import { findSdkForVideo } from "../../src/kernel/sdk.js";

/** Selector-satisfying fake node - enough surface for composedAncestry(). */
function fakeNode(selectors, parent) {
  const set = new Set(selectors);
  return {
    nodeType: 1,
    parentNode: parent,
    matches: (selector) => set.has(selector)
  };
}

/**
 * Typical Plyr-style tree: video nested 4 deep under ".plyr", with decoy
 * classes that other registries would want to claim if they could.
 * parentNode points UP the real DOM way - ancestry walks video -> root.
 */
function buildTree() {
  const root = fakeNode(["[data-vjs-player]", "[data-player]"], null);
  const container = fakeNode([".video-js"], root);
  const plyr = fakeNode([".plyr", "[data-plyr]"], container);
  const wrapper = fakeNode([".plyr__video-wrapper"], plyr);
  const video = fakeNode([], wrapper);
  return { video, winner: plyr };
}

const { video, winner } = buildTree();

/** Unmemoized twin of `video` - fresh identity per full-scan iteration. */
const freshVideo = () => buildTree().video;

// Warm the WeakMap memo once so the repeat-query case measures hits only.
findSdkForVideo(video);

export default [
  measure("findSdkForVideo full scan (Plyr tree)", () => {
    let sink;
    return () => {
      sink = findSdkForVideo(freshVideo());
      if (!sink || !sink.name.includes("Plyr")) throw new Error(`unexpected winner: ${JSON.stringify(sink)}`);
      void winner;
    };
  }),

  measure("findSdkForVideo repeat query (memo hit)", () => {
    let sink;
    return () => {
      sink = findSdkForVideo(video);
      if (!sink || !sink.name.includes("Plyr")) throw new Error("memo lost");
    };
  }),

  measure("findSdkForVideo miss (generic markup)", () => {
    // ".player" is deliberately unregistered - generic player markup stays unrecognized.
    const div = fakeNode([".player"], null);
    const bareVideo = fakeNode([], div);
    let sink;
    return () => {
      sink = findSdkForVideo(bareVideo);
      if (sink !== null) throw new Error("expected miss");
    };
  })
];
