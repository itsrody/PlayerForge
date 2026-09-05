/**
 * MSE data-plane orchestration (§Phase 6, fMP4-gated).
 *
 * This is the join the request-boundary seams cannot make: a §7.4 claim is
 * decided at the manifest fetch (no video in scope there), and a MediaSource
 * can only attach to the <video> element itself. `attachTakeover` is the
 * element-side rendezvous: given a claim (engage outcome + manifest text) and
 * the video it feeds, it builds the whole Plane — `MediaSink` on the element,
 * one `SegmentManager` per lane driven by the fragment plan from
 * `manifest-segments.js`, an `Aes128Decrypter` for HLS AES-128 lanes, and a
 * `ClearKeyEme` for DASH-IF ClearKey streams — then detaches the same way,
 * handing the element back toward native.
 *
 * Hard platform boundary: Firefox's MSE has no MPEG-TS column, so a raw `.ts`
 * lane is NOT take-over-able here — the page player (hls.js/dash.js) keeps
 * those bytes via Mode-A routing, which is exactly why the request-boundary
 * pipe exists. A take-over therefore engages only streams composed of
 * fragmented-MP4 lanes (HLS `#EXT-X-MAP` inits / DASH `SegmentTemplate`/
 * `SegmentList`/`SegmentBase` inits), and only when EVERY lane qualifies —
 * a mixed audio+video plan where one lane is TS declines as a whole, since
 * feeding one lane while the page owns the other desyncs playback. No
 * transmuxing, no guesswork: the lane either proves fMP4 via an init segment
 * or the take-over refuses and the page stays in charge, untouched.
 *
 * Every refusal is { taken: false, reason } with nothing written to the
 * element — Mode-A byte routing keeps running under the page player. Engage
 * is gated by the caller (the element seam checks the `features.mse` toggle),
 * re-verified against the ablation guard at attach time (a page player that
 * committed bytes in the gap since t2 wins), and surrendered the instant the
 * page grabs the element (`sourceclose`), through the flow's downgrade from
 * `ManifestFlow`, or on explicit `detach()`.
 *
 * Deterministic: MediaSource/object-URL creation, provider bytes, decrypt,
 * EME, and the video element are all injectable seams, so the whole plane —
 * attach, init-before-media, in-order append, teardown — runs headless.
 */
import { logger } from "../../shared/logger.js";
import { SegmentError, SegmentManager } from "./segment-manager.js";
import { MSEFactory } from "./mse.js";
import { Aes128Decrypter } from "./decrypt-aes128.js";
import { ClearKeyEme } from "./eme-clearkey.js";
import { parseManifest } from "./manifest-segments.js";

/** Per-lane fetch concurrency for the take-over's SegmentManagers. */
const LANE_CONCURRENCY = 2;

/** A lane counts as fragmented MP4 when it carries an init segment (HLS
 *  `#EXT-X-MAP` → lane.maps, DASH `<Initialization>`/`initialization=` →
 *  lane.init). Raw TS lanes have neither and are left to the page player. */
function laneHasInit(lane) {
  return (
    (Array.isArray(lane.maps) && lane.maps.length > 0) ||
    (lane.init && lane.init.uri != null)
  );
}

/** HLS AES-128 proves through any encrypted segment on the lane (the parser
 *  tags each segment with the `#EXT-X-KEY` active at it). DASH CENC/ClearKey
 *  flows ride EME instead and never take the in-band decrypt path. */
function laneIsAes128(lane) {
  return Array.isArray(lane.segments) && lane.segments.some((s) => s.encrypted === true);
}

/** The mime type one lane appends under. DASH lanes carry their own
 *  `mimeType`/`codecs`; an HLS fMP4 lane (proofed by `#EXT-X-MAP`) defaults
 *  to `video/mp4`, codecs attached when the plan names them. */
export function laneMime(lane) {
  const base = lane.mimeType ?? "video/mp4";
  return lane.codecs && lane.codecs !== "" ? `${base}; codecs="${lane.codecs}"` : base;
}

/** Fetch one byte payload through the provider with the status honored:
 *  2xx → the drained body; anything else → a retryable SegmentError carrying
 *  the status (the manager's retry seam decides healing). */
async function providerBytes(provider, uri, byteRange, signal) {
  const { resp, via } = await provider.fetch(uri, { signal, byteRange });
  const status = Number(resp?.status ?? 0);
  if (status !== 0 && (status < 200 || status >= 300)) {
    throw new SegmentError(`takeover fetch ${status} for ${uri}`, { status });
  }
  const body = resp?.body;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body ?? 0);
  logger.log("proxy", "takeover", "fetched", uri, { via, status, bytes: bytes.byteLength });
  return bytes;
}

function decline(reason) {
  logger.log("proxy", "takeover", "declined", reason);
  return { taken: false, reason };
}

/** Return the element to a no-src state after we set its src to our own
 *  object URL (handed back on teardown / arm failure / surrender). Guarded:
 *  if the page already moved the element to a NEW src, it is never clobbered. */
function handBack(video, objectURL) {
  if (!objectURL) {
    return;
  }
  if (video?.src === objectURL || video?.currentSrc === objectURL) {
    if (typeof video.removeAttribute === "function") {
      video.removeAttribute("src");
    } else {
      video.src = "";
    }
  }
}

/**
 * Build the MSE data plane for one engaged manifest. Returns
 * `{ taken: true, reason, video, claim, sink, managers, eme, detach() }` on
 * success, or `{ taken: false, reason }` on any refusal — nothing on the
 * element is touched in the refusal path.
 *
 * Ablation is re-checked HERE (the instant before attach) even though the
 * flow checked it at t2: the page player may have committed bytes or a
 * MediaSource in the gap, and the video wins over the claim.
 *
 * @param {object} env
 * @param {object}   env.video           the <video>/fake the stream feeds.
 * @param {object}   env.claim           { manifestUrl, kind, text, klass,
 *                                        laurl? } — the engaged claim.
 * @param {object}   env.provider        ProxyProvider transport for init +
 *                                       segments ({ fetch(uri, opts) }).
 * @param {object}   [env.mse]           MSEFactory seams ({ mediaSource }).
 * @param {object}   [env.decrypter]     Aes128Decrypter (or subtle/keyLoader
 *                                       seams to build one lazily).
 * @param {object}   [env.eme]           ClearKeyEme (built lazily).
 * @param {Function} [env.checkBusy]     (video) => boolean ablation re-check;
 *                                       default: any readyState past
 *                                       HAVE_NOTHING or any src set → busy.
 * @param {object}   [env.managerOptions] SegmentManager overrides per lane
 *                                       ({ signal } for headless teardown).
 */
export async function attachTakeover({
  video,
  claim,
  provider,
  mse = {},
  decrypter = null,
  eme = null,
  checkBusy = (v) =>
    (typeof v?.readyState === "number" && v.readyState > 0) ||
    (typeof v?.currentSrc === "string" && v.currentSrc !== "") ||
    (typeof v?.src === "string" && v.src !== "") ||
    typeof v?.mediaSource !== "undefined",
  managerOptions = {}
} = {}) {
  if (!video || !claim || !provider) {
    return decline("missing-seam");
  }
  const manifestUrl = claim.manifestUrl;
  const text = typeof claim.text === "string" ? claim.text : "";
  if (!manifestUrl || !text) {
    return decline("no-manifest");
  }
  if (checkBusy(video)) {
    return decline("busy");
  }

  // The fragment plan decides everything downstream. Unparseable input — or a
  // plan with no concrete segments (live, unbounded template) — declines; the
  // page player already rides Mode-A for those.
  let plan;
  try {
    plan = parseManifest(text, { kind: claim.kind ?? null, baseUrl: manifestUrl });
  } catch (err) {
    logger.warn("proxy", "takeover", "manifest unparseable", manifestUrl, err?.message ?? err);
    return decline("parse");
  }
  const lanes = Array.isArray(plan?.lanes) ? plan.lanes : [];
  if (lanes.length === 0 || !lanes.every(laneHasInit)) {
    // Every-lane rule: a mixed fMP4+TS plan declines wholesale so one lane
    // never desyncs against the page player.
    return decline("media-lane-unsupported");
  }
  if (!lanes.some((l) => Array.isArray(l.segments) && l.segments.length > 0)) {
    // Concrete fragments only: an init with no segment list (live unbounded
    // template) would arm an empty plane — Mode-A byte routing already serves
    // the page player those streams.
    return decline("no-concrete-segments");
  }

  // AES-128 lanes cannot reach cleartext without the decrypt pipeline; a plan
  // that needs it and cannot get it declines up front (never half-served).
  const needsAes128 = lanes.some(laneIsAes128);
  const aes =
    decrypter ??
    // A keyLoader is the credential seam the decrypter needs to fetch keys;
    // without one (or an injected decrypter) an AES-128 lane would arm a pipe
    // that can never reach cleartext — decline instead of half-serving.
    (needsAes128 && mse.keyLoader != null
      ? new Aes128Decrypter({ subtle: mse.subtle ?? null, keyLoader: mse.keyLoader })
      : null);
  if (needsAes128 && !aes) {
    return decline("no-decrypt");
  }

  const factory = mse instanceof MSEFactory ? mse : new MSEFactory(mse);
  let sink;
  try {
    sink = await factory.create({ video, mimeType: laneMime(lanes[0]) });
  } catch (err) {
    logger.warn("proxy", "takeover", "MediaSource attach failed", manifestUrl, err?.message ?? err);
    return decline("mse");
  }

  const signal = managerOptions.signal ?? null;
  const managers = [];
  let encryptedListener = null;
  let clearKey = null;
  try {
    for (const lane of lanes) {
      const mime = laneMime(lane);
      // Init first: the lane must prove its codecs before a single media
      // fragment lands on its SourceBuffer. HLS carries it as lane.maps[0]
      // (possibly a byte range of the media resource), DASH as lane.init.
      const initInfo = lane.init ?? (Array.isArray(lane.maps) && lane.maps.length > 0 ? lane.maps[0] : null);
      const initBytes = await providerBytes(provider, initInfo.uri, initInfo.byteRange ?? null, signal);
      sink.setInit(initBytes, { mimeType: mime });

      const segments = Array.isArray(lane.segments) ? lane.segments : [];
      // Positional windows alt to the manager's strict per-lane sequence.
      const byId = new Map();
      {
        let cursor = 0;
        for (const seg of segments) {
          const duration = Number(seg.duration ?? 0);
          byId.set(seg.id, { startTime: cursor, endTime: cursor + duration });
          cursor += duration;
        }
      }
      const isAes = laneIsAes128(lane);
      const manager = new SegmentManager({
        fetch: (seg, sig) => providerBytes(provider, seg.uri, seg.byteRange ?? null, sig),
        append: (seg, bytes) => {
          const win = byId.get(seg.id) ?? null;
          return sink.enqueue(seg.id, bytes, {
            mimeType: mime,
            startTime: win?.startTime ?? null,
            endTime: win?.endTime ?? null
          });
        },
        decrypt:
          isAes && aes
            ? (seg, bytes) =>
                aes.decrypt({
                  data: bytes,
                  keyUri: seg.key?.uri,
                  ivHex: seg.key?.iv ?? null,
                  sequence: seg.id
                })
            : null,
        concurrency: LANE_CONCURRENCY,
        allowGaps: false,
        maxRefreshes: 0,
        startSeq: segments.length > 0 ? segments.reduce((lo, s) => Math.min(lo, s.id), segments[0].id) : 0,
        ...managerOptions
      });
      managers.push(manager);
      for (const seg of segments) {
        manager.enqueue({
          id: seg.id,
          uri: seg.uri,
          byteRange: seg.byteRange ?? null,
          encrypted: isAes && seg.encrypted === true,
          key: seg.key ?? null
        });
      }
    }

    if (claim.klass === "clearkey") {
      clearKey = eme ?? new ClearKeyEme();
      await clearKey.attach(video, { laurl: claim.laurl ?? "" });
      if (typeof video.addEventListener === "function") {
        encryptedListener = (event) => {
          clearKey.handleEncrypted({ initData: event?.initData, initDataType: event?.initDataType });
        };
        video.addEventListener("encrypted", encryptedListener);
      }
      logger.log("proxy", "takeover", "ClearKey armed", manifestUrl);
    }
  } catch (err) {
    // Anything that fails before the plane is fully up hands the element back
    // — never leave a half-attached MediaSource or a dangling CDM behind.
    logger.warn("proxy", "takeover", "arm failed, tearing down", manifestUrl, err?.message ?? err);
    for (const m of managers) m.destroy();
    try {
      sink.destroy();
    } catch {}
    handBack(video, sink.objectURL);
    if (clearKey) {
      try {
        await clearKey.detach();
      } catch {}
    }
    return decline("arm");
  }

  // The page player beat us to the element the moment its MSE closed ours
  // (a blob/hls.js src swap overwrites ours). Release the plane without
  // touching the element's now-foreign src.
  const surrendered = { value: false };
  let closeListener = null;
  if (typeof sink.mediaSource?.addEventListener === "function") {
    closeListener = () => {
      if (surrendered.value) return;
      surrendered.value = true;
      logger.log("proxy", "takeover", "page took the element, releasing plane", manifestUrl);
      for (const m of managers) m.destroy();
      try {
        sink.destroy();
      } catch {}
      if (clearKey) {
        clearKey.detach();
      }
    };
    sink.mediaSource.addEventListener("sourceclose", closeListener);
  }

  logger.warn("proxy", "takeover", "takeover armed", manifestUrl, {
    lanes: lanes.length,
    mime: lanes.map(laneMime)
  });

  const release = async () => {
    if (surrendered.value) {
      for (const m of managers) m.destroy();
      return;
    }
    surrendered.value = true;
    for (const m of managers) m.destroy();
    try {
      sink.destroy();
    } catch {}
    handBack(video, sink.objectURL);
    if (clearKey) {
      try {
        await clearKey.detach();
      } catch {}
    }
    if (closeListener && typeof sink.mediaSource?.removeEventListener === "function") {
      sink.mediaSource.removeEventListener("sourceclose", closeListener);
    }
    if (encryptedListener && typeof video.removeEventListener === "function") {
      video.removeEventListener("encrypted", encryptedListener);
    }
  };

  return {
    taken: true,
    reason: "armed",
    video,
    claim,
    sink,
    managers,
    eme: clearKey,
    detach: release
  };
}