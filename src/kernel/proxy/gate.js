/**
 * Are we allowed to route this stream, and how is it protected? `gate.js` is
 * the single decision point for the proxy (§11.4): it classifies a manifest
 * into exactly one protection class (pure and total), and it decides, per
 * site and per feature-armed state, whether the proxy may engage.
 *
 * Classification is the one place encryption is assessed; every later
 * subsystem trusts the class. Ambiguous or unrecognized protection fails
 * closed to `unknown` - which is NOT routable - so we never engage a path we
 * might misread, and genuine DRM is never touched.
 */
import { logger } from "../../shared/logger.js";

/** Protection classes. Plain/tokenized/AES-128/ClearKey are the routable
 *  surface; DRM and unknown always fall through to native playback. */
export const CLASS = Object.freeze({
  PLAIN: "plain",
  TOKENIZED: "tokenized",
  AES128: "aes128",
  CLEARKEY: "clearkey",
  DRM: "drm",
  UNKNOWN: "unknown"
});

/** Classes the proxy may route. Anything outside is refused up front. */
export const ROUTABLE_CLASSES = new Set([
  CLASS.PLAIN,
  CLASS.TOKENIZED,
  CLASS.AES128,
  CLASS.CLEARKEY
]);

// HLS KEYFORMATs that identify genuine DRM rather than clear-key encryption.
const DRM_HLS_KEYFORMATS = new Set([
  "com.widevine.alpha",
  "com.apple.streamingkeydelivery",
  "com.microsoft.playready"
]);

// DASH ContentProtection schemeIdUris that identify genuine DRM systems.
const DRM_MPD_SCHEMES = new Set([
  "urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", // Widevine
  "urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", // PlayReady
  "com.apple.fps.1_0",                             // FairPlay
  "com.apple.fps"                                  // FairPlay (generic)
]);

/** DASH-IF ClearKey ("urn:uuid:e2719d58..." á DASH-IF CCP) signals the CDM
 *  may use the clear key we hand EME in §11.3. */
const CLEARKEY_MPD_SCHEME = "urn:uuid:e2719d58-a985-b3c9-781a-b030cd78e8be";
const MP4PROTECTION_SCHEME = "urn:mpeg:dash:mp4protection:2011";

/** Token markers: hls.js-style `$token$` path placeholders and the signed-URL
 *  query the providers use (`token`, `expires`, `md5`, `sig`, `sign`). */
const TOKEN_RE = /\$\s*[Tt]oken\s*\$|\{\s*token\s*\}|\b(?:token|expires|md5|sig|sign)\s*=/;

/** Same-origin-independent token scrape: true when a manifest carries an
 *  access token/signature shape (tokenized class; refresh handled in §12). */
export function hasTokenMarkers(source) {
  return TOKEN_RE.test(String(source ?? ""));
}

/**
 * Classify a manifest into exactly one protection class. Total by
 * construction: every (kind, text) maps to a class, with precedence
 * `drm > clearkey/aes128/unknown-encryption > tokenized > plain`. Encryption
 * wins over tokenization because refresh (§12) is orthogonal to decryption.
 */
export function classifyStream(kind, source) {
  const text = String(source ?? "");
  if (kind === MANIFEST_M3U8) {
    const hls = classifyHls(text);
    if (hls !== CLASS.PLAIN) {
      return hls;
    }
  } else if (kind === MANIFEST_MPD) {
    const dash = classifyMpd(text);
    if (dash !== CLASS.PLAIN) {
      return dash;
    }
  }
  return hasTokenMarkers(text) ? CLASS.TOKENIZED : CLASS.PLAIN;
}

const MANIFEST_M3U8 = "m3u8";
const MANIFEST_MPD = "mpd";

function classifyHls(text) {
  let aes128 = false;
  let unknownKey = false;
  let drm = false;
  for (const match of text.matchAll(/^#EXT-X-(?:SESSION-)?KEY:([^\r\n]*)/gm)) {
    const attrs = splitAttrs(match[1]);
    const method = (attrs.get("method") ?? "").toUpperCase();
    const keyformat = attrs.get("keyformat") ?? "";
    if (DRM_HLS_KEYFORMATS.has(keyformat.toLowerCase())) {
      drm = true;
    } else if (method === "SAMPLE-AES") {
      drm = true;
    } else if (method === "AES-128") {
      if (!keyformat || keyformat === "identity") {
        aes128 = true;
      } else {
        unknownKey = true;
      }
    } else if (method && method !== "NONE") {
      unknownKey = true;
    }
  }
  if (drm) {
    return CLASS.DRM;
  }
  if (unknownKey) {
    return CLASS.UNKNOWN;
  }
  if (aes128) {
    return CLASS.AES128;
  }
  return CLASS.PLAIN;
}

function classifyMpd(text) {
  let clearkey = false;
  let drm = false;
  let unknownCenc = false;
  for (const match of text.matchAll(/<ContentProtection\b([^>]*?)\/?>/gi)) {
    const attrs = splitXmlAttrs(match[1]);
    const schemeId = (attrs.get("schemeiduri") ?? "").toLowerCase();
    const value = (attrs.get("value") ?? "").toLowerCase();
    if (DRM_MPD_SCHEMES.has(schemeId)) {
      drm = true;
    } else if (schemeId === CLEARKEY_MPD_SCHEME) {
      clearkey = true;
    } else if (schemeId === MP4PROTECTION_SCHEME && (value === "cenc" || value === "cbcs")) {
      unknownCenc = true;
    } else {
      unknownCenc = true;
    }
  }
  if (drm) {
    return CLASS.DRM;
  }
  if (clearkey) {
    return CLASS.CLEARKEY;
  }
  if (unknownCenc) {
    return CLASS.UNKNOWN;
  }
  return CLASS.PLAIN;
}

/** DASH XML tags are whitespace-separated attributes (XML names + double
 *  quotes); unlike HLS they are never comma-delimited, so the HLS attr
 *  splitter cannot be reused. */
function splitXmlAttrs(input) {
  const out = new Map();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(String(input ?? "")))) {
    out.set((m[1] ?? m[3]).toLowerCase(), m[2] ?? m[4]);
  }
  return out;
}

/** Comma-split tag attributes, honoring double-quoted values. Returns a
 *  lowercase-keyed map with values unquoted. */
function splitAttrs(input) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === "," && !inQuote) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  const out = new Map();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

const REGEXP_SPECIALS = /[|\\{}()[\]^$+?.]/;
function escapeRegExpChar(ch) {
  return REGEXP_SPECIALS.test(ch) ? `\\${ch}` : ch;
}

/** Compile-once pattern pages for the site policy hot path. Site lists are
 *  handful-sized and stable between arms, but `inScope` consults them per
 *  request; compiling the wildcard/family regexes once per pattern (capped,
 *  LRU) removes a `new RegExp` from every scope probe. */
const COMPILED_CACHE_MAX = 128;
function compileCached(cache, source, build) {
  if (cache.has(source)) {
    const hit = cache.get(source);
    if (cache.size > 1) {
      cache.delete(source);
      cache.set(source, hit);
    }
    return hit;
  }
  const compiled = build(source);
  if (cache.size >= COMPILED_CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(source, compiled);
  return compiled;
}

function buildWildcardRe(pattern) {
  let regex = "^";
  for (const ch of pattern) {
    regex += ch === "*" ? ".*" : escapeRegExpChar(ch);
  }
  return new RegExp(regex + "$");
}

const wildcardReCache = new Map();

/** True when `pattern` (userscript-style glob: `*` wildcards) covers `text`.
 *  Anchored to the whole string so a partial scheme cannot over-match. */
export function matchWildcard(text, pattern) {
  if (typeof pattern !== "string") {
    return false;
  }
  const re = compileCached(wildcardReCache, pattern, buildWildcardRe);
  return re.test(String(text ?? ""));
}

/** Capped memo twin of net-watch's hostnameOf: classified/probed URLs repeat,
 *  so per-request `inScope` probes skip the URL parse after the first sight. */
const HOSTNAME_MEMO_MAX = 256;
const gateMemo = new Map();

function hostnameOf(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  if (gateMemo.has(url)) {
    const host = gateMemo.get(url);
    if (gateMemo.size > 1) {
      gateMemo.delete(url);
      gateMemo.set(url, host);
    }
    return host;
  }
  const host = URL.canParse(url) ? new URL(url).hostname : null;
  if (gateMemo.size >= HOSTNAME_MEMO_MAX) {
    gateMemo.delete(gateMemo.keys().next().value);
  }
  gateMemo.set(url, host);
  return host;
}

/** The hostname projection of a site pattern: a bare glob stays as-is, a URL
 *  glob loses its scheme, authority markers, and path. */
function hostGlobOf(pattern) {
  let rest = String(pattern ?? "");
  const m = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest);
  if (m) {
    rest = rest.slice(m[0].length);
  }
  const stop = rest.search(/[/?#]/);
  if (stop >= 0) {
    rest = rest.slice(0, stop);
  }
  return rest;
}

const hostFamilyReCache = new Map();
function buildHostFamilyRe(pattern) {
  const glob = hostGlobOf(pattern);
  const labels = glob.split(".");
  let regex = "^";
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === "*") {
      regex += i === 0 ? "(?:[^.]+[.])*" : "[.][^.]+";
    } else {
      for (const ch of label) {
        regex += ch === "*" ? ".*" : escapeRegExpChar(ch);
      }
      if (i < labels.length - 1) {
        regex += "[.]";
      }
    }
  }
  try {
    return new RegExp(regex + "$");
  } catch {
    return null;
  }
}

/** Domain-family match: `host` is covered by `glob`'s hostname when it is
 *  the same family - the glob itself, a subdomain of it, or (for a leading
 *  `*.` label) the apex. Purely label-bound: "not-example.com" is never a
 *  member of the example.com family. The family regex is compiled once per
 *  pattern (capped) instead of per scope probe. */
function hostCoveredBy(host, pattern) {
  const value = String(host ?? "");
  const glob = hostGlobOf(pattern);
  if (!value || !glob) {
    return false;
  }
  if (value === glob) {
    return true;
  }
  if (!glob.includes("*") && value.endsWith("." + glob)) {
    return true;
  }
  const re = compileCached(hostFamilyReCache, pattern, buildHostFamilyRe);
  return re ? re.test(value) : false;
}

/** True when `text` is a bare hostname entry (no scheme/authority), so
 *  `v.example.com` and `example.com` compare as host families. */
function bareHostname(text) {
  return typeof text === "string" && !!text && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text);
}

/**
 * The gate: does the proxy's engagement policy permit routing right now?
 * `arm()` sets the site list + armed flag; `routeDecision()` is the single
 * per-manifest decision the rest of the code trusts (reason strings are
 * deterministic for tests). Excludes always veto; when the include list is
 * non-empty an URL must match one of its patterns (allow-list first).
 */
export class Gate {
  #enabled = false;
  #includes = [];
  #excludes = [];

  constructor({ enabled = false, includes = [], excludes = [] } = {}) {
    this.arm({ enabled, includes, excludes });
  }

  /** Shift the armed state and site policy atomically. Returns this. */
  arm({ enabled, includes, excludes }) {
    this.#enabled = enabled === true;
    if (Array.isArray(includes)) {
      this.#includes = includes.slice();
    }
    if (Array.isArray(excludes)) {
      this.#excludes = excludes.slice();
    }
    return this;
  }

  disarm() {
    this.#enabled = false;
  }

  get enabled() {
    return this.#enabled;
  }

  get includes() {
    return this.#includes;
  }

  get excludes() {
    return this.#excludes;
  }

  /** Site policy: excluded URLs are always out; a non-empty include list
   *  gates eligibility to matching URLs only. Matches a full URL glob or a
   *  hostname family (URLs resolve to their hostname; bare hosts are compared
   *  as hosts - a hostname entry like `example.com` covers its subdomains). */
  inScope(url) {
    const host = hostnameOf(url) ?? (bareHostname(url) ? url : null);
    const matches = (patterns) =>
      patterns.some((p) => matchWildcard(url, p) || (host && hostCoveredBy(host, p)));
    if (matches(this.#excludes)) {
      return false;
    }
    return this.#includes.length === 0 || matches(this.#includes);
  }

  /** Pure classification passthrough, bound to this gate's kind inputs. */
  classify(kind, text) {
    return classifyStream(kind, text);
  }

  /**
   * The single engage decision for a manifest fetch. Order: armed state, then
   * protection class, then site policy - so a disabled or DRM stream costs
   * nothing beyond the classification. Reasons are deterministic.
   */
  routeDecision(manifestUrl, kind, text) {
    if (!this.#enabled) {
      logger.log("proxy", "gate", "disabled", manifestUrl);
      return { routed: false, klass: null, reason: "disabled" };
    }
    const klass = classifyStream(kind, text);
    if (!ROUTABLE_CLASSES.has(klass)) {
      logger.log("proxy", "gate", "non-routable class", manifestUrl, klass);
      return { routed: false, klass, reason: `class:${klass}` };
    }
    if (!this.inScope(manifestUrl)) {
      logger.log("proxy", "gate", "out of scope", manifestUrl, klass);
      return { routed: false, klass, reason: "site" };
    }
    logger.log("proxy", "gate", "routable", manifestUrl, klass);
    return { routed: true, klass };
  }
}