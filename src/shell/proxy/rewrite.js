/**
 * Pure manifest text surgery for the stream proxy. `rewrite.js` owns the
 * shapes of `.m3u8` and `.mpd` playlists and rewrites media URIs toward the
 * proxy pipe. It never decides WHEN to engage - that is `gate.js` - and never
 * decides WHAT a routed URI looks like - the caller supplies `rewriteUri` (the
 * eventual owner is the token manager / provider contract, §12.2). Every
 * function here is byte-stable on unarmed or out-of-scope input: when nothing
 * qualifies for a rewrite, the exact input string comes back unchanged, so
 * player frame drift and byte-range indexing are never disturbed.
 */

const MANIFEST_SUFFIX_RE = /\.(m3u8|mpd)$/i;
/** Media references routed through OTHER seams stay out of the segment pipe:
 *  variant playlists (the manifest layer), the AES-128 key path (§11.2), and
 *  subtitle lists (the existing GM_webRequest surface). */
const NON_SEGMENT_URI_RE = /\.(m3u8|mpd|key|vtt)$/i;

export const MANIFEST_KIND = Object.freeze({
  M3U8: "m3u8",
  MPD: "mpd"
});

/** Kind by URL pathname suffix ("m3u8" | "mpd" | null) - honors query/hash. */
export function detectManifestKind(url) {
  const path = String(url ?? "").split(/[?#]/, 1)[0];
  const m = MANIFEST_SUFFIX_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
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
  return !NON_SEGMENT_URI_RE.test(ref.split(/[?#]/, 1)[0].toLowerCase());
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
    if (line.startsWith("#EXT-X-MEDIA")) {
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

function rewriteMpd(text, scope, rewriteUri) {
  let out = text;
  out = out.replace(/<SegmentTemplate\b[^>]*>/g, (tag) => rewriteDashTemplateAttrs(tag, scope, rewriteUri));
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