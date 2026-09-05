/**
 * Proxy bootstrap: a production installer and a debug-capable cousin.
 *
 * `installProxy` is the always-on production arm, decoupled from debug mode
 * (§7.4, §11.4). The Gate is armed from config (`features.manifestProxy` plus
 * the optional `proxy.routing.includes/excludes` site lists); observe,
 * fetch/XHR interpose, MP4 request routing, and the element src seam all run on
 * every page, and only the routed surface is gated. Manifest engagement is the
 * Mode-A pipe: when the gate routes a manifest, `ManifestFlow` (the §7.4 t2
 * decision) records the claim and its CDN hosts join an engaged set; segment-
 * shaped fetches (`.ts`/`.m4s`/...) on engaged hosts are then routed through
 * ProxyProvider bytes like every MP4 request already is. `.ts` also names
 * TypeScript modules, so the engaged-host set — not the URL shape alone — is
 * what routes a segment. Engagement never rewrites bytes (the text path stays
 * byte-identical) and every refusal keeps the native wire.
 *
 * `installProxyDebug` is the same wiring for a debug session: the Gate is
 * hard-disabled so manifest routing stays observe-only and byte-identical
 * while the interpose layers are live for telemetry.
 *
 * Deterministic: every runtime seam (gmWebRequest, fetch, xhr prototype,
 * object URL creation, install points, getSetting, provider) is a parameter
 * and the module never touches a bare GM_webRequest identifier, so the whole
 * bootstrap runs headless in tests.
 */
import { logger } from "../../shared/logger.js";
import { Gate } from "./gate.js";
import {
  observeManifests,
  interposeFetch,
  manifestRewrite,
  interposeXhrPrototype,
  ManifestFlow
} from "./manifest.js";
import { ProxyProvider } from "./provider.js";
import { isMp4StreamUrl, Mp4Router } from "./mp4.js";
import { isManifestUrl, isSegmentLikeUrl } from "../../shared/media-shapes.js";
import { netSight } from "../../kernel/net-watch.js";

export { isManifestUrl };

/**
 * Install the observe-only seams for a debug session. Returns
 * `{ summary, router }` where `summary` is `{ enabled, observe, fetch, xhr,
 * mp4 }` and `router` is the shared Mp4Router (used by the element-level src
 * seam in addition to fetch/XHR routing). When `debugOn` is false nothing is
 * touched and the returned summary says `{ enabled: false }` with a null router.
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
 * @param {Function} [env.getSetting]         (key) => value, for `features.mp4Fallback`.
 * @param {object}   [env.provider]           ProxyProvider seam for routed re-fetch.
 * @param {Function} [env.reportNativeWire]   (url, status) => void, fed when a routed
 *                                            request rode the native-fetch fallback.
 */
export function installProxyDebug({
  debugOn = false,
  role = "top",
  gmWebRequest = null,
  fetch = null,
  installFetch = (wrapped) => {
    globalThis.fetch = wrapped;
  },
  xhrPrototype = null,
  getSetting = () => true,
  provider = null,
  reportNativeWire = () => {}
} = {}) {
  if (!debugOn) {
    return { summary: { enabled: false }, router: null };
  }

  const gate = new Gate({ enabled: false });
  const rewrite = (url, text) => manifestRewrite(url, text, { gate });
  const summary = { enabled: true, role, observe: false, fetch: false, xhr: false, mp4: { route: false } };

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
        // The GM rule sees the tab-wide request surface a per-realm observer
        // never can; relay the sighting into the kernel feed as the top-frame
        // analyst (via: "gm"). Debug-only: this whole bootstrap is armed for
        // a debug session and rides the feed's idle rule otherwise.
        netSight({ name: hit.url, via: "gm", initiatorType: hit.type ?? "other", responseStatus: null });
        logger.log("proxy", "observe", "manifest request seen", hit.url, hit.type);
      }
    });
    summary.observe = true;
  } else {
    logger.log("proxy", "bootstrap", "GM_webRequest unavailable - observe layer off (top frame)");
  }

  const onCapture = ({ url, contentType, failed }) => {
    if (failed) {
      logger.log("proxy", "mp4", "capture failed (no response)", url);
      return;
    }
    // Every in-scope fetch/XHR capture is a sighting the observer never sees
    // (the userscript is the initiator); feed it so the interpose surface is
    // not a blind spot. Debug-only like everything here.
    netSight({ name: url, via: "interpose", initiatorType: "fetch", responseStatus: null });
    logger.log("proxy", "mp4", "capture", url, contentType);
  };

  const shouldCapture = (url) => isManifestUrl(url) || isMp4StreamUrl(url);

  let router = null;
  if (typeof fetch === "function") {
    const fallbackProvider =
      provider ?? new ProxyProvider({ native: { fetch } });
    router = new Mp4Router({
      provider: fallbackProvider,
      enabledFor: (url) => getSetting("features.mp4Fallback") === true && gate.inScope(url),
      reportNativeWire
    });
  }

  if (typeof fetch === "function") {
    try {
      const wrapped = interposeFetch({
        fetch,
        shouldCapture,
        rewrite,
        isManifest: isManifestUrl,
        onCapture,
        route: (url) => (isMp4StreamUrl(url) ? router?.routeRequest(url, { stream: true }) ?? null : null),
        routeContent: (url) => router?.routeContent(url) ?? null,
        onOutcome: ({ url, decision }) => {
          logger.log("proxy", "bootstrap", "fetch interpose", url, decision);
        }
      });
      installFetch(wrapped);
      summary.fetch = true;
      summary.mp4.route = !!router;
    } catch (err) {
      logger.error("proxy", "bootstrap", "fetch interpose failed", err?.message ?? err);
    }
  }

  if (xhrPrototype) {
    try {
      const { registered } = interposeXhrPrototype(xhrPrototype, {
        shouldCapture,
        rewrite,
        isManifest: isManifestUrl,
        onCapture
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
  return { summary, router, claims: new Map() };
}

/** The hostname a network URL owns; null for any unparseable input. */
function hostnameOf(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  return URL.canParse(url) ? new URL(url).hostname : null;
}

/** Only string lists may drive the Gate's site policy (a foreign storage
 *  writer must not smuggle arbitrary values into the decision). */
function normalizeList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v) => typeof v === "string");
}

/** Absolute URL references a manifest text names: the manifest's own host plus
 *  every cross-host CDN it points segments at. Engagement routes the whole
 *  byte space a routed manifest touches, not just its seed host. */
const ABSOLUTE_URI_RE = /https?:\/\/[^\s"']+/gi;
function discoverEngagedHosts(manifestUrl, text) {
  const hosts = new Set();
  const seed = hostnameOf(manifestUrl);
  if (seed) {
    hosts.add(seed);
  }
  for (const match of String(text ?? "").matchAll(ABSOLUTE_URI_RE)) {
    const host = hostnameOf(match[0]);
    if (host) {
      hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Install the production proxy arm. Always-on, decoupled from debug mode: the
 * Gate's manifest routing rides `features.manifestProxy` plus the optional
 * `proxy.routing.includes/excludes` site lists, and only an armed manifest
 * engages its segment space. Returns `{ summary, router, flow, claims }` where
 * `summary` is `{ enabled, role, observe, fetch, xhr, manifest, mp4 }`, `router`
 * is the shared Mp4Router (element-level src seam), `flow` the §7.4
 * ManifestFlow over the rewrite decision (claim/telemetry, downgrade revokes),
 * and `claims` the §Phase 6 ring of engaged manifests (URL + text) waiting on
 * the element seam's MSE rendezvous.
 *
 * @param {object}   [env]
 * @param {"top"|"frame"} [env.role="top"]    tab-level ownership split (top owns
 *                                            GM_webRequest rules; frame skips).
 * @param {Function} [env.gmWebRequest]       GM_webRequest seam (feature-detected).
 * @param {Function} [env.fetch]              the real fetch to wrap.
 * @param {Function} [env.installFetch]       (wrapped) => void; default globalThis.fetch.
 * @param {object}   [env.xhrPrototype]       object with a `send` method to wrap.
 * @param {Function} [env.getSetting]         (key) => value, for features.manifestProxy,
 *                                            features.mp4Fallback, proxy.routing.includes/
 *                                            proxy.routing.excludes. Default: all false.
 * @param {object}   [env.provider]           ProxyProvider seam for routed re-fetch.
 * @param {Function} [env.reportNativeWire]   (url, status) => void when a routed
 *                                            request rode the native-fetch fallback.
 */
export function installProxy({
  role = "top",
  gmWebRequest = null,
  fetch = null,
  installFetch = (wrapped) => {
    globalThis.fetch = wrapped;
  },
  xhrPrototype = null,
  getSetting = () => false,
  provider = null,
  reportNativeWire = () => {}
} = {}) {
  const features = {
    manifest: getSetting("features.manifestProxy") === true,
    mp4: getSetting("features.mp4Fallback") === true
  };
  const gate = new Gate({
    enabled: features.manifest,
    includes: normalizeList(getSetting("proxy.routing.includes")),
    excludes: normalizeList(getSetting("proxy.routing.excludes"))
  });
  const flow = new ManifestFlow({
    gate,
    consented: true,
    onDisengage: ({ player }) => {
      disengageHostsFor(player);
      claims.delete(player);
    }
  });

  // The §Phase 6 ring: engaged claims (manifest URL + text) waiting for an
  // element-seam rendezvous. Declared before engageHostsFor so the flow's
  // onDisengage closure can reference it.
  const claims = new Map();

  // A routed manifest's CDN hosts, ref-counted across players. This set - not
  // the URL shape - is what makes a segment fetch routable: `.ts` ALSO names
  // TypeScript modules, so a host must be engaged by an actual manifest before
  // any segment-shaped request on it rides the proxy.
  const engagedHosts = new Map();
  const refsByPlayer = new Map();

  const engageHostsFor = (manifestUrl, text) => {
    const hosts = discoverEngagedHosts(manifestUrl, text);
    refsByPlayer.set(manifestUrl, hosts);
    for (const host of hosts) {
      engagedHosts.set(host, (engagedHosts.get(host) ?? 0) + 1);
    }
    logger.log("proxy", "bootstrap", "manifest engaged, segment hosts routed", manifestUrl, [...hosts]);
  };
  const disengageHostsFor = (manifestUrl) => {
    const hosts = refsByPlayer.get(manifestUrl);
    if (!hosts) {
      return;
    }
    refsByPlayer.delete(manifestUrl);
    for (const host of hosts) {
      const next = (engagedHosts.get(host) ?? 1) - 1;
      if (next <= 0) {
        engagedHosts.delete(host);
      } else {
        engagedHosts.set(host, next);
      }
    }
    logger.log("proxy", "bootstrap", "manifest disengaged, segment hosts released", manifestUrl, [...hosts]);
  };
  const segmentEngaged = (url) => {
    if (isManifestUrl(url) || !isSegmentLikeUrl(url)) {
      return false;
    }
    const host = hostnameOf(url);
    return host != null && engagedHosts.has(host);
  };

  const rewrite = (url, text) => {
    const result = manifestRewrite(url, text, { gate });
    if (result.decision.routed) {
      const outcome = flow.consider({ player: url, manifestUrl: url, kind: result.decision.kind, text });
      if (outcome.engage) {
        engageHostsFor(url, text);
        claims.set(url, {
          manifestUrl: url,
          kind: result.decision.kind,
          klass: result.decision.klass,
          text,
          engagedAt: Date.now()
        });
        logger.log("proxy", "bootstrap", "claim recorded", url);
      }
    }
    return result;
  };

  const summary = {
    enabled: features.manifest || features.mp4,
    role,
    observe: false,
    fetch: false,
    xhr: false,
    manifest: { route: features.manifest },
    mp4: { route: features.mp4 }
  };

  if (role === "frame") {
    // Not a hole: GM_webRequest rules are tab-scoped, so the top frame owns them.
    logger.log("proxy", "bootstrap", "observe owned by top frame - subframe skips GM_webRequest");
  } else if (typeof gmWebRequest === "function") {
    observeManifests({
      gmWebRequest,
      onObserve: (hit) => {
        netSight({ name: hit.url, via: "gm", initiatorType: hit.type ?? "other", responseStatus: null });
        logger.log("proxy", "observe", "manifest request seen", hit.url, hit.type);
      }
    });
    summary.observe = true;
  } else {
    logger.log("proxy", "bootstrap", "GM_webRequest unavailable - observe layer off (top frame)");
  }

  const onCapture = ({ url, contentType, failed }) => {
    if (failed) {
      logger.log("proxy", "mp4", "capture failed (no response)", url);
      return;
    }
    // A plain page's .ts/.m4s-shaped fetch (e.g. a TypeScript module) is not a
    // proxy sighting; only engaged segment space - or manifest/mp4 captures -
    // feed telemetry. The interpose surface is not a blind spot, but a
    // non-media fetch must not create one either.
    if (isSegmentLikeUrl(url) && !segmentEngaged(url)) {
      return;
    }
    netSight({ name: url, via: "interpose", initiatorType: "fetch", responseStatus: null });
    logger.log("proxy", "mp4", "capture", url, contentType);
  };

  const shouldCapture = (url) => isManifestUrl(url) || isMp4StreamUrl(url) || isSegmentLikeUrl(url);

  let router = null;
  if (typeof fetch === "function") {
    const fallbackProvider =
      provider ?? new ProxyProvider({ native: { fetch } });
    router = new Mp4Router({
      provider: fallbackProvider,
      enabledFor: (url) =>
        gate.inScope(url) && (isSegmentLikeUrl(url) ? features.manifest : features.mp4),
      reportNativeWire
    });
  }

  if (typeof fetch === "function") {
    try {
      const wrapped = interposeFetch({
        fetch,
        shouldCapture,
        rewrite,
        isManifest: isManifestUrl,
        onCapture,
        route: (url) => {
          if (isMp4StreamUrl(url) || segmentEngaged(url)) {
            return router?.routeRequest(url, { stream: true, byShape: isSegmentLikeUrl(url) }) ?? null;
          }
          return null;
        },
        routeContent: (url) => router?.routeContent(url) ?? null,
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
        shouldCapture,
        rewrite,
        isManifest: isManifestUrl,
        onCapture
      });
      summary.xhr = registered;
    } catch (err) {
      logger.error("proxy", "bootstrap", "XHR interpose failed", err?.message ?? err);
    }
  }

  logger.log("proxy", "bootstrap", "proxy seams installed", summary);
  return { summary, router, flow, claims };
}