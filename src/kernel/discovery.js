import { logger } from "../shared/diagnostics.js";
import { watchMediaEvents, meetsMinSize, forEachVideoInMutations, surveyVideos, describeVideo } from "./sdk.js";
import { onDomMutations } from "../shared/dom-manager.js";

/**
 * Should-boot decisions: the URL skip gate and the video presence probe. One
 * module because both answer the same question before the kernel exists —
 * "does this document deserve a kernel at all" — and entry.js is their only
 * consumer: guard the URL, then arm the sentinel, then boot on evidence.
 */

/* ── URL skip gate ───────────────────────────────────────────────────────
 *
 * Any match skips the document entirely (ad/track/captcha frames host no
 * players). Hostname-anchored on purpose: an ad domain may appear only in a
 * path or query on a legitimate video page (`/doubleclick-interview/`,
 * `?ref=taboola.com`), and substring-matching the whole href would silently
 * skip a real player. Suffix match covers subdomains; captcha widget frames
 * live on their own domains (hcaptcha.com, recaptcha.net), so dropping the
 * path-style `recaptcha` probe costs only a harmless script eval in the
 * occasional captcha iframe that hosts no video.
 */
const AD_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
  "hcaptcha.com",
  "googletagmanager.com",
  "recaptcha.net",
  "facebook.net"
];
/** Prefix families: adservice.google and its subdomains. */
const AD_HOST_PREFIXES = ["adservice.google."];

function isAdHost(hostname) {
  for (const suffix of AD_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  for (const prefix of AD_HOST_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

export function shouldSkipUrl() {
  try {
    const href = location.href;
    if (href === "about:blank" || href.startsWith("data:")) {
      return true;
    }
    // location.hostname, not new URL(href).hostname: same value, but the URL
    // object is pure throwaway work on a path that runs once per frame. Gecko
    // 157 measures ~2.6x cheaper (2.8ms vs 7.4ms per 5000 calls) and the
    // accessor cannot throw, which keeps the cross-origin throw below the only
    // thing that needs the try/catch.
    if (isAdHost(location.hostname)) {
      return true;
    }
    if (window.top !== window && window.top?.location?.href) {
      // The top frame's href must still be parsed: its location object is not
      // reachable from here, so there is no accessor to read instead.
      if (isAdHost(new URL(window.top.location.href).hostname)) {
        return true;
      }
    }
  } catch {}
  return false;
}

/* ── Presence probe ──────────────────────────────────────────────────────
 *
 * Framework video detection: a two-phase sentinel that defers the full kernel
 * boot until a document actually shows a video candidate - without paying for
 * a full-document MutationObserver on pages that never host a player.
 *
 * Phase 1 (cheap, no observer): capture-phase loadeddata/play listeners plus
 * a one-time DOM-ready <video> presence check. SDK players fire media events
 * through the composed path, so a real player surfaces here with zero subtree
 * observer cost.
 *
 * Escalation (commits to the full-document observer) happens only once there
 * is evidence of a player: a static <video> in the parsed DOM, or a media
 * event for a <video> that has not yet reached player size. Documents without
 * video therefore never open the subtree observer at all.
 *
 * The first size-qualified candidate fires onCandidate exactly once;
 * documents without a usable player never boot a kernel.
 */
export function installVideoProbe({ minWidth, minHeight, onCandidate }) {
  let done = false;
  let escalated = false;
  let offMutations = null;
  let stopEvents = null;
  let sizeWatcher = null;
  /** Every video surfaced so far, in discovery order, as survey records. */
  const surfaced = [];

  const detach = () => {
    stopEvents?.();
    stopEvents = null;
    offMutations?.();
    offMutations = null;
    sizeWatcher?.disconnect();
    sizeWatcher = null;
  };

  const finish = (winner) => {
    if (done) {
      return;
    }
    done = true;
    detach();
    logger.log("probe", "Video candidate found - booting kernel");
    // The handoff: what surfaced and how, so the kernel adopts in discovery
    // order instead of re-deriving it with a second full sweep.
    onCandidate({ videos: surfaced, origin: winner.origin });
  };

  const escalate = () => {
    if (escalated) {
      return;
    }
    escalated = true;
    offMutations = onDomMutations((mutations) => {
      if (done) {
        return;
      }
      forEachVideoInMutations(mutations, (video) => consider(video, "mutation"));
    });
  };

  /**
   * Watch a candidate that failed the size gate, so the gate can re-run when
   * the box actually changes.
   *
   * Without this the failure is final unless something else happens to fire:
   * the shared mutation feed observes childList only, so a style or class
   * change that grows or reveals an existing video produces no record - and
   * the media tap cannot re-fire an event that is already spent (a video that
   * ran loadeddata while hidden, or has no src at all, will never fire again).
   * Verified on the live bundle: a Plyr video that fails the gate and is then
   * grown by a style-only write is never re-checked, while a fresh qualifying
   * insertion on the same page boots immediately - the candidate was missed
   * for the life of the document.
   *
   * ResizeObserver observes the box itself, which is exactly the signal the
   * gate is about; Gecko holds observed targets weakly per the spec (unobserve
   * happens on qualification, and a detached candidate simply drops out when
   * GC collects it), so watching failures cannot pin elements. The re-check
   * runs at observation delivery - after layout, never inside the page's
   * mutation checkpoint (the shared feed dispatches past it via yield_ in
   * scheduleFlush), so this adds no forced-layout work to page script.
   */
  const watchGateFailure = (video) => {
    if (!sizeWatcher) {
      sizeWatcher = new ResizeObserver((entries) => {
        if (done) {
          return;
        }
        for (const { target } of entries) {
          if (!meetsMinSize(target, minWidth, minHeight)) {
            continue;
          }
          sizeWatcher.unobserve(target);
          consider(target, "resize");
        }
      });
    }
    sizeWatcher.observe(video);
  };

  const consider = (video, origin) => {
    if (done) {
      return;
    }
    const record = describeVideo(video);
    record.origin = origin;
    surfaced.push(record);
    if (meetsMinSize(video, minWidth, minHeight)) {
      finish(record);
      return;
    }
    // A real <video> exists but isn't player-sized yet - commit to the
    // observer so SDK-inserted siblings that may qualify are caught, and
    // watch this one's box so a later in-place grow/reveal re-runs the gate.
    watchGateFailure(video);
    escalate();
  };

  stopEvents = watchMediaEvents((video) => consider(video, "media"));

  // Cheap deferred check (atomic, no observer): videos already in the parsed
  // DOM surface without any media event or mutation subscription, through
  // the one sanctioned survey (light and shadow alike - qSA never crosses a
  // shadow boundary, so a shadow player in the parsed DOM would otherwise be
  // found by nothing until it fired a media event; see forEachShadowVideos
  // for the live repro).
  const checkStatic = () => {
    if (done) {
      return;
    }
    // Index walk, not for..of: a plain array underneath, and the iterator
    // protocol here costs more than the walk it replaces.
    const found = surveyVideos(document);
    for (let i = 0; i < found.length; i++) {
      consider(found[i].video, found[i].shadow ? "shadow" : "static");
    }
    const sawVideo = found.length > 0;
    if (!done && sawVideo) {
      // Video(s) exist but none qualified yet - keep the observer armed
      // so SDK-inserted successors that may reach player size are caught.
      escalate();
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkStatic, { once: true });
  } else {
    checkStatic();
  }

  return () => {
    if (!done) {
      done = true;
      detach();
    }
  };
}
