/* The Reforge witness vocabulary - the plane's pure classification tables.
 *
 * Ported from the recovered reforge branch (`reforge:src/shell/reforge/
 * tables.js`, the engine's source tables) with the branch's own vocabulary
 * - the names ARE the machine spelling (classifyUrl/classifyContentType/
 * fileFormat, family manifest/file/segment, kind hls/dash/file/segment).
 * Import-free: the node-realm flaw smoke imports this module alone and the
 * background bundle rides only this import edge from the ledger.
 *
 * Located in the background plane (the rebrand, 2026-11): this file is the
 * SOURCE of the census's one-classification-owner law - the ledger consumes
 * it, no second classification site exists, and a fork of the shape tables
 * would drift the family identity the claim composition (next batches)
 * depends on.
 *
 * The HLS/DASH body parser and the per-resource DRM verdict stay on the
 * recovered branch's shape for the claim-composition batch (they need
 * response TEXT, which the witness floor never reads - the witness is
 * URL/headers facts only).
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
