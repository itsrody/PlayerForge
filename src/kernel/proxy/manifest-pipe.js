/**
 * manifest-pipe.js — the manifest boundary and the segment pipe (consolidated
 * from `bootstrap.js` + `gate.js` + `rewrite.js` + `manifest.js`).
 *
 * The always-on arm computes one Gate per page and classifies every passenger
 * request by protection class; DRM falls back instantly. Engage is decided here
 * (Gate + protection class + site policy), the manifest text is rewritten here
 * (rewriteManifest), and the `ManifestFlow` (engaged host, consent, claim) is
 * the §7.4 object the ring consumes — the request-boundary seams make one
 * decision per manifest fetch, and that decision spends the whole plan.
 *
 * Kind detection delegates to media-shapes.js (`manifestKindFromUrl`); the
 * suite of per-segment rewrite helpers is byte-stable on unarmed or
 * out-of-scope input, so player frame drift and byte-range indexing are never
 * disturbed.
 *
 * Three section-bannered parts: the GATE (§11.4 engagement policy), the REWRITE
 * (pure manifest text surgery), and the MANIFEST SEAM (the observe/interpose
 * arm + ManifestFlow). All deterministic: the GM_webRequest, fetch, xhr
 * prototype, and predicate seams are parameters, so the whole pipe runs
 * headless.
 */
import { logger } from "../../shared/logger.js";
import { isManifestUrl, manifestKindFromUrl } from "../../shared/media-shapes.js";
import { isMp4ContentType } from "./stream-transport.js";

// ---------------------------------------------------------------------------
// GATE — engagement policy (§11.4): arm/disarm, protection-classification,
// include-exclude site policy. `classifyStream` + `Gate.routeDecision` are the
// single per-manifest engage decisions every other seam trusts.
// ---------------------------------------------------------------------------

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


// ---------------------------------------------------------------------------
// REWRITE — pure .m3u8 / .mpd text surgery. Byte-stable on unarmed or
// out-of-scope input: when nothing qualifies, the exact input string comes back
// unchanged, so player frame drift and byte-range indexing are never disturbed.
// ---------------------------------------------------------------------------

/** Media references routed through OTHER seams stay out of the segment pipe:
 *  variants (the manifest layer), the AES-128 key path (§11.2), and subtitle
 *  lists (the existing GM_webRequest surface). Manifest shapes come from
 *  media-shapes.js; only the key/vtt tails are local to this pipe. */
const NON_SEGMENT_URI_RE = /\.(?:key|vtt)$/i;

export const MANIFEST_KIND = Object.freeze({
  M3U8: "m3u8",
  MPD: "mpd"
});

/** Kind by URL pathname suffix ("m3u8" | "mpd" | null) - honors query/hash.
 *  Delegates to the media-shapes taxonomy. */
export function detectManifestKind(url) {
  return manifestKindFromUrl(url);
}

/** Kind by content head, for streams whose manifest URL hides the suffix. */
export function sniffManifestKind(text) {
  const source = String(text ?? "");
  if (source.startsWith("#EXTM3U")) {
    return MANIFEST_KIND.M3U8;
  }
  if (source.includes("<MPD")) {
    return MANIFEST_KIND.MPD;
  }
  return null;
}

/**
 * True when a URI is a media reference that belongs in the segment pipe:
 * a non-directive, non-empty reference that is not a variant playlist, key,
 * or subtitle list. Relative URIs and URI templates (DASH `$Number$`) qualify.
 */
export function isSegmentReference(uri) {
  const ref = String(uri ?? "").trim();
  if (!ref || ref.startsWith("#")) {
    return false;
  }
  if (ref.startsWith("data:") || ref.startsWith("blob:")) {
    return false;
  }
  const pure = ref.split(/[?#]/, 1)[0].toLowerCase();
  return !isManifestUrl(pure) && !NON_SEGMENT_URI_RE.test(pure);
}

/**
 * Rewrite media URIs inside a manifest. Byte-conservative by construction:
 * `armed` must be true, the kind must resolve, and each URI must pass `scope`
 * AND actually change under `rewriteUri` before the output differs from the
 * input.
 *
 * Options:
 *   armed       false -> input unchanged (unarmed pass-through)
 *   kind        "m3u8" | "mpd"; resolved from `baseUrl` suffix, else sniffed
 *               from the text when omitted
 *   baseUrl     absolute URL of the manifest, for kind + relative-URI context
 *   scope       (uri) => boolean; segment host / namespace eligibility
 *   rewriteUri  (uri) => string; the transformer applied to in-scope refs
 */
export function rewriteManifest(text, { armed = false, kind = null, baseUrl = null, scope = null, rewriteUri = null } = {}) {
  if (typeof text !== "string" || !armed) {
    return text;
  }
  const effectiveKind = kind ?? detectManifestKind(baseUrl) ?? sniffManifestKind(text);
  if (!effectiveKind || (typeof rewriteUri !== "function")) {
    return text;
  }
  const eligible = typeof scope === "function" ? scope : () => true;
  return effectiveKind === MANIFEST_KIND.MPD
    ? rewriteMpd(text, eligible, rewriteUri)
    : rewriteHls(text, eligible, rewriteUri);
}

function rewriteHls(text, scope, rewriteUri) {
  const parts = text.split(/(\r\n|\r|\n)/);
  let changed = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    if (line.startsWith("#EXT-X-MEDIA") || line.startsWith("#EXT-X-MAP")) {
      const next = rewriteMediaAttrs(line, scope, rewriteUri);
      if (next !== line) {
        changed = true;
        parts[i] = next;
      }
      continue;
    }
    if (line.startsWith("#") || !line.trim()) {
      continue;
    }
    const uri = line.trim();
    if (!isSegmentReference(uri) || !scope(uri)) {
      continue;
    }
    const rewritten = rewriteUri(uri);
    if (rewritten === uri) {
      continue;
    }
    changed = true;
    // Preserve whitespace hugging the reference so surrounding spacing
    // survives even though the reference itself is replaced.
    const lead = line.slice(0, line.indexOf(uri));
    const tail = line.slice(line.indexOf(uri) + uri.length);
    parts[i] = `${lead}${rewritten}${tail}`;
  }
  return changed ? parts.join("") : text;
}

function rewriteMediaAttrs(line, scope, rewriteUri) {
  return line.replace(/(URI\s*=\s*")([^"]*)(")/g, (match, open, uri, close) => {
    if (!uri || !isSegmentReference(uri) || !scope(uri)) {
      return match;
    }
    const next = rewriteUri(uri);
    return next === uri ? match : open + next + close;
  });
}

/** Range-style values ("0-999") are byte offsets, not URIs - never rewrite
 *  them, even when a template/init surface sits on the same tag. */
function isByteRangeValue(value) {
  return /^\s*\d+\s*-\s*\d+\s*$/.test(String(value ?? ""));
}

/** Rewrite one or more URL-ish attributes on a DASH tag (`sourceURL=`,
 *  `initialization=`) while leaving range/hash-fragment-only values alone. */
function rewriteDashUriAttrs(tagText, scope, rewriteUri, names) {
  const nameList = Array.isArray(names) ? names : [names];
  const re = new RegExp(`\\b(${nameList.join("|")})\\s*=\\s*"([^"]*)"`, "gi");
  return tagText.replace(re, (match, name, value) => {
    if (isByteRangeValue(value) || !isSegmentReference(value) || !scope(value)) {
      return match;
    }
    const next = rewriteUri(value);
    return next === value ? match : `${name}="${next}"`;
  });
}

function rewriteMpd(text, scope, rewriteUri) {
  let out = text;
  out = out.replace(/<SegmentTemplate\b[^>]*>/g, (tag) => rewriteDashTemplateAttrs(tag, scope, rewriteUri));
  out = out.replace(/<(SegmentBase|SegmentList)\b[^>]*\/?>/gi, (tag) =>
    rewriteDashUriAttrs(tag, scope, rewriteUri, "initialization"));
  out = out.replace(/<Initialization\b[^>]*\/?>/gi, (tag) =>
    rewriteDashUriAttrs(tag, scope, rewriteUri, "sourceURL"));
  out = out.replace(/<BaseURL\s*>([^<]*)<\/BaseURL>/g, (match, inner) => {
    if (!inner) {
      return match;
    }
    const uri = inner.trim();
    if (!isSegmentReference(uri) || !scope(uri)) {
      return match;
    }
    const next = rewriteUri(uri);
    if (next === uri) {
      return match;
    }
    const lead = inner.slice(0, inner.indexOf(uri));
    const tail = inner.slice(inner.indexOf(uri) + uri.length);
    return `<BaseURL>${lead}${next}${tail}</BaseURL>`;
  });
  return out;
}

function rewriteDashTemplateAttrs(tag, scope, rewriteUri) {
  return tag.replace(/\b(initialization|index|media)\s*=\s*"([^"]*)"/g, (match, name, uri) => {
    if (!uri || !isSegmentReference(uri) || !scope(uri)) {
      return match;
    }
    const next = rewriteUri(uri);
    return next === uri ? match : `${name}="${next}"`;
  });
}

/**
 * Inject query parameters (token / signature / expiry form) into a URI
 * without absolutizing it: relative segment references stay relative, and an
 * identical value is left untouched so a no-op rewrite keeps the byte stream
 * stable. Deterministic serialization (URLSearchParams order).
 */
export function injectQueryParams(uri, params) {
  if (!params || typeof params !== "object") {
    return uri;
  }
  const entries = Object.entries(params);
  if (!entries.length) {
    return uri;
  }
  const hashIndex = uri.indexOf("#");
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : "";
  const stem = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const qIndex = stem.indexOf("?");
  const query = qIndex >= 0 ? stem.slice(qIndex + 1) : "";
  const base = qIndex >= 0 ? stem.slice(0, qIndex) : stem;
  const sp = new URLSearchParams(query);
  let changed = false;
  for (const [key, value] of entries) {
    const text = String(value);
    if (sp.get(key) !== text) {
      sp.set(key, text);
      changed = true;
    }
  }
  if (!changed) {
    return uri;
  }
  const queryText = sp.toString();
  return base + (queryText ? `?${queryText}` : "") + hash;
}

/**
 * Fill `{name}` placeholders in a URI path (the path form of token rewrite,
 * e.g. `/{token}/{expires}/...`). No placeholder, no change - so a provider
 * whose template spells the replaceable segments is the only surface this
 * touches.
 */
export function injectPathTokens(uri, values) {
  if (!values || typeof values !== "object") {
    return uri;
  }
  let out = uri;
  let changed = false;
  for (const [name, value] of Object.entries(values)) {
    const placeholder = `{${name}}`;
    if (out.includes(placeholder)) {
      out = out.replaceAll(placeholder, encodeURIComponent(String(value)));
      changed = true;
    }
  }
  return changed ? out : uri;
}


// ---------------------------------------------------------------------------
// MANIFEST SEAM — the always-on arm's observe/interpose surface and the §7.4
// ManifestFlow (engaged host, consent, claim) the ring consumes.
// ---------------------------------------------------------------------------

/** Rules fed to `GM_webRequest`: observe-only. TM's MV2 `observe` is
 *  emulated by a no-op `cancel` rule whose listener never aborts. */
export const MANIFEST_OBSERVE_RULES = Object.freeze([
  {
    selector: {
      include: ["*.m3u8*", "*.mpd*"]
    },
    action: "cancel"
  }
]);

/**
 * Register the manifest-observation rules with a GM_webRequest-compatible
 * function. Feature-detected: a missing GM_webRequest resolves to
 * `{ registered: false }` and the caller keeps only the interposed manifest
 * rewrite path. Calling again updates the rules in place (MV2 allows
 * re-registration to change rules live).
 */
export function observeManifests({ gmWebRequest, rules = MANIFEST_OBSERVE_RULES, onObserve } = {}) {
  if (typeof gmWebRequest !== "function") {
    return { registered: false, rules: null };
  }
  gmWebRequest(rules, (info, message, details) => {
    onObserve?.({
      action: info?.action,
      ruleIndex: info?.ruleIndex,
      url: details?.url,
      type: details?.type,
      tab: details?.tab
    });
  });
  logger.log("proxy", "observe", "registered GM_webRequest rules", rules.length);
  return { registered: true, rules };
}

/**
 * The transport-agnostic core of mode A: wraps a real `fetch` and rewrites
 * manifest-text responses in place. Every other response — and every manifest
 * when unarmed/out-of-scope — passes byte-identically.
 *
 * @param {object} env
 * @param {Function} env.fetch        the real fetch (uri, opts) => Promise<Response>.
 * @param {Function} env.shouldCapture (url) => boolean — manifest/stream-looking URLs.
 * @param {Function} env.rewrite     (url, text) => { text, decision } — armed rewrite.
 * @param {Function} [env.isManifest] (url) => boolean — which captures take the
 *                                    text-rewrite path (default: shouldCapture).
 * @param {Function} [env.onCapture] ({ url, response, contentType, failed, error }) —
 *                                    capture record hook for non-manifest streams
 *                                    (progressive MP4s). Never consumes the body.
 * @param {Function} [env.route]       async (url) => Response|null — checked BEFORE
 *                                    the wire: when it returns a Response, that
 *                                    becomes the page's response and `fetch` is
 *                                    never called (request-level takeover makes the
 *                                    proxy the Network initiator). null keeps the
 *                                    native wire.
 * @param {Function} [env.routeContent] async (url) => Response|null — content-type
 *                                    armed: a request whose URL gives no MP4 shape
 *                                    hint but whose response comes back
 *                                    `video/mp4` is re-routed through the proxy and
 *                                    the fabricated Response replaces the native
 *                                    one (the native body is abandoned, so the
 *                                    browser cancels the stream). This is the MP4
 *                                    mirror of the manifest path: capture by what
 *                                    the response *is*, not just its URL shape.
 *                                    null keeps whatever the wire returned.
 * @param {Function} [env.onOutcome]  notification for tests/telemetry.
 * @param {Function} [env.makeResponse] (body, init) => Response-like object (default new Response).
 * @param {Function} [env.enabled]    (uri, opts) => boolean, evaluated per call BEFORE
 *                                    any capture/routing work. false short-circuits the
 *                                    wrapper to a pure passthrough - the plain page pays
 *                                    one callback, not regexes or async yields. Lets the
 *                                    arm run at decision-time (live feature flips) while
 *                                    keeping the off-state cost at zero.
 */
export function interposeFetch({
  fetch: realFetch,
  shouldCapture,
  rewrite,
  isManifest = null,
  onCapture = () => {},
  route = null,
  routeContent = null,
  onOutcome = () => {},
  makeResponse = (body, init) => new Response(body, init),
  enabled = () => true
}) {
  if (typeof realFetch !== "function") throw new TypeError("interposeFetch requires a fetch seam");
  if (typeof shouldCapture !== "function") throw new TypeError("interposeFetch requires shouldCapture");
  if (typeof rewrite !== "function") throw new TypeError("interposeFetch requires rewrite");
  if (typeof onCapture !== "function") throw new TypeError("interposeFetch requires onCapture to be a function");
  const manifestPending = (url) => (isManifest ? isManifest(url) : shouldCapture(url));

  return async (uri, opts) => {
    if (typeof enabled === "function" && !enabled(uri, opts)) {
      // Unarmed fast path: the wrapper becomes a pure passthrough. The plain
      // page pays this single check - never a regex, a capture, or an async
      // routing yield. The check is DECISION-TIME so a live feature flip
      // re-arms the next request without any reinstall.
      return realFetch(uri, opts);
    }
    const url = typeof uri === "string" ? uri : uri?.url;
    if (typeof route === "function" && shouldCapture(url)) {
      let routed = null;
      try {
        routed = await route(url);
      } catch (err) {
        // Routing is a service, never a trap: a throwing seam must degrade to
        // the native wire, per this module's fail-toward-native rule.
        logger.warn("proxy", "fetch", "route throw, keeping native wire", url, err?.message ?? err);
      }
      if (routed) {
        onOutcome({ url, decision: "routed" });
        return routed;
      }
    }
    let response;
    try {
      response = await realFetch(uri, opts);
    } catch (err) {
      if (shouldCapture(url)) {
        onCapture({ url, failed: true, error: err });
      }
      throw err;
    }
    const contentType =
      typeof response?.headers?.get === "function"
        ? response.headers.get("content-type") ?? ""
        : "";
    if (!shouldCapture(url)) {
      if (typeof routeContent === "function" && isMp4ContentType(contentType)) {
        let rerouted = null;
        try {
          rerouted = await routeContent(url);
        } catch (err) {
          logger.warn("proxy", "fetch", "routeContent throw, keeping native wire", url, err?.message ?? err);
        }
        if (rerouted) {
          onOutcome({ url, decision: "routed-content" });
          return rerouted;
        }
        onOutcome({ url, decision: "content-native" });
      }
      return response;
    }
    onCapture({ url, response, contentType, failed: false });
    if (!manifestPending(url)) {
      return response;
    }
    logger.log("proxy", "fetch", "capturing manifest response", url);
    const body = await response
      .clone()
      .text()
      .catch(() => null);
    if (body == null) {
      return response;
    }
    const { text, decision } = rewrite(url, body);
    onOutcome({ url, decision });
    if (text === body) {
      logger.log("proxy", "fetch", "manifest byte-identical (unarmed/no-change)", url, decision);
      return response;
    }
    const { status, headers } = response;
    const init = { status, statusText: response.statusText, headers };
    logger.log("proxy", "fetch", "manifest rewritten", url, { status, bytes: text.length });
    return makeResponse(text, init);
  };
}

/** Classify + rewrite a manifest body, or leave byte-identical. */
export function manifestRewrite(url, text, { gate, rewriteUri = null } = {}) {
  const kind = detectManifestKind(url) ?? sniffManifestKind(text);
  const decision = gate.routeDecision(url, kind, text);
  logger.log("proxy", "gate", "manifest decision", url, decision);
  if (!decision.routed) {
    return { text, decision };
  }
  const rewritten = rewriteManifest(text, {
    armed: true,
    kind,
    baseUrl: url,
    scope: (uri) => gate.inScope(resolveRef(url, uri)),
    rewriteUri
  });
  return { text: rewritten, decision: { ...decision, kind } };
}

/** A ref that names its own absolute scheme (or starts `//`): no base needed.
 *  Hoisted - a regex literal in `resolveRef` would re-allocate per manifest
 *  URI the scope callback judges. */
const ABSOLUTE_REF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Resolve a manifest-internal ref (possibly relative / `$`-templated) to its
 *  absolute URL so site policy can judge it. Non-URL refs fail open to the
 *  manifest URL's own host judgement. */
export function resolveRef(baseUrl, uri) {
  const ref = String(uri ?? "").trim();
  if (ABSOLUTE_REF_RE.test(ref)) {
    return ref;
  }
  return URL.canParse(ref, baseUrl) ? new URL(ref, baseUrl).href : baseUrl;
}

/**
 * Shared load-hook for the Mode-A XHR interposition (used by both the
 * per-instance `guardXhrBloom` wrap and the prototype-level interpose). Attaches
 * a `load` hook that rewrites a manifest-text response in place - byte-identical
 * when unarmed or unchanged. Operates on the xhr contract (open/send/responseText)
 * so a fake XHR exercises it headlessly.
 */
function hookXhrLoad(xhr, { shouldCapture, rewrite, isManifest = null, onCapture = () => {} }) {
  const onLoad = () => {
    const url = xhr.responseURL ?? xhr.url;
    const contentType =
      typeof xhr.getResponseHeader === "function"
        ? xhr.getResponseHeader("content-type") ?? ""
        : "";
    if (!shouldCapture(url)) {
      if (isMp4ContentType(contentType)) {
        onCapture({ url, response: xhr, contentType, failed: false });
      }
      return;
    }
    onCapture({ url, response: xhr, contentType, failed: false });
    if (isManifest && !isManifest(url)) {
      return;
    }
    if (xhr.responseType && xhr.responseType !== "") {
      return;
    }
    const body = typeof xhr.responseText === "string" ? xhr.responseText : "";
    const { text } = rewrite(url, body);
    if (text !== body) {
      logger.log("proxy", "xhr", "manifest responseText rewritten", url);
      Object.defineProperty(xhr, "responseText", {
        enumerable: true,
        configurable: true,
        get: () => text
      });
    }
  };
  if (xhr.addEventListener) {
    xhr.addEventListener("load", onLoad, { once: true });
  } else if (typeof xhr.onload === "function" || "onload" in xhr) {
    const prior = xhr.onload;
    xhr.onload = (event) => {
      try { if (prior) prior.call(xhr, event); } finally { onLoad(); }
    };
  }
  return xhr;
}

/**
 * Mode-A wiring for XMLHttpRequest: wraps an XHR-like object's `send` so that
 * a manifest-text response is rewritten in place before the player reads it.
 * Purely explicit in how much it rewrites: an unarmed/no-change response keeps
 * its original `responseText` (byte-identical).
 */
export function guardXhrBloom(xhr, { shouldCapture, rewrite, isManifest, onCapture }) {
  const originalSend = xhr.send;
  xhr.send = (...args) => {
    hookXhrLoad(xhr, { shouldCapture, rewrite, isManifest, onCapture });
    return originalSend.apply(xhr, args);
  };
  return xhr;
}

/**
 * Mode-A wiring at the prototype level: wrap `proto.send` so every request on a
 * page (players using XHR for manifests) is rewritten in place on load. Each
 * instance gets one load hook per `send`, and responses still pass byte-identical
 * when unarmed or unchanged.
 */
export function interposeXhrPrototype(proto, { shouldCapture, rewrite, isManifest, onCapture, enabled = () => true }) {
  if (!proto || typeof proto.send !== "function") {
    return { registered: false };
  }
  const originalSend = proto.send;
  proto.send = function (...args) {
    if (typeof enabled === "function" && !enabled()) {
      // Unarmed fast path: same decision-time contract as the fetch interpose -
      // the plain page pays one callback per send, no hook wiring at all.
      return originalSend.apply(this, args);
    }
    hookXhrLoad(this, { shouldCapture, rewrite, isManifest, onCapture });
    return originalSend.apply(this, args);
  };
  return { registered: true };
}

/** §7.4.3 engage modes. */
export const ENGAGE_MODE = Object.freeze({
  AUTO: "auto",
  ASK: "ask",
  MANUAL: "manual"
});

/** §7.4.4 ablation guard: only clean (uncommitted) videos are claimable.
 *  HAVE_NOTHING == 0; any advancing readyState means the page player is
 *  already feeding bytes and an MSE swap would rip a live stream. */
export function isClaimable({ readyState, mediaSourceAttached }) {
  const pastCommitted = typeof readyState === "number" && readyState > 0;
  return !(pastCommitted || mediaSourceAttached === true);
}

/**
 * The §7.4 opt-in seam state machine. Fired at the claim point t2 (a manifest
 * fetch observed / interposed), it decides - deterministically - whether the
 * stream may try to claim the video:
 *
 *   1. feature enabled, 2. protection class routable, 3. site in scope,
 *   (gate decision first), 4. ablation guard clean, 5. consent per mode.
 *
 * Engaged players are tracked so downgrade/teardown can revoke them. It never
 * touches a video or MSE itself - `onEngage`/`onDisengage` are the caller's
 * wiring (MSE attach, SegmentManager arm, src swap).
 */
export class ManifestFlow {
  #gate;
  #mode = ENGAGE_MODE.AUTO;
  #consented = false;
  #onEngage;
  #onDisengage;
  #onStatus;
  #claimed = new Map();
  #downgraded = false;

  constructor({ gate, mode = ENGAGE_MODE.AUTO, consented = false, onEngage, onDisengage, onStatus } = {}) {
    this.#gate = gate;
    this.#setMode(mode);
    this.#consented = consented === true;
    this.#onEngage = typeof onEngage === "function" ? onEngage : () => {};
    this.#onDisengage = typeof onDisengage === "function" ? onDisengage : () => {};
    this.#onStatus = typeof onStatus === "function" ? onStatus : () => {};
    logger.log("proxy", "flow", "created", { mode: this.#mode, consented: this.#consented });
  }

  #setMode(mode) {
    if (mode === ENGAGE_MODE.ASK || mode === ENGAGE_MODE.MANUAL) {
      this.#mode = mode;
    } else {
      this.#mode = ENGAGE_MODE.AUTO;
    }
  }

  get enabled() {
    return this.#gate?.enabled === true;
  }

  get mode() {
    return this.#mode;
  }

  get consented() {
    return this.#consented;
  }

  get claimedSize() {
    return this.#claimed.size;
  }

  /** First-run / per-context consent. */
  setConsent(value) {
    this.#consented = value === true;
    logger.log("proxy", "flow", "consent", this.#consented);
    return this;
  }

  setMode(mode) {
    this.#setMode(mode);
    logger.log("proxy", "flow", "mode", this.#mode);
    return this;
  }

  /** A player whose decision was reached stays claimed until disengaged. */
  decision(player) {
    return this.#claimed.get(player) ?? null;
  }

  /**
   * The t2 decision for one manifest fetch. Returns a stable ruling and fires
   * onStatus (telemetry) plus onEngage when the stream may claim the video.
   */
  consider({ player, manifestUrl, kind, text, video, readyState, mediaSourceAttached }) {
    const mode = this.#mode;
    const note = (reason, engage) => {
      const outcome = { player, engage, reason, mode, url: manifestUrl };
      logger.log("proxy", "flow", "decision", outcome);
      if (engage) {
        this.#claimed.set(player, outcome);
        this.#onEngage(outcome);
      }
      this.#onStatus(outcome);
      return outcome;
    };

    if (this.decision(player)) {
      const existing = this.#claimed.get(player);
      logger.log("proxy", "flow", "already claimed", player, existing.reason);
      this.#onStatus(existing);
      return existing;
    }
    if (this.#downgraded) {
      return note("downgraded", false);
    }
    if (!this.enabled) {
      return note("disabled", false);
    }
    const decision = this.#gate.routeDecision(manifestUrl, kind, text);
    if (!decision.routed) {
      return note(decision.reason, false);
    }
    if (video != null && !isClaimable({ readyState, mediaSourceAttached })) {
      return note("busy", false);
    }
    if (mode !== ENGAGE_MODE.MANUAL && !this.#consented) {
      return note("consent", false);
    }
    return note(null, true);
  }

  /**
   * Tear down one engaged player toward native. No-op when the player was
   * never claimed or already released.
   */
  disengage(player, { reason = "teardown" } = {}) {
    const existing = this.#claimed.get(player);
    if (!existing) {
      return existing ?? null;
    }
    this.#claimed.delete(player);
    this.#onDisengage({ player, reason });
    logger.log("proxy", "flow", "disengage", player, reason);
    return existing;
  }

  /**
   * §7.4.7 downgrade: stop engaging new streams immediately and hand every
   * engaged player back to native - fail toward native, never frozen.
   */
  downgrade({ reason = "downgrade" } = {}) {
    this.#downgraded = true;
    const released = Array.from(this.#claimed.keys());
    this.#claimed.clear();
    for (const player of released) {
      this.#onDisengage({ player, reason });
    }
    logger.warn("proxy", "flow", "downgraded, released players", released, reason);
    return released;
  }

  /** Re-arm after a downgrade (feature re-enabled live). */
  rearm() {
    this.#downgraded = false;
    logger.log("proxy", "flow", "rearmed");
    return this;
  }

  destroy({ reason = "teardown" } = {}) {
    return this.downgrade({ reason });
  }
}