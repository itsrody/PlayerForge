/**
 * Page identity and frames.
 *
 * One module answering everything about WHERE a PlayerForge instance runs:
 *   1. Domain identity - registrable-domain keys, comparison, similarity
 *   2. Entry hashing   - deterministic ids for resume entries
 *   3. Page context    - resolving {domain, path, title} for this shell
 *   4. Frame bridge    - always-on top<->iframe message plumbing + fullscreen
 *                        provisioning; the live iframe registry
 *
 * The bridge MUST be installed in every frame at document-start: kernels boot
 * lazily, so a video-bearing iframe cannot assume its ancestors run anything
 * unless the relay chain is already listening.
 */
import { onDomMutations } from "./dom.js";

/* - 1. Domain identity - */

/**
 * One module answering everything about WHICH SITE a PlayerForge instance
 * belongs to and how sites compare: registrable-domain keys and comparison,
 * graded similarity ranking, and deterministic resume-entry hashing - pure
 * functions over their inputs with no window, document, or message plumbing;
 * resume matching consumes them directly.
 */

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
/** Memo cap: stops unbounded growth on pages with dynamic subdomains. */
const DOMAIN_KEY_CACHE_MAX = 256;

/**
 * The capped hostname->key memo as one class. Pages resolve their hostname
 * repeatedly (kernel + probe + responder) and the TLD walk is pure over
 * hostname, so identical inputs share one cached result; the Map, the cap,
 * and the eviction walk are private to the instance (the same one-owner
 * shape as the layer's other memos - DomainMatcher's scratch rows,
 * TitleSanitizer's slot). The exported getDomainKey stays the thin wrapper.
 */
class DomainKeyCache {
  #cache = new Map();

  #store(hostname, key) {
    this.#cache.set(hostname, key);
    // Over-cap eviction clears the oldest quarter (ceil(count / 4)): one
    // bounded walk instead of unbounded growth; a page that just visited
    // 200+ hosts re-warms its fresh keys on the next resolves.
    if (this.#cache.size > DOMAIN_KEY_CACHE_MAX) {
      const evict = Math.ceil(DOMAIN_KEY_CACHE_MAX / 4);
      let i = 0;
      for (const k of this.#cache.keys()) {
        this.#cache.delete(k);
        if (++i >= evict) break;
      }
    }
  }

  compute(hostname) {
    if (!hostname) {
      return "";
    }
    // Single Map lookup - the cache never stores undefined, so a hit vs. miss
    // is one get() instead of has() + get().
    const hit = this.#cache.get(hostname);
    if (hit !== undefined) {
      return hit;
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
    this.#store(hostname, key);
    return key;
  }
}

const domainKeyCache = new DomainKeyCache();

/**
 * Reduce a hostname to its registrable-domain key (best effort, no PSL).
 * IP addresses become dash-separated so they are safe as identifiers.
 */
export function getDomainKey(hostname) {
  return domainKeyCache.compute(hostname);
}

/** Label-boundary containment: subdomains count, substrings do not. */
function boundaryContains(a, b) {
  return a.startsWith(`${b}.`) || a.endsWith(`.${b}`)
    || b.startsWith(`${a}.`) || b.endsWith(`.${a}`);
}

/** Strict equality or label-boundary relation between two domain keys. */
export function domainsMatch(a, b) {
  if (!a || !b) {
    return false;
  }
  return a === b || boundaryContains(a, b);
}

/**
 * The bounded-Levenshtein engine: its two scratch rows are private fields, so
 * the hot ranking path reuses one small Int32 pair instead of reallocating per
 * candidate. Module singleton; the exported domainScore wraps it.
 */
class DomainMatcher {
  /**
   * Reusable distance rows. Domain keys are short and ranking scans many
   * candidates, so two scratch rows equal to the shorter operand avoid
   * per-call allocation on the hot ranking path - and because operands are
   * swapped to that axis, alternating candidate lengths reuse one small pair
   * instead of reallocating per entry.
   */
  #rows = null;
  #rowLen = 0;

  #ensureRows(len) {
    if (!this.#rows || this.#rowLen < len + 1) {
      this.#rows = [new Int32Array(len + 1), new Int32Array(len + 1)];
      this.#rowLen = len + 1;
    }
  }

  #boundedLevenshtein(a, b, max = Infinity) {
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
    this.#ensureRows(m);
    let prev = this.#rows[0];
    let curr = this.#rows[1];
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

  /**
   * Graded similarity for ranking: exact 3, boundary-related 2, otherwise
   * distance-based decay to 0. Fuzz never promotes to a match - it only orders
   * candidates once domainsMatch() has accepted them.
   */
  score(a, b) {
    if (!a || !b) {
      return 0;
    }
    if (a === b) {
      return 3;
    }
    if (boundaryContains(a, b)) {
      return 2;
    }
    return Math.max(0, 3 - this.#boundedLevenshtein(a, b, 3));
  }
}

const domainMatcher = new DomainMatcher();

export function domainScore(a, b) {
  return domainMatcher.score(a, b);
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
/**
 * Page context engine.
 *
 * Resolves the {domain, path, title} payload a shell carries for resume - read
 * directly in a top frame (ownPageContext), asked up the frame bridge in an
 * embed. The title passes a sanitizer (stripNonAscii) before it rides the
 * payload; playback pages of the sites this targets release-tag their titles
 * and embed non-Latin noise that must not feed fuzzy resume matching.
 */
/**
 * The postMessage types the frame bridge sends and receives across iframe
 * edges. Inlined here - they are used only by this module, so a shared
 * namespace would just add indirection. Types and the dispatch gate below
 * derive from ONE prefix, so the gate can never drift from what it vets.
 */
const BRIDGE_MSG_PREFIX = "pf:";
const CTX_REQUEST_TYPE = `${BRIDGE_MSG_PREFIX}ctx-request`;
const CTX_RESPONSE_TYPE = `${BRIDGE_MSG_PREFIX}ctx`;
/** Down-only announcement: a frame's bridge handlers are armed. A pending
 *  context request re-issues on it (the event-driven retry) and a latched
 *  fullscreen provision re-hops; origin-limited to the parent hop. */
const BRIDGE_READY_TYPE = `${BRIDGE_MSG_PREFIX}ready`;
const FS_REQUEST_TYPE = `${BRIDGE_MSG_PREFIX}req-fullscreen`;

const TITLE_TAGS = /(?:^|[- ])(?:uncensored|uncut|leaked|censored|raw|bd|hdrip|dvdrip|webrip|bluray|remux|cam|reduc(?:ing)?\s*mosaic|english\s*subtitle)/gi;
const RECORDING_CODE_RE = /^\[([A-Z]+-\d+)(?:-[^\]]*)?\]/;
const BRACKET_STRIP_RE = /\[[^\]]*\]/g;
const EN_DASH_RE = /[\u2013\u2014]/g;
const NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}]+/gu;
const WS_COLLAPSE_RE = /\s{2,}/g;
const LEAD_PUNCT_RE = /^[\s\-–—|·:,/]+/;
const TRAIL_PUNCT_RE = /[\s\-–—|·:,/]+$/;

/**
 * The title sanitizer: stripNonAscii runs ~8 regex passes per call, so one
 * instance carries a single input->output memo slot (the hot shape is the
 * same input repeating - the top-frame responder re-sanitizes document.title
 * per incoming request of an unchanged title). Pure function, so one slot is
 * always correct - alternating inputs just miss, they never lie.
 */
class TitleSanitizer {
  #input = null;
  #output = "";

  sanitize(raw) {
    if (!raw) return "";
    if (raw === this.#input) return this.#output;
    const input = raw;
    // Leading recording-code brackets are identifiers worth keeping, so pull
    // them out whole first. A code is CAPS-NUMBER; anything after that in the
    // same bracket is a qualifier (subtitle group, remux, ...) and is dropped:
    // "[MIMK-278-SUBS] Repentance" -> "[MIMK-278] Repentance". A plain
    // "[ABC-123]" is kept too; non-code brackets still go through the blanket
    // strip below. The preserved [CODE] is reattached after that pass.
    let code = "";
    const codeMatch = raw.match(RECORDING_CODE_RE);
    if (codeMatch) {
      code = `[${codeMatch[1]}]`;
      raw = raw.slice(codeMatch[0].length);
    }
    let s = raw;
    s = s.replace(BRACKET_STRIP_RE, " ");
    s = s.replace(TITLE_TAGS, " ");
    s = s.replace(EN_DASH_RE, " ");
    s = s.replace(NON_LATIN_RE, " ");
    s = s.replace(WS_COLLAPSE_RE, " ").replace(LEAD_PUNCT_RE, "").replace(TRAIL_PUNCT_RE, "").trim();
    const out = code ? `${code} ${s}`.trim() : (s || raw);
    this.#input = input;
    this.#output = out;
    return out;
  }
}

const titleSanitizer = new TitleSanitizer();

/**
 * Strip non-Latin script characters and common video-title tags from a page
 * title, keeping only the show name and episode number.
 * Returns the original when the result would be empty (entirely non-Latin).
 * Trailing punctuation left behind by removed segments is cleaned up.
 * Thin adapter over the sanitizer singleton (its memo slot is private state).
 */
function stripNonAscii(raw) {
  return titleSanitizer.sanitize(raw);
}

/** Map a CTX_RESPONSE message into the {domain, path, title} payload shape
 *  shared by every responder set (pipe replies, port replies, broadcasts). */
function mapContextPayload(data) {
  return {
    domain: data.domain,
    path: data.path,
    title: stripNonAscii(typeof data.title === "string" ? data.title : "")
  };
}

/** Admission gate for a CTX_RESPONSE message: the preconditions every
 *  consumer re-derives before trusting the payload - an object carrying our
 *  response type and a domain string. The nonce/source checks that narrow
 *  individual consumers stay at their sites; title is sanitized later. */
function looksLikeContextResponse(data) {
  return data && typeof data === "object"
    && data.type === CTX_RESPONSE_TYPE && typeof data.domain === "string";
}

/** Page context resolved from THIS window, without any bridge: the direct
 *  answer for a top frame, and the fallback for a frame with no reachable
 *  parent chain (also makes {domain, path, title} testable in isolation).
 *  Internal to the context resolvers below - nothing outside this module
 *  orders a bridgeless direct read.
 */
function ownPageContext(win = window) {
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
    const bridged = await pipeState.bridge(() => requestPageContextFromParent());
    return bridged ?? ownPageContext();
  }
}

/**
 * One owner of the context-pipe state. Previously three module-level `let`
 * globals - the live pipe record, a legacy-chain memo, and the in-flight
 * bridge memo looked after elsewhere - were kept in step by ad-hoc resets at
 * every settle and teardown path; the legacy memo retired with its jsdom
 * premise (no memo on the refusal belt - see requestPageContextFromParent),
 * and the pipe records and the in-flight bridge memo are private fields of
 * one instance with four verbs, so the established-pipe identity check - a
 * stale request's timeout drops only ITS pipe, never one a newer resolve
 * already established - rides the same object as every reset site. The
 * in-flight bridge memo rides the same object: a page hosting several videos
 * boots one shell per video, so without the memo each shell would
 * round-trip the parent chain to resolve the same context; it is cleared on
 * settle, never cached, so a later document (a fresh boot) always
 * re-resolves.
 */
class ContextPipe {
  /** Live pipe record ({ port }), or null between establishes/drops. */
  #pipe = null;
  /** In-flight bridge promise, or null between resolves (never cached). */
  #bridge = null;

  get pipe() {
    return this.#pipe;
  }

  /** Retain a responding port as the persistent pipe. Closes any pipe it
   *  replaces (the chain may have been upgraded mid-session). Per-request
   *  listeners attach transiently; nothing hangs off the pipe between
   *  resolves. Close is spec-idempotent (a closed port's close() is a void
   *  no-op on this floor), so every site calls it directly. */
  establish(port) {
    if (this.#pipe) {
      this.#pipe.port.close();
    }
    this.#pipe = { port };
  }

  /** Drop the pipe only if it is still the live one: a stale request's
   *  timeout must never kill a pipe a newer resolve established. */
  dropIf(candidate) {
    if (this.#pipe !== candidate) {
      return;
    }
    this.#pipe = null;
    candidate.port.close();
  }

  /** Drop the pipe when the frame bridge is torn down. */
  stop() {
    if (this.#pipe) {
      this.#pipe.port.close();
    }
    this.#pipe = null;
  }

  /** Resolve through the parent chain, de-duplicated per frame: later shells
   *  sharing this document await the memo instead of re-arming the chain. */
  bridge(request) {
    if (!this.#bridge) {
      this.#bridge = request();
      this.#bridge.then(
        () => {
          this.#bridge = null;
        },
        () => {
          this.#bridge = null;
        }
      );
    }
    return this.#bridge;
  }
}

const pipeState = new ContextPipe();

/** Private one-shot context request over an established pipe: no broadcast,
 *  no transfer, no retry - the pipe is live and dedicated. Times out (and
 *  drops the dead pipe) instead of queueing, so the caller can fall back. */
function requestPageContextOverPipe(timeoutMs) {
  const { promise, resolve } = Promise.withResolvers();
  const ac = new AbortController();
  const pipe = pipeState.pipe;
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
    if (answered) {
      return;
    }
    if (looksLikeContextResponse(event.data)) {
      answered = true;
      settle(mapContextPayload(event.data));
    }
  };

  // Two native abort sources, kept separate by discrimination, not by realm
  // (the old cross-realm "no merged any()" rationale died with the jsdom
  // harness; the tree composes any() unconditionally where a single
  // membership answer suffices - e.g. the entry hint). Here the watchdog's
  // fire must DISCRIMINATE: it means a dead pipe -> drop + settle null,
  // while every other path settles with the answer through the request's
  // own controller. any() would still need both of these same listeners to
  // tell those two outcomes apart, so the composition buys an allocation,
  // not a teardown simplification.
  const dropDeadPipe = () => pipeState.dropIf(pipe);
  AbortSignal.timeout(timeoutMs).addEventListener("abort", () => {
    if (answered) {
      return;
    }
    dropDeadPipe();
    settle(null);
  }, { once: true });

  pipe.port.addEventListener("message", onData, { signal: ac.signal });
  try {
    pipe.port.postMessage({ type: CTX_REQUEST_TYPE, nonce: crypto.randomUUID() });
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
 * creates a channel and transfers a port upward; the port answer establishes
 * the pipe for later resolves.
 *
 * The nonce broadcast stays as the refusal belt only: a postMessage whose
 * port transfer the platform refused throws synchronously, the request
 * falls through port-less, and the ancestor answers addressed by nonce. No
 * explicit-answer memo on top (the retired arm remembered port-dropping
 * chains): on the actual floor every hop runs this same bundle, so the belt
 * arms per attempt, a persistent refuser re-pays one channel per attempt
 * (bounded by the ready-echo cadence, never a poll), and a one-shot refusal
 * recovers the pipe on the very next resolve.
 */
function requestPageContextFromParent(timeoutMs = CTX_REQUEST_TIMEOUT_MS) {
  if (pipeState.pipe) {
    return requestPageContextOverPipe(timeoutMs);
  }

  const { promise, resolve } = Promise.withResolvers();
  const ac = new AbortController();
  let nonce = null;
  let settled = false;

  // Two native abort sources, kept separate by discrimination (see the pipe
  // request above for why the realm rationale retired): the request's own
  // AbortController tears the listeners down on every settle path; the
  // AbortSignal.timeout watchdog's fire means the attempt BUDGET ran out -
  // settle null (the bridgeless fallback answers in getPageContext) - and
  // only that listener can tell that apart from a settled answer.
  const watchdog = AbortSignal.timeout(timeoutMs);
  watchdog.addEventListener("abort", () => {
    settle(null, null);
  }, { once: true });

  const settle = (context, pipePort) => {
    if (settled) {
      return;
    }
    settled = true;
    ac.abort();
    if (pipePort) {
      // A transferred port answered: the chain supports a private pipe.
      // Retain it for repeat resolves instead of closing it with this one
      // (establish also clears the legacy memo - the chain may have been
      // upgraded). An undelivered leftover port from a failed transfer needs
      // no close(): it is unreachable from its (derelict) peer, and the pair
      // is unreachable from here after the attempt closure dies.
      pipeState.establish(pipePort);
    }
    resolve(context);
  };

  // Private pipe per attempt: an ancestor that honored the transfer answers
  // here directly. Scoped to the request's own signal: settle() aborts it
  // first, so the listener drops natively on EVERY settle path (port answer,
  // broadcast answer, timeout) with no per-path removal to forget. The
  // channel is created per ATTEMPT - a re-issue (see the ready echo below)
  // must hand the newly-armed ancestor a live port, not a consumed one.
  const onMessage = (event) => {
    if (
      event.source === window.parent
      && looksLikeContextResponse(event.data)
      && event.data.nonce === nonce
    ) {
      // Broadcast answer: this chain answered port-less - a refused transfer
      // re-sent plain (the nonce travels in the message). No memo: the
      // markLegacy arm retired with its jsdom premise, so the belt arms per
      // attempt - a persistent refuser re-pays one channel per attempt, a
      // one-shot refusal recovers the pipe on the next resolve.
      settle(mapContextPayload(event.data), null);
    }
  };

  window.addEventListener("message", onMessage, { signal: ac.signal });

  const attempt = () => {
    if (settled || watchdog.aborted) {
      return;
    }
    nonce = crypto.randomUUID();
    const msg = { type: CTX_REQUEST_TYPE, nonce };
    try {
      const mc = new MessageChannel();
      const replyPort = mc.port1;
      replyPort.addEventListener("message", (event) => {
        if (looksLikeContextResponse(event.data)) {
          settle(mapContextPayload(event.data), replyPort);
        }
      }, { signal: ac.signal });
      replyPort.start();
      try {
        window.parent.postMessage(msg, "*", [mc.port2]);
        return;
      } catch {
        // Refused transfer (e.g. neutered port); fall through to
        // the plain nonce broadcast for this attempt.
      }
    } catch {
      // No MessageChannel on this host.
    }
    window.parent.postMessage(msg, "*");
  };

  // The event-driven retry: exactly ONE send now, and from then on only a
  // `pf:ready` echo re-issues it. An ancestor's armed state is a script fact
  // - invisible to layout, to the top-window read, and to any laid-out box -
  // so the announcement IS the real reading, and it replaces the backoff
  // ladder [60,150,320,640]: a bridge installs once per document, so the
  // echo fires once per late-armed ancestor rather than as a poll. Ready
  // flows only DOWN (install announcements + relay echoes to pending
  // requesters), from our own parent hop only, so a foreign document cannot
  // re-issue our requests: the echo count is bounded by how many ancestor
  // layers armed late.
  window.addEventListener("message", (event) => {
    const data = event && event.data;
    if (event.source === window.parent && data && data.type === BRIDGE_READY_TYPE) {
      attempt();
    }
  }, { signal: ac.signal });
  attempt();
  return promise;
}


/* - 4. Frame bridge - */

const NONCE_TTL_MS = 5000;
const CTX_REQUEST_TIMEOUT_MS = 3000;
/** How long a context pipe stays registered without a request before it is dropped. */
const CTX_PIPE_IDLE_MS = 60_000;

/**
 * One owner of the top-frame responder state. Previously a closure machine -
 * a `pipes` Map plus drop/touch/answer verbs captured by the factory and
 * reached from three event flows (the window message, per-pipe message and
 * messageerror listeners, and the idle sweep). Here the Map and the verbs are
 * private members of one instance (the FullscreenProvisioner shape), and the
 * createTopFrameResponder stays the thin event-handler wrapper.
 *
 * Handler for the top frame: answers validated context requests. Context is
 * resolved per request (not captured at install time) so late titles are
 * reflected. Requests qualify when they originate from our
 * own origin or from one of this document's <iframe> descendants.
 *
 * The payload carries document.title despite any embed in the page being able
 * to pass the frame-tree vouch: the title is a first-class resume-entry field
 * the history cards render, and an omitted top-title stranded every
 * cross-origin embed's history entry empty (0571346 reversed c515662's
 * titleless answer for exactly that cost). Resume identity itself stays
 * domain + path + duration driven — the title is presentation, sanitized at
 * both ends (resolveContext strips at the answering side, mapContextPayload
 * re-strips on arrival), and every consumer tolerates a titleless peer's
 * answer for bridges hardened under the old shape.
 */
class TopFrameResponder {
  #resolveContext;
  #pipes = new Map();

  constructor(resolveContext) {
    this.#resolveContext = resolveContext;
  }

  #dropPipe(entry) {
    if (this.#pipes.get(entry.port) !== entry) {
      return;
    }
    this.#pipes.delete(entry.port);
    entry.ac.abort();
    entry.port.close();
  }

  /** Live-pipe keepalive: refresh stamps on activity, evict idle ports. */
  #touchPipe(entry) {
    entry.lastUsed = performance.now();
    const cutoff = entry.lastUsed - CTX_PIPE_IDLE_MS;
    for (const candidate of this.#pipes.values()) {
      if (candidate.lastUsed < cutoff) {
        this.#dropPipe(candidate);
      }
    }
  }

  #onPipeRequest(entry) {
    return (event) => {
      this.#touchPipe(entry);
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== CTX_REQUEST_TYPE
          || typeof data.nonce !== "string") {
        return;
      }
      const { domain, path, title } = this.#resolveContext();
      try {
        entry.port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
      } catch {
        // Port closed under us; the next request on it won't arrive either. Drop
        // now instead of waiting for the idle sweep.
        this.#dropPipe(entry);
      }
    };
  }

  handle(event) {
    const data = event && event.data;
    if (
      !data || typeof data !== "object"
      || data.type !== CTX_REQUEST_TYPE || typeof data.nonce !== "string"
      || !event.source
    ) {
      return;
    }
    if (event.origin !== location.origin && !isOwnFrame(event.source)) {
      return;
    }
    const { domain, path, title } = this.#resolveContext();
    const ports = event.ports || [];
    if (ports.length) {
      const port = ports[0];
      let entry = this.#pipes.get(port);
      if (!entry) {
        // First contact on a fresh pipe: register the persistent handler so
        // repeat resolves over this port are answered without ever touching
        // the window message channel again. Both listeners ride one
        // entry-owned signal, so #dropPipe's single abort() tears the pair
        // down natively - there is no removal path that can forget one.
        entry = { port, lastUsed: performance.now(), ac: new AbortController() };
        entry.port.addEventListener("message", this.#onPipeRequest(entry), { signal: entry.ac.signal });
        entry.port.addEventListener("messageerror", () => this.#dropPipe(entry), { signal: entry.ac.signal });
        entry.port.start();
        this.#pipes.set(port, entry);
      }
      // A transferred MessageChannel pipe rides the request up the relay
      // chain; answer directly on it - unforgeable, no broadcast echo. Fall
      // back to the broadcast path if the port is already gone.
      try {
        port.postMessage({ type: CTX_RESPONSE_TYPE, domain, path, title });
        return;
      } catch {
        // Port neutered/closed: answer the requester by broadcast instead.
        this.#dropPipe(entry);
      }
    }
    event.source.postMessage({
      type: CTX_RESPONSE_TYPE,
      nonce: data.nonce,
      domain,
      path,
      title
    }, event.origin || "*");
  }
}

function createTopFrameResponder(resolveContext) {
  const responder = new TopFrameResponder(resolveContext);
  return (event) => responder.handle(event);
}

/**
 * One owner of the relay's nonce ledger (the responder-class shape for the
 * nested-frame role). The pending map and its TTL sweep are private to the
 * instance; the createFrameRelay stays the thin event-handler
 * wrapper.
 *
 * Handler for nested frames: relays requests upward and answers back down.
 */
class FrameRelay {
  #pending = new Map();

  handle(event) {
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
      if (!iframeRegistry.child(event.source)) {
        return;
      }
      // Remember who asked AND from which origin: the answer must travel back
      // down addressed to the requester's origin - this hop's upstream origin
      // would get the delivery dropped whenever the two differ. Kept for the
      // legacy broadcast answer; a port request is also answered directly on
      // the pipe, but a mixed chain may still deliver down as a broadcast.
      const now = Date.now();
      // Expired nonces never enter the ledger - a TTL sweep instead of
      // rehashing the map on every batch.
      for (const [nonce, entry] of this.#pending) {
        if (entry.deadline < now) {
          this.#pending.delete(nonce);
        }
      }
      this.#pending.set(data.nonce, { source: event.source, origin: event.origin, deadline: now + NONCE_TTL_MS });
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
    } else if (data.type === CTX_RESPONSE_TYPE && this.#pending.has(data.nonce)) {
      // Answers may only come from the parent we relayed to - a sibling or
      // nested frame that guesses a live nonce must not inject context.
      if (event.source !== window.parent) {
        return;
      }
      const requester = this.#pending.get(data.nonce);
      this.#pending.delete(data.nonce);
      requester.source?.postMessage(data, requester.origin || "*");
    } else if (data.type === BRIDGE_READY_TYPE && event.source === window.parent) {
      // An ancestor's bridge armed late: echo the ready down to every child
      // with a pending context request, so it re-issues (the event-driven
      // retry - see requestPageContextFromParent). Only pending requesters
      // hear it: ready carries no nonce and is worthless to anyone else, so
      // the echo is targeted, once per late-armed ancestor layer. The TTL
      // sweep runs first so a dead requester's slot doesn't pin the echo.
      const now = Date.now();
      for (const [nonce, entry] of this.#pending) {
        if (entry.deadline < now) {
          this.#pending.delete(nonce);
        } else {
          entry.source?.postMessage(data, entry.origin || "*");
        }
      }
    }
  }
}

function createFrameRelay() {
  const relay = new FrameRelay();
  return (event) => relay.handle(event);
}

/**
 * True when window is an <iframe> descendant reachable through this document.
 * Walks nested frame trees while they stay same-origin readable; a cross-origin
 * layer's subtree is invisible, so descendants behind it are not vouched for -
 * the strict security posture is unchanged, only deeper visible trees count.
 */
function isOwnFrame(source) {
  if (!source) {
    return false;
  }
  // Direct child registered by the live registry: O(1) instead of the walk.
  // The read rejects and drops a detached element - matching the scan's
  // connected-only querySelectorAll.
  if (iframeRegistry.read(source)) {
    return true;
  }
  // Not a direct child of this document; it may still be a nested
  // descendant behind readable same-origin layers - walk for those.
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
 * Live map from <iframe> contentWindow -> element, refreshed by the shared
 * document mutation feed (dom-watch onDomMutations). Without it, every relayed
 * message rewound the full frame tree via querySelectorAll - O(frametree) per
 * message on iframe-heavy pages. Armed lazily on the first bridged message
 * (see installContextBridge), so the vast majority of pages - which have no
 * child frames to vouch - never pay for a document-wide observer at all.
 *
 * The subscription rides the shared dispatcher instead of its former private
 * whole-document observer: one C++-level observer serves every document-wide
 * interest instead of two. Two consequences, both bounded:
 *   - dispatch defers while the tab is hidden (capped 500ms), so a frame
 *     inserted while hidden lands in the cache up to that cap late; reads
 *     reject detached entries via isConnected and fall back to an inline
 *     scan, so a late list can never vouch a wrong frame.
 *   - the dispatcher rebinds to a swapped document itself, so no rebinding
 *     machinery lives here - a reseed at arm/swap time keeps the map current.
 *
 * WeakMap-keyed by contentWindow: dead frames release their entries with
 * their window instead of pinning a detached document, so removals need no
 * sweep - every read rejects a detached element via isConnected and drops it.
 */
/** One owner of the live iframe registry. Previously four module-level lets
 *  (the WeakMap, its document stamp, an "active" flag, and the shared-feed
 *  subscription handle) kept in step by hand across seed/arm/stop; here the
 *  state is private to one instance and every lifecycle verb is a method, so
 *  there is no flag pair (doc/active) that can drift apart. */
class IframeRegistry {
  #cache = new WeakMap();
  /** Document the cache currently describes - a document swap (fresh page /
   *  test harness) reseeds instead of serving a stale map. */
  #doc = null;
  /** Shared-feed subscription handle; null until armed on the first bridged
   *  message. Pages with no child frames to vouch never pay. */
  #off = null;

  get armed() {
    return this.#off != null;
  }

  /** Register one <iframe> element under its contentWindow. Idempotent: moved
   *  or re-inserted frames just update the entry in place. */
  #register(ifr) {
    const win = ifr.contentWindow;
    if (win) {
      this.#cache.set(win, ifr);
    }
  }

  /** (Re)build the cache from the live <iframe> set. ContentWindow never
   *  throws, so this is safe across same- and cross-origin subtrees. Used at
   *  arm/swap time only - ongoing updates are differential (#diff). No clear():
   *  the WeakMap releases entries with their windows on its own, and reads
   *  against old windows are rejected by the isConnected check anyway. */
  #seed() {
    for (const ifr of document.querySelectorAll("iframe")) {
      this.#register(ifr);
    }
  }

  /** Keep the cache diffed against one observer batch: added nodes register
   *  any iframes they carry (an `<iframe>` itself, or a container subtree),
   *  scoped to the added node - the old full reseed walked the whole document
   *  every batch even when nothing changed. Removals need no sweep - the
   *  WeakMap drops dead windows with their documents and every read rejects
   *  a detached element via isConnected, so a frame removed anywhere
   *  (including inside a dropped ancestor subtree) stops vouching on its next
   *  message rather than on the next batch. */
  #diff(records) {
    for (const record of records) {
      const added = record.addedNodes;
      for (let i = 0; i < added.length; i++) {
        const node = added[i];
        if (!node || node.nodeType !== 1) {
          continue;
        }
        if (node.localName === "iframe") {
          this.#register(node);
          continue;
        }
        const set = node.querySelectorAll("iframe");
        for (let i = 0; i < set.length; i++) {
          this.#register(set[i]);
        }
      }
    }
  }

  /** Ensure the cache describes the CURRENT document, reseeding when the
   *  document swapped underneath us (fresh jsdom/page). No observer rebinding
   *  lives here: the shared feed rebinds to a swapped document itself, so
   *  only the map needs the reseed. */
  #ensureCurrent() {
    if (this.#doc === document) {
      return;
    }
    this.#seed();
    this.#doc = document;
  }

  /** Arm the registry subscription on the shared feed (idempotent - a repeat
   *  arm after a document swap just reseeds). Degrades gracefully when there
   *  is no feed to serve us (no MutationObserver on this host): the cache
   *  stays unseeded going forward and reads fall back to a scan, so the
   *  bridge's message handling never depends on it. */
  arm(ac) {
    if (this.#off) {
      this.#ensureCurrent();
      return;
    }
    this.#doc = document;
    this.#seed();
    this.#off = onDomMutations((records) => this.#diff(records), { signal: ac.signal });
    ac.signal.addEventListener("abort", () => this.#stop(), { once: true });
  }

  #stop() {
    this.#off?.();
    this.#off = null;
    this.#doc = null;
    // Entries need no clear: the WeakMap releases them with their windows, and
    // a stale (detached) element fails the isConnected read check - so neither
    // the fullscreen provisioner nor the relay can vouch a dead frame. The
    // inline scan is the fallback after teardown.
  }

  /** Validated read: the connected element the registry maps `win` to, or
   *  null. A detached entry is rejected AND dropped, so a dead frame's
   *  element stops being retained - each call site's fallback scan keeps the
   *  vouch exact while a re-seed is parked (hidden-tab flush can be up to
   *  500ms late). */
  read(win) {
    if (!this.armed) {
      return null;
    }
    this.#ensureCurrent();
    const hit = this.#cache.get(win);
    if (!hit || !hit.isConnected) {
      this.#cache.delete(win);
      return null;
    }
    return hit;
  }

  /** The direct <iframe> child of THIS document whose contentWindow is `win`,
   *  or null. Registry hit in O(1); the inline scan keeps the vouch exact
   *  before the registry arms (or when handlers are used directly), at an
   *  O(frametree) cost that only pays on genuine misses. */
  child(win) {
    if (!win) {
      return null;
    }
    const hit = this.read(win);
    if (hit) {
      return hit;
    }
    for (const iframe of document.querySelectorAll("iframe")) {
      if (iframe.contentWindow === win) {
        return iframe;
      }
    }
    return null;
  }
}

const iframeRegistry = new IframeRegistry();

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
 * One provisioner handler: vouch the sender as an own-iframe child, then grant
 * allowfullscreen on the target frame. The relay flag (nested frames) forwards
 * the original request upward so the chain continues to the top frame. Shared
 * body of the top-frame and relay provisioners.
 */
class FullscreenProvisioner {
  #relay = false;

  constructor({ relay = false } = {}) {
    this.#relay = relay;
  }

  handle(event) {
    const data = event && event.data;
    if (!data || typeof data !== "object" || data.type !== FS_REQUEST_TYPE) {
      return;
    }
    const frameElement = iframeRegistry.child(event.source);
    if (frameElement) {
      grantFullscreen(frameElement);
      if (this.#relay) {
        window.parent?.postMessage(data, "*");
      }
    }
  }

  static topFrame() {
    return new FullscreenProvisioner();
  }

  static relay() {
    return new FullscreenProvisioner({ relay: true });
  }
}

/**
 * Handler for the top frame: grant allowfullscreen on the direct child iframe
 * that asked, then stop (no parent). Vouched by an own-child match.
 */
function createTopFrameProvisioner() {
  const provisioner = FullscreenProvisioner.topFrame();
  return (event) => provisioner.handle(event);
}

/**
 * Handler for relay frames: grant allowfullscreen on the direct child that
 * asked, then forward the request to our own parent so the chain continues.
 * The child is vouched the same way - only an iframe this document owns gets
 * its allowlist expanded.
 */
function createFrameProvisioner() {
  const provisioner = FullscreenProvisioner.relay();
  return (event) => provisioner.handle(event);
}

/* - 4a. Fullscreen provision - */
/**
 * The provisioner FSM above grants per frame; this class is the sender side.
 * The boot-time send is latched one-shot: ancestors install their provisioners
 * at document start, well before the first request made here, so further
 * requests would only replay the same hops. The latch is RE-OPENED only by the
 * failure path - a fullscreen attempt just proved an ancestor still refuses
 * entry (its grant was wiped by a host re-render that rebuilt the iframe, or
 * granted late), and a fresh provisioning hop is exactly what answers the
 * next attempt. A top-frame retry posts to itself, where the provisioner's
 * own-child vouch finds no match and dead-ends harmlessly.
 */
class FullscreenProvisionRequest {
  #sent = false;

  send() {
    if (this.#sent) {
      return;
    }
    this.#sent = true;
    window.parent?.postMessage({ type: FS_REQUEST_TYPE }, "*");
  }

  rearm() {
    this.#sent = false;
  }
}

const provisionRequest = new FullscreenProvisionRequest();

export function requestFullscreenProvision() {
  provisionRequest.send();
}

export function retryFullscreenProvision() {
  provisionRequest.rearm();
  requestFullscreenProvision();
}

/**
 * Install the frame bridge (context + fullscreen provisioning) for this frame
 * and return a single teardown. Top frames answer and provision; nested frames
 * relay both. Idempotent per frame - the userscript evaluates exactly once per
 * document sandbox.
 */
export function installContextBridge() {
  const ac = new AbortController();
  const isTop = window === window.top;
  const onContext = isTop
    ? createTopFrameResponder(() => ({
      domain: getDomainKey(location.hostname),
      path: location.pathname,
      title: stripNonAscii(document.title)
    }))
    : createFrameRelay();
  const onFullscreen = isTop ? createTopFrameProvisioner() : createFrameProvisioner();

  // ONE window listener for the whole bridge. The previous shape - cache-arm
  // plus two role handlers as three separate listeners - made every
  // postMessage a page ever sent (analytics/ad traffic included) run three
  // dispatches and three polymorphic event.data reads. The pf: gate below
  // keeps non-bridge chatter at a single typeof/startsWith, then routes by
  // the exact message type. The lazy iframe-registry arm stays first within
  // this handler, so a synchronously-seeded cache still lands before the
  // vouch-check of the handler that runs next - the ordering the old
  // registration order guaranteed. Sibling routes stay isolated the way
  // separate listeners were: a throw in one must not eat the next.
  window.addEventListener("message", (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object") {
      return;
    }
    const type = data.type;
    if (typeof type !== "string" || !type.startsWith(BRIDGE_MSG_PREFIX)) {
      return;
    }
    // The live iframe registry exists only to vouch incoming bridged messages
    // against this document's own <iframe> children - never for anything
    // message-free. On the vast majority of pages (no child frames) the
    // shared-feed subscription therefore never needs to exist, so arm it
    // lazily on the first bridged message: the seed registers live frames
    // before any handler vouches, and the inline-scan fallback covers the
    // pre-subscription gap. (arm() is idempotent; an already-armed registry
    // reseeds itself when the document swapped underneath it.)
    iframeRegistry.arm(ac);
    try {
      if (type === CTX_REQUEST_TYPE || type === CTX_RESPONSE_TYPE
          || (type === BRIDGE_READY_TYPE && !isTop)) {
        onContext(event);
      } else if (type === FS_REQUEST_TYPE) {
        onFullscreen(event);
      }
      // The ready echo also re-arms an upward hop that a late ancestor alone
      // could have missed: this frame's own fullscreen provision was latched
      // one-shot at boot, and an ancestor arming late IS the event that
      // re-opens it (the top never hears ready - it is ready).
      if (type === BRIDGE_READY_TYPE && !isTop) {
        provisionRequest.rearm();
        provisionRequest.send();
      }
    } catch (err) {
      // The platform's own out-of-band report verb: the deliberate error
      // sentence still lands on the page error surface (the audit ledger's
      // rows read the same events), and sibling routes inside the dispatch
      // stay isolated. The queueMicrotask rethrow shape this replaces was
      // the same report one lap later.
      globalThis.reportError(err);
    }
  }, { signal: ac.signal });

  // Install-time announcement: this document's bridge is armed, declared DOWN
  // once to its own iframes. This is the real-world witness a pending child
  // re-issues on - an ancestor's armed state is script-selective and
  // invisible to every layout read (it cannot be watched by DOM observers,
  // which see nodes, not listeners), so the announcement IS the dynamic
  // driver, and there is nothing to sweep: frame load carries nothing new
  // (a child that loads this late finds the whole chain already armed and
  // answers on its own first attempt), and frame unload needs no reaction -
  // document death clears its own pipes. A directly nested child arming
  // before us is covered by the relay: it asks its parent, we forward by
  // our pending ledger (the FrameRelay ready echo).
  for (const iframe of document.querySelectorAll("iframe")) {
    iframe.contentWindow?.postMessage({ type: BRIDGE_READY_TYPE }, "*");
  }

  // Torn down with the bridge: the abort tears down THIS document's
  // listeners; the pipe state dies with them so a rebooted document starts
  // pipeless instead of inheriting ports from the torn-down session.
  return () => {
    ac.abort();
    pipeState.stop();
  };
}
