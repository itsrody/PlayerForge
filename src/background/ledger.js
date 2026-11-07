import { NET_HINT } from "../kernel/contract.js";
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
 * THE INGEST ARM (batch 2, probe-decided): a manifest record fetches its
 * own body ONCE - the background page's fetch rides the <all_urls> host
 * permission (the relay's grant applied to the manifest family; a
 * content-side fetch would inherit the page's CORS, the same wall the
 * subtitle relay exists to bypass), caps at BODY_READ_CAP, and feeds
 * tables.js's parser + verdict. Probe C's red verdict settled the route:
 * `filterResponseData` does NOT exist without `webRequestBlocking`, so
 * there is no observe-only body read alongside these headers - re-fetching
 * what the witness classified is the whole ingest story. Single-flight per
 * family key (Map<key, promise>) bundles the ABR token-rotation burst (a
 * master request races its token-refreshed re-request) into one fetch, and
 * an attempted latch keeps the record from re-fetching on every segment
 * witness of the same manifest for the document's lifetime; navigation
 * clears the records and re-arms the attempt naturally.
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

  install() {
    // Invalidation rides the two request types that MEAN navigation, so
    // hint freshness is event-driven all the way down.
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
      } else if (details.type === "sub_frame") {
        this.#hinted.get(details.tabId)?.delete(details.frameId);
        this.#families.get(details.tabId)?.delete(details.frameId);
        this.#latched.get(details.tabId)?.delete(details.frameId);
      }
    }, { urls: ["<all_urls>"] });

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
      // In-flight ingests ride #ingestKey = `tabId|familyKey` and die with
      // the tab - a settled fetch must never stamp resurrected state.
      for (const key of this.#ingesting.keys()) {
        if (key.startsWith(`${tabId}|`)) {
          this.#ingesting.delete(key);
        }
      }
    });
  }

  #onHeaders(details) {
    if (details.tabId === -1) {
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
      this.#ingestManifest(details.tabId, record);
    }
  }

  /** The manifest ingest arm: fetch the record's own body once, parse it
   *  through tables.js, and stamp the verdict + parse facts on the
   *  record. Single-flight per roster identity - the key is
   *  origin + pathname (#recordFacts's identity, not the full URL), so
   *  the ABR page's token-rotated re-request of the same manifest lands
   *  in the one in-flight promise instead of racing a second fetch. The
   *  attempt is done-once per record lifetime: every failure settles
   *  verdict "unknown" (never a retry loop) and navigation clears the
   *  records wholesale, which re-arms the attempt naturally. */
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
        const parsed = record.kind === "dash"
          ? null
          : parseHlsPlaylist(body, fileUrl);
        record.verdict = manifestVerdict(record.kind, parsed, body);
        if (record.kind === "hls" && parsed?.kind === "master") {
          record.variantCount = parsed.variants.length;
          record.topVariant = parsed.variants[0]?.uri ?? null;
        } else if (record.kind === "hls" && parsed?.kind === "media") {
          record.segmentCount = parsed.segmentCount;
          record.live = parsed.live;
          record.keyMethod = parsed.keyMethod;
        }
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
