/**
 * Manifest → fragment plan parser (§Phase 6 prep, MP4-fragment aware).
 *
 * Pure text-in / structure-out: no browser API, no logging, no side effects.
 * The SegmentManager lives off `enqueue({id, uri, byteRange, encrypted,
 * key})` calls, and this module is what turns a rewritable `.m3u8` / `.mpd`
 * into those plans — including the pieces fragmented-MP4 streams actually
 * need that URL-only rewriting can't see: the init segment (`#EXT-X-MAP` /
 * DASH `<Initialization>` / `initialization=`), byte ranges, media
 * sequence/start numbers, and the encryption key active at each fragment.
 *
 * Both formats resolve every URI against the manifest URL so the gate's
 * scope check and the provider's fetch see absolute targets.
 *
 * Output shape (shared by HLS + DASH):
 *   {
 *     kind,                 "m3u8" | "mpd"
 *     sequence,             HLS media sequence / DASH base start number
 *     lanes: [ {
 *       id, mimeType, codecs, maps/init, segments: [{
 *         id, uri, byteRange|null, duration, encrypted, key|null, map
 *       }]
 *     } ]
 *   }
 *
 * `byteRange` is normalized to `{start, end}` (byte offsets, inclusive) so
 * the provider can emit `Range: bytes=start-end`. HLS `n@o` / `n` forms and
 * DASH `<range>a-b</range>`-style strings all normalize to that.
 *
 * Unbounded DASH `SegmentTemplate`s (no timeline, no endNumber) emit the
 * template only — `resolveTemplate(template, n)` expands a numbered URI.
 */
import { MANIFEST_KIND } from "./rewrite.js";

/** Upper bound for expanding DASH timeline/template loops. */
const MAX_CONCRETE_SEGMENTS = 1024;

/** pathname suffix detection for kind resolution. */
const SUFFIX_RE = /\.(m3u8|mpd)$/i;

/**
 * Resolve a manifest-internal reference (possibly relative) against the
 * manifest URL. Non-URL refs and unresolvable bases fall back to the raw
 * reference so nothing crashes on bare-relative plans.
 */
function resolveManifestRef(baseUrl, uri) {
  const ref = String(uri ?? "").trim();
  if (!ref) {
    return ref;
  }
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) {
    return ref;
  }
  if (!baseUrl) {
    return ref;
  }
  try {
    return new URL(ref, baseUrl).href;
  } catch {
    return ref;
  }
}

/** True when a reference is a URL-ish thing we should resolve/route (skips
 *  bare numbers, `data:` payloads, and `#`-fragments). */

/**
 * Normalize a byte-range string to `{start, end}`.
 * - `"720-1439"`  → {start:720, end:1439}
 * - `"720@0"`     → {start:0, end:719} (length@offset, inclusive end)
 * - `"720"`       → length only; needs `startHint` (the running offset on the
 *   same resource) else null (unresolvable, fetch whole resource instead)
 */
export function normalizeByteRange(value, { startHint = null } = {}) {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  let m = /^(\d+)-(\d+)$/.exec(text);
  if (m) {
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    return { start, end: Math.max(end, start) };
  }
  m = /^(\d+)@(\d+)$/.exec(text);
  if (m) {
    const length = parseInt(m[1], 10);
    const start = parseInt(m[2], 10);
    return { start, end: start + length - 1 };
  }
  m = /^(\d+)$/.exec(text);
  if (m) {
    const length = parseInt(m[1], 10);
    if (startHint == null) {
      return null;
    }
    return { start: startHint, end: startHint + length - 1 };
  }
  return null;
}

/** Comma-split HLS tag attributes (quotes honored), lowercase keys, values
 *  unquoted. Mirrors the splitter the gate uses for classification. */
function parseHlsAttrs(input) {
  const parts = [];
  let current = "";
  let inQuote = false;
  for (const ch of String(input ?? "")) {
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

/** Whitespace-separated XML tag attributes (double-quoted values). */
function parseXmlAttrs(input) {
  const out = new Map();
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_:][\w:.-]*)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(String(input ?? "")))) {
    out.set(m[1] ?? m[3], m[2] ?? m[4]);
  }
  return out;
}

/** Parse an `#EXTINF:4.0,Title` line into duration seconds. */
function parseExtinf(line) {
  const value = line.slice("#EXTINF".length).replace(/^\s*:/, "").trim();
  const duration = parseFloat(value.split(/[,\s]/, 1)[0].trim());
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

function parseHlsKey(line, baseUrl) {
  const attrs = parseHlsAttrs(line.slice("#EXT-X-KEY:".length));
  const method = (attrs.get("method") ?? "").toUpperCase();
  if (!method) {
    return null;
  }
  const uriAttr = attrs.get("uri");
  const key = {
    method,
    keyFormat: attrs.get("keyformat") ?? null,
    iv: attrs.get("iv") ?? null,
    uri: uriAttr ? resolveManifestRef(baseUrl, uriAttr) : null
  };
  return key;
}

/**
 * Parse an HLS playlist into a single muxed lane. Fragment-aware fields:
 * `#EXT-X-MAP` entries become lane `maps` (each mapped segment records which
 * one applies), `#EXT-X-BYTERANGE` becomes `{start,end}`, and the active
 * `#EXT-X-KEY` (including mid-list rotation) rides along on each segment.
 */
export function parseHls(text, { baseUrl = null } = {}) {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  const segments = [];
  const maps = [];
  const mapsByRef = new Map();
  let mediaSequence = 0;
  let duration = 0;
  let activeKey = null;
  let lastMap = null;
  let pendingRange = null;
  let lastResource = null;
  const resourceEnds = new Map(); // running offset for length-only BYTERANGE

  const registerMap = (map) => {
    const ref = map.uri + (map.byteRange ? `#${map.byteRange.start}-${map.byteRange.end}` : "#full");
    if (!mapsByRef.has(ref)) {
      mapsByRef.set(ref, maps.length);
      maps.push({ uri: map.uri, byteRange: map.byteRange });
    }
    return mapsByRef.get(ref);
  };

  for (const line of lines) {
    const tag = line.trim();
    if (!tag || tag.startsWith("#EXTM3U") || tag.startsWith("#EXT-X-VERSION")) {
      continue;
    }
    if (tag.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      const n = parseInt(tag.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim(), 10);
      mediaSequence = Number.isFinite(n) ? n : 0;
      continue;
    }
    if (tag.startsWith("#EXT-X-KEY:")) {
      activeKey = parseHlsKey(tag, baseUrl);
      continue;
    }
    if (tag.startsWith("#EXT-X-MAP:")) {
      const attrs = parseHlsAttrs(tag.slice("#EXT-X-MAP:".length));
      const uri = attrs.get("uri");
      if (uri) {
        const startHint = resourceEnds.get(uri) ?? null;
        const map = {
          uri: resolveManifestRef(baseUrl, uri),
          byteRange: normalizeByteRange(attrs.get("byterange") ?? null, { startHint })
        };
        lastMap = registerMap(map);
        if (map.byteRange) {
          resourceEnds.set(uri, map.byteRange.end + 1);
        }
      }
      continue;
    }
    if (tag.startsWith("#EXT-X-BYTERANGE:")) {
      const raw = tag.slice("#EXT-X-BYTERANGE:".length).trim();
      const current = resourceEnds.get(lastResource) ?? null;
      pendingRange = normalizeByteRange(raw, { startHint: current });
      continue;
    }
    if (tag.startsWith("#EXTINF")) {
      duration = parseExtinf(tag);
      continue;
    }
    if (tag.startsWith("#")) {
      continue;
    }
    // Media reference line.
    const uriRef = tag;
    const uri = resolveManifestRef(baseUrl, uriRef);
    lastResource = uri;
    const byteRange = pendingRange;
    pendingRange = null;
    if (byteRange) {
      resourceEnds.set(uri, byteRange.end + 1);
    }
    segments.push({
      id: mediaSequence + segments.length,
      uri,
      byteRange,
      duration,
      encrypted: !!activeKey && activeKey.method === "AES-128",
      key: activeKey,
      map: lastMap
    });
    duration = 0;
  }

  return {
    kind: MANIFEST_KIND.M3U8,
    sequence: mediaSequence,
    lanes: [{ id: "main", mimeType: null, codecs: null, maps, segments }]
  };
}

/** DASH `$Token$` substitution. Supports `$Number$`, `$Number%0Nd$`,
 *  `$RepresentationID$`, `$Bandwidth$`. */
export function resolveTemplate(uriTemplate, n, { representationId = null, bandwidth = null } = {}) {
  let out = String(uriTemplate ?? "");
  out = out.replace(/\$Number(?:%0?(\d+)d)?\$/g, (all, width) => {
    const text = String(n);
    if (width && text.length < parseInt(width, 10)) {
      return text.padStart(parseInt(width, 10), "0");
    }
    return text;
  });
  out = out.replaceAll("$RepresentationID$", representationId ?? "");
  out = out.replaceAll("$Bandwidth$", bandwidth ?? "");
  return out;
}

/** Structured DASH walker tokens (lite). */
function tokenizeXml(text) {
  const tokens = [];
  let i = 0;
  let buffer = "";
  const src = String(text ?? "");
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      buffer += src.slice(i);
      break;
    }
    if (lt > i) {
      buffer += src.slice(i, lt);
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) {
      break;
    }
    if (buffer.trim()) {
      tokens.push({ type: "text", text: buffer.trim() });
      buffer = "";
    }
    const raw = src.slice(lt + 1, gt);
    i = gt + 1;
    if (!raw || raw.startsWith("!") || raw.startsWith("?")) {
      continue; // comments / declaration / doctype
    }
    if (raw.startsWith("/")) {
      tokens.push({ type: "close", name: raw.slice(1).trim().toLowerCase() });
      continue;
    }
    const self = /\/\s*$/.test(raw);
    const body = raw.replace(/\/\s*$/, "");
    const sp = body.search(/[\s]/);
    const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const attrs = sp < 0 ? {} : Object.fromEntries(parseXmlAttrs(body.slice(sp + 1)));
    tokens.push({ type: "open", name, attrs, self });
  }
  if (buffer.trim()) {
    tokens.push({ type: "text", text: buffer.trim() });
  }
  return tokens;
}

/**
 * Parse a DASH MPD into SourceBuffer-style lanes (one per Representation).
 * Handles `SegmentTemplate` (timeline + numbered + unbounded → `template`),
 * `SegmentList` (concrete `SegmentURL`s), and `SegmentBase`
 * (init + whole-file media). Init surfaces (`initialization=` /
 * `<Initialization sourceURL= range=>`) land on `lane.init`.
 */
export function parseDash(text, { baseUrl = null } = {}) {
  const tokens = tokenizeXml(text);
  const lanes = [];
  let base = baseUrl ?? "";
  let pendingBase = false;
  let rep = null; // working representation
  let adaptationMime = null;
  let adaptationCodecs = null;
  let laneCount = 0;

  const newRep = (attrs) => ({
    attrs,
    mimeType: attrs.mimeType ?? adaptationMime,
    codecs: attrs.codecs ?? adaptationCodecs,
    template: null,
    timeline: null,
    list: null,
    base: null,
    initElement: null
  });

  const useNumber = () => {
    const tpl = rep.template;
    const start = tpl ? parseInt(tpl.attrs.startNumber ?? "1", 10) : 1;
    return Number.isFinite(start) ? start : 1;
  };

  for (const token of tokens) {
    if (token.type === "text") {
      if (pendingBase && token.text) {
        base = resolveManifestRef(baseUrl ?? base, token.text);
      }
      pendingBase = false;
      continue;
    }
    if (token.type === "close") {
      if (token.name === "baseurl") {
        pendingBase = false;
      }
      if (token.name === "representation" && rep) {
        finalizeRep();
        rep = null;
      }
      continue;
    }

    const { name, attrs } = token;
    if (name === "baseurl") {
      pendingBase = true;
      continue;
    }
    if (name === "period" || name === "mpd") {
      continue;
    }
    if (name === "segmenttemplate") {
      if (rep && !rep.template) {
        rep.template = { attrs };
      }
      continue;
    }
    if (name === "segmenttimeline") {
      if (rep) {
        rep.timeline = [];
      }
      continue;
    }
    if (name === "s") {
      if (rep && rep.timeline) {
        rep.timeline.push({
          t: attrs.t ? parseInt(attrs.t, 10) : null,
          d: attrs.d ? parseInt(attrs.d, 10) : 0,
          r: attrs.r ? parseInt(attrs.r, 10) : 0
        });
      }
      continue;
    }
    if (name === "segmentlist") {
      if (rep && !rep.list) {
        rep.list = { attrs, segments: [] };
      }
      continue;
    }
    if (name === "segmenturl") {
      if (rep && rep.list) {
        rep.list.segments.push(attrs);
      }
      continue;
    }
    if (name === "segmentbase") {
      if (rep && !rep.base) {
        rep.base = { attrs };
      }
      continue;
    }
    if (name === "initialization") {
      if (rep && !rep.initElement) {
        rep.initElement = { attrs };
      }
      continue;
    }
    if (name === "adaptationset") {
      adaptationMime = attrs.mimeType ?? null;
      adaptationCodecs = attrs.codecs ?? null;
      continue;
    }
    if (name === "representation") {
      laneCount++;
      rep = newRep(attrs);
      continue;
    }
  }

  function finalizeRep() {
    const attrs = rep.attrs;
    const lane = {
      id: attrs.id ?? `rep-${laneCount}`,
      mimeType: rep.mimeType ?? null,
      codecs: rep.codecs ?? null,
      bandwidth: attrs.bandwidth ? parseInt(attrs.bandwidth, 10) : null,
      init: null,
      template: null,
      segments: []
    };

    // Init segment resolution.
    if (rep.initElement) {
      const range = rep.initElement.attrs.range ?? null;
      const sourceUrl = rep.initElement.attrs.sourceURL ?? null;
      lane.init = {
        uri: sourceUrl ? resolveManifestRef(base, sourceUrl) : base,
        byteRange: normalizeByteRange(range, { startHint: 0 })
      };
    } else if (rep.template && rep.template.attrs.initialization) {
      const tpl = resolveTemplate(rep.template.attrs.initialization, useNumber(), {
        representationId: attrs.id,
        bandwidth: attrs.bandwidth
      });
      lane.init = { uri: resolveManifestRef(base, tpl), byteRange: null };
    } else if (rep.base && rep.base.attrs.initialization) {
      const raw = String(rep.base.attrs.initialization).trim();
      const parts = raw.split("#");
      lane.init = {
        uri: parts[0] ? resolveManifestRef(base, parts[0]) : base,
        byteRange: parts[1] ? normalizeByteRange(parts[1], { startHint: 0 }) : null
      };
    }

    const timescale = rep.template?.attrs.timescale
      ? parseInt(rep.template.attrs.timescale, 10)
      : rep.list?.attrs.timescale
        ? parseInt(rep.list.attrs.timescale, 10)
        : rep.base?.attrs.timescale
          ? parseInt(rep.base.attrs.timescale, 10)
          : 1;
    const tsv = timescale > 0 ? timescale : 1;

    if (rep.list) {
      for (let i = 0; i < rep.list.segments.length; i++) {
        const s = rep.list.segments[i];
        lane.segments.push({
          id: i,
          uri: s.media ? resolveManifestRef(base, s.media) : base,
          byteRange: normalizeByteRange(s.mediaRange ?? s.range ?? null, { startHint: null }),
          duration: s.durationSec ?? 0,
          encrypted: false,
          key: null,
          map: null
        });
      }
    } else if (rep.timeline && rep.timeline.length > 0) {
      let number = useNumber();
      const tpl = rep.template ? rep.template.attrs.media : null;
      outer: for (const entry of rep.timeline) {
        const repeat = Math.max(1, entry.r + 1);
        for (let k = 0; k < repeat; k++) {
          lane.segments.push({
            id: number,
            uri: tpl ? resolveManifestRef(base, resolveTemplate(tpl, number, {
              representationId: attrs.id,
              bandwidth: attrs.bandwidth
            })) : base,
            byteRange: null,
            duration: entry.d / tsv,
            encrypted: false,
            key: null,
            map: null
          });
          number++;
          if (lane.segments.length >= MAX_CONCRETE_SEGMENTS) {
            break outer;
          }
        }
      }
    } else if (rep.template) {
      const tpl = rep.template.attrs;
      const start = useNumber();
      const end = tpl.endNumber ? parseInt(tpl.endNumber, 10) : null;
      if (end != null && !Number.isNaN(end)) {
        const step = tpl.duration ? parseInt(tpl.duration, 10) / tsv : 0;
        for (let n = start; n <= end && lane.segments.length < MAX_CONCRETE_SEGMENTS; n++) {
          lane.segments.push({
            id: n,
            uri: tpl.media ? resolveManifestRef(base, resolveTemplate(tpl.media, n, {
              representationId: attrs.id,
              bandwidth: attrs.bandwidth
            })) : base,
            byteRange: null,
            duration: step,
            encrypted: false,
            key: null,
            map: null
          });
        }
      } else {
        // Unbounded: hand the template to the flow for on-demand expansion.
        lane.template = {
          uriTemplate: resolveManifestRef(base, tpl.media ?? ""),
          number: start,
          step: tpl.duration ? parseInt(tpl.duration, 10) / tsv : 0,
          representationId: attrs.id,
          bandwidth: attrs.bandwidth
        };
      }
    } else if (rep.base) {
      // Whole-file representation: init + the resource itself as one segment.
      lane.segments = [{ id: 0, uri: base, byteRange: null, duration: 0, encrypted: false, key: null, map: null }];
    }

    lanes.push(lane);
  }

  return { kind: MANIFEST_KIND.MPD, sequence: 0, lanes };
}

/**
 * Parse a manifest into fragment plans. Kind is resolved from the URL suffix
 * first, then sniffed from the text (both via rewrite.js helpers).
 */
export function parseManifest(text, { kind = null, baseUrl = null } = {}) {
  const effectiveKind = kind ?? detectKind(baseUrl) ?? sniffKind(text);
  if (effectiveKind === MANIFEST_KIND.MPD) {
    return parseDash(text, { baseUrl });
  }
  return parseHls(text, { baseUrl });
}

function detectKind(url) {
  const path = String(url ?? "").split(/[?#]/, 1)[0];
  const m = SUFFIX_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
}

function sniffKind(text) {
  const source = String(text ?? "");
  if (source.startsWith("#EXTM3U")) {
    return MANIFEST_KIND.M3U8;
  }
  if (source.includes("<MPD")) {
    return MANIFEST_KIND.MPD;
  }
  return null;
}