import { NET_HINT, isAdHost } from "../kernel/contract.js";
import {
  classifyUrl,
  classifyContentType,
  fileFormat,
  parseHlsPlaylist,
  manifestVerdict,
  BODY_READ_CAP
} from "./tables.js";

/**
 * The Reforge witness floor + claim composition: background webRequest
 * observation with the frame topology Firefox attaches to every request
 * (frameId, tabId) and NO DOM access anywhere - the background never
 * touches a document.
 *
 * The rebrand (2026-11): this ledger is the Reforge plane's witness floor.
 * What it holds: a URL/headers classification of every media/xhr request
 * through the plane's own vocabulary (tables.js - the manifest/file/
 * segment families), family records keyed per (tab, frame) in reforge's
 * roster identity (origin + pathname, so CDN token rotations merge into
 * one family), and the frame-targeted hint that carries the classified
 * shape. The hint only accelerates: the content kernel's DOM-truth
 * detection stays the deciding pipeline. Segments are classified but not
 * rostered (the recovered branch's ignore-by-design class: per-segment
 * rostering floods the records on an ABR page).
 *
 * THE SKIP FLOOR (user direction 2026-11): the plane's own frame
 * classification over contract.js's isAdHost vocabulary - a frame whose
 * own document request named an ad host is ad-identified, and its whole
 * network life refuses this plane (no record, no ingest, no hint, no
 * claim, no filter). Resource requests never mark (a legitimate page
 * loading GTM in its top keeps its video witness), the frame's own
 * main/sub_frame navigation is the identity witness, and the mark rides
 * native - ads are observed-and-ignored, never blocked.
 *
 * THE INGEST ARM (batch 2, probe-decided; batch 3 collapsed it into the
 * page's own traffic): a manifest family's FIRST sighting rides a
 * pass-through `filterResponseData` capture - the page reads its native
 * bytes (the Network row stays real), the roster stamps the verdict from
 * the real body, and NO second GET exists: probe C's red verdict killed
 * the observe-only body read WITHOUT blocking, and batch 3's
 * `webRequestBlocking` grant (probe B proved the lever) opened the filter
 * seam the collision always wanted. The batch-2 fetch ingest remains as
 * the FAILURE fallback only (the filter failed or died un-witnessed):
 * single-flight per roster identity bundles token-rotation bursts, an
 * attempt is done-once per record lifetime, failures settle verdict
 * "unknown" - never a retry loop.
 *
 * THE EXECUTE ARM (batch 3): the SAME onBeforeRequest listener grew the
 * claim question for manifest families. A claim source (setClaimSource;
 * batch 4's EnhanceSession ships it) is asked
 * (method, url, record) and answers:
 *   - `{ rewrite: { text } }` - the body filter serves OUR text:
 *     the page reads the pinned bytes while status, headers and
 *     content-type ride the real response (probe B's measured serve
 *     semantics - the Network row exists and the real request completes);
 *   - `{ reload: url }` - one-shot redirectUrl to the roster's freshest
 *     capture: the page's request redirects transparently to the fresh
 *     spelling (its token-rotation sibling), the fresh bytes arrive under
 *     the target's own response facts, and the request row stays real;
 *   - null - the native ride (first-seen manifests absorb instead of
 *     claiming; a stale-verdict record rides native).
 * The source belts its own throw (the branch's decideRequest contract); a
 * null source (the shipped default until batch 4) means nothing about any
 * page changes silently.
 *
 * THE DRM LATCH (the records' sole veto, batch 2): a realm whose document
 * fed an EME-protected stream sends one DRM_LATCH message (the passive
 * `encrypted` listener in entry.js - no wrap). latchDrm flips that
 * (tab, frame)'s records: unknown-verdict manifests go presumed-protected,
 * body-evidence verdicts outrank the page context (a genuinely clear
 * AES-128 manifest survives the latch), and NEW records for the latched
 * frame are refused outright. Claims execute only against these records,
 * so the latch is the claim plane's veto by construction.
 *
 * No clock, no timers: the zero-timer pipeline holds here too. The roster
 * is event-invalidated - a main_frame request clears the tab's records (a
 * new document maps the whole topology), a sub_frame request clears that
 * frame's own records (an iframe navigation re-arms its families), and
 * tabs.onRemoved drops the tab outright. Between navigations a repeated
 * hint for the same (tab, frame) is suppressed by the seen-set, so a long
 * stream's media requests never re-wake the kernel for nothing.
 */

/** The roster floor's per-frame bound (see the bounded note at
 *  #recordFacts): media families are human-scale per document; the bound
 *  exists so a hostile or pathological page cannot grow the background
 *  page's memory, and eviction is oldest-first (the newest-first order
 *  makes that the map's tail). */
const FAMILY_BOUND = 64;

/** Pull the captured chunks into one BODY_READ_CAP-bounded buffer (the
 *  absorb state's chunks are ArrayBuffers; the roster's decoder needs
 *  one contiguous view). One scratch pass per absorbed manifest. */
function mergeChunks(chunks, total) {
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** The verdict vocabulary riding records: "clear" (AES-128 / keyless /
 *  decryptable by an external player), "protected" (SAMPLE-AES /
 *  ContentProtection / clearkey-needed - the ignore-by-design class),
 *  "unknown" (no body evidence), plus the latch-stamped "presumed" state
 *  unknowns carry once a frame latches. */
export class NetHintLedger {
  /** tabId -> Set(frameId): the (tab, frame) pairs this session's media
   *  traffic already hinted. Smallest state that can do the job. */
  #hinted = new Map();
  /** tabId -> frameId -> (familyKey -> record): the roster's witness
   *  floor. One record per manifest/file family, newest-first order, the
   *  whole subtree cleared at the navigation boundaries above. */
  #families = new Map();
  /** familyKey -> in-flight ingest promise: the single-flight belt for
   *  the manifest ingest. Cleared with the record when a family's body
   *  attempt settles (success or failure - a failed body is verdict
   *  "unknown", NOT a re-fetch loop; the next navigation re-arms). */
  #ingesting = new Map();

  /** tabId -> Set(frameId): frames whose document latched DRM (the
   *  DRM_LATCH message). Cleared at the same navigation boundaries and
   *  tab drop as the records. */
  #latched = new Map();
  /** tabId -> Set(frameId): frames whose witness identity is ad-hosted
   *  (the Reforge skip floor, per contract.js's isAdHost vocabulary): the
   *  frame's own document request named an ad host, and every later leg of
   *  that frame's network life refuses the witness plane - no family
   *  record, no roster ingest fetch, no media hint, no claim answer, no
   *  body filter. The frame's own navigation request is its network
   *  identity (main_frame/sub_frame only mark - a legitimate page loading
   *  gtm.js in its top frame must not refuse its own video). Cleared at
   *  the same navigation boundaries as the other frame state. */
  #skipped = new Map();
  /** requestId -> filter state: the manifest body filter's per-request
   *  bookkeeping (absorb mode captures the body for the roster; serve
   *  mode holds a claim's rewrite). Entries die at the filter's own
   *  stop/error; a race-clear at main_frame is harmless (the stamp on a
   *  detached record object writes an unlinked object). */
  #filters = new Map();
  /** The claim source (batch 4's EnhanceSession installs): (method, url,
   *  record) -> { rewrite: { text } } | { reload: url } | null. Belts
   *  its own throw per the decideRequest contract. */
  #claimSource = null;

  /** The execute arm's claim hook. Batch 4's EnhanceSession is the sole
   *  intended installer; the shipped default (null) rides every request
   *  native. */
  setClaimSource(source) {
    this.#claimSource = typeof source === "function" ? source : null;
  }

  install() {
    // Invalidation rides the two request types that MEAN navigation, so
    // hint freshness is event-driven all the way down; the blocking
    // extra (reforge batch 3) is what lets the SAME listener answer the
    // manifest claim question synchronously.
    browser.webRequest.onBeforeRequest.addListener((details) => {
      if (details.tabId === -1) {
        // Non-tab traffic (this page's own requests, devtools) owns no
        // content script to hint.
        return;
      }
      if (details.type === "main_frame") {
        this.#hinted.delete(details.tabId);
        this.#families.delete(details.tabId);
        this.#latched.delete(details.tabId);
        this.#skipped.delete(details.tabId);
      } else if (details.type === "sub_frame") {
        this.#hinted.get(details.tabId)?.delete(details.frameId);
        this.#families.get(details.tabId)?.delete(details.frameId);
        this.#latched.get(details.tabId)?.delete(details.frameId);
        this.#skipped.get(details.tabId)?.delete(details.frameId);
      }
      // The skip floor's mark (the Reforge plane's frame classification,
      // user direction 2026-11): a frame whose OWN document request named
      // an ad host rides the skip vocabulary - resource requests
      // (script/img/media) do not mark, so a legitimate page loading GTM
      // in its top frame keeps its video witness. Marking runs only on
      // the two document types; the mark then refuses everything the
      // witness plane does with that frame (below), while the request
      // itself stays native - ads are observed-and-ignored, never
      // blocked (the reforge premise: non-DRM media improves, other
      // traffic holds byte-untouched).
      if (details.type === "main_frame" || details.type === "sub_frame") {
        const navUrl = URL.parse(String(details.url ?? ""));
        if (navUrl && isAdHost(navUrl.hostname)) {
          let skippedFrames = this.#skipped.get(details.tabId);
          if (!skippedFrames) {
            skippedFrames = new Set();
            this.#skipped.set(details.tabId, skippedFrames);
          }
          skippedFrames.add(details.frameId);
          return {};
        }
      }
      return this.#claimManifest(details);
    }, { urls: ["<all_urls>"] }, ["blocking"]);

    // media / xhr: the <video> element's own src loads + the MSE/xhr
    // streaming routes both land in this set; a document/html content-type
    // (the page itself, sub_frame documents) is not media traffic.
    browser.webRequest.onHeadersReceived.addListener(
      (details) => this.#onHeaders(details),
      { urls: ["<all_urls>"], types: ["media", "xhr"] },
      ["responseHeaders"]
    );

    browser.tabs.onRemoved.addListener((tabId) => {
      this.#hinted.delete(tabId);
      this.#families.delete(tabId);
      this.#latched.delete(tabId);
      this.#skipped.delete(tabId);
      // In-flight ingests ride #ingestKey = `tabId|familyKey` and die with
      // the tab - a settled fetch must never stamp resurrected state.
      for (const key of this.#ingesting.keys()) {
        if (key.startsWith(`${tabId}|`)) {
          this.#ingesting.delete(key);
        }
      }
    });
  }

  /** The claim question at the manifest family's request edge (execute
   *  arm, reforge batch 3). Non-manifest families and non-tab traffic
   *  ride native. First-seen manifests (no record, or a verdict-less
   *  one whose fetch ingest never landed) absorb through the body
   *  filter instead of claiming - the page's own request supplies the
   *  body. An ingested manifest met by an armed claim source answers
   *  per the claim contract above; the source's own belt stands (its
   *  throw is its contract, the native ride degrades nothing here). */
  #claimManifest(details) {
    if (details.type !== "media" && details.type !== "xhr") {
      return {};
    }
    if (typeof browser.webRequest.filterResponseData !== "function") {
      // The lever is manifest-floor fact (probe B with the blocking
      // grant, probe C without); a floor that loses it rides native.
      return {};
    }
    if (this.#skipped.get(details.tabId)?.has(details.frameId)) {
      // The skip floor: an ad-identified frame's media traffic refuses
      // the witness plane wholesale - no absorb filter, no roster
      // ingest fetch, no claim answer. (A video ad stream is exactly
      // the traffic the product leaves byte-untouched.)
      return {};
    }
    const byUrl = classifyUrl(details.url);
    if (!byUrl || byUrl.family !== "manifest") {
      return {};
    }
    const url = URL.parse(String(details.url ?? ""));
    const familyKey = url ? url.origin + url.pathname : String(details.url ?? "");
    const tabId = details.tabId;
    const record = this.#families.get(tabId)?.get(details.frameId)?.get(familyKey) ?? null;
    const armed = this.#claimSource !== null;
    if (armed && record && "verdict" in record && record.verdict !== "unknown") {
      const claim = this.#claimSource(details.method ?? "GET", details.url, record);
      if (claim) {
        if (typeof claim.reload === "string" && claim.reload) {
          return { redirectUrl: claim.reload };
        }
        if (claim.rewrite && typeof claim.rewrite.text === "string") {
          this.#interpose(details, {
            mode: "serve",
            familyKey,
            text: claim.rewrite.text
          });
          return {};
        }
      }
      return {};
    }
    if (!this.#filters.has(details.requestId)) {
      // First-seen (or a body-less retry) manifest: absorb. The page's
      // own request is the transport - the filter captures, echoes
      // native bytes through unchanged, and the roster stamps the
      // verdict from the real body.
      this.#interpose(details, { mode: "absorb", familyKey });
    }
    return {};
  }

  /** The one body seam (the census's filterRewrites row): pass-through
   *  capture for absorb mode (the page reads its native bytes - the
   *  roster witnesses without a second GET), byte substitution for serve
   *  mode (probe B's measured semantics: OUR bytes, the real response's
   *  status/headers/content-type). The BODY_READ_CAP bounds capture
   *  memory; echoing never caps (the page gets everything it asked
   *  for). */
  #interpose(details, state) {
    state.tabId = details.tabId;
    state.record = null;
    state.chunks = [];
    state.size = 0;
    this.#filters.set(details.requestId, state);
    try {
      const filter = browser.webRequest.filterResponseData(details.requestId);
      filter.ondata = (event) => {
        if (state.mode === "absorb") {
          filter.write(event.data);
          if (state.size < BODY_READ_CAP) {
            state.chunks.push(event.data);
            state.size += event.data.byteLength;
          }
        }
        // serve mode writes at onstop only: the native stream is
        // swallowed whole and OUR bytes are the single body the page
        // reads.
      };
      filter.onstop = () => {
        try {
          if (state.mode === "serve" && state.text) {
            filter.write(new TextEncoder().encode(state.text));
          }
          filter.close();
        }
        // The close-time race (the request already ended) is the
        // release-tail class: the page's response finished; nothing
        // the roster can recover is behind the throw.
        catch {}
        this.#filterSettled(details.requestId, state, false);
      };
      filter.onerror = () => {
        try {
          filter.disconnect();
        }
        // Same release-tail class - the filter already reported the
        // failure; disconnecting is bookkeeping.
        catch {}
        this.#filterSettled(details.requestId, state, true);
      };
    } catch {
      // The seam's availability guard (probe C measured the API's
      // existence as the permission's product) - a throw here rides
      // native: the roster keeps its record and the fetch ingest path
      // remains the fallback.
      this.#filters.delete(details.requestId);
    }
  }

  /** The filter's settled edge: a successful absorb stamps the roster
   *  from the real body; a failed one re-arms the result-fallback fetch
   *  ingest. Serve mode never stamps (the roster record is the claim's
   *  own source). */
  #filterSettled(requestId, state, failed) {
    this.#filters.delete(requestId);
    if (state.mode !== "absorb") {
      return;
    }
    const record = state.record;
    if (!record) {
      // The headers stage never paired this request with a record (an
      // aborted request, a non-media type): nothing to stamp.
      return;
    }
    if (failed) {
      if (!("verdict" in record)) {
        this.#ingestManifest(state.tabId, record);
      }
      return;
    }
    if (state.size > 0 && !("verdict" in record)) {
      const body = new TextDecoder().decode(mergeChunks(state.chunks, state.size));
      this.#stampManifest(record, body);
    }
  }

  /** The manifest stamp: parse + verdict + facts, the ONE body-vocabulary
   *  reader both ingest arms share. Masters retain body + the parsed
   *  variant list (bandwidth-sorted) - the claim policy's abrPin lever
   *  serves the retention through the filter (batch 4); media bodies are
   *  never retained (live churn + no lever's material). */
  #stampManifest(record, body) {
    const parsed = record.kind === "dash"
      ? null
      : parseHlsPlaylist(body, record.url);
    record.verdict = manifestVerdict(record.kind, parsed, body);
    if (record.kind === "hls" && parsed?.kind === "master") {
      record.body = body;
      record.variants = parsed.variants;
    } else if (record.kind === "hls" && parsed?.kind === "media") {
      record.segmentCount = parsed.segmentCount;
      record.live = parsed.live;
      record.keyMethod = parsed.keyMethod;
    }
  }

  #onHeaders(details) {
    if (details.tabId === -1) {
      return;
    }
    if (this.#skipped.get(details.tabId)?.has(details.frameId)) {
      // The skip floor: an ad-identified frame refuses record, roster
      // ingest and hint alike (the hint would be a dead letter into the
      // skipped frame's realm anyway - the content plane's own gate
      // never booted its kernel there).
      return;
    }
    const contentType = (details.responseHeaders ?? []).find(
      (header) => header.name.toLowerCase() === "content-type"
    )?.value;
    // The witness classification: the URL tables speak FIRST (an
    // application/octet-stream-mistyped m3u8 is still a manifest), the
    // content-type witness fills what the URL does not spell. Segments
    // classify for no record and no hint (the ignore-by-design class).
    const byUrl = classifyUrl(details.url);
    const byType = classifyContentType(contentType);
    const family = byUrl?.family ?? byType?.family ?? null;
    const kind = byUrl?.kind ?? byType?.kind ?? null;
    if (family === "segment") {
      return;
    }
    if (family) {
      this.#recordFacts(details, contentType, family, kind);
    }
    // The header prefix is the whole media judgment: video/* and audio/*
    // payloads are media-shaped traffic by the server's own claim - and
    // the URL tables' manifest/file families are media-shaped by the
    // request's spelling. No inference beyond that - a wishlist of mime
    // patterns is where the false-hint rate would go unbounded.
    const mediaType = Boolean(contentType) && /^(video|audio)\//.test(contentType);
    if (!mediaType && !family) {
      return;
    }
    let frames = this.#hinted.get(details.tabId);
    if (!frames) {
      frames = new Set();
      this.#hinted.set(details.tabId, frames);
    }
    if (frames.has(details.frameId)) {
      return;
    }
    frames.add(details.frameId);
    // Frame-targeted: the request's frameId is where the element (or the
    // MSE consumer) lives, so that frame's kernel instance is the one that
    // gains from an earlier seed walk. A missing proxy (the frame never
    // armed its scripts - about:blank descendants, an unload race) rejects
    // harmlessly here and never matters to detection: the seed walk + media
    // tap were already the whole story.
    browser.tabs.sendMessage(
      details.tabId,
      {
        type: NET_HINT,
        url: details.url,
        // The classified shape rides the hint for the consumers that want
        // it (roster surfaces land in later batches); today's content-side
        // readers consume url alone, so the fields are additive.
        shape: family
          ? { family, kind, format: fileFormat(details.url), method: details.method ?? null }
          : null
      },
      { frameId: details.frameId }
    ).catch(() => {});
  }

  /** Create-or-refresh the (tab, frame) family record under reforge's
   *  roster identity (origin + pathname - token rotations merge). Facts
   *  merge into what an earlier witness wrote (contentType/method keep
   *  their first claim; the URL record refreshes to the newest spelling,
   *  whose query is the freshest token set) and every refresh moves the
   *  record newest-first (delete + set, the recovered branch's own order).
   *  The bound: a head eviction at FAMILY_BOUND keeps the background
   *  page's state bounded without per-entry bookkeeping. */
  #recordFacts(details, contentType, family, kind) {
    const url = URL.parse(String(details.url ?? ""));
    if (!url) {
      return;
    }
    const key = url.origin + url.pathname;
    let frame = this.#families.get(details.tabId);
    if (!frame) {
      frame = new Map();
      this.#families.set(details.tabId, frame);
    }
    let records = frame.get(details.frameId);
    if (!records) {
      records = new Map();
      frame.set(details.frameId, records);
    }
    const existing = records.get(key);
    if (existing) {
      existing.url = url.href;
      records.delete(key);
      records.set(key, existing);
      const pending = this.#filters.get(details.requestId);
      if (pending) {
        pending.record = existing;
      } else if (family === "manifest" && !("verdict" in existing)) {
        // A verdict-less refresh (the first-seen filter died unseen, an
        // unknown-verdict fetch ingest never fired): the fallback fetch
        // re-arms at the next sighting.
        this.#ingestManifest(details.tabId, existing);
      }
      return;
    }
    // The DRM latch vetoes NEW records for a latched frame outright: the
    // frame's document is mid-EME-handshake, so its manifests are presumed
    // CDM-fed until it proves otherwise by its own content - which the
    // latch's existing-record flip handles per-record, not here.
    if (this.#latched.get(details.tabId)?.has(details.frameId)) {
      return;
    }
    const record = { url: url.href, family, kind, contentType: contentType ?? null, method: details.method ?? null };
    records.set(key, record);
    if (records.size > FAMILY_BOUND) {
      const oldest = records.keys().next().value;
      records.delete(oldest);
    }
    if (family === "manifest") {
      const pending = this.#filters.get(details.requestId);
      if (pending) {
        // The first-seen absorb is already capturing this request's
        // body - the page's own traffic is the transport, and a second
        // GET would be the double-fetch the absorb exists to prevent.
        pending.record = record;
        return;
      }
      this.#ingestManifest(details.tabId, record);
    }
  }

  /** The manifest ingest FALLBACK (execute arm deployed): the fetch leg
   *  runs only when the page's own body never landed through the filter
   *  (an un-witnessed death, a rare non-GET shape). Single-flight per roster
   *  identity - the key is origin + pathname (#recordFacts's identity,
   *  not the full URL), so the ABR page's token-rotated re-request of
   *  the same manifest lands in the one in-flight promise instead of
   *  racing a second fetch. The attempt is done-once per record
   *  lifetime: every failure settles verdict "unknown" (never a retry
   *  loop) and navigation clears the records wholesale. */
  #ingestManifest(tabId, record) {
    const url = URL.parse(record.url);
    const familyKey = url ? url.origin + url.pathname : record.url;
    const ingestKey = `${tabId}|${familyKey}`;
    if (this.#ingesting.has(ingestKey)) {
      return;
    }
    const fileUrl = record.url;
    const attempt = (async () => {
      try {
        const response = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
        const text = await response.text();
        const body = text.slice(0, BODY_READ_CAP);
        if (!response.ok || !body) {
          record.verdict = "unknown";
          return;
        }
        this.#stampManifest(record, body);
      } catch {
        // The bounded-failure contract (relay.js's own shape): every
        // failure is a result state, never a retry loop - verdict
        // "unknown", the next navigation re-arms.
        record.verdict = "unknown";
      } finally {
        this.#ingesting.delete(ingestKey);
      }
    })();
    this.#ingesting.set(ingestKey, attempt);
    attempt.catch(() => {});
  }

  /** The DRM latch receiver: one message per realm whose document fed a
   *  CDM-protected stream. Flips the frame's ledger - unknown-verdict
   *  manifests go presumed-protected - and joins the frame to #latched
   *  so new records are refused until its next navigation. */
  latchDrm(tabId, frameId) {
    if (!Number.isInteger(tabId) || tabId === -1 || !Number.isInteger(frameId)) {
      return;
    }
    let frames = this.#latched.get(tabId);
    if (!frames) {
      frames = new Set();
      this.#latched.set(tabId, frames);
    }
    frames.add(frameId);
    const records = this.#families.get(tabId)?.get(frameId);
    if (!records) {
      return;
    }
    for (const record of records.values()) {
      // Body evidence (an ingested verdict) outranks the page context -
      // only unknowns join the presumption.
      if (record.family === "manifest" && (!("verdict" in record) || record.verdict === "unknown")) {
        record.verdict = "presumed-protected";
      }
    }
  }
}
