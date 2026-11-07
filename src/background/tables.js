/* The Reforge witness vocabulary - the plane's pure classification tables.
 *
 * Ported verbatim from the recovered reforge branch (`reforge:src/shell/
 * reforge/tables.js`, the engine's source tables) with the branch's own
 * vocabulary - the names ARE the machine spelling (classifyUrl/
 * classifyContentType/fileFormat/parseAttrs/parseHlsPlaylist/
 * manifestVerdict/BODY_READ_CAP, family manifest/file/segment, kind
 * hls/dash/file/segment). Import-free: the node-realm flaw smoke imports
 * this module alone and the background bundle rides only this import edge
 * from the ledger.
 *
 * Located in the background plane (the rebrand, 2026-11): this file is the
 * SOURCE of the census's one-classification-owner law - the ledger consumes
 * it, no second classification site exists, and a fork of the shape tables
 * would drift the family identity the claims execute against.
 *
 * The ingestion premise (the port's decision, probe-redirected): the
 * recovered branch read manifest BODIES two ways - the on-page verb wraps
 * (the wrap saw the body as the page fetched it, zero egress) and the
 * relay fetch leg (gmRequestText's resolved-manifest path). Probe A measured
 * the verb-wrap shape per-carrier fragile on the extension plane (three
 * carriers x three Xray walls on the serve half), so the wraps retired and
 * the FETCH LEG is the whole ingest route now: the witness classifies from
 * URL/headers, and when the family is a manifest the background fetches
 * what it classified (probe C's red verdict settled this - filterResponseData
 * pass-through observation does NOT exist without webRequestBlocking, so
 * there is no free body-read alongside observe-only headers). The parse +
 * verdict below are what that fetch feeds.
 */

/**
 * The one URL-shape string tables (machine-facing source tables - each new
 * shape is a table row, never an inline regex): manifests by path/query/
 * fragment-adjacent spelling, direct media by extension, segments by
 * extension.
 */
const M3U8_SHAPE_RE = /\.m3u8(?:;[^?#/?]*|\/)?(?:[?#]|$)/i;
const MPD_SHAPE_RE = /\.mpd(?:;[^?#/?]*|\/)?(?:[?#]|$)/i;
/** Named query-param manifest conventions (CDN tokens ride the query, so
 *  the manifest can be a carrier of it: `?format=m3u8`-style players; the
 *  bare word values `hls`/`dash` are the audio/video-player convention
 *  family). */
const QUERY_MANIFEST_RE = /[?&](?:format|type)=(m3u8|mpd|hls|dash)\b/i;

/** Direct-file extension table (playable as-is by external players; a
 *  small honest set, not a media-type encyclopedia - the content-type
 *  witness and the manifest classification are the authoritative arms).
 *  The boundary tail mirrors the manifest tables' normalization arm
 *  exactly (`;`-parameter + CDN trailing-slash then query/fragment/end) -
 *  one shape family: the get_file class asks `169523_720p.mp4/?
 *  v-acctoken=...`, a first-class file spelling whose extension is
 *  followed by a slash, and a mid-path extension (`/x.mp4/y`) still
 *  nulls. */
const FILE_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|flv|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:;[^?#/?]*|\/)?(?:[?#]|$)/i;

/** The direct file's container format when the URL speaks an extension,
 *  or null (the witness record's kind label rides the URL tables alone -
 *  `contentType` alone never mints a format name). */
export function fileFormat(urlText) {
  const matched = FILE_EXT_RE.exec(String(urlText || ""));
  return matched ? matched[1].toLowerCase() : null;
}

/**
 * Segment/fragment shape table (recovered branch's own record: ignored by
 * design, like the protected class). Per-segment rostering floods the
 * records on an ABR page; the witness arms classify them (they were the
 * one shape the arms could mis-serve: a `video/mp2t` segment plugged
 * STRAIGHT into the `video/` file rule), then do not roster them. `.ts`
 * is the MPEG-TS container spelling, `.m4s` the ISO-BMFF media segment/
 * fragment. The boundary tail mirrors FILE_EXT_RE exactly - the same
 * trailing-slash normalization (one shape family).
 */
const SEGMENT_EXT_RE = /\.(?:ts|m4s)(?:;[^?#/?]*|\/)?(?:[?#]|$)/i;

/**
 * Content-type table for the network witness: the ordered first-arrow
 * match wins. Segments ride before the `video/` catch-all - a
 * `video/mp2t` segment is a segment, not a playable direct file.
 */
const CONTENT_KINDS = [
  ["application/vnd.apple.mpegurl", "hls"],
  ["application/x-mpegurl", "hls"],
  ["application/dash+xml", "dash"],
  ["video/mp2t", "segment"],
  ["video/", "file"],
  ["audio/", "file"]
];

/**
 * Classify a request URL into a witness family. Pure. Returns null for
 * everything that is NOT a named media shape (the no-generic-fallback
 * law - syndic URLs record nothing).
 */
export function classifyUrl(urlText) {
  const raw = String(urlText || "");
  if (M3U8_SHAPE_RE.test(raw)) {
    return { family: "manifest", kind: "hls" };
  }
  if (MPD_SHAPE_RE.test(raw)) {
    return { family: "manifest", kind: "dash" };
  }
  const queryKind = QUERY_MANIFEST_RE.exec(raw);
  if (queryKind) {
    // The captured spelling ("m3u8"/"hls"/"mpd"/"dash") maps onto the
    // kind vocabulary ("hls"/"dash").
    const spelled = queryKind[1].toLowerCase();
    return { family: "manifest", kind: spelled === "m3u8" || spelled === "hls" ? "hls" : "dash" };
  }
  if (FILE_EXT_RE.test(raw)) {
    return { family: "file", kind: "file" };
  }
  if (SEGMENT_EXT_RE.test(raw)) {
    return { family: "segment", kind: "segment" };
  }
  return null;
}

/** Content-type kind, or null when absent/unknown (the URL tables then
 *  speak alone). */
export function classifyContentType(contentType) {
  const raw = String(contentType || "").toLowerCase();
  if (!raw) {
    return null;
  }
  for (const [marker, kind] of CONTENT_KINDS) {
    if (raw.startsWith(marker)) {
      return { family: kind === "hls" || kind === "dash" ? "manifest" : kind, kind };
    }
  }
  return null;
}

/** Manifest body text the ingest may read before capping (masters are
 *  bytes; media playlists of long VODs reach tens of KB - 256KiB is the
 *  belt, the recovered branch's own constant). */
export const BODY_READ_CAP = 262144;

/**
 * Split "KEY=value,KEY="quoted, comma-bearing value",... attribute lists
 * per the HLS attribute grammar: quoted strings may carry commas, so a
 * plain comma split would shred CODECS lists. The ONE attribute reader -
 * the parser and (later batches) the claim composition both read
 * stream-inf attrs through it; a second BANDWIDTH spelling diverged once
 * already on the branch and dropped every block.
 */
export function parseAttrs(source) {
  const attrs = {};
  const pattern = /([A-Za-z-]+)=("[^"]*"|[^,]*)(?:,|$)/g;
  let match;
  while ((match = pattern.exec(source))) {
    let value = match[2];
    if (value.startsWith('"')) {
      value = value.slice(1, -1);
    }
    attrs[match[1]] = value;
  }
  return attrs;
}

/**
 * Pure HLS text classifier: a master playlist parses into bandwidth-sorted
 * variants, a media playlist into segment/live/encryption facts, plain text
 * into null. Encryption rides labels only - AES-128 is what an external
 * player decrypts natively, SAMPLE-AES is the protected arm (ignore by
 * design). baseUrl supplies the variant URIs' resolution base (the
 * background plane has no document.baseURI - the record's request URL is
 * the base, the same relative-manifest grammar HLS itself serves).
 */
export function parseHlsPlaylist(text, baseUrl) {
  const body = String(text || "").slice(0, BODY_READ_CAP);
  if (!/#EXTM3U/.test(body)) {
    return null;
  }
  const lines = body.split(/\r?\n/);
  const variants = [];
  const sessionKeys = [];
  let pendingAttrs = null;
  let segmentCount = 0;
  let keyMethod = "";
  let live = true;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pendingAttrs = parseAttrs(line.slice(18));
      continue;
    }
    if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttrs(line.slice(11));
      if (attrs.METHOD && attrs.METHOD !== "NONE" && !keyMethod) {
        keyMethod = attrs.METHOD;
      }
      continue;
    }
    if (line.startsWith("#EXT-X-SESSION-KEY:")) {
      const attrs = parseAttrs(line.slice(19));
      if (attrs.METHOD && attrs.METHOD !== "NONE") {
        sessionKeys.push(attrs.METHOD);
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      segmentCount++;
      continue;
    }
    if (line === "#EXT-X-ENDLIST") {
      live = false;
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    if (pendingAttrs) {
      variants.push({
        uri: new URL(line, baseUrl).href,
        bandwidth: Number(pendingAttrs.BANDWIDTH) || 0,
        resolution: pendingAttrs.RESOLUTION || "",
        codecs: pendingAttrs.CODECS || "",
        name: pendingAttrs.NAME || ""
      });
      pendingAttrs = null;
    }
  }
  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    if (sessionKeys.length) {
      for (const variant of variants) {
        variant.keys = sessionKeys;
      }
    }
    return { kind: "master", variants };
  }
  if (segmentCount) {
    return { kind: "media", segmentCount, live, keyMethod };
  }
  return null;
}

/**
 * Per-resource DRM verdict from parsed manifest evidence. AES-128 and
 * keyless playlists are CLEAR (external players handle them); SAMPLE-AES,
 * any DASH `<ContentProtection>` and clearkey-needed say PROTECTED - the
 * ignore-by-design class. "unknown" is the not-evidence answer: a 404
 * page must not mint a usable manifest verdict.
 */
export function manifestVerdict(kind, parsed, text) {
  if (kind === "dash") {
    // DASH verdict rides the XML vocabulary: not MPD-shaped text is not
    // evidence (a 404 page must not mint a usable entry).
    if (!/<(?:[\w-]+:)?MPD[\s>]/i.test(String(text || ""))) {
      return "unknown";
    }
    return /<ContentProtection[\s>]/i.test(String(text || "")) ? "protected" : "clear";
  }
  if (!parsed || (parsed.kind !== "master" && parsed.kind !== "media")) {
    return "unknown";
  }
  if (parsed.kind === "media") {
    return parsed.keyMethod === "SAMPLE-AES" ? "protected" : "clear";
  }
  const sampleAes = parsed.variants.some((v) => (v.keys ?? []).includes("SAMPLE-AES"));
  return sampleAes ? "protected" : "clear";
}
