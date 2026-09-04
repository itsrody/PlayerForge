/**
 * Manifest observation + interposition (§6, §7.4, Phase 5).
 *
 * This is the entry seam into the routed pipe. Two delivery modes:
 *
 *  - A. Rewrite-in-place (interposed `fetch`/XHR): the response whose URL ends
 *    in `.m3u8`/`.mpd` is text-captured, segment URLs rewritten (delegated to
 *    `rewrite.js`), and handed to the player *unchanged in shape*.
 *  - B. Full handoff (`gmRequestText`/`GM_xmlhttpRequest`): for players whose
 *    fetcher is too entangled to interpose, or cross-origin manifests with no
 *    CORS.
 *
 * And the §7.4 seam controller: the claim point is the *manifest request*, not
 * the video. `ManifestFlow` is the opt-in state machine — engage modes
 * (`auto`/`ask`/`manual`), first-run consent, the ablation guard, and
 * disarm / degrade-toward-native. `GM_webRequest` registration is
 * feature-detected (§4); if the grant is stripped the observe layer is skipped
 * and only the inline MSE pass-through works.
 */
import { logger } from "../../shared/logger.js";
import { detectManifestKind, sniffManifestKind, rewriteManifest } from "./rewrite.js";

/** Rules fed to `GM_webRequest`: observe-only. TM's MV2 `observe` is
 *  emulated by a no-op `cancel` rule whose listener never aborts. */
export const MANIFEST_OBSERVE_RULES = Object.freeze([
  {
    selector: {
      include: ["*.m3u8*", "*.mpd*"]
    },
    action: "cancel"
  }
]);

/**
 * Register the manifest-observation rules with a GM_webRequest-compatible
 * function. Feature-detected: a missing GM_webRequest resolves to
 * `{ registered: false }` and the caller keeps only the interposed manifest
 * rewrite path. Calling again updates the rules in place (MV2 allows
 * re-registration to change rules live).
 */
export function observeManifests({ gmWebRequest, rules = MANIFEST_OBSERVE_RULES, onObserve } = {}) {
  if (typeof gmWebRequest !== "function") {
    return { registered: false, rules: null };
  }
  gmWebRequest(rules, (info, message, details) => {
    onObserve?.({
      action: info?.action,
      ruleIndex: info?.ruleIndex,
      url: details?.url,
      type: details?.type,
      tab: details?.tab
    });
  });
  logger.log("proxy", "observe", "registered GM_webRequest rules", rules.length);
  return { registered: true, rules };
}

/**
 * The transport-agnostic core of mode A: wraps a real `fetch` and rewrites
 * manifest-text responses in place. Every other response — and every manifest
 * when unarmed/out-of-scope — passes byte-identically.
 *
 * @param {object} env
 * @param {Function} env.fetch        the real fetch (uri, opts) => Promise<Response>.
 * @param {Function} env.shouldCapture (url) => boolean — manifest-looking URLs.
 * @param {Function} env.rewrite     (url, text) => { text, decision } — armed rewrite.
 * @param {Function} [env.onOutcome]  notification for tests/telemetry.
 * @param {Function} [env.makeResponse] (body, init) => Response-like object (default new Response).
 */
export function interposeFetch({
  fetch: realFetch,
  shouldCapture,
  rewrite,
  onOutcome = () => {},
  makeResponse = (body, init) => new Response(body, init)
}) {
  if (typeof realFetch !== "function") throw new TypeError("interposeFetch requires a fetch seam");
  if (typeof shouldCapture !== "function") throw new TypeError("interposeFetch requires shouldCapture");
  if (typeof rewrite !== "function") throw new TypeError("interposeFetch requires rewrite");

  return async (uri, opts) => {
    const response = await realFetch(uri, opts);
    const url = typeof uri === "string" ? uri : uri?.url;
    if (!shouldCapture(url)) {
      return response;
    }
    logger.log("proxy", "fetch", "capturing manifest response", url);
    const body = await response
      .clone()
      .text()
      .catch(() => null);
    if (body == null) {
      return response;
    }
    const { text, decision } = rewrite(url, body);
    onOutcome({ url, decision });
    if (text === body) {
      logger.log("proxy", "fetch", "manifest byte-identical (unarmed/no-change)", url, decision);
      return response;
    }
    const { status, headers } = response;
    const init = { status, statusText: response.statusText, headers };
    logger.log("proxy", "fetch", "manifest rewritten", url, { status, bytes: text.length });
    return makeResponse(text, init);
  };
}

/** Classify + rewrite a manifest body, or leave byte-identical. */
export function manifestRewrite(url, text, { gate, rewriteUri = null } = {}) {
  const kind = detectManifestKind(url) ?? sniffManifestKind(text);
  const decision = gate.routeDecision(url, kind, text);
  logger.log("proxy", "gate", "manifest decision", url, decision);
  if (!decision.routed) {
    return { text, decision };
  }
  const rewritten = rewriteManifest(text, {
    armed: true,
    kind,
    baseUrl: url,
    scope: (uri) => gate.inScope(resolveRef(url, uri)),
    rewriteUri
  });
  return { text: rewritten, decision: { ...decision, kind } };
}

/** Resolve a manifest-internal ref (possibly relative / `$`-templated) to its
 *  absolute URL so site policy can judge it. Non-URL refs fail open to the
 *  manifest URL's own host judgement. */
export function resolveRef(baseUrl, uri) {
  const ref = String(uri ?? "").trim();
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) {
    return ref;
  }
  try {
    return new URL(ref, baseUrl).href;
  } catch {
    return baseUrl;
  }
}

/**
 * Shared load-hook for the Mode-A XHR interposition (used by both the
 * per-instance `guardXhrBloom` wrap and the prototype-level interpose). Attaches
 * a `load` hook that rewrites a manifest-text response in place - byte-identical
 * when unarmed or unchanged. Operates on the xhr contract (open/send/responseText)
 * so a fake XHR exercises it headlessly.
 */
function hookXhrLoad(xhr, { shouldCapture, rewrite }) {
  const onLoad = () => {
    const url = xhr.responseURL ?? xhr.url;
    if (!shouldCapture(url) || xhr.responseType && xhr.responseType !== "") {
      return;
    }
    const body = typeof xhr.responseText === "string" ? xhr.responseText : "";
    const { text } = rewrite(url, body);
    if (text !== body) {
      logger.log("proxy", "xhr", "manifest responseText rewritten", url);
      Object.defineProperty(xhr, "responseText", {
        enumerable: true,
        configurable: true,
        get: () => text
      });
    }
  };
  if (xhr.addEventListener) {
    xhr.addEventListener("load", onLoad, { once: true });
  } else if (typeof xhr.onload === "function" || "onload" in xhr) {
    const prior = xhr.onload;
    xhr.onload = (event) => {
      try { if (prior) prior.call(xhr, event); } finally { onLoad(); }
    };
  }
  return xhr;
}

/**
 * Mode-A wiring for XMLHttpRequest: wraps an XHR-like object's `send` so that
 * a manifest-text response is rewritten in place before the player reads it.
 * Purely explicit in how much it rewrites: an unarmed/no-change response keeps
 * its original `responseText` (byte-identical).
 */
export function guardXhrBloom(xhr, { shouldCapture, rewrite }) {
  const originalSend = xhr.send;
  xhr.send = (...args) => {
    hookXhrLoad(xhr, { shouldCapture, rewrite });
    return originalSend.apply(xhr, args);
  };
  return xhr;
}

/**
 * Mode-A wiring at the prototype level: wrap `proto.send` so every request on a
 * page (players using XHR for manifests) is rewritten in place on load. Each
 * instance gets one load hook per `send`, and responses still pass byte-identical
 * when unarmed or unchanged.
 */
export function interposeXhrPrototype(proto, { shouldCapture, rewrite }) {
  if (!proto || typeof proto.send !== "function") {
    return { registered: false };
  }
  const originalSend = proto.send;
  proto.send = function (...args) {
    hookXhrLoad(this, { shouldCapture, rewrite });
    return originalSend.apply(this, args);
  };
  return { registered: true };
}

/** §7.4.3 engage modes. */
export const ENGAGE_MODE = Object.freeze({
  AUTO: "auto",
  ASK: "ask",
  MANUAL: "manual"
});

/** §7.4.4 ablation guard: only clean (uncommitted) videos are claimable.
 *  HAVE_NOTHING == 0; any advancing readyState means the page player is
 *  already feeding bytes and an MSE swap would rip a live stream. */
export function isClaimable({ readyState, mediaSourceAttached }) {
  const pastCommitted = typeof readyState === "number" && readyState > 0;
  return !(pastCommitted || mediaSourceAttached === true);
}

/**
 * The §7.4 opt-in seam state machine. Fired at the claim point t2 (a manifest
 * fetch observed / interposed), it decides - deterministically - whether the
 * stream may try to claim the video:
 *
 *   1. feature enabled, 2. protection class routable, 3. site in scope,
 *   (gate decision first), 4. ablation guard clean, 5. consent per mode.
 *
 * Engaged players are tracked so downgrade/teardown can revoke them. It never
 * touches a video or MSE itself - `onEngage`/`onDisengage` are the caller's
 * wiring (MSE attach, SegmentManager arm, src swap).
 */
export class ManifestFlow {
  #gate;
  #mode = ENGAGE_MODE.AUTO;
  #consented = false;
  #onEngage;
  #onDisengage;
  #onStatus;
  #claimed = new Map();
  #downgraded = false;

  constructor({ gate, mode = ENGAGE_MODE.AUTO, consented = false, onEngage, onDisengage, onStatus } = {}) {
    this.#gate = gate;
    this.#setMode(mode);
    this.#consented = consented === true;
    this.#onEngage = typeof onEngage === "function" ? onEngage : () => {};
    this.#onDisengage = typeof onDisengage === "function" ? onDisengage : () => {};
    this.#onStatus = typeof onStatus === "function" ? onStatus : () => {};
    logger.log("proxy", "flow", "created", { mode: this.#mode, consented: this.#consented });
  }

  #setMode(mode) {
    if (mode === ENGAGE_MODE.ASK || mode === ENGAGE_MODE.MANUAL) {
      this.#mode = mode;
    } else {
      this.#mode = ENGAGE_MODE.AUTO;
    }
  }

  get enabled() {
    return this.#gate?.enabled === true;
  }

  get mode() {
    return this.#mode;
  }

  get consented() {
    return this.#consented;
  }

  get claimedSize() {
    return this.#claimed.size;
  }

  /** First-run / per-context consent. */
  setConsent(value) {
    this.#consented = value === true;
    logger.log("proxy", "flow", "consent", this.#consented);
    return this;
  }

  setMode(mode) {
    this.#setMode(mode);
    logger.log("proxy", "flow", "mode", this.#mode);
    return this;
  }

  /** A player whose decision was reached stays claimed until disengaged. */
  decision(player) {
    return this.#claimed.get(player) ?? null;
  }

  /**
   * The t2 decision for one manifest fetch. Returns a stable ruling and fires
   * onStatus (telemetry) plus onEngage when the stream may claim the video.
   */
  consider({ player, manifestUrl, kind, text, video, readyState, mediaSourceAttached }) {
    const mode = this.#mode;
    const note = (reason, engage) => {
      const outcome = { player, engage, reason, mode, url: manifestUrl };
      logger.log("proxy", "flow", "decision", outcome);
      if (engage) {
        this.#claimed.set(player, outcome);
        this.#onEngage(outcome);
      }
      this.#onStatus(outcome);
      return outcome;
    };

    if (this.decision(player)) {
      const existing = this.#claimed.get(player);
      logger.log("proxy", "flow", "already claimed", player, existing.reason);
      this.#onStatus(existing);
      return existing;
    }
    if (this.#downgraded) {
      return note("downgraded", false);
    }
    if (!this.enabled) {
      return note("disabled", false);
    }
    const decision = this.#gate.routeDecision(manifestUrl, kind, text);
    if (!decision.routed) {
      return note(decision.reason, false);
    }
    if (video != null && !isClaimable({ readyState, mediaSourceAttached })) {
      return note("busy", false);
    }
    if (mode !== ENGAGE_MODE.MANUAL && !this.#consented) {
      return note("consent", false);
    }
    return note(null, true);
  }

  /**
   * Tear down one engaged player toward native. No-op when the player was
   * never claimed or already released.
   */
  disengage(player, { reason = "teardown" } = {}) {
    const existing = this.#claimed.get(player);
    if (!existing) {
      return existing ?? null;
    }
    this.#claimed.delete(player);
    this.#onDisengage({ player, reason });
    logger.log("proxy", "flow", "disengage", player, reason);
    return existing;
  }

  /**
   * §7.4.7 downgrade: stop engaging new streams immediately and hand every
   * engaged player back to native - fail toward native, never frozen.
   */
  downgrade({ reason = "downgrade" } = {}) {
    this.#downgraded = true;
    const released = Array.from(this.#claimed.keys());
    this.#claimed.clear();
    for (const player of released) {
      this.#onDisengage({ player, reason });
    }
    logger.warn("proxy", "flow", "downgraded, released players", released, reason);
    return released;
  }

  /** Re-arm after a downgrade (feature re-enabled live). */
  rearm() {
    this.#downgraded = false;
    logger.log("proxy", "flow", "rearmed");
    return this;
  }

  destroy({ reason = "teardown" } = {}) {
    return this.downgrade({ reason });
  }
}