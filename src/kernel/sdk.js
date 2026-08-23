/** Container selectors probed (in order) via video.closest() to find the player wrapper. */
export const PLAYER_SELECTORS = [
  ".jwplayer",
  "[id*=\"jwplayer\"]",
  ".jw-wrapper",
  "[data-vjs-player]",
  ".video-js",
  ".vjs-tech",
  "[data-plyr]",
  ".plyr",
  ".plyr__video-wrapper",
  ".artplayer",
  ".art-video-player",
  ".dplayer",
  "#dplayer",
  ".mejs-container",
  ".mejs__container",
  "[class*=\"player\"]",
  "[class*=\"video-wrapper\"]",
  "[class*=\"video-container\"]",
  "[data-player]",
  "[class*=\"bg-black\"][class*=\"overflow-hidden\"][class*=\"select-none\"]"
];

export const MIN_VIDEO_WIDTH = 100;
export const MIN_VIDEO_HEIGHT = 60;

const CONTAINER_MIN_WIDTH = 200;
const CONTAINER_MIN_HEIGHT = 100;
const MAX_ANCESTOR_WALK = 8;

/** Identify the SDK from the closest matching player container. */
export function findSdkForVideo(video) {
  for (const selector of PLAYER_SELECTORS) {
    const container = video.closest(selector);
    if (container) {
      return identifySdk(container, selector);
    }
  }
  return null;
}

function identifySdk(element, matchedSelector) {
  const signature = `${element.className || ""} ${element.id || ""}`;
  if (/\bjw/i.test(signature) || matchedSelector.startsWith(".jw")) {
    return { name: "JW Player", selectors: [".jwplayer", "[id*=\"jwplayer\"]"] };
  } else if (/\bvjs/i.test(signature) || matchedSelector.startsWith(".vjs") || matchedSelector.startsWith("[data-vjs")) {
    return { name: "Video.js", selectors: ["[data-vjs-player]", ".video-js"] };
  } else if (/\bplyr/i.test(signature) || matchedSelector.startsWith(".plyr") || matchedSelector.startsWith("[data-plyr")) {
    return { name: "Plyr", selectors: ["[data-plyr]", ".plyr"] };
  } else if (/\bart\b/i.test(signature) || matchedSelector.startsWith(".art")) {
    return { name: "ArtPlayer", selectors: [".artplayer", ".art-video-player"] };
  } else if (/\bdplayer\b/i.test(signature) || matchedSelector.startsWith(".dplayer")) {
    return { name: "DPlayer", selectors: [".dplayer", "#dplayer"] };
  } else if (/\bmejs/i.test(signature) || matchedSelector.startsWith(".mejs")) {
    return { name: "MediaElement.js", selectors: [".mejs-container", ".mejs__container"] };
  } else {
    return { name: "Generic", selectors: [matchedSelector] };
  }
}

/**
 * Resolve the real <video> for a media event. Media events don't bubble, but
 * capture listeners on document still receive them through the composed path —
 * where shadow-DOM hosts retarget event.target away from the actual video
 * (open roots only; closed roots are unreachable by design).
 */
export function videoFromEvent(event) {
  const target = event.target;
  if (target?.localName === "video") {
    return target;
  }
  for (const node of event.composedPath?.() ?? []) {
    if (node?.localName === "video") {
      return node;
    }
  }
  return null;
}

/**
 * Find the element that should host the shell DOM: prefer an SDK container,
 * then the nearest positioned ancestor of meaningful size, then the parent.
 */
export function findContainer(video, sdk) {
  if (sdk.selectors?.length) {
    for (const selector of sdk.selectors) {
      const container = video.closest(selector);
      if (container) {
        return container;
      }
    }
  }
  let ancestor = video.parentElement;
  let depth = 0;
  while (ancestor && depth < MAX_ANCESTOR_WALK) {
    const style = getComputedStyle(ancestor);
    if (style.position === "relative" || style.position === "absolute") {
      const rect = ancestor.getBoundingClientRect();
      if (rect.width >= CONTAINER_MIN_WIDTH && rect.height >= CONTAINER_MIN_HEIGHT) {
        return ancestor;
      }
    }
    ancestor = ancestor.parentElement;
    depth++;
  }
  return video.parentElement || null;
}
