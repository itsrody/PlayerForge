# PlayerForge 2.0 — Gecko-native engine architecture

Status: design proposal. No implementation yet.
Target: Gecko 157+ (floor), tested on Firefox Developer Edition 158.0b3.
Manager contract: Violentmonkey MV2 2.49+.

## 0. Scope

In scope: the engine underneath the HUD.

Out of scope: HUD visual design, markup structure, CSS, panel layout. The existing
markup and styling are treated as a frozen contract that the new engine must
drive byte-identically. This keeps the rewrite reviewable and lets the engine
land independently of any design work.

Out of scope: Chromium. `src/shell/chrome/` is historical naming, not Chromium code.

## 1. Honest starting point: most of 2.0 already exists

A survey of the current tree shows the passive, event-driven, Gecko-native
engine is substantially built already. Before proposing new architecture, this
section records what is present, because the correct 2.0 is a consolidation,
not a rewrite.

| Capability | Present as | Notes |
| --- | --- | --- |
| Teardown primitive | `src/shared/scope.js` | `Scope`: one `AbortController`, idempotent `dispose()`, reverse-order disposers, child scopes, isolated disposer errors |
| Passive activity windows | `src/shared/activity.js` | `createActivity()`: zero work until an edge fires; work scope minted on enter, disposed on exit; edges not events; `isActive()` reads the platform property at the moment Gecko fires |
| Host scheduling facade | `src/shared/scheduler.js` | `postTask`, `delay`, `debounce` (+`.flush()`/`.cancel()`), `yield_()` |
| Frame coalescing on mutation | `src/shared/dom-manager.js` | MutationObserver with deferred flush |
| Visibility gating | `src/shell/resume.js:685` | IntersectionObserver for off-screen carousel progress |
| Media session integration | `src/shell/media.js:220` | `claimMediaSession()` |
| Observer-based adoption | `src/kernel/sdk.js`, `kernel.js`, `lifecycle.js` | MutationObserver-based `<video>` discovery and settle detection |

Evidence that the idle-cost goal is already largely met:

- `setInterval` appears exactly once in the whole tree, at
  `src/shell/chrome/panel.js:101`, as a key-hold auto-repeat. That is a
  user-driven input affordance, not polling.
- `requestAnimationFrame` appears only in `src/shared/diagnostics.js` (a
  diagnostic frame-gap probe, debug-gated) and in `scheduler.js`'s `yield_()`.
- `requestIdleCallback` is not used at all.
- There is no unconditional rAF loop in the shipping path.

So the remaining work is narrower than a redesign. It is:

1. An explicit, enumerable per-player status model.
2. A coalescing, priority-routed, single-commit render gate.
3. A snapshot-diffing renderer that stops redundant DOM writes.
4. HUD occlusion gating on player visibility.
5. A single source of truth for engine capability and realm.
6. Frame-quality signals, used within Gecko's limits.

## 2. Gecko knowledge this design depends on

### 2.1 Refresh tick order

From the Gecko profiler marker definitions, a refresh tick runs:

```
RefreshDriverTick
├── requestAnimationFrame callbacks   <- FIRST, before any style flush
├── FireScrollEvent
├── Styles
├── Reflow
├── DispatchSynthMouseMove
├── DisplayList
├── LayerBuilding
├── Rasterize
├── ForwardTransaction
└── NotifyDidPaint                   (post-refresh GC chunk)
compositor thread: LayerTransaction (incl. texture upload), Composite
```

Two consequences:

- rAF runs before the style and layout flush, so DOM writes issued from rAF are
  absorbed into that tick's flush. rAF is the cheapest place to write DOM.
- rAF fires on vsync whether or not anything changed. A permanent rAF loop is
  therefore a permanent per-frame cost. This is why the engine must stay
  demand-triggered and must never adopt a rAF spin.

### 2.2 WebRender caching

WebRender's unit of "expected to update together" is the **Slice** — "a
grouping of pictures that are expected to render and update together". A slice
that is not expected to change much gets a `TileCacheInstance`, which
subdivides into `Tile`s. Each tile tracks what is in it and what is changing,
so "the 'damage' from changes can be localized to single tiles, while we
salvage the rest of the cache." Tiles that keep seeing invalidations
"recursively divide themselves in a quad-tree like structure to try and
localize the invalidations", and recombine when they settle.

Tile damage is detected by **interning**:

> "To spot invalidated tiles, we need a fast way to compare its contents from
> the previous frame with the current frame. To speed this up, we use interning;
> similar to string-interning, this means that each `TextRun`, `Decoration`,
> `Image` and so on is registered in a repository (a `DataStore`) and
> consequently referred to by its unique ID. Cache contents can then be encoded
> as a list of IDs (one such list per internable element type). Diffing is then
> just a fast list comparison."
> — Firefox Source Docs, Rendering Overview §Interning

#### Correcting an earlier draft of this section

An earlier draft argued: "writing a DOM property whose value did not actually
change changes its interned ID, invalidates its tile, and forces re-raster plus
texture upload." **That mechanism is wrong, and it matters.** Interning is
*content-addressed*: a value that renders identically interns to the *same* ID,
so WebRender's diff correctly finds nothing changed and preserves the tile.
Interning exists precisely to make unchanged content free. Claiming otherwise
would justify a much heavier write-guard system than the platform requires.

The real cost of a redundant write sits **upstream of WebRender**, in style
invalidation, and Gecko's own documentation is refreshingly candid about not
being able to fully answer it. `DynamicChangeHandling.md` states:

> "For many types of changes, however, there is substantial overhead to
> processing a change, no matter how small. For example, reflow must propagate
> from the top of the frame tree down to the frames that are dirty, no matter
> how small the change."

and then lists batching strategies (tree-based style reresolution batching,
deferred frame reconstruction, deferred reflow, OS-queued invalidates) —
concluding with two literal open items: **"TODO: how style system optimizes away
rerunning selector matching"** and **"TODO: style changes and nsChangeHint"**.
Whether an identical-value write still produces a change hint is exactly the
question the cited source leaves unresolved.

So compare-before-write is still the right discipline, but it must be justified
honestly and verified rather than assumed:

1. It is cheap insurance at the DOM boundary — one integer compare against a
   snapshot.
2. Gecko genuinely batches notifications tree-wise, so *coalescing* writes has a
   real, documented payoff, independent of whether any single write is a no-op.
3. The magnitude of the win is **an open question this project should measure**,
   not a settled fact. See the `playerforge 2.0 write-cost` measurement in §5.

### 2.3 Observer delivery timing

| API | Measured | Callback runs |
| --- | --- | --- |
| `ResizeObserver` | after layout, in-frame | in-frame; handler can cause further layout, so keep it trivial |
| `IntersectionObserver` | during frame generation | posted as a task, after the frame finishes |
| `PerformanceObserver` paint/event timing | after paint | post-task |

Gecko and Blink both order `ResizeObserver` before `IntersectionObserver`.
IntersectionObserver is explicitly not for frame-precise work. That suits HUD
occlusion gating, which is not frame-critical.

### 2.4 Two measured Gecko traps already recorded in this tree

These are documented in `src/shared/scheduler.js` and were found empirically.
2.0 must not regress either.

**Trap 1 — a self-rearming `postTask` starves rendering.** A 40-deep
self-rearming `user-visible` `postTask` chain was measured draining in 0.26 ms
with zero rAF callbacks in between, against an idle rAF baseline of 25 frames
per 200 ms. The zero is starvation, not a dead frame. Consequence: `postTask` is
only ever used for one-shot deferred work, re-armed from a MutationObserver
callback or a timer. A retry or spin loop built on `postTask` would freeze paint
and input for the whole page.

**Trap 2 — `scheduler.yield()` poisons an aborted continuation.** `yield()`
inherits the calling task's scheduling state, including its abort signal. A
`postTask` task that aborts its own handle leaves an aborted source behind, so a
`yield()` awaited in that task's continuation rejects with `AbortError`. This
killed shell boot outright, leaving no panel, no `data-pf-shell` mark, and a
logger-only error.

This is not a Gecko quirk to be worked around — it is **specified, intentional
behaviour**, which makes it a permanent architectural constraint rather than
something that might get fixed:

> "The priority of the continuation and the signal used to abort it are
> inherited from the originating task. If the originating task was scheduled
> with via `postTask()` with an `AbortSignal`, then that signal is used to
> determine if the continuation is aborted."
> — Prioritized Task Scheduling, §2.2

The algorithm reads the current scheduling state, takes its `abort source`, and
rejects immediately if that source is already aborted. Consequence: the engine
uses the hand-written `yield_()` (rAF raced with a 50 ms backstop, MessageChannel
on hidden documents) and never reads `scheduler.yield`.

Both are load-bearing. Any 2.0 scheduler must preserve them.

### 2.5 `requestVideoFrameCallback` in Gecko

rVFC fires on frame submission for composition, at the lower of the video frame
rate and the display refresh rate. Metadata includes `mediaTime`,
`presentationTime`, `presentedFrames`, `width`, `height`, `processingDuration`.

Gecko-specific caveat, **bug 1935256**, reported as "requestVideoFrameCallback
intervals limited to 40ms". Stated precisely, because an earlier draft of this
document overstated it:

- The reporter measured rVFC firing every 40 ms on a 60 fps video, with
  `metadata.presentedFrames` showing the skipped frames, and confirmed by
  running rAF alongside it to rule out animation-frame throttling.
- The reporter states it has been present "since the very first release that
  supported rVFC (131 with beta releases)" and still occurs on nightly.
- **Status is `UNCONFIRMED`.** It is S3, unassigned, has sat without triage
  activity for about a year, and carries the `behind-pref` flag — the throttle
  is gated behind a preference. Tracking flags reference 157/158/159 without a
  resolution.

So this is a reproducible user report, not a triaged or confirmed Gecko defect,
and it may be adjustable by pref. The design rule below does not depend on it
being confirmed:

Design rule: treat rVFC cadence in Gecko as **not guaranteed to be one callback
per video frame**, and never let it back a frame-accurate feature. Where real
quality metrics are needed, prefer `getVideoPlaybackQuality()`,
`mozPresentedFrames`, and `mozPaintedFrames`, which are Firefox-specific and
not subject to this cadence question. The `behind-pref` flag is also a reason to
re-test rVFC cadence before building anything on top of it.

### 2.6 Scheduler priorities

`scheduler.postTask` is available from Firefox 142, so it is safely inside the
157 floor. Priorities are `user-blocking` > `user-visible` (default) >
`background`.

Per spec, continuations get a strictly higher effective priority than tasks of
the same level, which is the theoretical reason to prefer `yield()` for
chunking. Confirmed by the spec's effective-priority table: `background`
task = 0 but continuation = 1; `user-visible` task = 2, continuation = 3;
`user-blocking` task = 4, continuation = 5. Trap 2 rules `yield()` out anyway,
so chunking uses `yield_()`.

#### There is no `scheduler.render()`

An earlier draft of this document proposed `scheduler.render()` as the await
point for "the frame I dirtied has been painted". **That API does not exist and
must not be a design dependency.** Verified against the current spec:

- The `Scheduler` WebIDL interface defines exactly two members — `postTask()`
  and `yield()`. There is no third method.
- The string `scheduler.render` does not appear anywhere in the spec, including
  the table of contents, the IDL index, and the issues index.
- MDN's `Scheduler` reference lists only those two instance methods. There is no
  `Scheduler/render` page (it 404s).
- `scheduler.render()` appears only in the WICG **explainer**, as a proposed
  "High Priority Rendering Updates" API alongside `scheduler.wait()`. Prose in
  an explainer is not a shipping contract.

Consequence for 2.0: there is no portable "await the next paint" primitive, so
the engine must not pretend otherwise. The honest options, in order:

| Need | Mechanism | Guarantee |
| --- | --- | --- |
| Yield to the browser between chunks | existing `yield_()` | next refresh tick, with a 50 ms backstop |
| "Stop until the next frame" | one-shot `requestAnimationFrame` | callback runs at the *start* of the next refresh tick, before the style flush (§2.1). DOM written there lands in that tick. |
| "The frame I dirtied has been painted" | `PerformanceObserver` on `paint`, or frame-gap sampling in the existing debug probe | coarse, and asynchronous |

Use the first for chunking and the second for "next frame". Only reach for the
third in diagnostics, and treat it as a measurement, not a fence. `L0
EngineHost` no longer claims a `#canRender` capability; if a future Gecko ships
a render primitive, it can be feature-detected and adopted then, behind the
existing facade, without the architecture having depended on it.

### 2.7 Violentmonkey 2.49 realm behaviour

`v2.49.0` shipped 6 Sep 2026, requires Firefox 57+ / Android 121+, and the
Firefox build is MV2. Its changes are unrelated to us: sync no longer overwrites
metadata, `GM_registerMenuCommand` can now update an existing command's text and
icon, editor search fixes, MV3 execution-order preservation after edit, Ctrl-S in
editor settings on non-English layouts.

The load-bearing detail is `@inject-into`, whose default is `auto`: page context
if possible, content context (isolated world) if CSP blocks inline injection. In
content mode the script cannot touch page JS objects directly, though Firefox
grants `wrappedJSObject`, `cloneInto`, and `exportFunction`. `GM_info.injectInto`
reports the mode actually granted at runtime.

Consequence: the engine must stay realm-agnostic. The same install may land in
either realm depending on the target site's CSP, so no page-object access may be
assumed. Native scripting API is `browser.userScripts.register()` with
`worldId`; a custom `worldId` executes in the MAIN world.

#### Greasemonkey corroborates the realm, and contradicts the GM_* surface

Greasemonkey is the original userscript manager and the Firefox-native one, so
it is the right place to check whether the preceding paragraph describes
Violentmonkey's quirks or userscript reality in general. Read at source level on
`master` (`manifest.json` version 4.14, MV2, `strict_min_version` 120.0):

- **There is no realm directive at all.** The string `inject-into` and the
  identifier `injectInto` appear **zero times** in the entire Greasemonkey
  source tree. There is nothing to pin.
- **It never uses `browser.userScripts`.** No `userScripts.register()` call
  exists; the manifest does not even request the `userScripts` permission. It
  injects the old MV2 way — `src/bg/execute.js` calls
  `chrome.tabs.executeScript({ code, matchAboutBlank: true, runAt, frameId })`,
  which lands in the extension's **isolated content-script world, always**.
- Evidence of that world is in the generated wrapper itself
  (`src/user-script-obj.js`): every script is emitted as
  `try { (function scopeWrapper(){ function userScript() { … } const
  unsafeWindow = window.wrappedJSObject; … userScript(); })(); }`, i.e. an
  Xray view of the page plus a `wrappedJSObject` escape hatch.
- **`@grant none` means "no APIs", not "page context".** `api-provider-source.js`
  returns the literal `/* No grants, no APIs. */` for a `none`-only grant list.
  This is the well-known Greasemonkey 4 break from Greasemonkey 3, and it is the
  decisive data point: **on the most Firefox-native manager, a granted script
  cannot choose page realm and does not get it.**

This substantially strengthens §2.7's conclusion. Content realm is not a
Violentmonkey quirk to be tolerated, nor something PF merely declines to exploit.
It is the only outcome the ecosystem reliably offers a granted script, so a
realm-agnostic engine is not defensive over-engineering — it is the design that
matches every manager's actual behaviour. PlayerForge's existing
selector-only detection (`src/kernel/sdk.js`), which never reads a page-defined
global or an expando, is therefore not merely adequate but correctly targeted.

#### What Greasemonkey does *not* have, and why that is fine

The `GM_*` surface is where the two managers genuinely diverge, and it confirms
that the realm-agnostic reasoning must not be over-generalised into
"manager-agnostic". Greasemonkey 4's entire supported set is eleven promise-based
names, from `src/supported-apis.js`:

```
GM.deleteValue   GM.getValue      GM.listValues    GM.setValue
GM.getResourceUrl  GM.notification  GM.openInTab  GM.registerMenuCommand
GM.setClipboard    GM.xmlHttpRequest
```

Every one is implemented as a `chrome.runtime.sendMessage` round trip returning
`new Promise(...)`. Measured against PlayerForge's eight grants, that is a clean
split:

| PlayerForge grant | Greasemonkey 4 | Consequence if GM were ever targeted |
| --- | --- | --- |
| `GM_getValue`, `GM_setValue` | `GM.getValue` / `GM.setValue`, promise-returning | PF reads its whole config document synchronously during boot. A promise-returning shape hands it a Promise and stalls the entry path — precisely the failure `platform/capabilities.json` already predicts. |
| `GM_xmlhttpRequest` | `GM.xmlHttpRequest`, promise-returning | PF's callback-based subtitle fetch would never fire its handler. |
| `GM_registerMenuCommand` | `GM.registerMenuCommand`, **different signature and no return value** | GM's third argument is a string `accessKey`, not VM's options object; and the function returns nothing, so PF's stored handle has nothing to hold. |
| `GM_unregisterMenuCommand` | **absent entirely** | No counterpart. Greasemonkey tears the entry down implicitly by disconnecting its port on a trusted `unload` event, so PF's symmetric store-then-hand-back pattern cannot exist. |
| `GM_getResourceText` | **absent entirely** | Greasemonkey's own source carries the comment `// TODO: GM_getResourceText -- maybe.` in `api-provider-source.js`. PF's stylesheet warm-load is already a probed optimisation that degrades to plain adoption, so this costs nothing. |
| `GM_addValueChangeListener`, `GM_removeValueChangeListener` | **absent entirely** | No cross-tab resume sync; PF already degrades to next-load sync, per `capabilities.json`. |
| `GM_info` (ungranted) | `GM.info`, aliased to `const GM_info` | **Works.** See below. |

So the honest summary is: PF's *realm* assumptions generalise to every manager,
while its *`GM_*` contract is deliberately VM-specific. The shipped banner says
"Requires Violentmonkey", and this table is the concrete reason that wording is
accurate rather than lazy. This is recorded as background knowledge only — no
Greasemonkey support is planned, proposed, or implied, and nothing here is a
work item.

One incidental gain: `calculateGmInfo()` in `user-script-obj.js` stamps
`scriptHandler: 'Greasemonkey'` into the metadata object, which VM likewise
populates. Since PF already reads `GM_info.script.version` for its version
source, `GM_info.scriptHandler` is a free, reliable manager fingerprint for the
existing diagnostics surface, should that ever be wanted.

#### A caution this research produced

Greasemonkey parses `@noframes` into `user-script-obj.js` and exposes it through
a getter, but the identifier appears in only five places in the whole tree — all
of them parsing or storage. `execute.js` sets `frameId` for sub-frames without
ever consulting `noFrames`, so as of 4.14 the directive is parsed and not
enforced. That is Greasemonkey's bug, not a licence to rely on it, and it is
worth recording for one reason: it independently confirms this project's existing
methodology. `esbuild.config.mjs` derives the GM contract from 2.49.0's shipped
`injected-web.js` **rather than its documentation**, and that instinct has now
been vindicated twice — once for VM's `@connect` being parsed but never
consulted, and here again for GM's `@noframes`. Manager docs describe intent;
manager source describes behaviour.

PlayerForge itself declares no frame key at all and self-guards per frame, so it
is unaffected by either manager's frame-gating behaviour.

### 2.8 Version landscape

Firefox 157 (Stable, 29 Sep 2026) is the floor: `@supports at-rule()`,
`overscroll-behavior: chain`, WebGPU `TRANSIENT_ATTACHMENT`,
`Animation.reverse()` playbackRate-0 behaviour, scroll-driven animation
playbackRate mirroring, WebDriver BiDi `setDownloadBehavior` tightening.

Firefox 158 is Beta and ships 13 Oct 2026. Its web-developer change list is still
empty; add-on side it adds `runtime.getVersion()` and changes
`publicSuffix.isKnownSuffix()` to throw on an invalid hostname instead of
returning `false`.

## 3. Reference-architecture cross-check

Two mature codebases were read at source level to challenge this design rather
than decorate it. Both produced findings that changed it — one removed a
non-existent API (§2.6), one corrected a false performance rationale (§2.2).
Verdicts are recorded explicitly, including the ideas that were **rejected**, so
later phases do not re-litigate them or reintroduce them by accident.

### 3.1 uBlock Origin — uBO's public engine

Source read: `src/js/dom.js`, `mrucache.js`, `static-ext-filtering.js`,
`hntrie.js`, `cosmetic-filtering.js`.

Worth adopting (FIT):

- **Delegated events with containment guards.** uBO registers listeners on the
  document/root once and uses `closest()` plus an explicit containment check,
  rather than per-node listeners. Same shape as PlayerForge's event delegation.
- **One-shot `IntersectionObserver` (`onFirstShown`).** uBO disconnects the
  observer after the first intersection. Directly analogous to L1's occlusion
  gating and to the existing `src/shell/resume.js:685` observer: pay once, then
  stop.
- **Coarse parse → specialized engine dispatch.**
  `static-ext-filtering.js` parses once, then routes to cosmetic / html /
  httpheader / scriptlet engines, with `freeze()` on compiled structures and
  `toSelfie()`/`fromSelfie()` for serialization. Supports the §1 principle of
  classifying work cheaply before doing expensive work.
- **Snapshot integrity via checksum.** `hntrie.js` stores a self-describing
  typed-array buffer and validates it with a djb2 checksum, rejecting a
  mismatched snapshot rather than reading garbage.
- **Content-addressed memoization.** A last-value/one-slot memo (e.g.
  `setNeedle`, and `storeHostname`'s `lastStored` short-circuit) is used
  throughout to skip redundant re-parsing.

Rejected (NON-FIT):

- **hntrie typed-array trie / WASM trie.** NON-FIT. It is designed for uBO's
  large multi-hundred-thousand-entry filter sets. PlayerForge handles a handful
  of hostnames and a small rule set; the complexity, serialization surface, and
  checksum plumbing are not justified. The direction of travel reinforces this:
  `master` now carries `biditrie.js` alongside `hntrie.js`, i.e. uBO is on a
  later generation of trie specialization for filter volumes orders of magnitude
  larger than PlayerForge's.
- **MRU cache.** NON-FIT. PlayerForge's SDK caches are already `WeakMap`-based
  and do not need LRU promotion for this scale.

An instructive NON-adoption, on the question that matters most to L5:

- **uBO does not guard redundant DOM writes.** `dom.js`'s `attr()` writes
  unconditionally, with no comparison against the current value, and current
  `cosmetic-filtering.js` contains no `setAttribute` call at all — DOM
  application has been moved out of the file that parses cosmetics. So uBO is
  *not* a precedent for a compare-before-write reconciler, and this design
  should not cite it as one. The precedents for value-diffing come from Media
  Chrome's template layer (§3.2) and from Gecko's own batching model (§2.2),
  where the payoff is real but the exact no-op behaviour is admittedly an open
  question. That is why §5 treats the win as something to measure.

### 3.2 Media Chrome — media UI state machine

Source read: `src/js/media-store/request-map.ts`, `state-mediator.ts`,
`media-store.ts`, `media-controller.ts`, `media-theme-element.ts`,
`constants.ts`.

This is the closest architectural analogue to the HUD: a media UI that turns
media-element events into a rendered control surface. Findings:

- **Requests and state are strictly separated, with two distinct namespaces.**
  `MediaUIEvents` holds ~23 *request* events (`mediaplayrequest`,
  `mediapauserequest`, `mediaseekrequest`, `mediavolumerequest`,
  `mediaenterpiprequest`, …) while `MediaUIProps` holds ~47 *observed state*
  properties (`mediaPaused`, `mediaCurrentTime`, `mediaVolume`,
  `mediaIsPip`, `mediaLoading`, …). This is the cleanest confirmation of L2's
  split: PlayerForge's `PlayerStatus` (observed) must stay separate from
  anything intent-shaped, and Media Chrome shows the separation is not optional
  bookkeeping — it is the whole design.
- **State is never written from a request; requests only *attempt* to fulfil
  state, and real state changes arrive from the media element.** A request
  handler may return `Partial<MediaState>` for derived values (e.g. loop,
  preview image) but the authoritative `mediaPaused` value comes from the
  element's actual events, not from the click. **This is the single most
  important import for PlayerForge:** status must be written only from observed
  media/visibility events, never optimistically from a keypress or click.
  Otherwise the HUD lies the moment `video.play()` is rejected by autoplay
  policy or returns a rejected promise.
- **Cross-axis invariants are enforced at the request boundary, not the render
  layer.** e.g. volume-request unmutes if muted; unmute-request raises a zero
  volume; enter-PiP exits fullscreen. Related axes are reconciled together at
  the point of intent. Supports L2's orthogonal-axes model: coupled axes resolve
  coherently at one boundary instead of drifting until render.
- **Capability/availability is modelled as state, not as a static check.**
  Properties like `mediaAirplayUnavailable`, `mediaPipUnavailable`,
  `mediaVolumeUnavailable` make "can I even do this" a first-class observable
  axis. This is an alternative to a static `EngineHost` capability map: media
  Chrome's per-feature availability can change at runtime (e.g. leaving PiP),
  which a static `canX` cannot express. PlayerForge should treat per-feature
  availability as part of `PlayerStatus` where it can change, and keep only
  truly static environment facts (engine, realm, scheduler) in L0.
- **Attribute↔event mappings are derived, not hand-maintained.**
  `StateChangeEventToAttributeMap` and its inverse are computed from a single
  registry, so they cannot drift. L5's reconciler should likewise derive its
  attribute set from one table.
- **The render entry point is readiness-gated and diffed by the template
  layer.** `media-theme-element.ts` re-reads all observed attributes into a fresh
  props object and calls `lit-html`'s `TemplateInstance.update()`, which diffs
  before writing; the `MutationObserver` is gated on `breakpointsComputed` being
  set before any render runs. PlayerForge has no template layer and frozen
  hand-written markup, so HudReconciler must hand-roll the diff and needs its
  own "not ready yet" drop guard — Media Chrome gets both for free from
  `lit-html` + readiness gate.

### 3.3 Three idioms all three codebases converge on

Across Gecko's batching model, uBO, and Media Chrome, the same three
disciplines recur. These are the load-bearing patterns of this design:

1. **Last-value memo / one-slot cache** to short-circuit redundant work
   (uBO `lastStored`, Media Chrome `#prevTemplateId`, PlayerForge's planned
   `#applied` snapshot in L5).
2. **Narrow, explicit observer allowlist** rather than reacting to everything
   (uBO delegated containment guard, Media Chrome `observedMediaAttributes`,
   PlayerForge `dom-manager.js`).
3. **Coarse classification before expensive work** (uBO parse-then-dispatch,
   PlayerForge idle-vs-active `createActivity`, Media Chrome request-vs-state
   separation).

## 4. Layer model

```
L5  HudReconciler     snapshot -> desired DOM, diffed against applied snapshot
L4  RenderGate        demand-triggered, tick-coalescing, priority-routed commit
L3  PlayerSession     per-<video> owner: status + subscribers, inside a Scope
L2  PlayerStatus      enumerated axes + typed transitions
L1  Signals           media / visibility / layout / frame / lifecycle edges
L0  EngineHost        engine version, VM realm, scheduler availability
```

Dependency direction is strictly downward. No layer reaches around another.

### L0 — EngineHost

Single source of truth for environment facts, so capability checks stop being
repeated at call sites. `platform/capabilities.json` is Node-side and cannot be
read by the userscript, which is exactly why this is needed.

```js
class EngineHost {
  #engine = "Gecko";
  #version;          // prerelease-aware, e.g. 158.0b3
  #realm;            // 'page' | 'content' | 'auto'
  #canPostTask;
  #canYield;
  #canRvfc;         // requestVideoFrameCallback availability
  #canMozQuality;   // getVideoPlaybackQuality + mozPresentedFrames
}
```

Read-only after construction. Every other layer asks this instead of
feature-detecting. Note what is deliberately *absent*: there is no "can await
paint" flag, because no such API exists to detect (§2.6). Also absent is any
`canRaf`: `yield_()` re-reads `requestAnimationFrame` on every call because the
harness installs and removes it per test, so a construction-time snapshot would
freeze a branch that callers re-read live. `canRvfc` and `canMozQuality` are
sketched here but do not exist yet — they land with phase 6.

One field beyond the sketch is implemented: `canMessageChannel`.
`scheduler.js`'s `nextTask()` and `context.js`'s reply pipe both feature-detected
MessageChannel independently, which is the repetition L0 exists to end, and its
presence does not vary at runtime.

### L1 — Signals

Existing `createActivity()` already expresses "passive until an edge fires", so
L1 composes it rather than replacing it. Sources:

| Source | Mechanism | Note |
| --- | --- | --- |
| Media | `<video>` events via `createActivity` | Gecko media state machine fires these; no polling |
| Visibility | `IntersectionObserver` + `visibilityState` + PiP events | callbacks are post-task, which is correct here |
| Layout | `ResizeObserver` | handler must stay trivial; it can trigger further layout |
| Frame | `requestVideoFrameCallback` | coarse only (§2.5); re-armed only while unpaused, cancelled on pause/seek/end |
| Lifecycle | `pagehide` / `pageshow` / scope abort | teardown trigger |

Every listener registers with `{ passive: true, signal }` so teardown is native.

### L2 — PlayerStatus

Today `isActive()` closures are authored independently at each `createActivity`
call site (`src/shell/shell.js:309`, `src/shell/resume.js:702`,
`src/shared/shadow.js:73`). Nothing answers "what is this player's status right
now" as a single queryable value.

L2 introduces orthogonal axes rather than one large enum, so adding an axis never
multiplies states:

```js
const Playback = { IDLE, LOADING, READY, PLAYING, PAUSED, ENDED };
const Buffer   = { NONE, WAITING, SEEKING };
const Presence = { DETACHED, VISIBLE, OCCLUDED, BACKGROUND, PIP };
const Screen   = { NONE, FULLSCREEN };
```

`Presence` is what these notes originally called `Scope`. The name moved
because `Scope` is already this codebase's disposal primitive
(`src/shared/scope.js`, the thing an activity mints on entry), and every file
needing both would otherwise import two different meanings of one word.

Scalars alongside: `duration`, `currentTime`, `rate`, `volume`, `muted`,
`hasTextTrack`, `error`.

Each transition emits exactly one typed event carrying `from` and `to`.
Subscribers receive the change; nobody re-diffs the whole status.

Invariant: one transition produces at most one scheduled commit.

#### Status is observed, never optimistic

**No handler may write status to express intent.** A keypress or click handler
asks the engine to play, pause, or seek; it does not set `Playback.PLAYING` or
`Playback.PAUSED`. Those values are written only by real `<video>` events
(`play`, `pause`, `waiting`, `seeking`, `ended`, `ratechange`, `volumechange`).

This is the discipline Media Chrome enforces structurally, by keeping requests
and state in separate namespaces (§3.2), and it is a correctness requirement
here rather than a tidiness one. `video.play()` returns a promise that rejects
when autoplay policy blocks it; an optimistic status would render a pause icon
for a video that never started. The same applies to a `seek` that the media
element clamps or refuses, and to PiP or fullscreen requests the user dismisses.

Requests are still modelled — as intents, kept apart from status — so that
cross-axis reconciliation has a defined boundary. Volume intents unmute if
muted; unmute intents raise a zero volume. But the *result* is confirmed by
the media event, never assumed by the request handler.

#### Availability is a state axis, not a static capability

Per-feature availability that can change at runtime belongs in status, not in
L0's static map. Media Chrome models this with `mediaAirplayUnavailable`,
`mediaPipUnavailable`, `mediaVolumeUnavailable`, and similar properties (§3.2),
which is strictly more expressive than a boolean captured at startup: leaving PiP
can make PiP unavailable again, and a `canPip` snapshot would be stale.

L0 therefore holds only genuinely static facts — engine and version, VM realm,
and scheduler API availability. Everything that depends on the current document
or element is expressed in L2.

### L3 — PlayerSession

One per adopted `<video>`. Owns a `Scope`, the status graph, the signal
subscriptions, and the render gate registration. Disposal is the existing
`Scope`, so `pagehide`, kernel teardown, and SPA re-injection all collapse into
one `dispose()`.

### L4 — RenderGate

This is the new core. Today writes happen from event handlers and activity
`onEnter`/`onExit` directly. L4 makes commits demand-triggered and coalesced.

```js
class RenderGate {
  #pending = false;
  #controller = new AbortController();   // child of the session scope

  request(priority) {
    if (this.#pending) return;           // coalesce to one commit per tick
    this.#pending = true;
    postTask(() => this.#commit(), { priority, signal: this.#controller.signal })
      .finally(() => { this.#pending = false; });
  }
}
```

The `#pending` guard is what keeps this compliant with Trap 1: the task is
one-shot, never self-rearming. Any retry must be re-armed from an observer
callback or a timer, per `scheduler.js`.

Priority routing:

| Work | Priority |
| --- | --- |
| Response to a keypress or click | `user-blocking` |
| HUD commit after a media edge | `user-visible` (default) |
| Commit after a ResizeObserver change | `user-visible` |
| Resume and history persistence, diagnostics | `background` |

Frame-dependent measurement after a commit does **not** get a render fence,
because none exists to await (§2.6). It samples the next refresh tick via a
one-shot `requestAnimationFrame`, which fires at the *start* of that tick
rather than after paint, and is therefore only an "after the next frame was
scheduled" marker. Diagnostics that genuinely need presentation evidence use
`PerformanceObserver` on `paint` entries, or compare `mozPresentedFrames`
against `mozPaintedFrames` to see how many frames never reached the screen.
Both are treated as coarse measurements, never as correctness gates.

Chunked non-urgent work splits with the existing `yield_()`, never
`scheduler.yield`.

### L5 — HudReconciler

Drives the frozen markup, so this is a pure write-discipline change with no
visual difference.

```js
class HudReconciler {
  #applied = null;

  apply(status) {
    if (this.#applied === status) return;    // no-op fast path
    this.#reconcile(status, this.#applied);
    this.#applied = status;
  }
}
```

Rules, each traceable to §2.2:

- Compare before write. Skip any attribute whose value is already correct.
- Prefer class or attribute swaps over scattered inline style writes, so Gecko
  can batch the style invalidation across the subtree. This is the part with a
  documented payoff: Gecko batches style reresolution and reflow tree-wise.
- Never mutate a property whose value is unchanged. Note the honest rationale:
  interning is content-addressed, so a no-op write does *not* by itself break
  tiles (§2.2). The win is upstream style invalidation and notification
  batching, whose exact no-op behaviour Gecko documents as an open question.
  Cheap insurance, and worth measuring — not a proven disaster-avoidance.
- Treat `textContent` writes as the expensive case and gate them hardest, since
  text runs participate in the most interning and re-raster work.
- When status is paused, occluded, not hovered, and not focus-within, detach the
  HUD or set `display: none` so it contributes zero layout, paint, and composite
  cost.

Cross-reference: this layer is **load-bearing precisely because PlayerForge has
no template layer to diff for it.** Media Chrome gets value-diffing free from
`lit-html`'s `TemplateInstance.update()` (§3.2), so it needs no reconciler.
PlayerForge's HUD is frozen hand-written markup, so the compare-before-write
discipline has to be hand-written — there is no framework underneath to absorb
the mistake.

## 5. Performance invariants

Each is testable, not aspirational.

| Invariant | Verification |
| --- | --- |
| Zero steady-state main-thread cost when idle | No rAF handle retained while idle; profiler shows no markers between transitions |
| At most one DOM commit per state transition | Count `RenderGate.#commit` |
| Zero writes for unchanged values | Instrument reconciler writes, diff against applied snapshot |
| Hidden HUD costs no layout or paint | Profiler `Styles` / `Reflow` / `Rasterize` flat while occluded |
| No self-rearming `postTask` | No `postTask` callback re-arms itself |
| History and diagnostics never block input | Assert every such write issues at `background` |
| No forced synchronous layout | Lint rule banning a layout-property read in the same task as its write |

## 6. Migration phases

Each phase is independently shippable and testable.

**Landed so far**

*Phase 1 — L0 EngineHost.* `src/shared/engine-host.js` states engine,
prerelease-aware version, granted realm, and scheduler availability once at
construction, and `scheduler.js` / `context.js` now ask it for MessageChannel
instead of probing the same API twice. It is exercised by
`tests/engine-host.test.mjs`, and `platform/capabilities.json` was updated to
match — a probe that moves between modules still has to be classified, and the
classification follows the file that now holds it. Integration coverage reported
the same result before and after (79 pass, 1 skipped), which is what "no
behaviour change" is verified against here rather than assumed.

*Phase 2 — L2 PlayerStatus.* `src/shared/player-status.js` introduces the four
axes and the scalars beside the existing `createActivity` closures, which were
left exactly as they were: the playback activity still decides when the media
clock attaches, and status only records what happened. Nothing consumes it yet,
so the closures remain the compatibility shim.

Three things are worth recording because they constrain later phases:

- The class has no public setter and no way to express intent. That is the
  structural half of "observed, never optimistic" — a handler physically cannot
  write `Playback.PLAYING` on the element's behalf, which is what would render a
  pause icon for a video whose `play()` was rejected by autoplay policy.
- `Screen` is fed by shadow.js's single fullscreen gate rather than by its own
  `fullscreenchange` listener. Adding one would reintroduce the double-listener
  fan-out that module exists to prevent, so the axis reads the existing SOL.
- Transitions are applied synchronously but delivered in one microtask, so an
  edge producing two changes (a `volumechange` moving both `volume` and `muted`)
  is one commit. A change raised *during* that commit lands in the next one,
  which `tests/player-status.test.mjs` asserts by parking a flag on the microtask
  queue rather than by counting await turns.

Every transition carries `cause`, the event that produced it.
`platform/integration/status-transitions.test.mjs` arms a `pf:status` listener
and a recorder for every legal cause in the same page-side call, then drives
play/pause/seek against real media and asserts that no logged change names a
cause this run never saw fire. That is the "event-sourced rather than
discovered" proof, measured rather than asserted.

One cross-realm detail is fixed here because it will bite any other module that
ships an event out of the script's realm: both the `CustomEvent` constructor and
the `detail` object have to be built in the *element's* realm. A page can hold a
reference to an object created over here and still be denied reading its
properties, so a detail passed through as-is arrives and then fails on the first
field access.

1. **L0 EngineHost.** Centralise engine version, realm, and scheduler
   availability. No behaviour change.
2. **L2 PlayerStatus.** Introduce the enumerated axes beside the existing
   `createActivity` closures, with the existing closures as a compatibility
   shim. Record transitions during integration runs to prove every state change
   is event-sourced rather than discovered.
3. **L4 RenderGate.** Route existing writes through the gate. Priority routing
   and tick coalescing only; DOM behaviour unchanged.
4. **L5 HudReconciler.** Snapshot-diff the existing writes. Output must remain
   byte-identical, which integration coverage already asserts.
5. **Occlusion gating.** IntersectionObserver-driven HUD detach. This is where
   the idle-cost improvement shows up.
6. **Frame quality.** `getVideoPlaybackQuality()` and `mozPresentedFrames`
   signals for dropped-frame reporting. No rVFC dependence beyond coarse
   presentation edges.
7. **Retire ad-hoc writes.** Delete leftover direct-write paths and any
   remaining unconditional rAF.

## 7. Gecko-specific decisions, and what they rule out

- Scheduler priorities replace timer-based deferral. `postTask` is available
  from 142, inside the 157 floor.
- `postTask` stays one-shot. Trap 1 is treated as a hard architectural
  constraint, not a style preference.
- `scheduler.yield()` is never called. Trap 2 killed boot with it, and the
  behaviour is specified rather than buggy. Chunking uses `yield_()`; there is
  no `scheduler.render()` to reach for, so "next frame" is a one-shot rAF.
- IntersectionObserver post-task delivery is used as designed, since HUD
  occlusion is not frame-critical.
- rVFC is a coarse signal only. Bug 1935256 is `UNCONFIRMED`, S3, unassigned, and
  `behind-pref`, so it justifies caution without being treated as a confirmed
  defect.
- Quality metrics prefer `getVideoPlaybackQuality()`, `mozPresentedFrames`, and
  `mozPaintedFrames` over rVFC metadata, because those bypass the cadence
  question entirely.
- The engine is realm-agnostic, because VM 2.49's default `auto` inject mode is
  CSP-dependent per site.
- No Chromium compositor assumptions anywhere. All timing reasoning is anchored
  to the Gecko refresh-tick order in §2.1.

## 8. Build and release policy

`dist/` stays tracked. Consequences accepted deliberately:

- Browser gates rebuild via `ensureBundle()` in `platform/run.mjs`, so a gate
  run leaves `dist/` dirty. That is expected, not a failure.
- Regenerated artifacts are committed at release time, alongside the version
  bump, not on incidental rebuilds.
- `dist/` is intentionally **not** in `.gitignore`. If a build produces no
  change, the tree stays clean; if it does, the diff is reviewable and
  intentional.
- `@resource pfStyle` remains unpinned to the `firefox` branch for CSS hot-fixes.
  Do not pin it without revisiting `esbuild.config.mjs:173-177`.

Open item carried forward: `@version` in the banner and `package.json` are still
separately maintained. A drift guard test is worth adding during phase 1.

## 9. Source references

Gecko internals and scheduling:

- `https://firefox-source-docs.mozilla.org/gfx/RenderingOverview.html`
- `https://firefox-source-docs.mozilla.org/layout/DynamicChangeHandling.html`
- `https://firefox-source-docs.mozilla.org/layout/LayoutOverview.html`
- `https://github.com/firefox-devtools/profiler/blob/main/docs-developer/markers.md`
- `https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/157`
- `https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/158`
- `https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/postTask`
- `https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield`
- `https://bugzilla.mozilla.org/show_bug.cgi?id=1935256`
- `https://wicg.github.io/scheduling-apis/` — `Scheduler` IDL (only
  `postTask`/`yield`) and the §2.2 abort-inheritance algorithm
- `https://github.com/violentmonkey/violentmonkey/releases/tag/v2.49.0`
- `https://violentmonkey.github.io/posts/inject-into-context/`
- `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts/register`

- `https://github.com/greasemonkey/greasemonkey` — `manifest.json`,
  `src/supported-apis.js`, `src/user-script-obj.js`, `src/bg/execute.js`,
  `src/bg/api-provider-source.js`, `src/parse-user-script.js` (read on `master`
  at 4.14)

Reference implementations read for §3, in the `main` / `master` branches at the
time of review:

- `https://github.com/gorhill/uBlock` — `src/js/dom.js`, `src/js/mrucache.js`,
  `src/js/static-ext-filtering.js`, `src/js/hntrie.js`,
  `src/js/cosmetic-filtering.js`
- `https://github.com/muxinc/media-chrome` — `src/js/media-store/request-map.ts`,
  `src/js/media-store/state-mediator.ts`, `src/js/media-store/media-store.ts`,
  `src/js/media-controller.ts`, `src/js/media-theme-element.ts`,
  `src/js/constants.ts`

Note on uBlock paths: engine sources live under `src/js/`, not `src/engine/`.
An earlier draft of this list also cited `src/js/cosmetic-filter-matcher.js`
and `src/js/sniffer.js`; neither exists on `master` at the time of review, and
both references have been dropped rather than guessed at.

In-tree:

- `src/shared/scheduler.js` — traps in §2.4, `postTask`, `yield_()`
- `src/shared/scope.js` — teardown primitive
- `src/shared/activity.js` — passive activity windows
- `src/shell/shell.js:309`, `src/shell/resume.js:702`, `src/shared/shadow.js:73` — `createActivity` call sites
- `src/shared/dom-manager.js` — mutation coalescing
- `src/shell/chrome/panel.js:101` — the only `setInterval` in the tree
- `src/shared/diagnostics.js` — debug-gated rAF frame-gap probe
- `src/kernel/contract.js:21` — `SHELL_MARKER`
- `platform/capabilities.json` — Gecko floor and manager contract
- `platform/run.mjs` — `ensureBundle()`
- `esbuild.config.mjs:173-177` — unpinned `@resource`