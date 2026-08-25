/**
 * Page context engine.
 *
 * One module answering everything about WHERE a PlayerForge instance runs:
 * which site it belongs to, how to compare sites, how embedded players learn
 * their top-page identity across origins, and whether this document hosts a
 * player at all.
 *
 * Sections:
 *   1. Domain identity   - registrable-domain keys and comparison
 *   2. Entry hashing     - deterministic ids for resume entries
 *   3. Page context      - resolving {domain, path, title} for this shell
 *   4. Frame bridge      - always-on top<->iframe message plumbing (context)
 *   5. Presence probe    - defers full kernel boot until a video shows up
 *
 * The bridge MUST be installed in every frame at document-start: kernels boot
 * lazily, so a video-bearing iframe cannot assume its ancestors run anything
 * unless the relay chain is already listening.
 */
import { logger } from "./logger.js";
import { watchDocumentVideos, meetsMinSize } from "../kernel/sdk.js";

/* - 1. Domain identity - */

/**
 * Reduce a hostname to its registrable-domain key (best effort, no PSL).
 * IP addresses become dash-separated so they are safe as identifiers.
 */
export function getDomainKey(hostname) {
  if (!hostname) {
    return "";
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
    return hostname.replace(/\./g, "-");
  }
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const multiPartTlds = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "mil"]);
  let idx = parts.length - 1;
  if (parts[idx] && parts[idx].length <= 3) {
    idx--;
  }
  if (parts[idx] && multiPartTlds.has(parts[idx])) {
    idx--;
  }
  return parts[Math.max(0, idx)] || "";
}

/** Label-boundary containment: subdomains count, substrings do not. */
function boundaryContains(a, b) {
  return a.startsWith(`${b}.`) || a.endsWith(`.${b}`)
    || b.startsWith(`${a}.`) || b.endsWith(`.${a}`);
}

function boundedLevenshtein(a, b, max = Infinity) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > max) {
    return max + 1;
  }
  let prev = new Array(lenB + 1);
  for (let j = 0; j <= lenB; j++) {
    prev[j] = j;
  }
  let curr = new Array(lenB + 1);
  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    let rowMin = i;
    const chA = a[i - 1];
    for (let j = 1; j <= lenB; j++) {
      const cost = chA === b[j - 1] ? 0 : 1;
      curr[j] = cost === 0 ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    [prev, curr] = [curr, prev];
  }
  return prev[lenB];
}

/** Strict equality or label-boundary relation between two domain keys. */
export function domainsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return a === b || boundaryContains(a, b);
}

/**
 * Graded similarity for ranking: exact 3, boundary-related 2, otherwise
 * distance-based decay to 0. Fuzz never promotes to a match - it only orders
 * candidates once domainsMatch() has accepted them.
 */
export function domainScore(a, b) {
  if (!a || !b) {
    return 0;
  }
  if (a === b) {
    return 3;
  }
  if (boundaryContains(a, b)) {
    return 2;
  }
  return Math.max(0, 3 - boundedLevenshtein(a, b, 3));
}

/* - 2. Entry hashing - */

/**
 * Deterministic djb2-based id for a (domain, path, duration) triple. The
 * domain participates so identical paths on different sites can never
 * collide into one shared entry - /watch/1 on two hosts are different videos.
 */
export function hashEntry(domainKey, path, duration) {
  const seed = `${domainKey}::${path}::${Math.round(duration)}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) + hash + seed.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36).substring(0, 8);
}

/* - 3. Page context - */

/**
 * Resolve the page context ({domain, path, title}) this shell belongs to:
 * read the top frame directly when possible, otherwise ask up the parent
 * chain through the frame bridge.
 */
export async function getPageContext() {
  if (window.top === window) {
    return {
      domain: getDomainKey(location.hostname),
      path: location.pathname,
      title: document.title
    };
  }
  try {
    const top = window.top;
    return {
      domain: getDomainKey(top.location.hostname),
      path: top.location.pathname,
      title: top.document?.title ?? ""
    };
  } catch {
    return requestPageContextFromParent();
  }
}

/** Ask the parent chain for page context via postMessage (cross-origin iframes). */
function requestPageContextFromParent(timeoutMs = CTX_REQUEST_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const { promise, resolve } = Promise.withResolvers();
  let nonce = null;
  let retryTimer = null;

  const onMessage = (event) => {
    const data = event.data;
    if (
      event.source === window.parent
      && data && typeof data === "object"
      && data.type === "pf:ctx" && data.nonce === nonce
      && typeof data.domain === "string"
    ) {
      clearTimeout(retryTimer);
      window.removeEventListener("message", onMessage);
      resolve({
        domain: data.domain,
        path: data.path,
        title: data.title
      });
    }
  };

  window.addEventListener("message", onMessage);

  const sendRequest = () => {
    nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.parent.postMessage({ type: "pf:ctx-request", nonce }, "*");
  };
  const attempt = () => {
    if (Date.now() >= deadline) {
      window.removeEventListener("message", onMessage);
      resolve(null);
      return;
    }
    sendRequest();
    retryTimer = setTimeout(attempt, 1200);
  };
  attempt();
  return promise;
}

/* - 4. Frame bridge - */

const NONCE_TTL_MS = 5000;
export const CTX_REQUEST_TIMEOUT_MS = 3000;

/**
 * Handler for the top frame: answers validated context requests. Context is
 * resolved per request (not captured at install time) so late titles and SPA
 * route changes are reflected. Requests qualify when they originate from our
 * own origin or from one of this document's <iframe> descendants.
 */
export function createTopFrameResponder(resolveContext, ownOrigin = location.origin, post = defaultPostToSource) {
  return (event) => {
    const data = event && event.data;
    if (
      !data || typeof data !== "object"
      || data.type !== "pf:ctx-request" || typeof data.nonce !== "string"
      || !event.source
    ) {
      return;
    }
    if (event.origin !== ownOrigin && !isOwnFrame(event.source)) {
      return;
    }
    const { domain, path, title } = resolveContext();
    post(event.source, {
      type: "pf:ctx",
      nonce: data.nonce,
      domain,
      path,
      title
    }, event.origin || "*");
  };
}

function defaultPostToSource(source, message, origin) {
  source.postMessage(message, origin);
}

/** Handler for nested frames: relays requests upward and answers back down. */
export function createFrameRelay() {
  const pending = new Map();
  return (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    if (data.type === "pf:ctx-request" && typeof data.nonce === "string" && event.source) {
      // Remember who asked AND from which origin: the answer must travel back
      // down addressed to the requester's origin - this hop's upstream origin
      // would get the delivery dropped whenever the two differ.
      pending.set(data.nonce, { source: event.source, origin: event.origin });
      setTimeout(() => pending.delete(data.nonce), NONCE_TTL_MS);
      window.parent.postMessage(data, "*");
    } else if (data.type === "pf:ctx" && pending.has(data.nonce)) {
      const requester = pending.get(data.nonce);
      pending.delete(data.nonce);
      requester.source?.postMessage(data, requester.origin || "*");
    }
  };
}

/**
 * True when window is an <iframe> descendant reachable through this document.
 * Walks nested frame trees while they stay same-origin readable; a cross-origin
 * layer's subtree is invisible, so descendants behind it are not vouched for -
 * the strict security posture is unchanged, only deeper visible trees count.
 */
function isOwnFrame(source) {
  const scan = (doc, depth) => {
    if (depth > 4) {
      return false;
    }
    for (const iframe of doc.querySelectorAll("iframe")) {
      if (iframe.contentWindow === source) {
        return true;
      }
      try {
        const nested = iframe.contentDocument;
        if (nested && scan(nested, depth + 1)) {
          return true;
        }
      } catch {
        // Cross-origin contentDocument throws: subtree ends here.
      }
    }
    return false;
  };
  return scan(document, 0);
}

/**
 * Install the context bridge for this frame and return its teardown. Top
 * frames answer; nested frames relay. Idempotent per frame - the userscript
 * evaluates exactly once per document sandbox.
 */
export function installContextBridge() {
  const handler = window === window.top
    ? createTopFrameResponder(() => ({
        domain: getDomainKey(location.hostname),
        path: location.pathname,
        title: document.title
      }))
    : createFrameRelay();
  window.addEventListener("message", handler);
  return () => window.removeEventListener("message", handler);
}

/* - 5. Presence probe - */

/**
 * Cheap sentinel that defers the full kernel boot until a document actually
 * shows a video candidate. Under @run-at document-start nothing pre-exists
 * us: SDK-created players trip the shared discovery tap the moment their
 * <video> enters the DOM, and static players fire loadeddata/play right
 * after parse. The first size-qualified candidate fires onCandidate exactly
 * once; documents without video never pay for a kernel.
 */
export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  const stop = watchDocumentVideos((video) => {
    if (done || !meetsMinSize(video, minWidth, minHeight)) {
      return;
    }
    done = true;
    stop();
    logger.log("probe", "Video candidate found - booting kernel");
    onCandidate();
  });
  return stop;
}
