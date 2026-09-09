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
 *
 * The bridge MUST be installed in every frame at document-start: kernels boot
 * lazily, so a video-bearing iframe cannot assume its ancestors run anything
 * unless the relay chain is already listening.
 */
/* - Window message types - */

/**
 * The postMessage types the frame bridge sends and receives across iframe
 * edges. Inlined here - they are used only by this module, so a shared
 * namespace would just add indirection.
 */
export const CTX_REQUEST_TYPE = "pf:ctx-request";
export const CTX_RESPONSE_TYPE = "pf:ctx";
export const FS_REQUEST_TYPE = "pf:req-fullscreen";

/* - 1. Domain identity - */

const DOMAIN_TLDS = {
  multi: new Set(["co", "com", "org", "net", "gov", "edu", "ac", "mil"]),
  single: new Set([
    "biz", "info", "name", "mobi", "asia", "tel", "travel", "jobs", "museum", "coop", "aero",
    "app", "blog", "dev", "fun", "game", "host", "live", "love", "new", "news", "one", "online",
    "page", "park", "plus", "pro", "shop", "site", "store", "tech", "video", "work", "xyz",
    "club", "life", "world", "today", "tools", "social", "beer", "email", "space", "cool",
    "social", "games", "legal", "luxury", "fans", "buzz", "country", "kim", "pub", "rest"
  ])
};
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
/** Memoized domain keys: pages resolve their hostname repeatedly (kernel +
 *  probe + responder), and the TLD walk is pure over hostname.
 *  Capped at 256 entries to prevent unbounded growth on SPAs with dynamic
 *  subdomains. Eviction clears the oldest half when the cap is hit.
 */
const DOMAIN_KEY_CACHE_MAX = 256;
const domainKeyCache = new Map();

/**
 * Reduce a hostname to its registrable-domain key (best effort, no PSL).
 * IP addresses become dash-separated so they are safe as identifiers.
 * Pure over hostname, so identical inputs share one cached result.
 */
export function getDomainKey(hostname) {
  if (!hostname) {
    return "";
  }
  if (domainKeyCache.has(hostname)) {
    return domainKeyCache.get(hostname);
  }
  let key;
  if (IPV4_RE.test(hostname)) {
    key = hostname.replaceAll(".", "-");
  } else if (hostname.includes(":")) {
    // Bracketed IPv6 ([::1]) or bare forms - the TLD walk would mangle them
    // into garbage keys, so collapse to one dash-safe identifier like IPv4.
    key = hostname.replace(/[\\[\]:]+/g, "-").replace(/^-+|-+$/g, "") || "ipv6";
  } else {
    const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
    const multiPartTlds = DOMAIN_TLDS.multi;
    const singleLabelTlds = DOMAIN_TLDS.single;
    let idx = parts.length - 1;
    if (parts[idx] && (parts[idx].length <= 3 || singleLabelTlds.has(parts[idx]))) {
      idx--;
    }
    if (parts[idx] && multiPartTlds.has(parts[idx])) {
      idx--;
    }
    // Suffixes missing from the curated lists (e.g. .basketball) never moved
    // `idx`, so without this the suffix LABEL itself would become the key -
    // collapsing every registrable domain under one unlisted gTLD into a single
    // entry. Assume the unclassified last label is a TLD and step up one more.
    if (idx === parts.length - 1 && parts.length >= 2) {
      idx--;
    }
    key = parts[Math.max(0, idx)] || "";
  }
  domainKeyCache.set(hostname, key);
  if (domainKeyCache.size > DOMAIN_KEY_CACHE_MAX) {
    const evict = Math.ceil(DOMAIN_KEY_CACHE_MAX / 4);
    let i = 0;
    for (const k of domainKeyCache.keys()) {
      domainKeyCache.delete(k);
      if (++i >= evict) break;
    }
  }
  return key;
}

/** Label-boundary containment: subdomains count, substrings do not. */
function boundaryContains(a, b) {
  return a.startsWith(`${b}.`) || a.endsWith(`.${b}`)
    || b.startsWith(`${a}.`) || b.endsWith(`.${a}`);
}

/** Reusable distance rows for the bounded Levenshtein below. Domain keys are
 *  short and ranking scans many candidates, so two scratch rows equal to the
 *  shorter operand avoid per-call allocation on the hot ranking path - and
 *  because operands are swapped to that axis, alternating candidate lengths
 *  reuse one small pair instead of reallocating per entry.
 */
let distRows = null;
let distRowLen = 0;

function ensureDistRows(len) {
  if (!distRows || distRowLen < len + 1) {
    distRows = [new Int32Array(len + 1), new Int32Array(len + 1)];
    distRowLen = len + 1;
  }
}

function boundedLevenshtein(a, b, max = Infinity) {
  const lenA = a.length;
  const lenB = b.length;
  if (Math.abs(lenA - lenB) > max) {
    return max + 1;
  }
  // Levenshtein is symmetric in its operands: iterate the longer string on the
  // row axis and keep the SHORTER one as the columns, so scratch-row sizing is
  // bound by the shorter operand (and the early-exit band stays exact).
  let rows = a;
  let cols = b;
  if (lenB > lenA) {
    rows = b;
    cols = a;
  }
  const m = cols.length;
  ensureDistRows(m);
  let prev = distRows[0];
  let curr = distRows[1];
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= rows.length; i++) {
    curr[0] = i;
    let rowMin = i;
    const ch = rows[i - 1];
    for (let j = 1; j <= m; j++) {
      const cost = ch === cols[j - 1] ? 0 : 1;
      const v = cost === 0 ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
      curr[j] = v;
      if (v < rowMin) {
        rowMin = v;
      }
    }
    if (rowMin > max) {
      return max + 1;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
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
 *
 * Feeds column-separator char codes directly instead of concatenating a seed
 * string (`${domainKey}::${path}::${duration}`): the old shape allocated the
 * seed and hashed the same bytes - the produced id is byte-for-byte identical,
 * so persisted resume entries keep matching, but no seed string is built.
 */
export function hashEntry(domainKey, path, duration) {
  let hash = 5381;
  for (let i = 0; i < domainKey.length; i++) {
    hash = ((hash << 5) + hash + domainKey.charCodeAt(i)) | 0;
  }
  hash = ((hash << 5) + hash + 58) | 0;
  hash = ((hash << 5) + hash + 58) | 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) + hash + path.charCodeAt(i)) | 0;
  }
  hash = ((hash << 5) + hash + 58) | 0;
  hash = ((hash << 5) + hash + 58) | 0;
  const dur = String(Math.round(duration));
  for (let i = 0; i < dur.length; i++) {
    hash = ((hash << 5) + hash + dur.charCodeAt(i)) | 0;
  }
  return (hash < 0 ? -hash : hash).toString(36).substring(0, 8);
}

/* - 3. Page context - */

const TITLE_TAGS = /(?:^|[- ])(?:uncensored|uncut|leaked|censored|raw|bd|hdrip|dvdrip|webrip|bluray|remux|cam|reduc(?:ing)?\s*mosaic|english\s*subtitle)/gi;

/**
 * Strip non-Latin script characters and common video-title tags from a page
 * title, keeping only the show name and episode number.
 * Returns the original when the result would be empty (entirely non-Latin).
 * Trailing punctuation left behind by removed segments is cleaned up.
 */
function stripNonAscii(raw) {
  if (!raw) return "";
  // Leading recording-code brackets are identifiers worth keeping, so pull
  // them out whole first. A code is CAPS-NUMBER; anything after that in the
  // same bracket is a qualifier (subtitle group, remux, ...) and is dropped:
  // "[MIMK-278-SUBS] Repentance" -> "[MIMK-278] Repentance". A plain
  // "[ABC-123]" is kept too; non-code brackets still go through the blanket
  // strip below. The preserved [CODE] is reattached after that pass.
  let code = "";
  const codeMatch = raw.match(/^\[([A-Z]+-\d+)(?:-[^\]]*)?\]/);
  if (codeMatch) {
    code = `[${codeMatch[1]}]`;
    raw = raw.slice(codeMatch[0].length);
  }
  let s = raw;
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(TITLE_TAGS, " ");
  s = s.replace(/[\u2013\u2014]/g, " ");
  s = s.replace(/[^\p{Script=Latin}\p{Script=Common}]+/gu, " ");
  s = s.replace(/\s{2,}/g, " ").replace(/^[\s\-–—|·:,/]+/, "").replace(/[\s\-–—|·:,/]+$/, "").trim();
  if (code) {
    return `${code} ${s}`.trim();
  }
  return s || raw;
}

/** Reuse one in-flight bridge request across the shells sharing this frame
 *  (a page hosting several videos boots one shell per video, so without this
 *  each would round-trip the parent chain to resolve the same context). The
 *  memo is cleared on settle, never cached: SPA path changes re-resolve.
 */
let frameContextBridge = null;

/** Page context resolved from THIS window, without any bridge: the direct
 *  answer for a top frame, and the fallback for a frame with no reachable
 *  parent chain (also makes {domain, path, title} testable in isolation).
 */
export function ownPageContext(win = window) {
  return {
    domain: getDomainKey(win.location.hostname),
    path: win.location.pathname,
    title: stripNonAscii(win.document?.title ?? "")
  };
}

/**
 * Resolve the page context ({domain, path, title}) this shell belongs to:
 * read the top frame directly when possible, otherwise ask up the parent
 * chain through the frame bridge. When no frame answers (bridgeless embed),
 * fall back to this frame's own context instead of skipping resume entirely.
 */
export async function getPageContext() {
  if (window.top === window) {
    return ownPageContext();
  }
  try {
    return ownPageContext(window.top);
  } catch {
    if (!frameContextBridge) {
      frameContextBridge = requestPageContextFromParent();
      frameContextBridge.then(
        () => {
          frameContextBridge = null;
        },
        () => {
          frameContextBridge = null;
        }
      );
    }
    const bridged = await frameContextBridge;
    return bridged ?? ownPageContext();
  }
}

/**
 * Backoff table (ms) for bridge request retries. The fixed 1200ms poll the
 * bridge previously used intentionally avoided hammering the parent chain, but
 * cost up to a full second of latency whenever the child raced the ancestors'
 * document-start message handlers (the common embed case). An exponential
 * backoff with jitter is just as sparing in the worst case yet answers a ready
 * parent within one short retry. Initial low latency for the typical
 * already-listening parent; jitter (<=250ms) prevents a thundering herd when
 * several nested frames boot simultaneously.
 */
const CTX_RETRY_BACKOFF = [60, 150, 320, 640];
const CTX_RETRY_JITTER_MS = 250;

/**
 * Established private context pipe to an ancestor responder. Set the FIRST time
 * a resolve is answered on a transferred port, then reused by every later
 * resolve so repeat requests never recreate/transfer a channel or touch the
 * broadcast channel again. Null when no ancestor honored a port (legacy chain)
 * or after the pipe dies (teardown/timeout) so a fresh one can be established.
 */
let contextPipe = null;
/**
 * Remember a chain that only ever answers the broadcast (no port ever came
 * back). Later resolves skip creating + transferring a channel that the legacy
 * chain just drops, avoiding a wasted MessageChannel per resolve. Reset when a
 * port pipe is established (the chain may have been upgraded mid-session).
 */
let legacyChain = false;

/** Private one-shot context request over an established pipe: no broadcast,
 *  no transfer, no retry - the pipe is live and dedicated. Times out (and
 *  drops the dead pipe) instead of queueing, so the caller can fall back. */
function requestPageContextOverPipe(timeoutMs, deadline) {
  const { promise, resolve } = Promise.withResolvers();
  const ac = new AbortController();
  const pipe = contextPipe;
  let settled = false;
  let answered = false;

  const settle = (context) => {
    if (settled) {
      return;
    }
    settled = true;
    ac.abort();
    resolve(context);
  };

  const onData = (event) => {
    const data = event.data;
    if (answered) {
      return;
    }
    if (data && typeof data === "object" && data.type === CTX_RESPONSE_TYPE
        && typeof data.domain === "string") {
      answered = true;
      settle({
        domain: data.domain,
        path: data.path,
        title: stripNonAscii(typeof data.title === "string" ? data.title : "")
      });
    }
  };

  let signal;
  try {
    signal = AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]);
  } catch {
    signal = null;
  }

  const dropDeadPipe = () => {
    if (contextPipe === pipe) {
      contextPipe = null;
      try {
        pipe.port.close();
      } catch {}
    }
  };

  if (signal) {
    signal.addEventListener("abort", () => {
      // The abort fires both on the timeout AND on settle()'s own ac.abort()
      // after a response. Only a timeout (no answer) means the pipe is dead.
      if (answered) {
        return;
      }
      dropDeadPipe();
      settle(null);
    }, { once: true });
  } else {
    const timer = setTimeout(() => {
      if (answered) {
        return;
      }
      dropDeadPipe();
      ac.abort();
      settle(null);
    }, Math.max(0, deadline - Date.now()));
    ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }

  pipe.port.addEventListener("message", onData, { signal: ac.signal });
  try {
    pipe.port.postMessage({ type: CTX_REQUEST_TYPE, nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}` });
  } catch {
    // Port already closed under us: re-establish from scratch on the next call.
    dropDeadPipe();
    settle(null);
  }
  return promise;
}

/** Ask the parent chain for page context via postMessage (cross-origin iframes).
 *
 * Reuses an established private MessageChannel pipe when one exists: repeat
 * resolves ride the dedicated, unforgeable link straight to the ancestor
 * responder - no broadcast, no transfer, no retry. Otherwise a first contact
 * creates a channel and transfers a port upward; the answer identifies whether
 * the chain supports the pipe (port answer: establishment) or only the legacy
 * broadcast (fallback, and the chain is remembered as legacy so later resolves
 * stop wasting channels on it).
 *
 * The legacy nonce broadcast remains the fallback for parents (or test hosts
 * such as jsdom) that drop transferred ports.
 */
function requestPageContextFromParent(timeoutMs = CTX_REQUEST_TIMEOUT_MS) {
  if (contextPipe) {
    return requestPageContextOverPipe(timeoutMs, Date.now() + timeoutMs);
  }

  const { promise, resolve } = Promise.withResolvers();
  const ac = new AbortController();
  let nonce = null;
  let retryTimer = null;
  let attemptCount = 0;
  let replyPort = null;
  let transferPort = null;
  let settled = false;

  // AbortSignal.any() + AbortSignal.timeout() is the ideal path (Chromium 103+),
  // but Node's brand-check can reject timeout signals in older runtimes.
  // Feature-detect and fall back to manual deadline tracking.
  let signal;
  let useSignalAny = false;
  try {
    signal = AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]);
    useSignalAny = true;
  } catch {
    signal = ac.signal;
  }
  const deadline = useSignalAny ? 0 : Date.now() + timeoutMs;

  const settle = (context, viaPort) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(retryTimer);
    ac.abort();
    if (replyPort) {
      if (viaPort) {
        // A port answered: the chain supports a private pipe. Retain the pipe
        // for repeat resolves instead of closing it with this one.
        importMarshalPipe(replyPort);
        legacyChain = false;
      } else {
        try {
          replyPort.removeEventListener("message", onReplyPort);
          replyPort.close();
        } catch {}
      }
    }
    resolve(context);
  };

  // Private pipe: an ancestor that honored the transfer answers here directly.
  const onReplyPort = (event) => {
    const data = event.data;
    if (data && typeof data === "object" && data.type === CTX_RESPONSE_TYPE
        && typeof data.domain === "string") {
      settle({
        domain: data.domain,
        path: data.path,
        title: stripNonAscii(typeof data.title === "string" ? data.title : "")
      }, true);
    }
  };
  if (!legacyChain && typeof MessageChannel === "function") {
    try {
      const mc = new MessageChannel();
      replyPort = mc.port1;
      transferPort = mc.port2;
      replyPort.addEventListener("message", onReplyPort);
      replyPort.start();
    } catch {
      replyPort = null;
      transferPort = null;
    }
  }

  const onMessage = (event) => {
    const data = event.data;
    if (
      event.source === window.parent
      && data && typeof data === "object"
      && data.type === CTX_RESPONSE_TYPE && data.nonce === nonce
      && typeof data.domain === "string"
    ) {
      // Broadcast answer: this chain does not honor ports - remember it so
      // later resolves stop allocating channels it will only drop.
      legacyChain = true;
      settle({
        domain: data.domain,
        path: data.path,
        title: stripNonAscii(typeof data.title === "string" ? data.title : "")
      }, false);
    }
  };

  if (useSignalAny) {
    signal.addEventListener("abort", () => {
      settle(null, false);
    }, { once: true });
  }

  window.addEventListener("message", onMessage, { signal });

  let portAttached = false;
  const sendRequest = () => {
    nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const msg = { type: CTX_REQUEST_TYPE, nonce };
    if (transferPort && !portAttached) {
      try {
        window.parent.postMessage(msg, "*", [transferPort]);
        portAttached = true;
        return;
      } catch {
        // Parent rejected the transfer (e.g. neutered port); fall through to
        // the plain nonce broadcast for this and every later attempt.
        transferPort = null;
      }
    }
    window.parent.postMessage(msg, "*");
  };
  const attempt = () => {
    if (useSignalAny ? signal.aborted : Date.now() >= deadline) {
      if (!useSignalAny) ac.abort();
      settle(null, false);
      return;
    }
    sendRequest();
    const base = CTX_RETRY_BACKOFF[Math.min(attemptCount, CTX_RETRY_BACKOFF.length - 1)];
    attemptCount++;
    retryTimer = setTimeout(attempt, base + Math.floor(Math.random() * (CTX_RETRY_JITTER_MS + 1)));
  };
  attempt();
  return promise;
}

/** Retain a responding port as the frame's persistent context pipe. Per-request
 *  listeners attach transiently (see requestPageContextOverPipe); nothing hangs
 *  off the pipe between resolves. Reset with the bridge teardown. */
function importMarshalPipe(port) {
  if (contextPipe) {
    try {
      contextPipe.port.close();
    } catch {}
  }
  contextPipe = { port };
}

/** Drop the persistent pipe + legacy memo when the frame bridge is torn down. */
export function stopContextPipe() {
  if (contextPipe) {
    try {
      contextPipe.port.close();
    } catch {}
  }
  contextPipe = null;
  legacyChain = false;
}

/* - 4. Frame bridge - */

const NONCE_TTL_MS = 5000;
export const CTX_REQUEST_TIMEOUT_MS = 3000;

/**
 * Handler for the top frame: answers validated context requests. Context is
 * resolved per request (not captured at install time) so late titles and SPA
 * route changes are reflected. Requests qualify when they originate from our
 * own origin or from one of this document's <iframe> descendants.
 *
 * The payload deliberately omits document.title: any embed in the page can
 * pass the frame-tree vouch, and the title is the one field with nothing to
 * offer resume matching (domain + path + duration drive identity). Domain
 * and path stay because cross-origin players cannot function without them.
 */
export function createTopFrameResponder(resolveContext, ownOrigin = location.origin, post = defaultPostToSource) {
  // Ports that established a private pipe get a persistent handler: after the
  // first contact, the requesting frame sends every later resolve straight
  // over the pipe, and those messages arrive as MessagePort events (no window
  // source/origin/ports), so the window responder alone would never see them.
  const pipePorts = new Set();

  const onPipeRequest = (port) => (event) => {
    const data = event.data;
    if (!data || typeof data !== "object" || data.type !== CTX_REQUEST_TYPE
        || typeof data.nonce !== "string") {
      return;
    }
    const { domain, path, title } = resolveContext();
    try {
      port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
    } catch {
      // Port closed under us; the next request on it won't arrive either.
    }
  };

  return (event) => {
    const data = event && event.data;
    if (
      !data || typeof data !== "object"
      || data.type !== CTX_REQUEST_TYPE || typeof data.nonce !== "string"
      || !event.source
    ) {
      return;
    }
    if (event.origin !== ownOrigin && !isOwnFrame(event.source)) {
      return;
    }
    const { domain, path, title } = resolveContext();
    const ports = event.ports || [];
    if (ports.length) {
      const port = ports[0];
      if (!pipePorts.has(port)) {
        // First contact on a fresh pipe: register the persistent handler so
        // repeat resolves over this port are answered without ever touching
        // the window message channel again.
        pipePorts.add(port);
        port.addEventListener("message", onPipeRequest(port));
        port.start();
      }
      // A transferred MessageChannel pipe rides the request up the relay
      // chain; answer directly on it - unforgeable, no broadcast echo. Fall
      // back to the broadcast path if the port is already gone.
      try {
        port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
        return;
      } catch {
        // Port neutered/closed: answer the requester by broadcast instead.
      }
    }
    post(event.source, {
      type: CTX_RESPONSE_TYPE,
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
    if (data.type === CTX_REQUEST_TYPE && typeof data.nonce === "string" && event.source) {
      // Only accept from a DIRECT <iframe> child of this document - the same
      // vouch the fullscreen provisioner demands. A relay may only be asked by
      // frames it spawned: anything else (sibling, parent, unhosted window)
      // gets dropped instead of being forwarded up the chain. contentWindow
      // stays readable across origins, so cross-origin children still pass.
      if (!iframeElementForWindow(event.source)) {
        return;
      }
      // Remember who asked AND from which origin: the answer must travel back
      // down addressed to the requester's origin - this hop's upstream origin
      // would get the delivery dropped whenever the two differ. Kept for the
      // legacy broadcast answer; a port request is also answered directly on
      // the pipe, but a mixed chain may still deliver down as a broadcast.
      pending.set(data.nonce, { source: event.source, origin: event.origin });
      setTimeout(() => pending.delete(data.nonce), NONCE_TTL_MS);
      // Requests carrying a transferred MessageChannel port are chained upward
      // by re-transferring the SAME port, so the top frame's answer travels
      // back down the private, unforgeable pipe straight to the requester.
      // Our copy is neutered by the transfer; the nonce entry above still
      // guards a legacy broadcast answer arriving instead.
      const ports = event.ports || [];
      try {
        window.parent.postMessage(data, "*", ports.length ? ports : undefined);
      } catch {
        window.parent.postMessage(data, "*");
      }
    } else if (data.type === CTX_RESPONSE_TYPE && pending.has(data.nonce)) {
      // Answers may only come from the parent we relayed to - a sibling or
      // nested frame that guesses a live nonce must not inject context.
      if (event.source !== window.parent) {
        return;
      }
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

/* - 4a. Live iframe registry - */

/**
 * Live map from <iframe> contentWindow -> element, refreshed by an observer
 * that lives for the whole frame bridge. Without it, every relayed message
 * rewound the full frame tree via querySelectorAll - O(frametree) per message
 * on iframe-heavy pages.
 *
 * This is self-contained to the shared layer (no dependency on the kernel's
 * dom-watch dispatcher, which is installed lazily and may not exist when the
 * bridge boots at document-start) and torn down by the bridge teardown, so a
 * top frame that never relays pays no ongoing cost. Cross-origin iframe
 * elements are still readable (contentWindow stays accessible across origins),
 * so a cross-origin child's element is resolvable here - which is exactly what
 * the fullscreen provisioner and frame relay need to vouch event.source.
 */
const iframeCache = new Map();
/** Document the cache currently describes. Tracked so a document swap (fresh
 *  page / test harness) reseeds instead of serving a stale map. */
let iframeCacheDoc = null;
/** True once the bridge wired the cache observer (installContextBridge). Before
 *  that - e.g. handlers used directly - iframeElementForWindow scans inline so
 *  the vouch stays correct even unseeded. */
let iframeCacheActive = false;
/** Observer driving the cache; lifecycled by startIframeCache/stopIframeCache. */
let iframeCacheObserver = null;

/** (Re)build the cache from the live <iframe> set. ContentWindow never throws,
 *  so this is safe across same- and cross-origin subtrees. Only used for the
 *  initial install and a document swap reseed - ongoing updates are
 *  differential (diffIframeCache). */
function seedIframeCache() {
  iframeCache.clear();
  for (const ifr of document.querySelectorAll("iframe")) {
    const win = ifr.contentWindow;
    if (win) {
      iframeCache.set(win, ifr);
    }
  }
}

/** Register one <iframe> element under its contentWindow. Idempotent: moved or
 *  re-inserted frames just update the entry in place (Map keyed by window). */
function registerIframe(ifr) {
  const win = ifr.contentWindow;
  if (win) {
    iframeCache.set(win, ifr);
  }
}

/** Register every <iframe> inside one added node (an `<iframe>` itself, or a
 *  container subtree). Scoped to the added node only - the old full reseed
 *  walked the whole document every batch even when nothing changed. */
function collectIframes(node) {
  if (!node || node.nodeType !== 1) {
    return;
  }
  if (node.localName === "iframe") {
    registerIframe(node);
    return;
  }
  const set = node.querySelectorAll("iframe");
  for (let i = 0; i < set.length; i++) {
    registerIframe(set[i]);
  }
}

/** Keep the cache diffed against one observer batch: added nodes register any
 *  iframes they carry, then an isConnected sweep drops frames removed anywhere
 *  - including inside a dropped ancestor subtree (the SPA replacer case, which
 *  no added-node scan covers). One O(added subtree) traversal per batch plus a
 *  constant sweep over the map (bounded by iframe count) instead of the old
 *  shape, which re-ran a full querySelectorAll("iframe") over the document for
 *  EVERY batch, even one touching nothing iframe-related. */
function diffIframeCache(records) {
  for (const record of records) {
    const added = record.addedNodes;
    for (let i = 0; i < added.length; i++) {
      collectIframes(added[i]);
    }
  }
  for (const [win, ifr] of iframeCache) {
    if (!ifr.isConnected) {
      iframeCache.delete(win);
    }
  }
}

/** Install the cache observer bound to the current document. Returns an
 *  AbortSignal teardown. Degrades gracefully when MutationObserver is absent
 *  (jsdom without an explicit binding): the cache stays inactive and
 *  iframeElementForWindow falls back to a scan, so the bridge's message
 *  handling never depends on it.
 *
 *  The observe target falls back to `document` when the root element has not
 *  been parsed yet (fresh nested frames at document-start): observing the
 *  document node covers the same subtree and never throws on a missing
 *  documentElement - a throw here would abort entry.js's boot BEFORE the
 *  video probe, silently killing capture in that frame.
 */
function startIframeCache(ac) {
  if (typeof MutationObserver !== "function") {
    return;
  }
  seedIframeCache();
  iframeCacheDoc = document;
  iframeCacheActive = true;
  iframeCacheObserver = new MutationObserver(diffIframeCache);
  try {
    iframeCacheObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch {
    // Root not available yet (or observer rejected): drop the cache instead of
    // throwing out of the bridge install - scans remain the fallback vouch.
    stopIframeCache();
    return;
  }
  ac.signal.addEventListener("abort", () => {
    stopIframeCache();
  }, { once: true });
}

function stopIframeCache() {
  iframeCacheObserver?.disconnect();
  iframeCacheObserver = null;
  iframeCacheActive = false;
  iframeCacheDoc = null;
}

/** Ensure the cache describes the CURRENT document, reseeding and rebinding the
 *  observer if the document swapped underneath us (fresh jsdom/page). */
function ensureIframeCacheCurrent() {
  if (!iframeCacheActive || iframeCacheDoc === document) {
    return;
  }
  if (typeof MutationObserver !== "function") {
    stopIframeCache();
    return;
  }
  // Cache belongs to a previous document - rebind to the live one.
  iframeCacheObserver?.disconnect();
  seedIframeCache();
  iframeCacheDoc = document;
  try {
    iframeCacheObserver = new MutationObserver(diffIframeCache);
    iframeCacheObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    stopIframeCache();
  }
}

/** The direct <iframe> child of THIS document whose contentWindow is `win`, or null. */
function iframeElementForWindow(win) {
  if (!win) {
    return null;
  }
  if (iframeCacheActive) {
    ensureIframeCacheCurrent();
    return iframeCache.get(win) || null;
  }
  // Fallback before the bridge seeds the cache (or when handlers are used
  // directly): scan inline so the vouch never silently drops.
  for (const iframe of document.querySelectorAll("iframe")) {
    if (iframe.contentWindow === win) {
      return iframe;
    }
  }
  return null;
}

/**
 * Browsers require `allowfullscreen`/`allow="fullscreen"` on EVERY ancestor
 * iframe for requestFullscreen() to succeed in a nested frame. A video parked
 * behind a cross-origin iframe therefore silently loses fullscreen - and with
 * it PlayerForge's fullscreen-gated gestures - unless we provision it. The
 * video frame pushes a `pf:req-fullscreen` hop up the chain;
 * each frame grants `allowfullscreen` on the DIRECT child iframe it received
 * the request from (event.source is always the immediate child, readable even
 * across origins), then forwards to its own parent. Granting is scoped to that
 * one child, so a hostile foreign window cannot punch allowfullscreen for
 * frames it does not own: every grant is vouched by an own-<iframe> match.
 */

/** Grant allowfullscreen on an iframe element when it lacks it (idempotent). */
function grantFullscreen(frameElement) {
  if (!frameElement.hasAttribute("allowfullscreen")) {
    frameElement.setAttribute("allowfullscreen", "");
  }
  const allow = frameElement.getAttribute("allow") || "";
  if (!/(?:^|\s)fullscreen(?:\s|$)/.test(allow)) {
    frameElement.setAttribute("allow", `${allow ? `${allow} ` : ""}fullscreen`);
  }
  return frameElement;
}

/**
 * Sender side, called by a video-bearing frame: request fullscreen provisioning
 * (allowfullscreen + allow="fullscreen") on every ancestor iframe up the chain.
 * Granting is a one-shot, idempotent operation per frame (ancestors install
 * their provisioners at document start, well before the first request made
 * here), so further requests would only replay the same hops - latch it.
 */
let fullscreenProvisionSent = false;
export function requestFullscreenProvision() {
  if (fullscreenProvisionSent) {
    return;
  }
  fullscreenProvisionSent = true;
  window.parent?.postMessage({ type: FS_REQUEST_TYPE }, "*");
}

/**
 * Handler for the top frame: grant allowfullscreen on the direct child iframe
 * that asked, then stop (no parent). Vouched by an own-child match.
 */
export function createTopFrameProvisioner() {
  return (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object" || data.type !== FS_REQUEST_TYPE) {
      return;
    }
    const frameElement = iframeElementForWindow(event.source);
    if (frameElement) {
      grantFullscreen(frameElement);
    }
  };
}

/**
 * Handler for relay frames: grant allowfullscreen on the direct child that
 * asked, then forward the request to our own parent so the chain continues.
 * The child is vouched the same way - only an iframe this document owns gets
 * its allowlist expanded.
 */
export function createFrameProvisioner() {
  return (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object" || data.type !== FS_REQUEST_TYPE) {
      return;
    }
    const frameElement = iframeElementForWindow(event.source);
    if (frameElement) {
      grantFullscreen(frameElement);
      window.parent?.postMessage(data, "*");
    }
  };
}

/**
 * Install the frame bridge (context + fullscreen provisioning) for this frame
 * and return a single teardown. Top frames answer and provision; nested frames
 * relay both. Idempotent per frame - the userscript evaluates exactly once per
 * document sandbox.
 */
export function installContextBridge() {
  const ac = new AbortController();
  const handlers = window === window.top ? [
    createTopFrameResponder(() => ({
      domain: getDomainKey(location.hostname),
      path: location.pathname,
      title: stripNonAscii(document.title)
    })),
    createTopFrameProvisioner()
  ] : [
    createFrameRelay(),
    createFrameProvisioner()
  ];
  for (const handler of handlers) {
    window.addEventListener("message", handler, { signal: ac.signal });
  }
  // Every handler above vouch-checks event.source against the live iframe
  // registry; seed it once (with an observer keeping it current) so relayed
  // messages never pay a per-message tree scan. Torn down with the bridge.
  startIframeCache(ac);
  return () => {
    ac.abort();
    stopContextPipe();
  };
}
