/**
 * The unified network resources manager (§7.7).
 *
 * Two planes live here, deliberately under one roof:
 *
 *  1. The FEED - one realm-wide live PerformanceObserver over `resource`
 *     entries, coalesced per microtask, fanned out to subscribers - the
 *     network sibling of dom-watch.js. The media element's native GETs (the
 *     network-process loads this userscript's request seams can never see) and
 *     every other resource sighting reach subscribers here without each
 *     interest owning its own observer or polling the performance timeline.
 *
 *  2. The RESOURCE PLANE - every stateful network resource the kernel owns:
 *     the wire-seam installer (installProxy / installProxyDebug) with its
 *     armed Gate, engaged-host set, and §Phase 6 claims ring, plus the kernel
 *     shell-lifecycle coordinator (armProxy) that fires the element plane and
 *     tears its temporary surfaces back down.
 *
 * Both planes are one surface: netSight() lets the framework's own seams
 * schedule the sightings PerformanceObserver can never see into the identical
 * coalesced fan-out, and the manager's proxies ride the same feed for the
 * native-wire fallback telemetry.
 *
 * THE MANAGER'S UTILITIES: the modules under src/kernel/proxy/ are this
 * manager's algorithms - headless models (classification, manifest rewrite,
 * fragment planning, the segment flow state machine, the MSE sink, the
 * take-over plane, the transport provider, token/decrypt/EME machinery, the
 * frame feed, and the media network timeline). Every one is re-exported below
 * so the whole network surface is reachable from this single import. The
 * dependency direction is one-way: the manager imports the models; no model
 * imports the manager.
 *
 * Realm-native, not privileged: PerformanceObserver is per-frame by design,
 * so a subframe's element GETs surface in ITS realm with no TM privileges and
 * no cross-frame routing - the "top-frame-only" GM_webRequest limitation never
 * applies to this feed and there is nothing to relay. GM_webRequest stays a
 * top-frame tab-wide analyst and is deliberately NOT a transport of this
 * module; debug sightings it sees may still be relayed INTO the feed (as
 * `via: "gm"` entries via netSight) - analysis in, never transport of net
 * facts out. Because the feed is realm-local, page scripts cannot spoof it
 * and no privileged action is reachable through it - observe-only by
 * construction.
 *
 * Firefox-native: PerformanceObserver / PerformanceResourceTiming are FF 57+
 * (baseline 2024). `entry.name` (the URL) survives cross-origin -
 * Timing-Allow-Origin only zeros granular timestamps, never the name.
 * `buffered: false` is the efficient mode by design: a buffered replay would
 * O(n) the whole 250-entry default window on first callback and drop the live
 * pressure this feed exists to catch.
 *
 * Resource rule borrowed from uBO (and dom-watch.js): the underlying observer
 * exists only while at least one subscriber is attached, and teardown is
 * automatic when the last one leaves (or via AbortSignal). An optional
 * per-subscriber `filter` runs inline (uBO-style) so one observer + one
 * fan-out pass serves every interest; ad/analytics entries never leave the
 * dispatcher unless a subscriber opts into them.
 *
 * Deterministic: like dom-watch.js, the observer class is resolved from the
 * active global at call time, so a test installing a stub before subscribing
 * drives the whole feed headless. Every installer seam (roles, GM_webRequest,
 * fetch, xhr prototype, object URL creation, provider, reportNativeWire) is a
 * parameter and no arm path touches a bare GM_webRequest identifier, so the
 * whole manager runs headless.
 */
import { logger } from "../shared/logger.js";
import { isManifestUrl, isSegmentLikeUrl } from "../shared/media-shapes.js";
import { getSetting } from "./settings.js";
import { Gate, classifyStream } from "./proxy/manifest-pipe.js";
import {
  observeManifests,
  interposeFetch,
  manifestRewrite,
  interposeXhrPrototype,
  ManifestFlow
} from "./proxy/manifest-pipe.js";
import { isMp4StreamUrl, Mp4Router, ProxyProvider } from "./proxy/stream-transport.js";
import {
  routeProgressiveSource,
  disposeElementSource,
  routeManifestStreams,
  disposeManifestStream
} from "./proxy/element-plane.js";
import { onFrame } from "./proxy/element-plane.js";
import { mediaTimeline, isMediaElementEntry } from "./proxy/media-timing.js";

// ---------------------------------------------------------------------------
// THE FEED
// ---------------------------------------------------------------------------

const subscribers = new Set();

let observer = null;
let queued = false;
let pendingEntries = [];

function flush() {
  queued = false;
  const entries = pendingEntries;
  pendingEntries = [];
  // A teardown/resubscribe may have cleared the queue while this flush was
  // already queued (stopIfIdle resets pendingEntries but not the flag); the
  // re-armed feed must not deliver a stale empty batch - an empty flush is a
  // no-op, never a handler call.
  if (entries.length === 0) {
    return;
  }
  for (const subscriber of subscribers) {
    const handler = subscriber.handler;
    if (!subscriber.filter) {
      handler(entries);
      continue;
    }
    // Lazy batch: the filtered array is only allocated when something matches,
    // so a high-churn resource feed allocates nothing for non-media entries.
    let matched = null;
    for (const entry of entries) {
      if (subscriber.filter(entry)) {
        (matched ??= []).push(entry);
      }
    }
    if (matched) {
      handler(matched);
    }
  }
}

function ensureObserver() {
  // Structural guard mirroring dom-watch.js's `!doc?.documentElement`: the
  // observer class exists in every browser (FF 57+, baseline) and modern Node;
  // a realm without it (stripped test host) stays idle rather than throwing.
  const ObserverClass = globalThis.PerformanceObserver;
  if (typeof ObserverClass !== "function") {
    return;
  }
  if (observer) {
    return;
  }
  observer = new ObserverClass((list) => {
    for (const entry of list.getEntries()) {
      pendingEntries.push(entry);
    }
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  });
  observer.observe({ type: "resource", buffered: false });
}

/** Idempotent no-op when already detached (observer torn down). */
function stopIfIdle() {
  if (subscribers.size === 0 && observer) {
    observer.disconnect();
    observer = null;
    pendingEntries = [];
  }
}

/**
 * Subscribe to every resource sighting. `handler(entries)` receives one
 * coalesced batch per microtask. `filter(entry)` (optional) is applied inline
 * so only matching entries reach this handler; a subscriber without a filter
 * sees everything. Returns the unsubscribe function.
 */
export function onNetEvents(handler, { signal, filter = null } = {}) {
  ensureObserver();
  const subscriber = { handler, filter: typeof filter === "function" ? filter : null };
  subscribers.add(subscriber);
  const off = () => {
    subscribers.delete(subscriber);
    stopIfIdle();
  };
  signal?.addEventListener("abort", off, { once: true });
  return off;
}

/**
 * Schedule the framework's OWN network sightings onto the feed. The proxy
 * seams schedule here what the observer never sees - the routed native-fetch
 * fallback and the debug observe/interpose captures. Same `{ name, via,
 * initiatorType, responseStatus }` shape as resource entries, coalesced with
 * them in insertion order. With no subscribers the feed is idle by design: a
 * sighting nobody is listening for is dropped immediately (live feed, no
 * look-backs), never queued.
 */
export function netSight(entry) {
  if (!entry || typeof entry?.name !== "string" || !entry.name) {
    return;
  }
  if (subscribers.size === 0) {
    return;
  }
  pendingEntries.push(entry);
  if (!queued) {
    queued = true;
    queueMicrotask(flush);
  }
}

// ---------------------------------------------------------------------------
// THE RESOURCE PLANE: the wire-seam installer and the kernel coordinator
// ---------------------------------------------------------------------------

/** The hostname a network URL owns; null for any unparseable input. Memoized
 *  against a capped LRU: segment hosts repeat per stream, so the per-request
 *  `segmentEngaged`/`discoverEngagedHosts` probes hot-path through a Map
 *  instead of a `new URL` (and its full URL parse) every time. */
const HOSTNAME_MEMO_MAX = 256;
const hostnameMemo = new Map();
function hostnameOf(url) {
  if (typeof url !== "string" || !url) {
    return null;
  }
  if (hostnameMemo.has(url)) {
    const host = hostnameMemo.get(url);
    if (hostnameMemo.size > 1) {
      hostnameMemo.delete(url);
      hostnameMemo.set(url, host);
    }
    return host;
  }
  const host = URL.canParse(url) ? new URL(url).hostname : null;
  if (hostnameMemo.size >= HOSTNAME_MEMO_MAX) {
    hostnameMemo.delete(hostnameMemo.keys().next().value);
  }
  hostnameMemo.set(url, host);
  return host;
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
    try {
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
    } catch (err) {
      // Seams are isolated: a broken observe row must not abort the interpose arm.
      logger.error("proxy", "bootstrap", "observe registration failed", err?.message ?? err);
    }
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

/**
 * Install the always-on production arm, decoupled from debug mode: the Gate's
 * manifest routing rides `features.manifestProxy` plus the optional
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
  // Policy is DECISION-TIME, not snapshotted: the fast-path + per-lane gates
  // re-read the settings engine per request (uBO re-evaluates policy per
  // request), so a user flipping a feature mid-page stops routing at the next
  // fetch - the settings engine live-reloads by design. The install-time
  // `features` snapshot below only feeds the install report; the Gate arms
  // true and `routingArmed` is the real gate.
  const routingArmed = () =>
    getSetting("features.manifestProxy") === true || getSetting("features.mp4Fallback") === true;
  const gate = new Gate({
    enabled: true,
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
    // Live feature gate in front of the classify work: flipping the manifest
    // feature off must stop rewrites at the next fetch, not at the next load.
    if (getSetting("features.manifestProxy") !== true) {
      return { text, decision: { routed: false, klass: null, reason: "disabled" } };
    }
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
  } else if (routingArmed() && typeof gmWebRequest === "function") {
    // Rules are tab-wide registered rows; with routing off (nothing armed) they
    // would register neutral observers for no purpose, so registration waits
    // until a feature is on. Wrapped so one broken row cannot abort the arm.
    try {
      observeManifests({
        gmWebRequest,
        onObserve: (hit) => {
          netSight({ name: hit.url, via: "gm", initiatorType: hit.type ?? "other", responseStatus: null });
          logger.log("proxy", "observe", "manifest request seen", hit.url, hit.type);
        }
      });
      summary.observe = true;
    } catch (err) {
      logger.error("proxy", "bootstrap", "observe registration failed", err?.message ?? err);
    }
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
      enabledFor: (url) => {
        // Decision-time lanes: segments ride the manifest toggle, standalone
        // MP4s the mp4Fallback toggle - re-read per request so a live flip
        // stops routing immediately (fail toward native).
        const shaped = isSegmentLikeUrl(url);
        const on = shaped
          ? getSetting("features.manifestProxy") === true
          : getSetting("features.mp4Fallback") === true;
        return on && gate.inScope(url);
      },
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
        },
        enabled: routingArmed
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
        onCapture,
        enabled: routingArmed
      });
      summary.xhr = registered;
    } catch (err) {
      logger.error("proxy", "bootstrap", "XHR interpose failed", err?.message ?? err);
    }
  }

  logger.log("proxy", "bootstrap", "proxy seams installed", summary);
  return { summary, router, flow, claims };
}

/**
 * Kernel-owned proxy arm: installs the production proxy wire seams and
 * subscribes the element-level takeover plane to the kernel's shell lifecycle.
 *
 * The kernel never imports a shell; it arms the proxy by calling the provider
 * it is handed (hosting the top/frame role split and the GM_webRequest mount)
 * and then rides its own shell-created / shell-destroyed hooks to fire the
 * element seams and tear their temporary surfaces back down. This is the one
 * manager port that turns the shell facade (a created Shell) into proxy calls -
 * the proxy data plane itself stays headless (no shell import anywhere in
 * the manager's model layer).
 *
 * Deterministic: every seam (roles, GM_webRequest, fetch, xhr prototype, object
 * URL creation, provider, reportNativeWire) is a parameter; role + onShellReady
 * come from the kernel's registered provider/wiring so the whole arm runs
 * headless.
 *
 * @param {object}   env
 * @param {object}   env.kernel       the Kernel (for onShellCreated/onShellDestroyed).
 * @param {"top"|"frame"} [env.role="top"]
 * @param {Function} [env.gmWebRequest]
 * @param {Function} [env.fetch]
 * @param {object}   [env.xhrPrototype]
 * @param {object}   [env.provider]   ProxyProvider seam (defaults to a native-fetch one).
 * @param {Function} [env.reportNativeWire]
 * @param {boolean}  [env.debugOn=false]
 */
export function armProxy({ kernel, role = "top", gmWebRequest = null, fetch = null, xhrPrototype = null, provider = null, reportNativeWire = () => {}, debugOn = false } = {}) {
  if (!kernel || typeof kernel.onShellCreated !== "function") {
    logger.error("proxy", "arm", "a kernel with shell lifecycle hooks is required");
    return null;
  }

  const fallbackProvider = provider ?? new ProxyProvider({ native: { fetch: fetch ?? globalThis.fetch } });

  const installed = debugOn
    ? installProxyDebug({ debugOn: true, role, gmWebRequest, fetch, xhrPrototype, provider: fallbackProvider, reportNativeWire, getSetting })
    : installProxy({ role, gmWebRequest, fetch, xhrPrototype, provider: fallbackProvider, reportNativeWire, getSetting });

  if (!installed.router) {
    logger.warn("proxy", "arm", "no fetch seam - element seams stay inactive", installed.summary);
    return installed;
  }
  const { router, claims } = installed;

  // fire the element takeover seams on shell rendezvous, and tear their
  // temporary surfaces on shell destruction (the DOMManager-free teardown
  // twin of shell.dom.onCleanup).
  kernel.onShellCreated((shell) => {
    const routeSrc = () => {
      routeProgressiveSource({ video: shell.video, router, getSetting });
    };
    routeSrc();
    shell.ready
      .then(routeSrc)
      .catch((err) => logger.warn("kernel", "proxy element src route rejected", err?.message ?? err));
    routeManifestStreams({ video: shell.video, getSetting, claims, provider: fallbackProvider });
    shell.ready
      .then(() => routeManifestStreams({ video: shell.video, getSetting, claims, provider: fallbackProvider }))
      .catch((err) => logger.warn("kernel", "proxy manifest takeover rejected", err?.message ?? err));
  });
  kernel.onShellDestroyed((shell) => {
    disposeManifestStream(shell.video).catch((err) =>
      logger.warn("kernel", "proxy manifest stream dispose failed", err?.message ?? err)
    );
    disposeElementSource(shell.video);
  });

  logger.log("proxy", "arm", "proxy armed", installed.summary);
  return installed;
}

/**
 * The unified network resources manager: the feed, the wire-seam installer,
 * the kernel coordinator, and the model utilities it composes. One import in
 * entry/kernel obtains the whole network surface.
 */
export const network = Object.freeze({
  // the feed
  onNetEvents,
  netSight,
  // the resource plane
  installProxy,
  installProxyDebug,
  armProxy,
  // the classification + policy model
  Gate,
  classifyStream,
  // the transport + routing models
  ProxyProvider,
  Mp4Router,
  ManifestFlow,
  // the element plane algorithms
  routeProgressiveSource,
  routeManifestStreams,
  disposeElementSource,
  disposeManifestStream,
  // the timeline + frame algorithms
  mediaTimeline,
  onFrame,
  isMediaElementEntry
});

// ---------------------------------------------------------------------------
// THE MANAGER'S UTILITIES & ALGORITHMS - re-exported from the model layer
// ---------------------------------------------------------------------------
export * from "./proxy/manifest-pipe.js";
export * from "./proxy/stream-transport.js";
export * from "./proxy/element-plane.js";
export * from "./proxy/decrypt-eme.js";
export * from "./proxy/segment-flow.js";
export * from "./proxy/media-timing.js";
export * from "./proxy/media-timing.js";
export { isManifestUrl } from "../shared/media-shapes.js";
export { isProgressiveStreamUrl, isSegmentLikeUrl, hasMediaExtension, isMediaUrlName, manifestKindFromUrl } from "../shared/media-shapes.js";