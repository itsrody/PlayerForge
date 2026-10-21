/**
 * Pure page-identity primitives.
 *
 * One module answering everything about WHICH SITE a PlayerForge instance
 * belongs to and how sites compare: registrable-domain keys and comparison,
 * graded similarity ranking, and deterministic resume-entry hashing.
 *
 * Formerly the first two sections of the context engine (context.js), split
 * out because they are pure functions over their inputs with no window,
 * document, or message plumbing - resume matching consumes them directly.
 */

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
  // Single Map lookup - the cache never stores undefined, so a hit vs. miss
  // is one get() instead of has() + get().
  const hit = domainKeyCache.get(hostname);
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
