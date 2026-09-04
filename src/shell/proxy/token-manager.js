/**
 * Refresh-tokenized stream credential state machine (§12). Owns the armed /
 * refreshing envelope around a provider's token API: a proactive timer that
 * refreshes mid-TTL, a reactive 403/410 path that refresh-and-retry-once,
 * per-URL token rewrite (path `{token}/{expires}` placeholders or query
 * `md5`/`expires`), bounded refresh backoff, and destroy-scoped teardown.
 *
 * Pure orchestration: time enters only through the injected `clock` and
 * `scheduler`, so every transition is deterministic and headless. The manager
 * never touches the network - `getToken(signal)` is the caller's seam (Phase 3
 * wire-up feeds it the token API through the existing `gmRequest*` helpers).
 */

import { injectPathTokens, injectQueryParams } from "./rewrite.js";

export const TOKEN_STATE = Object.freeze({
  IDLE: "idle",
  ARMED: "armed",
  REFRESHING: "refreshing",
  FAILED: "failed"
});

const DEFAULT_QUERY_SCHEME = Object.freeze({ token: "md5", expires: "expires" });

/**
 * options:
 *   getToken(signal) -> Promise<{
 *     token, expires,            // required (expires: epoch seconds)
 *     token_ip?, client_ip?,     // IP-bound token: prefer token_ip when both
 *     url?, url_ip?, cookie?,    // cookie/header creds to attach on requests
 *   }> | null
 *   clock() -> ms          deterministic test injection; default Date.now
 *   scheduler(fn, ms)      deterministic test injection; default setTimeout
 *   queryScheme {token, expires}  query-form param names (default md5/expires)
 *   minLeadMs, retryBaseMs, maxRetryMs, maxAttempts   backoff/lead tuning
 */
export class TokenManager {
  #getToken;
  #clock;
  #scheduler;
  #queryScheme;
  #minLeadMs;
  #retryBaseMs;
  #maxRetryMs;
  #maxAttempts;

  #ac = new AbortController();
  #state = TOKEN_STATE.IDLE;
  #token = null;
  #timer = null;
  #scheduled = new Set();
  #attempts = 0;
  #refreshing = null;
  #listeners = new Set();

  constructor(options = {}) {
    const opts = options || {};
    this.#getToken = typeof opts.getToken === "function" ? opts.getToken : null;
    this.#clock = typeof opts.clock === "function" ? opts.clock : () => Date.now();
    this.#scheduler = typeof opts.scheduler === "function" ? opts.scheduler : (fn, ms) => setTimeout(fn, ms);
    this.#queryScheme = { ...DEFAULT_QUERY_SCHEME, ...(opts.queryScheme ?? {}) };
    this.#minLeadMs = Math.max(0, opts.minLeadMs ?? 2000);
    this.#retryBaseMs = Math.max(1, opts.retryBaseMs ?? 1000);
    this.#maxRetryMs = Math.max(1, opts.maxRetryMs ?? 60000);
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  }

  /** Subscribe to flow events; returns an unsubscribe function. Event shapes:
   *  {type:"state", from, to}, {type:"refresh", ok, reason?, reactive?}. */
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #emit(event) {
    for (const cb of this.#listeners) {
      cb(event);
    }
  }

  #setState(to) {
    if (this.#state === to) {
      return;
    }
    const from = this.#state;
    this.#state = to;
    this.#emit({ type: "state", from, to });
  }

  #setToken(token) {
    this.#token = token;
  }

  get state() {
    return this.#state;
  }

  get token() {
    return this.#token;
  }

  get armed() {
    return this.#state === TOKEN_STATE.ARMED;
  }

  get aborted() {
    return this.#ac.signal.aborted;
  }

  /** Rewrite a URL with the live credential - path `{token}/{expires}`
   *  placeholders win when present, else the query form (`md5`/`expires`).
   *  Byte-stable when no token is current or nothing changes; a stale token
   *  can never escape because only the ARMED state rewrites. */
  rewriteUrl(uri) {
    if (this.#state !== TOKEN_STATE.ARMED || !this.#token) {
      return uri;
    }
    const t = this.#token;
    const expiresText = t.expiresRaw != null ? String(t.expiresRaw) : "";
    const pathFilled = injectPathTokens(uri, { token: t.value, expires: expiresText });
    if (pathFilled !== uri) {
      return pathFilled;
    }
    return injectQueryParams(uri, {
      [this.#queryScheme.token]: t.value,
      [this.#queryScheme.expires]: expiresText
    });
  }

  /** Obtain or re-obtain the first credential and arm. No provider configured
   *  leaves the manager IDLE (passive - reactive-only is handled elsewhere). */
  async arm() {
    if (!this.#getToken || this.aborted) {
      return { refreshed: false, reason: this.#getToken ? "aborted" : "no-provider" };
    }
    if (this.#refreshing) {
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    return this.refresh({ reactive: false });
  }

  /**
   * Force a refresh. Returns {refreshed, token, reason?}. Concurrent callers
   * share the single in-flight request. `reactive:true` distinguishes a
   * mid-playback 403 recovery (unit-test assertions on refresh events).
   */
  async refresh({ reactive = false } = {}) {
    if (!this.#getToken) {
      this.#setState(TOKEN_STATE.FAILED);
      return { refreshed: false, reason: "no-provider" };
    }
    if (this.#refreshing) {
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    this.#setState(TOKEN_STATE.REFRESHING);
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    this.#refreshing = { promise, resolve };
    try {
      return await this.#doRefresh(resolve, reactive);
    } finally {
      this.#refreshing = null;
    }
  }

  /**
   * Reactive credential expiry signal: a routed request came back 403/410.
   * Refreshes once (or waits on any in-flight refresh) and reports whether the
   * caller's single retry has a fresh credential. Any other status is not our
   * signal: {refreshed:false, reason:"not-token-error"}.
   */
  async handleStatus(status) {
    if (status !== 403 && status !== 410) {
      return { refreshed: false, reason: "not-token-error" };
    }
    if (this.#refreshing) {
      await this.#refreshing.promise;
      return { refreshed: this.#state === TOKEN_STATE.ARMED, token: this.#token };
    }
    if (this.aborted) {
      return { refreshed: false, reason: "aborted" };
    }
    return this.refresh({ reactive: true });
  }

  async #doRefresh(resolve, reactive) {
    let outcome;
    try {
      outcome = await this.#getToken(this.#ac.signal);
    } catch {
      if (this.aborted) {
        this.#setToken(null);
        this.#setState(TOKEN_STATE.IDLE);
        resolve({ refreshed: false, reason: "aborted", token: null });
        this.#emit({ type: "refresh", ok: false, reason: "aborted", reactive });
        return { refreshed: false, reason: "aborted", token: null };
      }
      this.#fail(reactive);
      this.#emit({ type: "refresh", ok: false, reason: "provider-error", reactive });
      const result = { refreshed: false, token: null, reason: "provider-error" };
      resolve(result);
      return result;
    }
    if (this.aborted || outcome == null) {
      if (this.aborted) {
        this.#setToken(null);
        this.#setState(TOKEN_STATE.IDLE);
      } else {
        this.#fail(reactive);
      }
      const result = outcome == null && !this.aborted
        ? { refreshed: false, token: null, reason: "empty-token" }
        : { refreshed: false, token: null, reason: "aborted" };
      resolve(result);
      this.#emit({ type: "refresh", ok: false, reason: result.reason, reactive });
      return result;
    }
    this.#attempts = 0;
    this.#token = this.#buildToken(outcome);
    this.#setState(TOKEN_STATE.ARMED);
    this.#scheduleProactive();
    const result = { refreshed: true, token: this.#token };
    resolve(result);
    this.#emit({ type: "refresh", ok: true, reactive });
    return result;
  }

  #fail(reactive) {
    this.#attempts++;
    this.#setToken(null);
    this.#setState(TOKEN_STATE.FAILED);
    if (this.#attempts < this.#maxAttempts) {
      const delay = Math.min(this.#retryBaseMs * (1 << (this.#attempts - 1)), this.#maxRetryMs);
      this.#schedule(() => {
        if (!this.aborted && this.#state === TOKEN_STATE.FAILED) {
          this.refresh({ reactive });
        }
      }, delay);
    }
  }

  #buildToken(outcome) {
    const now = this.#clock();
    const expiresRaw = Number(outcome.expires);
    const expiresAt = Number.isFinite(expiresRaw) ? expiresRaw * 1000 : now;
    return {
      value: outcome.token_ip || outcome.token,
      ip: outcome.token_ip ?? null,
      clientIp: outcome.client_ip ?? null,
      cookie: outcome.cookie ?? null,
      header: outcome.header ?? null,
      url: outcome.url ?? null,
      urlIp: outcome.url_ip ?? null,
      expiresRaw,
      expiresAt,
      issuedAt: now,
      ttl: Math.max(0, expiresAt - now)
    };
  }

  /** Proactive refresh at `expiresAt - max(minLeadMs, ttl/2)` (§12.1). The
   *  timer, not the decision, tracks wall time. */
  #scheduleProactive() {
    if (this.#timer != null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const now = this.#clock();
    const t = this.#token;
    const lead = Math.max(this.#minLeadMs, Math.floor(t.ttl / 2));
    const delay = Math.max(1, t.expiresAt - now - lead);
    this.#timer = this.#scheduler(() => {
      this.#timer = null;
      if (!this.aborted) {
        this.refresh({ reactive: false });
      }
    }, delay);
  }

  #schedule(fn, ms) {
    const handle = this.#scheduler(fn, ms);
    if (handle != null && typeof handle !== "undefined") {
      this.#scheduled.add(handle);
    }
  }

  #clearTimer(handle) {
    try {
      clearTimeout(handle);
    } catch {}
  }

  /** Teardown (player change / page unload): clear timers, drop the credential,
   *  and abort any in-flight provider request via the manager's signal. */
  destroy() {
    if (!this.aborted) {
      this.#ac.abort();
    }
    if (this.#timer != null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    for (const handle of this.#scheduled) {
      this.#clearTimer(handle);
    }
    this.#scheduled.clear();
    this.#token = null;
    this.#setState(TOKEN_STATE.IDLE);
  }
}