/**
 * Media URL taxonomy - the single source for what a media URL looks like.
 *
 * Before this module the shapes were rediscovered six times: the progressive
 * `.mp4`/get_video/stream=1/tokenized-CDN shape lived in stream-transport.js,
 * the manifest `.m3u8`/`.mpd` shape in bootstrap.js, the manifest suffix in
 * rewrite.js and segment-flow.js, and the media-name superset in
 * media-timing.js. Each copy drifted independently. Proxy, kernel, and the
 * timing surface all import from here.
 *
 * Levels:
 *  - isProgressiveStreamUrl - the byte-seam routing shape: `.mp4` paths and
 *    tokenized StreamTape-style endpoints the proxy can take over wholesale;
 *  - isManifestUrl          - the manifest look the observe/interpose seam
 *    recognizes (the segment-level surface, engaged by its own gate);
 *  - manifestKindFromUrl    - the exact manifest suffix ("m3u8" | "mpd" | null);
 *  - isSegmentLikeUrl       - the segment-fetch shape (.ts/.m4s/.aac/.m4a...):
 *    the byte surface Mode-A routing carries. Deliberately NOT folded into
 *    isMediaUrlName because .ts ALSO names TypeScript modules - the routing
 *    seam guards every match by the engaged-host set (a routed manifest's
 *    CDN hosts only), so the predicate is the shape, never the decision;
 *  - hasMediaExtension      - any media container extension, query/hash honored;
 *  - isMediaUrlName         - the observation superset: everything the element
 *    net feed classifies as media. A superset of the routing levels above by
 *    construction: any routable URL also counts as a media sighting, but the
 *    reverse is not required.
 *
 * Deterministic: pure regex predicates over strings, no DOM or network.
 */
const PROGRESSIVE_STREAM_URL_RE = /\.mp4(?:[?#]|$)|get_video|[?&]stream=1\b|(?:tapecontent|radosgw)[^#?]*\.mp4/i;
const MANIFEST_URL_RE = /\.(?:m3u8|mpd)(?:[?#&]|$)/i;
const MANIFEST_EXTENSION_RE = /\.(m3u8|mpd)$/i;
const MEDIA_EXTENSION_RE = /\.(?:mp4|webm|ogv|ogg|m4v|mov)(?:[?#]|$)/i;
const SEGMENT_LIKE_URL_RE = /\.(?:ts|mts|m2ts|m4s|aac|m4a|eac3)(?:[?#]|$)/i;

/** True for a URL that could be a progressive MP4 stream: `.mp4` paths,
 *  `get_video` handlers, `stream=1` markers, or presigned media-CDN paths
 *  (tapecontent/radosgw) that carry a `.mp4` deep inside an opaque tokenized
 *  path. Tokens are opaque - routing keeps the full URL, token intact. */
export function isProgressiveStreamUrl(url) {
  return PROGRESSIVE_STREAM_URL_RE.test(String(url ?? ""));
}

/** True for a manifest-looking URL (`.m3u8`/`.mpd`, query/fragment tails
 *  included) - the shape the observe and interpose seams recognize. */
export function isManifestUrl(url) {
  return MANIFEST_URL_RE.test(String(url ?? ""));
}

/** The exact manifest kind ("m3u8" | "mpd" | null) from the URL pathname,
 *  honoring query/hash. */
export function manifestKindFromUrl(url) {
  const path = String(url ?? "").split(/[?#]/, 1)[0];
  const m = MANIFEST_EXTENSION_RE.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/** True for a URL naming a media container file (`.mp4`/`.webm`/`.ogv`/
 *  `.ogg`/`.m4v`/`.mov`), query/fragment tails included. */
export function hasMediaExtension(url) {
  return MEDIA_EXTENSION_RE.test(String(url ?? ""));
}

/** True for a URL whose tail names a media segment (`.ts`/`.mts`/`.m2ts`/
 *  `.m4s`/`.aac`/`.m4a`/`.eac3`), query/fragment tails included. This is the
 *  byte shape Mode-A routing carries. Shape alone is never a decision: `.ts`
 *  also names TypeScript modules, so the routing seam only treats a match as a
 *  segment when its host is inside a routed manifest's engaged-host set. */
export function isSegmentLikeUrl(url) {
  return SEGMENT_LIKE_URL_RE.test(String(url ?? ""));
}

/** True for any media-shaped resource name: the extension superset, a
 *  manifest URL, or a progressive-stream URL. */
export function isMediaUrlName(url) {
  const source = String(url ?? "");
  return hasMediaExtension(source) || isManifestUrl(source) || isProgressiveStreamUrl(source);
}