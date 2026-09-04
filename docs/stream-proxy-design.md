# Stream Proxy: Segment / Fragment Flow Design (Firefox / Tampermonkey MV2)

Status: **Design** (no `src/` code yet)
Branch: `firefox`
Target: Firefox 155+ / Tampermonkey 5.5+ (MV2)

## 1. Purpose

Give PlayerForge the ability to re-route a player's **HLS (`.m3u8` + `.ts` segments)** and
**DASH (`.mpd` + media fragments)** traffic through a user-controlled pipe, with two concrete
use cases:

1. **Inline pass-through proxy** — fetch each segment ourselves via `GM_xmlhttpRequest` (which
   bypasses CORS and page CSP) and stream the bytes into the player through **Media Source
   Extensions (MSE)**. This is the "no separate process" topology.
2. **Manifest-level control** — observe / cancel / redirect the `.m3u8` / `.mpd` / subtitle
   fetches (all `xhr`-typed) so the player's own fetcher is steered.

The routed surface deliberately covers **every non-DRM protection**: plaintext, token-only, HLS
**AES-128 clear-key**, and DASH **ClearKey-EME** (§11) — while refusing genuine DRM
(Widevine/FairPlay/PlayReady) and SAMPLE-AES. It also **supports refresh-tokenized streams**: a
credential state machine that renews and rewrites signed/token URLs before expiry so playback
never stalls on a mid-session 403 (§12).

The design centers on **flow management**: a state machine that knows which segment is being
fetched, why, whether it succeeded, how it should be decrypted (if at all), and how its
credential is refreshed — not a pile of one-off rules.

## 2. The hard constraint that shapes everything

Tampermonkey's `GM_webRequest` (MV2, Firefox) intercepts **only** these `webRequest` resource
types:

- `sub_frame`
- `script`
- `xhr`
- `websocket`

It does **not** intercept `media`, `object`, `other`, images, etc. HLS/DASH **media segments**
are fetched by the browser/player as resource type **`media`** — so `GM_webRequest` **cannot**
see, cancel, or redirect the raw segment requests.

> This is the single most important fact in this design. Any architecture that tries to make
> `GM_webRequest` reach the segments themselves is impossible. The segments reach our proxy
> via **rewriting the manifest the player already fetched, plus MSE**, and `GM_webRequest`
> is used where it legitimately can help: the **manifest / subtitle fetches** (which are
> `xhr`) and as a **redirect layer on those** when a pure header-rule route is desired.

### What each mechanism can actually do

| Mechanism | Reaches | Good for |
|---|---|---|
| `GM_webRequest` (MV2) | `xhr`, `script`, `sub_frame`, `websocket` | manifest `.m3u8`/`.mpd` fetch, `.vtt` subtitle fetch, redirect/cancel rules on those |
| `GM_xmlhttpRequest` | any cross-origin URL (bypasses CORS/CSP via `@connect *`) | fetching segments/bytes ourselves (the actual proxy pipe) |
| MSE (`MediaSource` + `SourceBuffer`) | in-page media append | delivering those fetched bytes to the `<video>` |
| Manifest rewriting | — | rewrite segment URLs inside `.m3u8`/`.mpd` so *our* fetcher is always the one that runs |

## 3. Architecture overview

Two cooperating subsystems:

```
                    ┌────────────────────────────┐
   page <video> ──► │  MSE  ◄─ appendBuffer      │
                    └──────▲─────────────────────┘
                           │
   manifest fetch (xhr)    │ segment bytes
   ┌──────────┐   GM_webRequest   ┌──────────────────────┐
   │  player   │ ──observe/rewrite─►│  SegmentManager       │
   │ fetcher   │ ◄──redirect/      │  (flow state machine) │
   └──────────┘     pass-through   └───────▲──────────────┘
                                           │ GM_xmlhttpRequest (CORS-free)
                                           │ + fetch()+pipe, fallback
                                 ┌─────────┴─────────┐
                                 │   ProxyProvider    │
                                 │   (strategy: inline│
                                 │    pass-through)   │
                                 └───────────────────┘
```

- **Manifest layer** (`GM_webRequest` on `.m3u8`/`.mpd` `xhr`): observe, optionally rewrite
  segment URLs to our own scheme, optionally redirect the whole manifest.
- **Segment layer** (`GM_xmlhttpRequest` / inline fetch): the actual byte pipe. Feeds MSE.
- **Flow manager**: the state machine coordinating both — tracking out-of-order segments,
  backpressure, retries, and teardown so we never leak fetches or double-append.

> **Read the takeover seam first.** The diagram shows our MSE feeding the page `<video>`, but the
> *page's own player* already feeds that same video and owns its `src`. Today PlayerForge is
> purely non-invasive (it never sets `video.src`, never wires MSE). The proxy therefore performs
> a **protocol-level takeover of a third-party player**, which is only safe when it is opt-in,
> timed to the manifest-fetch claim point, and self-healing toward native. See §7.4 — the
> timing, engage modes, and failure-toward-native contract that make that takeover seamless.
> Everything in §4–§7.3 is the machinery; §7.4 is the workflow that keeps it from fighting the
> player it rides.

## 4. Banner (`@grant` / `@connect`) changes required

Current banner (`esbuild.config.mjs`) grants:
`GM_setValue, GM_getValue, GM_registerMenuCommand, GM_unregisterMenuCommand,
GM_addValueChangeListener, GM_removeValueChangeListener, GM_getResourceText,
GM_xmlhttpRequest` + `@connect *`.

New grants/logic for the proxy feature:

```
// @grant        GM_webRequest          (new)
// @grant        GM_getResourceURL      (optional: for redirect-to-blob patterns)
// @webRequest   <JSON rules>          (optional: apply redirect rules even before script load)
```

`@connect *` is already present, which is exactly what the inline pass-through needs for
arbitrary segment hosts.

**Grant is conditional:** `GM_webRequest` is experimental and MV2-only. Everything must stay
feature-detected (`typeof GM_webRequest === "function"`) and degrade gracefully — if the grant
is stripped, the manifest-observation layer is skipped and only the inline MSE pass-through
(which needs no `GM_webRequest`) still works. The userscript must never hard-require it.

## 5. `GM_webRequest` rules (manifest layer)

Registered once at startup (idempotent `GM_webRequest(rules, listener)`). Firefox MV2 allows
re-registration to change rules live; we expose per-site on/off so rules can be empty when the
feature is disabled.

```js
const manifestRules = [
  // observe only (no action): let the flow manager decide
  { selector: { include: ["*.m3u8*", "*.mpd*", "*.vtt*"] }, action: "observe" },
];
```

Selector supports `include` / `match` / `exclude` (same syntax as `@include`/`@match`, incl.
regex). Actions supported by MV2: `cancel` and `redirect` (literal URL or `{from,to}` regex).
`observe` is not an action shipped by TM; to observe we register rules with a **no-op
`cancel`/`redirect` that we immediately pass through**, or better — use a **pass-through
redirect to self** as the trigger so the listener fires, then act. The listener signature:

```js
GM_webRequest(manifestRules, (info, message, details) => {
  // info.action, info.ruleIndex; details.url, details.tab, details.type
  flow.observeManifestFetch(details);
});
```

`@webRequest` header form is important for **pre-script-load** intercept (e.g., cancel a known
ad manifest before the script even runs). Rule JSON must match `GM_webRequest` arg 1.

### Why not route segments through `GM_webRequest` redirect?
It cannot, per §2. When a *redirect* of the manifest-target is desired purely as a header rule
(no body rewrite), `GM_webRequest` is the right tool; when body rewriting of segment URLs is
needed, that must happen on the **manifest text** (see §6).

## 6. Manifest rewriting (the segment-route injection point)

Because `GM_webRequest` can't redirect `media` segments, the route to the proxy pipe must be
injected into the player by rewriting the **manifest text** the player consumes.

Two delivery modes:

- **A. Rewrite-in-place (native `fetch` interception):** patch `window.fetch` (streaming) and
  guard native `XMLHttpRequest` such that responses whose URL is `.m3u8`/`.mpd` are text-captured,
  URI-referenced segment URLs rewritten, and the response returned to the player *unmodified in
  shape*. This is the same "ride the stream" pattern the repo already uses for DOM (kernel/dom-watch),
  but for the network layer. Works for players that call `fetch()`/XHR directly.
- **B. Full proxy handoff (`GM_xmlhttpRequest`):** when the player's fetcher is too entangled to
  interpose, we intercept the manifest request and re-issue it through `GM_xmlhttpRequest`
  (CORS-free), rewrite, then hand the bytes back. This is the established pattern in
  `src/shared/storage.js::gmRequestText`/`GM_xmlhttpRequest`.

Rewriting rules (applied to manifest text):
- HLS `.m3u8`: rewrite `#EXTINF`-following URI lines and `#EXT-X-MEDIA` URI attributes.
- DASH `.mpd`: rewrite `BaseURL` and `<SegmentTemplate>` `media="..."`/`index="..."` patterns.
- Only rewrite when the feature is armed and the segment host is in scope; leave everything else
  byte-identical so player frame drift / byte-range indexing is preserved.

## 7. Inline pass-through proxy (SegmentManager + ProxyProvider)

The actual byte pipe. This is the "<?php-ish proxy without a process"> design: we fetch and pipe.

### 7.1 `ProxyProvider` (transport strategies, in priority order)

1. **`GM_xmlhttpRequest` (binary)** — primary. `responseType: "blob"` (or `arraybuffer`).
   Bypasses CORS + CSP, honors `@connect *`. This is what the design leans on.
2. **Native `fetch` + `ReadableStream` pipe** — fallback when the segment is same-origin or
   served with permissive CORS. Cheaper than GM round-trips, but blocked by CORS/CSP.
3. **Native `fetch` with `forceRequest`-style blob** — for `blob:`/`data:` segment URLs
   (players that already blob-packaged), decode and forward locally.

`GM_xmlhttpRequest` in Tampermonkey is **serialized** (known issue — see §13) and fires only one
progress event, so the pipe must be **segment-granular (whole segment per request), never
true streaming** — that matches MSE's source-buffer model anyway.

### 7.2 The MSE sink

- Create one `MediaSource` per `<video>`, `objectURL = URL.createObjectURL(ms)`.
- `SourceBuffer` per mime (video codec / audio codec), configured with
  `appendWindowStart/End` for accurate seeking.
- Feed `appendBuffer(cleartextBytes)` in **sequence-number order**, honoring
  `buffer.full` / `updating` backpressure. For non-DRM-encrypted streams the bytes are always
  **decrypted before append** (see §11.2/§11.3) — MSE only ever receives cleartext.
- On `updateend` after each append, drop the `TimeRanges` bookkeeping slot.

Opening MSE **replaces** the player's own fetcher for routed media: MSE is only engaged when the
feature is armed and the first manifest rewrite occurs; otherwise the player plays natively.

### 7.3 `SegmentManager` — the flow state machine

Coordinates everything; must be allocation-friendly on the hot per-segment path (mirrors the
repo's "keep hot paths allocation-free" rule).

Per-stream micro-state (a segment record):

```
Segment {
  id,               // sequence/fragment number
  uri,              // absolute URL post-rewrite AND post token-refresh (§12)
  auth,             // { token?, expiry?, cookie?, headers? } snapshot (§12)
  key?,             // key id / decryption key ref for non-DRM encryption (§11)
  status,           // IDLE | FETCHING | DECRYPTING | BUFFERING | DONE | FAILED | SKIPPED
  attempts,         // retry counter (bounded)
  byteRange,        // optional Range header for fragment indexing
}
```

Transitions (encryption-aware):

```
          fetch()                  bytes          WebCrypto/EME
IDLE ───────────► FETCHING ───────► DECRYPTING ───────────────► BUFFERING ──(updateend)──► DONE
   │                │    │             │   (AES-128 clear key /      │
   │                │    │             │    ClearKey-EME only;        │
   │             retry   │             │    plain + tokenized         │
   │                │    │             │    go straight through)      │
   │                │    └─(error, attempts<max)─────► IDLE (backoff) │
   │                └────(error, attempts==max)───────► FAILED → SKIPPED (media continues)
   └──────────────────────(403/410: token expired)────► TOKEN_REFRESH → re-IDLE with fresh uri/§12
```

Guarantees the design enforces:
- **Ordering:** MSE `SourceBuffer` requires in-order appends; out-of-order segments are queued
  (a bounded reorder buffer keyed by sequence), never skipped — unless the player signals it can
  tolerate a gap, in which case `SKIPPED` and `clear()` the buffer portion (repo already has a
  `forgeTrack.clear()`/filter `clear()` idiom to reuse).
- **Backpressure:** one in-flight `GM_xmlhttpRequest` per SourceBuffer lane; a global per-stream
  cap on pending bytes so memory stays bounded.
- **Cancellation:** `AbortController` per stream (repo already uses FF `AbortSignal.any` +
  `AbortSignal.timeout` patterns in `context.js`); abort all in-flight on video `pause`/`ended`/
  seeking/teardown. Never leak fetches on destroy — mirrors `DOMManager`'s destroy-scoped
  teardown in `src/shared/dom-manager.js`.
- **Retries:** bounded, with `AbortSignal.timeout` jitter/backoff; no infinite loop.
- **Determinism:** no wall-clock-dependent decisions that break tests; injectable clock/texture
  like the existing test harness.
- **Token awareness:** a 403/410 on any routed request (manifest, key, or segment) is treated as
  the *normal* signal that the credential expired, not an error — it drives the refresh path in
  §12 and only surfaces as `FAILED` if refresh + a bounded retry also fail.

### 7.4 Opt-in workflow, timing, and seamlessness (the takeover seam)

This is the make-or-break subsection. PlayerForge today is a **non-invasive enhancer**: the
probe (`probe.js`) → kernel adopt (`kernel.js::#adoptVideo`) → shell boot (`shell.js`) pipeline
only ever observes the page's `<video>` and overlays a HUD; it **never touches `video.src`**,
never calls `.load()`, never wires MSE (verified: zero `src=`/`createObjectURL`/`MediaSource` in
`src/`). The **page's own player owns the video element and drives its bytes**.

A media proxy that owns segment fetches is therefore a **protocol-level takeover of a
third-party player** (hls.js, dash.js, or NativeHLS on FF's MSE). That is inherently invasive
and timing-sensitive. The whole opt-in design exists to make that takeover opt-in, delayed, and
impossible to run silently wrong.

#### 7.4.1 Why "just always take over" is unsafe

- The page player is mid-flight before we even boot. NativeHLS on FF can already be loading the
  first manifest and first segment the moment `DOMContentLoaded`/`loadeddata` fires — well before
  our probe (`probe.js`) even escalates to a full observer. Grabbing the video then means
  ripping a half-open stream out from under an owned player mid-seek.
- hls.js/dash.js re-set `video.src` and recreate their own `MediaSource` on quality switches.
  Any MSE blob URL we publish will be overwritten by the page player on the next adaptation
  step, leaving a zombie MSE we keep feeding.
- Two MSEs / two fetchers fighting the same video = double-buffering, drifts, or hard stalls.

#### 7.4.2 The opt-in decision surface

A single global "proxy" toggle is not enough; the takeover must be expressed as an explicit,
per-context, revocable intent:

| Control | Meaning | Why |
|---|---|---|
| **Feature enabled** (global `pf:proxy.enabled`) | The proxy code is armed to *observe*, never to engage on its own | A global off means the feature costs nothing and cannot misfire |
| **Per-site include/exclude** | Only matching players are even eligible | Takeover is bounded to known-good sites |
| **Protection class** (§11.1) | `plain`/`tokenized`/`AES-128`/`ClearKey` only; **never** DRM | The gate is the lowest-level refusal |
| **Per-player engage mode** | `auto` / `ask` / `manual` (below) | The visible seam: when and how the takeover actually bites |
| **First-run consent** | One-time explicit "route my video through PlayerForge's proxy?" | Honest: the feature hijacks a watched stream, so it must be consented to, not just enabled |

#### 7.4.3 Engage modes (the visible seam)

- **`auto`:** engage private-mode. A player matching site+class routes through the proxy
  automatically, *if* the stream can be intercepted before the page player commits
  (§7.4.4). If interception is impossible, degrade to native — never hard-fail.
- **`ask`:** surface a one-time "engage proxy for this player?" affordance on the HUD before
  routing. Default-first flag. Most compatible with seamlessness (nothing happens until the
  user says so).
- **`manual`:** a panel/menu "Route this stream" button; proxy engages on explicit user action
  for the current player only. Zero surprise.

#### 7.4.4 Timing: the engage race and how we win (or back off)

The takeover must complete **before the page player commits its own byte path to the video**,
but **after** the page player has produced a routable manifest. That window is where all the
timing lives:

```
  probe           adopt          manifest observed         page player commits
   │                │                    │                        │
   │ (cheap)        │  ──auto/ask──►  (we rewrite + can claim)   (native path wins — TOO LATE
   ▼                ▼                    ▼                        ▼    unless we claimed first)
  t0             t1                    t2                       t3
```

- **Goal:** claim (attach our MSE, arm SegmentManager, rewrite the manifest URL) in
  `(t1, t2)`, i.e., as soon as a routable manifest is *observed* (§5) but before the page
  player turns that manifest into native bytes at `t3`.
- **The decisive primitive is NOT the video element — it's the manifest request.** We do not
  watch the `<video>` for "readiness"; we watch the **manifest fetch** ($5 `GM_webRequest` +
  interposed `fetch`/XHR). The moment `.m3u8`/`.mpd` is seen, we know the *exact* stream to
  route and the exact player; that is our claim point `t2`.
- **If we miss `t2`** (page player already started feeding bytes, or the manifest was fetched
  before our listeners were live under non-instant injection), the video may already be
  receiving native bytes. **We must not race into MSE over a playing stream.** The honest
  behavior: mark the stream "too late to route, native", and only engage the *next* stream
  (next manifest reload, next play) — or engage `ask`/`manual` which can force a clean reload
  as the user's explicit choice. Flickering an MSE swap over a live native player is exactly
  the seamlessness failure we forbid.
- **Ablation guard:** before engage we atomically check "no page player is feeding this video
  right now" (no `loadeddata` yet, `readyState` still `HAVE_NOTHING`, no `MediaSource` already
  detached to this element). Only then do we attach; otherwise defer/fallback.

#### 7.4.5 Why "engage on manifest observation" is seamless (and self-healing)

- Because we intercept the **manifest** (the page player's single point of commitment), the
  page player never sees a foreign src: it asks for the manifest, we hand it back a rewritten
  manifest whose segment URLs point at our MSE-routed namespace, and the page player's own
  adapter logic rides the rewritten manifest exactly as it would the original. The "takeover"
  is invisible to the page player's state machine.
- For **native FF/NativeHLS**, the page player *is* the browser element; there is no adapter to
  ride, so takeover means swapping the element's src to our MSE blob once, at `t2`, when
  `readyState` is still `HAVE_NOTHING`. Because it happens before the first committed byte and
  we can fully tear down (close MSE, restore previous src) on any failure, it is a clean swap,
  not a mid-stream rip.
- **Self-healing contract:** on any engage-time or mid-stream failure (codec mismatch,
  append error, token API down, manifest unobservable), the proxy **detaches MSE, restores the
  video's prior src / lets the page player reload, and swallows itself** for that player — the
  native player was always one reload away. "We fail toward native", never toward a frozen
  screen.

#### 7.4.6 The "already native / resumed" case

- **bfcache / pagehide** (`kernel.js::#onPageHide/#onPageShow`) and **ResumeTracker** already
  reconcile video state after restores. The proxy hooks the same lifecycle: on `pagehide` tear
  down MSE/abort fetches; on `persisted` restore, re-evaluate the manifest route from scratch
  (do not assume the previous MSE blob survived bfcache).
- **Resume seeks:** if the user reopens mid-movie, the page player seeks *after* the manifest
  loads; our MSE `appendWindowStart/End` (§7.2) + reorder-buffer make a late seek
  indistinguishable from a fresh start to our state machine. We do not need intercept-position
  games; we serve from the manifest the page player already re-requested.

#### 7.4.7 Disarm / downgrade (not just teardown)

- **Teardown** (disengage, page unload): abort in-flight, drain reorder buffer, close MSE
  (`sourceBuffer` → `ms.endOfStream()`), release object URL, restore prior src.
- **Downgrade** (`pf:proxy.enabled=false` live via `gmAddValueChangeListener`, or player lost its
  site include): *stop engaging new streams* immediately; for the current stream, finish the
  already-buffered segments then hand control back to native on the next manifest reload — no
  mid-segment rip. This mirrors the config live-reload precedent in `config.js`.
- **No persistent side effects:** nothing the proxy does may survive the page (no global state,
  no storage keys beyond the config toggle), so turning it off is trivially clean.

### 7.5 Lifecycle wiring

- **Arm:** config flag (`pf:configs`, live across tabs via `gmAddValueChangeListener` — already
  established in `config.js`). Per-site include/exclude + engage mode + consent (§7.4.2).
- **Discovery:** when a manifest fetch is observed (§5) or a `.m3u8`/`.mpd` URL is seen — the
  claim point `t2` (§7.4.4), not the video-probe point.
- **Engage:** only within `(t1, t2)` and only when the ablation guard passes (§7.4.4); rewrite +
  open MSE + start SegmentManager.
- **Disarm / teardown / downgrade:** §7.4.7 — abort in-flight, drain reorder buffer, close MSE
  (`sourceBuffer` → `ms.endOfStream()`), release the object URL, restore prior src, and stop
  engaging new streams on a live downgrade.

## 8. Failure modes (explicitly designed for)

| Failure | Behavior |
|---|---|
| `GM_webRequest` grant missing / MV3 host | Skip manifest layer; inline pass-through still works via interposed manifest rewrite (native path) |
| Segment fetch 4xx/5xx | Retry with backoff; after max, `SKIPPED`; MSE continues on next good segment (no freeze) |
| **403/410 (token expired)** | **Not an error** — triggers token refresh (§12); re-IDLE with fresh uri/credentials, retry once |
| Token refresh API down / 429 | Exponential backoff on refresh, keep serving from the short reorder buffer, surface a notice after N failures |
| AES-128 key fetch denied (auth/cookie) | Route the key request through the same credential path as segments (§11.2); bound retries like any segment |
| Decrypt failure (bad IV/key, corrupted blob) | Mark segment `FAILED → SKIPPED`, continue; never emit partial ciphertext to MSE |
| ClearKey EME license/`update` error | Detach `MediaKeys`, fall back to native playback, one-time notice (§11.3) |
| MSE append error (codec mismatch) | Tear down MSE cleanly, fall back to native playback, surface a one-time notice |
| Out-of-order / late segment | Bounded reorder buffering; never append out of order |
| `GM_xmlhttpRequest` serialization stall | Per-segment timeout via `AbortSignal.timeout`; drop + retry the stalled segment |
| Segment host not in `@connect` | `GM_xmlhttpRequest` errors → report host, offer one-click config add (no silent fail) |
| Cross-origin manifest (no CORS) | Route manifest through `GM_xmlhttpRequest` (mode B) |
| **DRM (Widevine/FairPlay/PlayReady) or SAMPLE-AES** | **Refuse to route/engage** — the mandatory DRM gate (§11.4). Fall straight through to native playback |

> **DRM gate is mandatory (refined).** DRM and SAMPLE-AES streams are never re-routed through the
> userscript pipe. The gate *only* refuses **DRM / sample-encrypted / license-managed** flows —
> not **non-DRM encryption** (HLS AES-128 clear-key, DASH ClearKey-EME), which this design
> actively supports in §11. The intent is to (a) avoid breaking playback by carrying bytes MSE
> cannot already-encrypted consume, and (b) never touch license/certificate-managed content. Any
> manifest advertising `#EXT-X-KEY:METHOD=SAMPLE-AES`, Widevine/FairPlay/PlayReady, or an EME
> license exchange with a CDM falls through unmodified to the native player. Everything **else**
> (plain, token-only, AES-128 clear-key, DASH ClearKey-EME) is the routed surface this feature
> owns.

## 9. Integration with existing PlayerForge layers

- **`src/shared/storage.js`** — add `gmRequestBinary` (blob/arraybuffer) beside
  `gmRequestText`, and `gmRequestWithHeaders` (attach `Authorization` / referer / manager
  cookie on the token path). Reuse the `Promise.withResolvers` + status/error/timeout contract.
- **`src/shared/context.js`** — reuse the `AbortSignal.any([signal, AbortSignal.timeout(ms)])`
  pattern for per-segment timeouts.
- **`src/shared/dom-manager.js`** — reuse destroy-scoped listener/observer cleanup for MSE and
  the SegmentManager's per-video scope.
- **`src/kernel/sdk.js` / probe** — gate on the same `meetsMinSize`/probe used for video
  discovery; MSE attaches to the *same* video the shell already owns.
- **Config/menus** — a new `pf:proxy` config section + a TM menu toggle, wired exactly like
  existing menu commands in `kernel/menus.js`.
- **WebCrypto (`crypto.subtle`)** — native on FF, no grant; used for all AES-128 clear-key
  decryption (§11.2).
- **EME (`MediaKeys` ClearKey)** — native on FF via MSE; used for DASH ClearKey (§11.3) through
  the standard `video.setMediaKeys` path, no grant needed.

## 10. File layout (proposed `src/shell/proxy/`)

```
src/shell/proxy/
  manifest.js          # GM_webRequest rules + register/listener, @webRequest fallback
  rewrite.js           # pure .m3u8 / .mpd text rewriting (URL -> routed URL)
  provider.js          # ProxyProvider: GM_xmlhttpRequest / fetch / blob strategies
  mse.js               # MediaSource + SourceBuffer lifecycle, append gate
  segment-manager.js   # the flow state machine (§7.3), reorder buffer, backpressure
  gate.js              # arm/disarm, protection-classification, include-exclude policy (§11.4)
  decrypt-aes128.js    # pure AES-128-CBC segment decryption via WebCrypto (§11.2)
  eme-clearkey.js      # DASH ClearKey EME wiring: MediaKeys/encrypted/update (§11.3)
  token-manager.js     # refresh tokenized-stream state machine: TTL, refresh, URL rewrite (§12)
```

Pure functions (`rewrite.js`, `segment-manager.js` state transitions, `decrypt-aes128.js`,
`token-manager.js`) are unit-testable exactly like the existing `tests/` (jsdom where needed,
otherwise pure Node — WebCrypto is injectable, Web Crypto on Node is async via
`globalThis.crypto.subtle`). `mse.js`/`provider.js`/`eme-clearkey.js` wrap browser APIs behind
thin seams and are integration-tested via the existing `platform/harness` GM stubs (extend
`gm-stubs.mjs` with `GM_webRequest` + binary `GM_xmlhttpRequest` mocks) and `platform/run.mjs`.

## 11. All non-DRM encryption (the routed surface)

The proxy is not limited to plaintext streams. "Access control vs encryption vs DRM" are three
layers; this design routes the **plain**, the **token-only**, and the **non-DRM-encrypted**
layers, and refuses only genuine **DRM / sample-encryption**.

### 11.1 Protection classification (decided once per stream, at manifest parse)

`gate.js` classifies a stream the moment its manifest is parsed, and that class is fixed for the
stream's lifetime (re-classified on live-manifest reload):

| Class | Signal | Routable? | Decode path |
|---|---|---|---|
| **plain** | no `#EXT-X-KEY`, no `ContentProtection`, no token | ✅ | none (append as-is) |
| **tokenized** | signed/token URL or auth cookie only, segments unencrypted | ✅ | none; §12 handles refresh |
| **encrypted AES-128 clear key** | `#EXT-X-KEY:METHOD=AES-128,URI=...` (key format `identity`) | ✅ | §11.2 WebCrypto |
| **encrypted ClearKey-EME** | DASH `ContentProtection` ClearKey (`urn:uuid:e2719d58…`, or `cbcs`/`cenc` with clear key) | ✅ | §11.3 EME `MediaKeys` |
| **DRM / SAMPLE-AES** | Widevine/FairPlay/PlayReady `KEYFORMAT` or `METHOD=SAMPLE-AES` | ❌ | native player, never routed |

Classification must be **pure and total**: every manifest maps to exactly one class, and
ambiguous/unhandled tags fail closed to **plain-or-natural** (don't engage a path we might
misread). A `#EXT-X-KEY` with `METHOD=AES-128` and a `KEYFORMAT` that is *not* `identity` is
treated as non-routable unless the format is explicitly recognized.

### 11.2 HLS AES-128 clear key — decrypt in the pipe (WebCrypto)

AES-128-CBC encrypts **whole segments** ([RFC 8216](https://www.rfc-editor.org/info/rfc8216));
the key is delivered in the clear via the `URI=` in the manifest (usually gated by the same
cookie/token as the segments). This is precisely the "app-space decryption before the source
buffer" model hls.js already uses, and it's a natural fit for our inline pipe because **we** own
every byte handed to MSE.

Flow, per the AES-128 class:
1. **Key acquisition (cached, auth-aware):** fetch the `#EXT-X-KEY` `URI=` through the same
   proxy path as segments (`GM_xmlhttpRequest`, attaching the token/cookie from §12). Cache the
   16-byte key **keyed by URI** for the stream; re-fetch on rotation (`#EXT-X-KEY` changes) or
   on a 403/401 key request (which the token manager refreshes).
2. **IV derivation:** the per-segment IV is the tag's explicit `IV=` (hex) if present, else the
   media sequence number (`#EXT-X-MEDIA-SEQUENCE` + index), per RFC 8216. Computed in
   `decrypt-aes128.js` as pure logic.
3. **Decrypt (WebCrypto):** `crypto.subtle.importKey("raw", key, {name:"AES-CBC"}, false,
   ["decrypt"])` then `subtle.decrypt({name:"AES-CBC", iv}, key, ciphertext)` → cleartext
   segment → `appendBuffer`.
4. **Key drift / rotation:** AES-128 supports per-segment key URLs and rotation
   (`.key` changes mid-stream). `Segment.key` tracks which key applies; rotation triggers a cache
   invalidation for the new URI — never a mid-segment partial append.

Why WebCrypto and not EME for AES-128: AES-128 clear-key is not represented as an EME license
exchange; the browser's native HLS path on FF handles "clear key" internally for *non-proxied*
playback, but once we own the bytes we decrypt explicitly. WebCrypto is synchronous-safe (async
state machine), allocation-bounded, and needs no CDM — which keeps us firmly in the non-DRM
bucket.

### 11.3 DASH ClearKey (CCP) via EME `MediaKeys`

DASH ClearKey ([ClearKey Content Protection](https://github.com/Dash-Industry-Forum/ClearKey-Content-Protection))
signals a `ContentProtection` with the ClearKey schemeIdUri and a license-session laurl; the
*media* is CENC (`cenc`/`cbcs`) and is decrypted by the **Content Decryption Module**, not by us.
So for this class we hand EME the session and let MSE append the (still-encrypted to the CDM)
bytes:

1. Classify as ClearKey (§11.1). Attach a `MediaKeys` (ClearKey) to the `<video>` via
   `navigator.requestMediaKeySystemAccess("org.w3.clearkey", config)` →
   `createMediaKeys` → `video.setMediaKeys`.
2. MSE `SourceBuffer` still feeds encrypted bytes (the CDM decrypts at decode time); we keep
   ordering/backpressure unchanged — *only* the `DECRYPTING` lane differs from AES-128 (here it
   is key-session setup, not per-segment decrypt).
3. On the video's `encrypted` event → build the JSON license request (kids/KID/base64, type
   `temporary`), POST to the laurl (via `gmRequestWithHeaders`, since it is cross-origin and
   possibly token-gated), feed the JSON license response to
   `mediaKeySession.update()`, then `message`/`keystatuseschange` drives remaining sessions.
4. **Gate caveat:** if `MediaKeys` construction or the license response fails, detach cleanly
   (`video.setMediaKeys(null)`) and fall back to native playback — never leave a half-attached
   CDM. This keeps ClearKey *best-effort*, unlike DRM which we refuse up front.

### 11.4 Refined gate rule

`gate.js` enforces: **route `plain`, `tokenized`, `AES-128`, `ClearKey`; never route `SAMPLE-AES`
or Widevine/FairPlay/PlayReady.** The classification run is the single decision point — it
happens once, is pure, unit-tested, and every later subsystem trusts it (no piecemeal
encryption checks scattered through the segment path).

## 12. Refresh-tokenized streams (the credential state machine)

Token-protected streams (signed URLs, path/query tokens, auth cookies) are encrypted-or-not but
always **time-limited**: the credential expires mid-playback (live: often 1–5 min TTL; VOD:
5–30 min) and the *next* segment/manifest/key request returns **403/410**. "Support refresh
tokenized streams" means PlayerForge must renew the credential and rewrite every outstanding
URL — manifest, key, and segment — without a visible interruption.

### 12.1 The `token-manager` state machine

Per-stream credential state:

```
Token { token, ip?, expiresAt, ttl, cookie?, header? , issuedAt }
```

Transitions:

```
                    token API 200
  IDLE ──(register provider + TTL)──► ARMED ──(timer fires ~T/2 before expiresAt)──► REFRESHING
   │                                     │                                              │
   │                                     └────(expired/403, no time to pre-refresh)───────┘
   └──(destroy/teardown)────────────────► new token ──► ARMED (reset timer)
```

- **Provider:** a configurable async `getToken()` (user-supplied token API URL) returning
  `{ token, expires }` — same contract as hls.js `TokenRewriteLoader` / dash.js
  `RequestModifier` (§12.2). If no provider is configured, the manager is *passive*: it only
  reacts to 403 → attempt refresh from the provider, else degrade to native playback.
- **Proactive refresh:** a timer (no wall-clock dependence in state logic — the *timer*, not the
  decision, tracks wall time) fires at `expiresAt - max(2s, ttl/2)`; on success rewrites every
  registered URL template and re-arms.
- **Reactive refresh:** any 403/410 on a routed request (segment, key, or manifest) is routed to
  the manager, which refreshes once and retries that request (per §7.3 token-aware transition).
- **URL rewrite:** the manager owns a rewrite function that substitutes the live token into
  either path form (`/{token}/{expires}/...`) or query form (`?md5=...&expires=...`) on **every**
  outgoing request it controls. Because we own segment fetch (`GM_xmlhttpRequest`) and manifest
  fetch (interposed `fetch`/`GM_xmlhttpRequest`), every URL passes through it — the same seam the
  repo's manifest rewrite (§6) already establishes.
- **IP-bound tokens:** if the provider returns `token_ip` + `client_ip`, prefer the bound token;
  TCP/IP observation is out of scope but honored if exposed by the provider contract.
- **Signed-cookie tokens:** if the stream auths via a *cookie* (set by the page backend), the
  manager's job reduces to (a) refreshing the cookie via the provider before expiry and (b)
  ensuring each `GM_xmlhttpRequest` carries it via `gmRequestWithHeaders` (boilerplate: TM
  forwards the tab's cookies to `@connect`-allowed hosts).
- **Teardown:** destroy-scoped; on player change / page unload clears the timer, aborts any
  in-flight refresh, drops the reorder buffer (§7.3).

### 12.2 Provider contract (matches player-loader conventions)

To stay drop-in with ecosystem loaders and let the same design serve native, hls.js, and dash.js
targets:

```
getToken() -> Promise<{ token, token_ip?, client_ip?, expires, url?, url_ip?, cookie? }>
rewriteUrl(uri, state) -> string     // inject live {token}/{expires} or query token
```

- Our manifest interposition (§6) and every `GM_xmlhttpRequest` **always** call `rewriteUrl` last,
  so a stale token can never escape once the manager is armed.
- If the page already runs hls.js/dash.js with a built-in token-rewriting loader, our interposed
  manifest pass-through must **not** double-rewrite: detect an existing loader token contract and
  hand control of URL rewriting to it, keeping our manager only as the *audit/observe* layer.

### 12.3 Token + encryption interaction

- A **tokenized AES-128** stream (§11.2) is common: segments and the **key** share the token
  scope. The key fetch goes through the same credential path and the token manager refreshes
  both the key request and the segment requests (§11.2 step 1).
- A **tokenized ClearKey** stream (§11.3) is also possible: the *laurl license request* carries
  the token, so `update()`/`message` re-arm after a token change. The manager must refresh the
  license flow driver, not just the segment URLs.
- **Cache-key hygiene:** when the token is part of the URL/cookie, the browser CDN/cache key
  must strip it (a manager-side concern only when we interpose; document it so users configure
  Query-String Forwarding the way gcore/CloudFront require).

## 13. Known TM limitations baked into the design

- `GM_webRequest` intercepts only `xhr`/`script`/`sub_frame`/`websocket` — hence the manifest
  route (§6), not the segment route.
- `GM_xmlhttpRequest` requests are **serialized** (closed `tampermonkey/tampermonkey#2215`) and
  fire one progress event — hence **segment-granular** requests and the concurrency-one-per-lane
  rule, not byte streaming.
- `GM_webRequest` experimental + MV2-only → **feature-detected**, never required.
- Firefox webRequest needs host permission; as a userscript the manager holds
  `@connect *` / `@match *://*/*`, which is why this works on FF MV2 at all.

## 14. Testing strategy

- **Unit (node:test, jsdom where needed):**
  - `rewrite.test.mjs` — .m3u8/.mpd rewrite is byte-stable on unarmed/out-of-scope input; correct
    per-line URI rewrite; token rewrite (§12.2) on path and query forms; non-routable-manifest
    refusal.
  - `gate.test.mjs` — protection-classification is **pure/total**: every sample manifest maps to
    exactly one class (§11.1); arm/disarm transitions; per-site include/exclude; **SAMPLE-AES /
    DRM refusal**; ambiguous tag fails closed.
  - `segment-manager.test.mjs` — state transitions (incl. `DECRYPTING` and the token-aware
    403→`TOKEN_REFRESH` transition): ordering, reorder buffering, bounded retries, SKIPPED
    semantics, abort on pause/seek/teardown, backpressure (cap pending bytes).
  - `decrypt-aes128.test.mjs` — known-vector AES-128-CBC decrypt, explicit vs sequence IV,
    key-cache hit/miss/rotation, corrupted-blob fail-to-SKIP, never partial append.
  - `token-manager.test.mjs` — proactive (timer) + reactive (403) refresh with an injectable
    clock, URL rewrite on every request, refresh-API failure backoff, teardown clears timer and
    aborts in-flight, IP-bound/cookie variants.
- **Integration (platform/harness):** extend `gm-stubs.mjs` with a `GM_webRequest` recorder, a
  binary + header-bearing `GM_xmlhttpRequest`, a fake segment source, and a fake token API /
  ClearKey license server. Assert: MSE receives segments in sequence order, decrypt/ClearKey
  paths produce only cleartext/valid-EME appends, token rotation swaps out stale URLs, and abort
  leaves zero in-flight.
- **Determinism:** no wall-clock branches; injectable AbortSignal/timeout and a fake append clock;
  matches the repo's determinism rule.
- **Opt-in workflow (seam) tests:** with an in-process fake page player that commits bytes to the
  video, assert — for engage modes `auto`/`ask`/`manual` — every claim happens only in the
  `(t1, t2)` window and only when the ablation guard passes; that a missed `t2` degrades to
  native (never a mid-stream MSE rip); that `ask` engages only after consent; and that
  disarm mid-stream + downgrade both "fail toward native" with zero frozen-screen frames.

## 15. Scoping / phasing

1. **Phase 1 — Flow core (no browser sim needed):** `gate.js` (incl. protection
   classification §11.1) + `segment-manager.js` (incl. the `DECRYPTING`/token-aware
   transitions §7.3) + `rewrite.js` pure logic + unit tests. Fully testable headless.
2. **Phase 2 — Decrypt + token pure logic:** `decrypt-aes128.js` (WebCrypto, IV derivation,
   key cache, rotation) + `token-manager.js` (TTL state machine, proactive/reactive refresh,
   URL rewrite) + unit tests with an injectable clock and `crypto.subtle`.
3. **Phase 3 — Transport + MSE seams:** `provider.js` (GM_xmlhttpRequest binary + headers) +
   `mse.js`, backed by harness-level stubs + integration tests.
4. **Phase 4 — Encryption + token browser wiring:** `eme-clearkey.js` (`MediaKeys`/`encrypted`/
   `update`) + provider contract (§12.2); live FF validation against a ClearKey sample and a
   tokenized HLS sample.
5. **Phase 5 — Manifest interposition + opt-in workflow:** `manifest.js` (`GM_webRequest` +
   interposed fetch/XHR rewrite) + the §7.4 seam logic (claim point `t2`, ablation guard,
   engage modes `auto`/`ask`/`manual`, first-run consent, disarm/downgrade-fail-toward-native)
   + banner `@grant GM_webRequest` + `@webRequest` header + config/menu toggle (`pf:proxy`)
   + live FF validation tracking, for the moment a page player is a moving target we must not
   visibly disturb while taking over.

## 16. Open questions (to resolve before implementation)

- Which players are the primary targets (custom HLS via `hls.js`? native HLS on FF with MSE?
  DASH via `dash.js`)? FF supports MSE for HLS natively, so native-HLS is the MVP path —
  and native-FF HLS already decrypts AES-128 clear-key internally, so confirm whether routing
  should *always* win over letting the engine's own clear-key path handle it.
- For DASH ClearKey, which license-server exchange shape(s) to support first (the DASH-IF
  ClearKey laurl JSON contract in §11.3, plus common platform variants)?
- Which token formats does the provider contract need first — path `{token}/{expires}`, query
  `?md5&expires`, or signed-cookie? Scope the pro-active timer to the first real provider.
- **Which feed target is the MVP takeover — native FF NativeHLS, or a page lib like hls.js?**
  The `#adoptVideo` discovery path already sees the `<video>`; but whether the *manifest is
  routable* depends on who owns the fetch. NativeHLS routes via §7.4.5 (swap src at `t2`,
  `readyState` still `HAVE_NOTHING`); hls.js/dash.js route via the interposed `fetch`/XHR
  rewrite (§6). Confirm the first real target so §7.4.4's ablation guard is tuned to it.
- **Consent default:** is the first-run "route this video?" consent default **off** (pure
  opt-in, `ask`/`manual`), or on-but-per-session with an easy downgrade? This decides the
  practical surprise surface the whole seam design is protecting.
- **Engage-mode default per site:** should `auto` be gated behind user-provided include rules,
  or behind the per-site list itself (i.e., opt-in site list = auto-engage there)? Recommend:
  explicit site allow-list first; `auto` only within it.
- Should the "proxy" support per-segment `Range` requests (byte-range indexing) or only
  whole-segment? Whole-segment first; Range added to `Segment.byteRange`.
- Is a remote proxy host ever desired later? The design keeps `ProxyProvider` an interface so a
  remote strategy (e.g., `proxy?url=...`) can slot in without touching the flow manager.
