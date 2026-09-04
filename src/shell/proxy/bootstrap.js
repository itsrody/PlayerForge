/**
 * Debug-only proxy bootstrap (pre-Phase 6 wiring).
 *
 * Loads the proxy seams into the page with the Gate *disabled*: the GM_webRequest
 * observe layer plus interposed fetch/XHR are live so every manifest request is
 * seen and logged, but routing is refused up front - responses keep their exact
 * bytes and no MSE takeover happens. The point is live telemetry for tuning the
 * Phase 6 wiring (which players fetch what, from where) before engagement turns on.
 *
 * Deterministic: every runtime seam (gmWebRequest, fetch, xhr prototype, install
 * point) is a parameter and the module never touches a bare GM_webRequest
 * identifier, so the whole bootstrap runs headless in tests. `debugOn` defaults
 * false: unless the caller opts in, nothing on the page is touched.
 */
import { logger } from "../../shared/logger.js";
import { Gate } from "./gate.js";
import {
  observeManifests,
  interposeFetch,
  manifestRewrite,
  interposeXhrPrototype
} from "./manifest.js";

/** Manifest-looking URLs (`.m3u8`/`.mpd`, including query/fragment tails). */
const MANIFEST_URL_RE = /\.(?:m3u8|mpd)(?:[?#&]|$)/i;

export function isManifestUrl(url) {
  return MANIFEST_URL_RE.test(String(url ?? ""));
}

/**
 * Install the observe-only seams for a debug session. Returns a summary:
 * { enabled, observe, fetch, xhr }. When `debugOn` is false nothing is touched
 * and the returned summary says `{ enabled: false }`.
 *
 * @param {object}   [env]
 * @param {boolean}  [env.debugOn=false]      caller decides (hash / stored toggle).
 * @param {"top"|"frame"} [env.role="top"]    tab-level ownership split from the kernel's
 *                                            top/frame model: "top" owns GM_webRequest
 *                                            rules (feature-detected); "frame" skips
 *                                            observe by design - rules are tab-wide and
 *                                            the top frame registers them - but still
 *                                            interposes fetch/XHR where the player runs.
 * @param {Function} [env.gmWebRequest]       GM_webRequest seam (feature-detected, top only).
 * @param {Function} [env.fetch]              the real fetch to wrap.
 * @param {Function} [env.installFetch]       (wrapped) => void; default assigns globalThis.fetch.
 * @param {object}   [env.xhrPrototype]       object with a `send` method to wrap.
 */
export function installProxyDebug({
  debugOn = false,
  role = "top",
  gmWebRequest = null,
  fetch = null,
  installFetch = (wrapped) => {
    globalThis.fetch = wrapped;
  },
  xhrPrototype = null
} = {}) {
  if (!debugOn) {
    return { enabled: false };
  }

  const gate = new Gate({ enabled: false });
  const rewrite = (url, text) => manifestRewrite(url, text, { gate });
  const summary = { enabled: true, role, observe: false, fetch: false, xhr: false };

  if (role === "frame") {
    // Not a hole: GM_webRequest rules are tab-scoped, so the top frame owns them.
    // A frame instance must not register a second rule set (double-fires per request).
    // Diagnostic hint: if NO top-frame "debug seams installed" line appears in this
    // tab, the top page never matched the script and observe is dark for the tab.
    logger.log("proxy", "bootstrap", "observe owned by top frame - subframe skips GM_webRequest");
  } else if (typeof gmWebRequest === "function") {
    observeManifests({
      gmWebRequest,
      onObserve: (hit) => {
        logger.log("proxy", "observe", "manifest request seen", hit.url, hit.type);
      }
    });
    summary.observe = true;
  } else {
    logger.log("proxy", "bootstrap", "GM_webRequest unavailable - observe layer off (top frame)");
  }

  if (typeof fetch === "function") {
    try {
      const wrapped = interposeFetch({
        fetch,
        shouldCapture: isManifestUrl,
        rewrite,
        onOutcome: ({ url, decision }) => {
          logger.log("proxy", "bootstrap", "fetch interpose", url, decision);
        }
      });
      installFetch(wrapped);
      summary.fetch = true;
    } catch (err) {
      logger.error("proxy", "bootstrap", "fetch interpose failed", err?.message ?? err);
    }
  }

  if (xhrPrototype) {
    try {
      const { registered } = interposeXhrPrototype(xhrPrototype, {
        shouldCapture: isManifestUrl,
        rewrite
      });
      summary.xhr = registered;
    } catch (err) {
      logger.error("proxy", "bootstrap", "XHR interpose failed", err?.message ?? err);
    }
  }

  logger.log("proxy", "bootstrap", "debug seams installed", summary);
  // Unconditional (survives silent mode): one visible line per debug session
  // proving the new build is loaded and which seams are live - the first thing
  // to look for when no breadcrumbs appear.
  logger.warn("proxy", "bootstrap", "debug seams installed", summary);
  return summary;
}