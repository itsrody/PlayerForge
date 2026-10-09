# PlayerForge 2.0 — Gecko-native engine architecture

Status: implemented. §4's layer model and all seven migration phases in §6
have landed, and every invariant in §5 is pinned by a test. The design text
below is written as it was reasoned out; where an implementation forced a
change, the section says so at the point it happened.
Target: Gecko 157+ (floor), tested on Firefox 158.0b5.
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
| Media session integration | `src/shell/media.js:265` | `claimMediaSession()` |
| Observer-based adoption | `src/kernel/sdk.js`, `kernel.js`, `discovery.js` | MutationObserver-based `<video>` discovery and settle detection |

Evidence that the idle-cost goal is already largely met:

- `setInterval` appears exactly once in the whole tree, at
  `src/shell/chrome/panel.js:116`, as a key-hold auto-repeat. That is a
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
   not a settled fact. Measured, and reported as the `write-cost` pair in §5:
   `platform/browser-bench/write-cost.bench.mjs`.

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

### 2.9 Priced on Gecko, or not at all

Two rules that came out of measuring, not out of theory, and that constrain how
any future performance work in this tree may be justified.

**A number from another engine is not evidence for a change here.** The sibling
`chromium` branch ran five waves of micro-optimisation against Node 26.9 / V8
14.6. Its figures are V8 figures: SpiderMonkey has its own inline caches and
its own Warp tiering. Re-pricing the same candidate shapes on Gecko 158 through
`platform/browser-bench/jit-shape.bench.mjs` moved every one of them — and moved
two of them to nothing:

| candidate shape | V8 said | Gecko 158 says | taken |
| --- | --- | --- | --- |
| unroll `matchPreset`'s keyed load | 8.6× | 3.4× deep scan / 1.6× mid-drag | yes |
| `x ** 1.5` → `x * sqrt(x)` | 1.6× | 1.4× | yes |
| cache the swipe transform prefix | — | 2.2× | yes |
| `Math.hypot` → `sqrt(dx*dx + dy*dy)` | 1.6× | **1.04×** | no |
| hoist `10 ** decimals` per stepper | — | **1.00×** | no |
| array-back the pinch pointer list | — | 6.8× | no, see below |

 A second wave priced six shapes the first left unmeasured, all on Gecko 158
 on the device's 158.0b5 build. None had a V8 number to re-price; every one
 confirms the shape the tree already has:

 | candidate shape | Gecko 158 says | kept |
 | --- | --- | --- |
 | freeze the status transition object | 4.8× (3.5 µs per transition) | yes — immutability across the subscriber boundary is worth microseconds at media-edge rate |
 | `Promise.withResolvers` vs executor form | 1.11× (0.7 µs per wait) | yes — readability; a wash either way |
 | Scope-per-task vs bare controller | 1.7× (29 µs per scheduled task, ±10% spread) | yes — the teardown vocabulary outranks tens of microseconds at event rate |
 | JSON realm-copy vs reference pass | 14× (20 µs per transition) | yes — the pass-through is unsafe across realms; this prices the hard-learned lesson |
 | `Map.get` vs keyed object read | 2.1× (4.2 µs per keystroke) | yes — table semantics at user rate |
 | optional call vs explicit null check | **1.00×** | yes — guards are free; a wash like the stepper's |

 A seventh pair priced the one shape the audit found misaligned with its own
 file: `forEachVideoInMutations` drained the live `addedNodes` NodeList with
 `for..of` while its header (and the `querySelectorAll` walk beside it)
 mandates index walks. 2.9× on Gecko 158 at ~0.2 µs per visited node — small
 in absolute terms, but the fix is four lines with no structural cost, so
 unlike the array-backed pointer list there is no trade to weigh: taken.

 A third instrument, `discovery-match.bench.mjs`, prices anchor-matching
 strategies instead of JS shapes: the per-video walk with per-anchor
 `matches()` against `closest()`-first, an inverted `:has(video)` query, and
 one grouped `:is()` call per node — on a mixed page of four SDK players,
 twelve unregistered videos, filler depth and one shadow player the
 light-DOM strategies are structurally blind to. DOM rows run page-side, so
 the realm caveat applies (fewer DOM touches survive the translation to the
 userscript realm; close ratios might not). Results on 158.0b5, all tight
 spreads: `closest()`-first 1.09× (misses pay the attempt plus the full walk
 anyway — rejected as complexity for 9%), `:has()`-inverted 3.5× (rejected:
 it restructures offers into batches and still needs the shadow fallback),
  grouped `:is()` **7.0×, taken** — one engine call per node replaces up to
  forty, with registry-then-anchor resolution preserving the exact winner, so
  the whole sdk-engine suite passes unchanged.

  A fourth instrument, `discovery-revisit-offer.bench.mjs`, prices what the
  twenty-fourth movement's learned prints save per discovery offer: the full
  slow-path measurement (playback and activation gates plus a container walk
  with a `getBoundingClientRect` per ancestor) against a print match
  (tag/class/id compares, zero rect reads) — each op call starting from a
  freshly dirtied tree, so the cold arm pays a genuine post-mutation layout
  flush the way an offer after a real state change does. On 158.0b5, four
  remembered players plus eight ad-grid misses over a 1.5k-node document:
  **0.30 ms vs 0.059 ms per 96-video sweep** (±2.0% / ±13.5%), roughly
  2.6 µs saved per single-video offer. The absolute is small and is stated
  as such; what is not small is structural — the learned path removes every
  forced layout from the per-offer path, and the cold arm's spread (against
  the warm arm's flat one) shows the flush component growing with document
  weight. Deliberately NOT an end-to-end row: navigation-to-shell is
  wait-dominated on both arms (a print learned while playing does not match
  a paused pre-click DOM, by the subset rule's design — it fires when that
  state recurs), so an end-to-end comparison would report ~1.0× and teach
  nothing. No `src/` change came out; the instrument confirms the shape the
  twenty-fourth movement shipped.

 The pattern holds: the largest absolute on the board is tens of microseconds
 on paths that run at event rate or rarer, and the one genuine wash joins the
 stepper's `10 ** decimals` as a recorded non-difference. No `src/` change
 came out of the wave, which is the expected outcome for an instrument whose
 job is to confirm shapes, not to hunt wins.

The two washes are the point. Both read as obvious wins, both are recorded in
the source as deliberate non-changes (`forge.js`'s `#checkPinch`, `panel.js`'s
`roundTo`) with their numbers, so they cannot be re-proposed as oversights. The
third rejection is the one that looks most like a win and is not: re-backing
`#pointers` as an array removes a per-move Map iterator for **6.8×**, and costs
an ordered add/remove/size reimplementation across ~20 call sites — one of which
walks `.keys()` in insertion order to emit per-pointer cancels — to save 729 ns
on a path that only runs during a two-finger drag.

**A ratio is not a win; the absolute cost decides.** Every taken row above is a
sub-microsecond effect on a path that runs at pointer rate. The largest single
saving in the set — the scrub velocity curve, on the hottest line in the tree —
is **13 ns per pointermove**, about 0.8 µs per second of continuous dragging.
None of these are latency wins, and none of them are claimed to be. What they
buy is shape: fewer megamorphic load sites, no foreign call in the innermost
gesture loop, fewer concats per move, and code that reads more plainly. §2.2's
argument that these paths are DOM- and task-bound rather than JS-bound holds
sharply after measurement, and the correct conclusion from a 13 ns result is to
record it and move on, not to go looking for more leaves to trim.

The instrument itself has a stated limit, which is why its rows license a
narrower claim than they might appear to. PF runs in the manager's isolated
userscript realm and no page-side timing reaches into it, so — exactly as
`write-cost.bench.mjs` argues for itself — these rows are driven page-side. For
a DOM measurement that would be fatal, because realm isolation changes what the
CSS engine costs. It is not fatal here: every row is pure JS, compiled by the
same SpiderMonkey in the same process, and IC shape and tier-up do not depend on
which content realm the bytecode came from. So the claim is *"this shape costs X
on Gecko"*, never *"PF's filter is X times faster"*, and a row earns the right
to change `src/` because the fixture is a faithful copy of a shape that code
already has. All rows are report-only and need no `baseline.json` entry: the
meaningful quantity is the ratio between two arms, which is why they are not
gated on either absolute.

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
  split: PlayerForge's `StatusManager` (observed) must stay separate from
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
  availability as part of `StatusManager` where it can change, and keep only
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
L2  StatusManager     enumerated axes + typed transitions
L1  Signals           media / visibility / layout / frame / lifecycle edges
L0  EngineHost        engine capability flags (MessageChannel, rVFC, frame quality)
```

Dependency direction is strictly downward. No layer reaches around another.

L4 and L5 share one module (`src/shared/render.js`): every commit is both a
scheduled task and a diffed write, so the file boundary follows the commit
rather than the layer. The split below is still the contract — the gate never
touches the DOM and the reconciler never schedules.

### L0 — EngineHost

Single source of truth for engine capability facts, so capability checks stop being
repeated at call sites. `platform/capabilities.json` is Node-side and cannot be
read by the userscript, which is exactly why this is needed.

```js
class EngineHost {
  #canMessageChannel;
  #canRvfc;         // requestVideoFrameCallback availability
  #canMozQuality;   // getVideoPlaybackQuality + mozPresentedFrames
}
```

Read-only after construction (frozen; entry bootstrap re-probes explicitly
via `probeEngineHost()` so import order never decides the facts). Every other
layer asks this instead of feature-detecting. Deliberately narrow: only
capabilities with live readers live here. Identity facts with no readers -
engine brand, Gecko version, manager realm, postTask/yield presence - were
cut: recording them made the snapshot look authoritative about things nothing
branched on. Note what else is deliberately *absent*: there is no "can await
paint" flag, because no such API exists to detect (§2.6). Also absent is any
`canRaf`: `yield_()` re-reads `requestAnimationFrame` on every call because the
harness installs and removes it per test, so a construction-time snapshot would
freeze a branch that callers re-read live.

`canRvfc` and `canMozQuality` exist as of phase 6 and are the one place the
engine-level distinction matters: both are read from
`HTMLVideoElement.prototype`, not from an element, because the caller is asking
what this engine ships rather than whether a particular element has been
upgraded yet. `canMozQuality` is all-or-nothing — the standard
`getVideoPlaybackQuality()` *and* Gecko's `mozPresentedFrames` /
`mozPaintedFrames` — because Gecko reports the standard `presentedFrames` as
null, so the half set cannot produce the submitted-versus-painted number the
report is built on. Both answer only what the engine offers; whether one
particular element has the method is still probed on that element where it is
read (`resume.js`, `diagnostics.js`).

Two fields beyond the sketch are implemented: `canMessageChannel` and the frame
pair above. `scheduler.js`'s `nextTask()` and `context.js`'s reply pipe both
feature-detected MessageChannel independently, which is the repetition L0 exists
to end, and its presence does not vary at runtime.

### L1 — Signals

Existing `createActivity()` already expresses "passive until an edge fires", so
L1 composes it rather than replacing it. Sources:

| Source | Mechanism | Note |
| --- | --- | --- |
| Media | `<video>` events via `createActivity` | Gecko media state machine fires these; no polling |
| Visibility | `IntersectionObserver` + `visibilityState` | callbacks are post-task, which is correct here |
| Layout | `ResizeObserver` | **no production site** — see below |
| Frame | `requestVideoFrameCallback` | coarse only (§2.5); re-armed only while unpaused, cancelled on pause/seek/end. Landed with phase 6 as the edge `watchFrameQuality()` samples on, with the flush window as the fallback when an element has no rVFC |
| Lifecycle | `pagehide` / `pageshow` / scope abort | teardown trigger |

Every listener registers with `{ passive: true, signal }` so teardown is native.

Two rows are aspirational rather than shipped, and both are load-bearing to
record rather than quietly delete:

- **`ResizeObserver` has no caller.** The priority table it belongs to is
  exercised by `render-gate.test.mjs`, but nothing in `src/` observes element
  size, because every layout question this fork asks is answered by status
  (`Playback`, `Presence`) or by CSS (`pf-detached`'s `display: none`). The one
  mention in `src/` is a comment (`src/shell/inputs/forge.js:861`).
- **PiP is gone, not pending.** Picture-in-picture was removed outright
  (`a5bc9fb`, "remove picture-in-picture entirely"), so the earlier draft's "+
  PiP events" has no event to name. `Presence.PIP` survives as an enum member
  with no writer, alongside `Presence.DETACHED` — `status-manager.js:70` records
  why both are named but undriven.

One structural caveat: L1 has no single owner. Visibility is instantiated
twice — `status-manager.js:461` for the `Presence` axis, and an independent
observer at `resume.js:686` gating off-screen saves. The two answer different
questions (what is the player's status versus should we churn storage for a
video the user cannot see) and their lifetimes differ, so folding them would
couple the resume cadence to the status graph. The single-source discipline L0
and L5 apply is deliberately not applied here, and that is a choice rather than
an oversight.

### L2 — StatusManager

Today `isActive()` closures are authored independently at each `createActivity`
call site (`src/shell/shell.js:367`, `src/shell/resume.js:702`,
`src/shared/shadow.js:135`). Nothing answers "what is this player's status right
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

That event has *two* deliveries, not one, and the second is the reason most of
the axis surface exists. `subscribe()` callbacks fire in-realm, and the same
change is dispatched as a `pf:status` CustomEvent on the `<video>`
(`status-manager.js:363`) so the **page world** can read status across the
sandbox boundary — which is the only consumer of `Buffer`, `Screen`, `duration`,
`rate`, `volume`, `muted`, `hasTextTrack` and `error`. In-tree exactly one
subscriber exists (`shell.js:515`, feeding the occlusion resolve), and it reads
two of the ten fields. The other eight are carried for the page, so "no in-tree
consumer" is the expected shape rather than dead code.

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

**Not landed as a class, and not needed as one.** `Shell` (`src/shell/shell.js`)
already *is* the per-`<video>` owner: it holds `#scope`, `#status`, two
`RenderGate`s, and every sub-component, and `destroy()` (`shell.js:647`) fans out
to exactly the single `dispose()` this section describes. Extracting a
`PlayerSession` would have been a rename with no second implementation behind
it, so §6's seven phases never opened one — the one layer in the §4 diagram with
no module of its own.

Three consequences worth recording, because each is a limit on what the rest of
the layers can assume:

- **Status is private to the shell.** `Shell` exposes no `get status()`, so
  "owns the status graph" does not mean "publishes it". The input layer,
  subtitles, panel and resume each hold their own references to the `<video>`
  rather than a status handle. Widening this is the one change that would make
  L2 generally useful in-tree, and it is deliberately not done: only the
  occlusion resolve needs status today, and it is inside the shell.
- **The gate is not one-per-session.** `Shell` registers two — media-state
  (`shell.js:420`) and occlusion (`shell.js:507`) — because they have different
  priorities' worth of coalescing and different snapshot shapes. `ToastManager`
  (`toast.js:123`) and `SettingsPanel` (`panel.js:293`) each own a further gate
  on their own scope, so the tree has four `RenderGate` constructions in total.
  "The render gate registration" (singular) is the sketch's simplification.
- **`Scope.child()` has no production caller.** The optional child scope §2's
  layout describes is implemented and covered by `tests/scope.test.mjs:76`, but
  nothing in `src/` uses it; disposal nesting is done by passing one `signal`
  down instead.

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

Implementing it (phase 3) forced two refinements of the sketch, both pinned by
`tests/render-gate.test.mjs`:

- `postTask` returns a `{ abort() }` handle, not a promise, so `.finally()`
  becomes a `try/finally` around the commit - and `#pending` is therefore held
  for the *whole* commit rather than released just before it. A `request()`
  raised from inside the commit is dropped, which is exactly what makes the
  one-shot property hold; a separate `#running` flag guards the case a
  *higher*-priority request would otherwise open, since it would take the
  re-raise branch below and abort the handle it was standing on.
- The sketch's bare `if (this.#pending) return;` is not enough once priorities
  differ: a `background` write already in flight would delay the
  `user-blocking` response it outranks, which is the opposite of what the table
  below is for. A higher-priority request therefore aborts the pending task and
  reschedules at its own priority; a same-or-lower one is absorbed. Either way
  there is still exactly one commit this tick.

Priority routing:

| Work | Priority |
| --- | --- |
| Response to a keypress or click | `user-blocking` |
| HUD commit after a media edge | `user-visible` (default) |
| Toast pill repaint, HUD occlusion resolve, panel compact crossing | `user-visible` |
| Commit after a ResizeObserver change | `user-visible` |
| Resume and history persistence, diagnostics | `background` |

Frame-dependent measurement after a commit does **not** get a render fence,
because none exists to await (§2.6). It samples the next refresh tick via a
one-shot `requestAnimationFrame`, which fires at the *start* of that tick
rather than after paint, and is therefore only an "after the next frame was
scheduled" marker. Diagnostics that genuinely need presentation evidence use
`PerformanceObserver` on `paint` entries, or compare `mozPresentedFrames`
against `mozPaintedFrames` to see how many frames never reached the screen —
which is what `watchFrameQuality()` does (phase 6).
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

Implementing it (phase 4) pinned three things the sketch leaves implicit, each
with its test:

- **The identity fast path is a contract, not a courtesy.**
  `if (this.#applied === status)` only holds if a snapshot is immutable once
  handed over: a producer that mutates its object in place and re-applies the
  same reference is skipped forever. The scrub hint does exactly that — one
  object, two fields, rewritten every ~100ms — so `show()` normalises its
  arguments into a fresh snapshot, and `tests/toast.test.mjs` mutates a payload
  and re-shows it to prove the repaint still lands. Without that test the defect
  is invisible in every other case.
- **A nullish snapshot is dropped rather than rejected.** §3.2 notes that Media
  Chrome gets its "not ready yet" gate from `lit-html` plus a readiness-checked
  `MutationObserver`; a hand-rolled reconciler needs its own, so `apply(null)`
  returns `false` while a non-object still throws. Call sites already reach the
  surface through `?.`.
- **`writes` counts binding invocations, not DOM mutations.** The decision to
  write is made in `apply()`, before the binding runs, so that is where §5's
  "instrument reconciler writes" row is measured. `RenderGate.commits` answers
  how many commits ran; `writes` answers how many of them had anything to do.

The occlusion rule in the list above was deliberately **not** part of phase 4:
dropping the HUD out of layout needs a visibility signal that `apply()` has no
reason to hold. Phase 5 lands it in `#watchOcclusion()` in `src/shell/shell.js`,
which owns a HudReconciler with exactly one binding — `detached` — and feeds it
the resolved rule, so the write discipline is shared while the signal stays
local. Two of the rule's four conjuncts needed pinning down there:

- **"not focus-within" does not count the shell's own focus anchor.**
  `#setupFocusManagement()` parks focus on the host and puts it back after every
  outside click, so `host.contains(document.activeElement)` is true at boot and
  at rest — a reading that would make the conjunct unsatisfiable and the whole
  rule dead on arrival. What blocks the detach is `deepestActiveElement()`
  landing *past* the anchor, inside a control of ours, which is exactly the case
  where `display: none` would drop focus mid-interaction. Losing the anchor's
  focus instead is harmless: the key gate already accepts `document.body` as a
  target, so shortcuts survive the round trip.
- **"not hovered" is implied by "occluded",** so it is not observed at all.
  `isIntersecting === false` means no part of the target is inside the viewport,
  and the pointer is always inside the viewport, so an occluded player cannot be
  hovered. Two listeners that could only ever agree with the geometric answer
  would be bookkeeping rather than a guard.

## 5. Performance invariants

Each is testable, not aspirational.

| Invariant | Verification |
| --- | --- |
| Zero steady-state main-thread cost when idle | No rAF handle retained while idle: `tests/idle-guard.test.mjs` pins the rAF inventory (exactly two files hold a call, one re-arming and debug-gated, `yield_()` one-shot) and `platform/integration/idle-cost.test.mjs` asserts an idle shell mutates nothing and raises no `pf:status` |
| At most one DOM commit per state transition | Count `RenderGate.#commit` |
| Zero writes for unchanged values | Instrument reconciler writes, diff against applied snapshot |
| Compare-before-write pays for itself | `platform/browser-bench/write-cost.bench.mjs` runs the same five-field pill update to an identical final state twice — written unconditionally (what the HUD did before L5) and diffed first (what it does now) — in interleaved batches, reported as a non-gated pair. The win is the ratio: ≈3.4× per unchanged apply, which is §2.2's open question answered rather than assumed |
| Hidden HUD costs no layout or paint | `pf-detached` is `display: none` and contributes zero client rects after a forced document flush, and gets them back on return (`platform/integration/hud-occlusion.test.mjs`) — a display:none subtree is never laid out or painted. Measured as well as argued: `platform/browser-bench/css-layout.bench.mjs` runs the same amplified forced-recalc op attached and occluded and reports the pair as a non-gated row, with the occluded figure an order of magnitude below the attached one. The profiler reading the row started as is taken too, by `platform/integration/profiler-occlusion.test.mjs`: the same media-neutral drive sampled idle and driving, on screen and detached, where `SetDisplayList` is at least 4× lower detached and the drive moves it by nothing at all |
| No self-rearming `postTask` | `tests/posttask-guard.test.mjs`: the tree's `postTask` call-site inventory is pinned by file, and every self-arm is required to carry a `delay` — the line Trap 1 turns on, since a delayed self-arm is a timer that interleaves and an undelayed one is the measured starvation chain. The one self-arm in the tree is `context.js`'s ancestor handshake, floored at 60ms. The gate's private-field callback is the shape a static scan cannot resolve, so `RenderGate`'s `#running` latch is asserted separately in the same file and dynamically in `tests/render-gate.test.mjs` |
| Persist writes never block input | `tests/video-filter.test.mjs` asserts the filter's trailing persist is the one task in its window and that it issues at `background`. The two writers §5 used to name here do not have a deferred write at all and are covered by their own tests rather than by this row: `chrome/history.js` persists nothing (it reads the store the resume tracker owns), and `diagnostics.js` is console I/O behind the debug toggle with no GM write. Resume's persist is deliberately synchronous — see below |
| No forced synchronous layout | `pf/no-forced-layout` (`platform/eslint-rules.mjs`, wired over `src/` by `eslint.config.js`): a layout-property read in the same task as a layout write fails `npm run lint`. Pinned by `tests/lint-rule.test.mjs`, which drives the rule block read back out of the real config |
| Hot-path JS shapes are priced on Gecko, and a ratio on a negligible cost is not a win | `platform/browser-bench/jit-shape.bench.mjs` prices seven candidate shapes as report-only non-gated pairs, two arms per shape in interleaved batches, and §2.9 records what survived: three taken (the `matchPreset` unroll, the gated `x * sqrt(x)` scrub curve, the latch-cached swipe prefix), three recorded in-tree as deliberate non-changes (`Math.hypot` at 1.04×, the stepper's `10 ** decimals` at 1.00×, and the array-backed pointer list, which is 6.8× and still the wrong trade). The bound the rows keep is behavioural, not numeric: `tests/input-forge.test.mjs` pins the swipe prefix's output string and that it is rebuilt per stroke rather than carried over, mutation-checked in both directions |
| Scoped observers are registered, never orphaned | The three native observers (removal watch, settle, shell watchdog) stay native for C++ subtree filtering but their lifetime is owned by the registry in `src/shared/dom-manager.js`: every registration releases on abort or explicit release, and `trackedObserverLabels()` exposes the live set. `tests/dom-manager.test.mjs` pins release/abort/manager-destroy teardown and asserts the label count returns to baseline - the leak radar |
| No string-to-DOM sinks, no realm-escape primitives, no unowned document listeners | `tests/realm-contract.test.mjs` scans `src/` for `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write`, `wrappedJSObject`/`cloneInto`/`exportFunction`, `eval`/`new Function` (comments excluded), and pins the exact census of raw `document`/`window` listeners - every entry a recorded singleton with its reason, so a new bare listener fails until it is routed through a manager or justified |

One row was narrowed rather than satisfied, and the reason is worth keeping
visible. "History and diagnostics never block input" named two writers that have
no deferred write to prioritise. `chrome/history.js` persists nothing at all — it
renders the store `ResumeTracker` owns — and `diagnostics.js` is console I/O
behind the debug toggle, which §6's phase 3 already recorded. The row now names
the writer that does defer (the filter's trailing persist) and says plainly that
the other two are covered elsewhere rather than implying a guarantee they were
never subject to.

That leaves **resume's persist, which is synchronous by decision, not by
omission.** `gmSetValue` runs inline from `#persist()` (`resume.js:269`), on the
incremental `timeupdate` path, on the pause flush and from `destroy()`. §6's
phase 3 identified the fix — splitting the scheduled save from the unload flush
so only the former can go `background` — and did not do it, because the flush
half has to save before the scope it saves against is gone, and the pause flush
is asserted in the same turn as the dispatch that triggers it
(`tests/resume-tracker.test.mjs:268`, which pins that the wall floor gates the
incremental path and never the pause flush). Deferring the periodic half alone
buys a cadence that `TUNING.resume.saveIntervalMs` already bounds, in exchange
for a second code path through the store whose failure mode is a lost position.
That trade is not worth making for a scheduling-priority win, so the row was
corrected rather than the code. **If resume is ever moved to `background`, the
split has to land whole** — pause flush, `destroy()`, and the cross-tab re-assert
in `#persist` all assume the write has already happened when they return.

Two other rows used to be phrased as a Gecko Profiler reading — `Styles` /
`Reflow` / `Rasterize` flat while occluded, and "no markers between
transitions". The first is taken automatically now; the second still is manual.
Firefox exposes no layout, paint or longtask counters to content (157 lists
neither `longtask` nor
`long-animation-frame` in `supportedEntryTypes`, which is why the frame-gap
watchdog exists at all), and the userscript runs in the add-on's isolated realm,
which nothing page-side can instrument — so the harness asks from where it can.
Its own add-on holds `geckoProfiler`: Firefox grants that permission to
extension ids listed in `extensions.geckoProfiler.acceptedExtensionIds`, a pref
the harness sets in the profile before it installs the add-on, and
`platform/integration/profiler-occlusion.test.mjs` counts markers out of a live
profile through it, running the same media-neutral drive on screen and detached
so the differential belongs to the HUD and not to the page. What gets asserted
is what moves: `SetDisplayList` and `CompositeToTarget`, which rise with the
drive on screen and sit still while the HUD is detached. `Reflow`,
`LayerBuilding` and `Rasterize` counted zero in every window measured, including
forty deliberate forced reflows, and `Styles` / `DisplayList` /
`RefreshDriverTick` never tracked the drive — so "no markers between transitions"
stays a manual reading until a build emits markers that follow it. The
automated half still rests on the mechanism underneath: an idle shell writes
nothing to the shared DOM, and a detached shell has no box for layout or paint
to visit — the second of those measured directly, since `css-layout.bench.mjs`
runs the same forced-recalc op attached and occluded and reports the pair.

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

*Phase 3 — L4 RenderGate.* `src/shared/render-gate.js` is the primitive from §4:
`request(priority)` coalesces to one commit per tick, the commit runs in a
one-shot `postTask`, and the gate's controller is a child of the session scope so
teardown cancels a commit that has not fired yet. `commits` is the §5 counter.

Two writes were routed, chosen because nothing reads them synchronously and
because each demonstrates one end of the priority table:

- The shell's `--pf-media-paused` / `--pf-media-muted` edges now request
  `user-visible` instead of writing from inside the event handler. The commit
  reads `video` at commit time, so `play` + `pause` in one tick resolves to the
  state that actually survived the tick. The construction seed still runs
  inline — that is initialisation, not a commit, and the first frame must not
  paint with the properties undefined.
- `filter.js`'s trailing persist now debounces at `background`. It was
  `user-visible` by default, which put a settings write in the same queue as the
  HUD commit it has no business competing with. `delay()` and `debounce()` grew
  an optional `priority` for it, and `tests/video-filter.test.mjs` asserts that
  the persist is the one task in its window and that it is `background` — which
  is §5's "assert every such write issues at `background`", made checkable.

What was **not** routed, each checked rather than assumed:

- Toasts and the panel's `pf-compact` toggle are asserted synchronously in
  `tests/shell-fullscreen.test.mjs` and `tests/panel-compact.test.mjs` —
  dispatch, then assert, no await between them. Deferring them changes observed
  behaviour, which is phase 7's job, not a priority tweak. Phase 7 did exactly
  that and nothing more: each file now settles between the dispatch and the
  assertion, and no assertion itself changed.
- Resume's pause flush is asserted the same way (`tests/resume-tracker.test.mjs`
  writes on `pause` and reads the store in the same turn), and `destroy()` has
  to save before the scope it saves against is gone. Splitting "scheduled save"
  from "unload flush" is what would let the periodic path go `background`.
- Diagnostics has no `postTask` write to re-prioritise: the frame-gap probe is
  rAF by §2.6, and `logger` is console I/O gated off by default.

Two things about verification are worth recording:

- **The integration test cannot instrument the userscript.** The bundle runs in
  the add-on's isolated userScript realm and `WebDriver`'s `executeScript` only
  ever sees the page world, so a spy on `scheduler.postTask` or on
  `style.setProperty` installed from the page records nothing at all. That cost
  a debugging round before it was recognised, so
  `platform/integration/render-gate.test.mjs` states it in the header rather
  than letting a future test assert a vacuous zero. What the page *can* see is
  the value on the host and when it moves, and that is enough to separate the
  two architectures: seven synthetic edges inside one synchronous block leave
  the seeded value in place when the handler returns *and* at the microtask
  checkpoint, then land as the surviving state. Commit counts and priorities
  stay in the unit suite, where the realm is ours.
- `ResizeObserver` does not appear anywhere in `src/` yet, so that row of the
  §4 priority table has no production site, and neither does `user-blocking`.
  Both are exercised by the gate's own tests and wait for a caller.

Lint clean; unit 481 pass (468 before); integration 85 pass, 1 skipped (82 and
1 before).

*Phase 4 — L5 HudReconciler.* `src/shared/hud-reconciler.js` is the §4 primitive:
one `bindings` table per surface is both the field list and the sole writer for
each field, `apply()` diffs `Object.is` against `#applied` and invokes a binding
only when its value moved, and `writes` is §5's "instrument reconciler writes"
row. The table is read once at construction, so a snapshot key with no binding
is inert rather than half-applied — §3.2's "derived, not hand-maintained", and
the reason there is no second field list to drift.

Two surfaces were routed:

- The shell's `--pf-media-paused` / `--pf-media-muted` flip guards moved out of
  the commit closure and into a two-field reconciler. The commit, its inline
  seed and its gate are unchanged; only the "has this already been written"
  half moved, and write order is still paused-then-muted because that is the
  table's key order.
- The toast replaced its `#lastIcon` / `#lastText` / `#lastColor` /
  `#lastHadActions` fingerprint with a five-field snapshot (`visible`, `icon`,
  `text`, `color`, `actions`). Output is byte-identical — `tests/toast.test.mjs`
  asserts `outerHTML` equality across a repeated show and holds references to
  the icon and text nodes to prove `textContent` was never reassigned — but the
  old fingerprint compared the payload as a whole, so it could not gate a
  *partial* change: a new colour with the same text still re-cloned the icon and
  rewrote the text node.

One finding that constrains later phases: **visibility has to be a diffed field
too.** `hide()` and the auto-hide timer previously reached for
`classList.remove` directly; with `visible` in the snapshot they must apply
`{ ...applied, visible: false }`, because a direct removal leaves
`#applied.visible` stale and the next `show()` skips the write that makes the
pill appear again. `tests/toast.test.mjs` re-shows after a hide for exactly that
reason — it is the one regression the diff makes possible.

Two non-adoptions, each for the opposite reason:

- `forge-track.js`'s `#render()` already runs a per-slot two-level dirty check
  on an allocation-free fast path. Routing it through a generic table would
  replace a specialised diff with a general one and add a snapshot object per
  `cuechange`, which is worse on the one path that is genuinely hot.
- The panel's `classList.toggle(cls, force)` has nothing to gate: the DOM
  already no-ops a no-op toggle. `markStyle` / `markAttribute` are one-shot
  construction writes across five call sites, not on any path this layer needs.

One harness note, because it cost a debugging round: `fixtures.test.mjs` asserts
on `pf:resume` as soon as `until(...)` returns, while the previous test's
ResumeTracker can still have a write in flight — `freshStore()` deletes the key
but does not cancel the write that lands afterwards. Two runs of this phase
tripped it (once on an empty entry list, once on a sibling fixture's path); four
runs after, plus one against the stashed Phase 3 tree, were clean. The mechanism
touches nothing this phase changed, but that test is what to suspect before the
reconciler when it trips.

Lint clean; unit 504 pass (481 before; +11 toast, +12 reconciler); integration
85 pass, 1 skipped — unchanged, which is the byte-identical claim checked rather
than asserted.

*Phase 5 — Occlusion gating.* `src/shared/player-status.js` gained the
IntersectionObserver behind `Presence.OCCLUDED`: one observer on the status
target, one `#set("axis", "presence", …, "intersection")` per crossing, and
disconnect through `#teardown` because `IntersectionObserverInit` has no
`signal` member to ride. `#presence()` folds the two inputs with `BACKGROUND`
checked first, so a hidden tab cannot be talked back into `VISIBLE` by geometry.
`DETACHED` and `PIP` stay named but undriven — detach has no event to observe
and this fork ships no picture-in-picture surface. A probe that gains a second
caller still has to be classified: `platform/capabilities.json` now lists
`src/shared/player-status.js` beside `resume.js` under `IntersectionObserver`.

The rule itself is `#watchOcclusion()` in `src/shell/shell.js`, resolving
`idle && occluded && !focusWithin` and applying it as one `detached` field
through a HudReconciler, which is what turns §4 L5's last rule into §5's
"Hidden HUD costs no layout or paint". The write is a class —
`.pf-shell.pf-detached { display: none; }` in `src/shell/chrome/styles.css` —
rather than an inline style, so Gecko batches the invalidation across the
subtree. Four decisions are worth recording:

- **`idle` comes from status, not `video.paused`,** and excludes `LOADING` as
  well as `PLAYING`, so a `play()` in flight never detaches the HUD it is about
  to paint. Reading status is what makes the rule answer the same question §4
  asks — "when status is …" rather than "when the element happens to be …".
- **The observer's first report corrects a seed rather than triggering a forced
  layout.** A rect is not readable without a layout, and reading one on the boot
  path is precisely the synchronous work §1 rules out, so `#intersecting` seeds
  `true` and the observer — which runs after construction — settles it. The
  correction is one transition with `cause: "intersection"`; a repeat report of
  the same geometry is not a second one.
- **The resolve was synchronous, not routed through L4.** Both inputs are
  already deferred (an IntersectionObserver callback is posted as a task, focus
  settles in a microtask), and retiring the remaining direct writes was phase
  7's job. Phase 7 routed it: both live sources request one `user-visible`
  commit now, and the construction seed still resolves inline — the shape the
  shell takes today.
- **Focus listeners sit on both the hud layer and the host.** The layer is
  always an ancestor of a focused descendant and the host is not, and a
  duplicate trigger is free because the reconciler diffs.

Verification, and one thing it could not cover:

- `tests/player-status.test.mjs` grew four presence cases against a
  controllable observer, including the hidden-tab-wins-over-geometry precedence
  and the disconnect on dispose.
- `tests/hud-occlusion.test.mjs` runs a full shell against the same fake:
  paused-and-off-screen detaches and takes it back, playing never detaches, a
  focused control inside the HUD blocks the detach while the host's own focus
  anchor does not, a hidden tab detaches, and teardown leaves no observer
  behind.
- `platform/integration/hud-occlusion.test.mjs` proves the real observer fires:
  a spacer plus a scroll takes the player out of the viewport, `pf:status`
  reports `presence` crossing with `cause: "intersection"`, the host picks up
  `pf-detached`, and scrolling back drops it — and a muted player at `playing`
  keeps its HUD at the same scroll position.

The `BACKGROUND` arm is deliberately **not** driven from integration. The page
cannot make its own document read as hidden to the userscript: an expando the
page defines on `document` is invisible across the sandbox boundary, which a
patched build confirmed by showing the listener fire while only the
`visibilityState` read disagreed, and WebDriver cannot leave a window hidden
while still executing in it. Both unit suites cover that arm instead, where the
two worlds are one.

Lint clean; unit 515 pass (504 before; +4 presence, +7 shell occlusion);
integration 87 pass, 1 skipped (85 and 1 before).

*Phase 6 — Frame quality.* The dropped-frame report is the third debug-only
diagnostic in `src/shared/diagnostics.js`, beside the frame-clock watchdog and
the Event Timing observer: `watchFrameQuality(video, signal)` registers one
entry, arms nothing until `setDebugRuntime` is on, and reports through
`logger.warn("perf", …)` at §5's flush window, at teardown, and on dispose.
Registration is deliberately independent of the toggle — a shell that boots
while debug is off is still reported on the moment it is switched on, and the
caller never has to know the state — while arming is not: no listener is added
and no handle requested before then. `src/shell/shell.js` registers its own
video against the shell scope, so the disposer runs with the shell.

Every number comes from the quality APIs (§2.5, §7), and only those:

- `getVideoPlaybackQuality().droppedVideoFrames` is the decoder's own count.
- `mozPresentedFrames` minus `mozPaintedFrames` is §4's own diagnostic pair —
  how many frames were submitted and never reached the screen. The standard
  `presentedFrames` cannot stand in for it, because Gecko reports it as null.

Four decisions are worth recording:

- **rVFC contributes its occurrence, never its metadata.** One callback means
  "a frame was presented", which is the edge the sample is taken on — §4 L1's
  Frame row, landing here. Its `presentedFrames` is never read, because §2.5's
  cadence question (bug 1935256) is precisely what makes it untrustworthy for
  anything frame-accurate. An element without rVFC samples at the flush
  instead, and the flush samples every armed entry whatever cancelled the
  callbacks first, so no interval is lost either way.
- **The counters are rebased, never subtracted.** A value below the previous one
  means the element reset (a new resource, `emptied`), so the whole current
  value counts as what landed since; a plain subtraction would walk `presented`
  backwards by hundreds and fabricate the drops the report exists to measure.
- **The baseline read at arm time is not an interval.** Without it the opening
  delta would be the element's entire lifetime, reported as though all of it
  happened inside this window.
- **The engine flags live in L0; the element probe stays at the read site.**
  `canRvfc` / `canMozQuality` are read once from `HTMLVideoElement.prototype`,
  as engine facts, while `resume.js` and `diagnostics.js` still ask the element
  itself for `requestVideoFrameCallback` — whether *this* element has been
  upgraded is a different question, and the harness installs it per video.

`platform/capabilities.json` grew one entry and one claim: the existing
`requestVideoFrameCallback` capability now carries the prototype chain and names
`engine-host.js` and `diagnostics.js` beside `resume.js`, and the new
`video-playback-quality` host probe records what is lost without the set — the
report and nothing else, which is why it is a host probe rather than a
capability with a version floor.

Verification:

- `tests/frame-quality.test.mjs` (12) drives a hand-built video against a fake
  frame clock: the arm/cancel lifecycle, the flush-window report, the no-rVFC
  fallback, the rebase across a new resource, the silent zero-drop window,
  dispose flushing and cancelling, and registration while debug is already on.
  Its fake `HTMLVideoElement` has to exist *before* `engine-host.js` is first
  evaluated — `engineHost` is a frozen singleton — which is why that file's
  imports are dynamic.
- `tests/engine-host.test.mjs` grew the all-or-nothing case: the quality set as
  one unit, the mozilla half missing, rVFC missing, and the prototype deleted
  outright rather than undefined, which is where a bare `in` would have thrown.
- No integration coverage, for the reason `render-gate.test.mjs` records: the
  diagnostic is debug-only, console-bound, and its inputs are counters the page
  cannot move on demand, so there is nothing for WebDriver to observe that the
  unit suite does not already drive. Integration ran unchanged (87 pass,
  1 skipped) as the check that this phase added no observable behaviour outside
  debug mode.

Lint clean; unit 528 pass (515 before; +12 frame quality, +1 engine-host);
integration 87 pass, 1 skipped — unchanged.

*Phase 7 — Retire ad-hoc writes.* The three direct-write paths §4 and the
earlier phases had flagged are now routed through L4, and everything else that
writes DOM in `src/` is accounted for. They went the same way: one writer
function, reached inline from the construction seed and from a gate commit for
every live trigger.

- **Toast.** `show()` and `hide()` store the desired snapshot and request one
  `user-visible` commit; the commit is the only thing that calls
  `reconciler.apply()`. The scrub hint repainting on every gesture event was
  N applies per tick and is now one, and a `show()` immediately followed by a
  `hide()` resolves to whichever survived the tick. The desired state is held
  beside the reconciler rather than read off it, because a request that has not
  committed yet is not in `applied` — and folding it in is what keeps a
  coalesced show-then-hide from dropping the content it never got to paint.
- **Panel compact.** `#applyCompact()` is the sole writer for `pf-compact`,
  reached three ways: the construction seed (inline — initialisation is not a
  commit), the gate for a live viewport crossing, and `open()`'s ViewTransition
  update callback, which still writes synchronously because an update callback
  has to land in the frame the transition snapshots. Before this the class had
  three ad-hoc writers, each re-reading `#isCompactMode()` for itself; the read
  now lives inside the one writer.
- **Occlusion.** `#watchOcclusion()`'s resolve became the gate's commit. Both
  sources were already deferred, so the gain is in the *read*: a focus move
  resolved twice, once per edge, each walking focus again, and any status axis
  change landing in the same tick resolved a third time. All of them are now
  one commit reading where focus actually ended up. The inline seed stayed, and
  the `queueMicrotask` the focus edges used to ride is gone — the commit is a
  task, which is strictly later, so focus has settled by the time it is read.

What was deliberately **not** routed, named rather than left implicit:

- **Construction seeds.** The toast's `pointerEvents`, the panel's roles and
  aria attributes, `context.js`'s iframe `allow`, history's first render,
  `filter.js`'s section head layout. Initialisation writes the first frame of
  state; there is nothing for it to coalesce with.
- **ViewTransition update callbacks.** `pf-open`, and `pf-compact` inside
  `open()`. One task later and the opening snapshot paints the wrong state.
- **Reconciler bindings.** Shell media state, the toast's five fields, the
  occlusion class — already diffed by L5, and since this phase all three are
  gated by L4 as well.
- **Hot paths.** `forge.js` / `actions.js`'s transform, `willChange` and
  `transition` writes on every pointer move, `forge-track.js`'s per-`cuechange`
  slot writes, `filter.js`'s per-input `style.filter`. Phase 4 recorded the
  first two as the case where a generic reconciler would replace a specialised
  diff with a general one on the one path that is genuinely hot; the filter is
  the drag's own visual feedback, and the events it would merge are each the
  latest state rather than a sequence worth collapsing.
- **Input affordances.** Tab activation, stepper disabled state, `pf-drop-active`
  over a drag. One class per user action, with no second write in the tick to
  merge into it.

And "any remaining unconditional rAF": verified against the finished tree
rather than asserted. `requestAnimationFrame` is called from two files —
`scheduler.js`'s `yield_()`, a one-shot with a 50ms backstop that hidden
documents never take, and `diagnostics.js`'s frame loop, which exists only
while debug is on. (`diagnostics.js` holds three of the call sites, two of them
inside the loop; the inventory is pinned per file, which is the granularity that
matters here.) `setInterval` appears once, as the panel's key-hold auto-repeat.
§1's "no unconditional rAF loop in the shipping path" still holds, and
`tests/idle-guard.test.mjs` is what keeps it true.

Verification: three test files gained a settle between a mutation and the
assertion that reads it back — `tests/toast.test.mjs` (which now also asserts
that `show()` does *not* write in the same turn, so the routing cannot be
quietly undone), `tests/panel-compact.test.mjs` (the same assertion for a
viewport crossing), and `tests/hud-occlusion.test.mjs`, whose microtask `tick`
stopped being enough once the class write moved to a task and now settles too.
`tests/render-gate.test.mjs` is unchanged: one-commit-per-tick is the gate's
property and this phase only added producers to it. Integration is unchanged,
which is the point — the routing is invisible to anything that polls.

Lint clean; unit 530 pass (528 before; +2 toast); integration 87 pass,
1 skipped — unchanged.

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

All seven are landed, each with its own commit and its own verification at
the end of §6. Taken together, as of 2.0.0: lint clean (including
`pf/no-forced-layout`), unit 570 pass, integration 90 pass / 1 skipped,
28 browser-benchmark rows (14 gated and green, 14 report-only shape pairs),
node bench green, and `vm-smoke` 19/19
against Violentmonkey 2.49.0 — the one check that exercises the shipping
bundle in the manager it ships for.

The unit count has moved thirty-six times since that cut. The first two movements
are the point. `tests/posttask-guard.test.mjs` (5) was added to make §5's "No
self-rearming `postTask`" row verifiable rather than self-evident. Its
verification column used to restate the invariant, which is the one form of
"verification" that cannot fail; the row is now pinned by a test that has been
checked to fail on both a tight self-arm and a new call site, and to *pass* on a
delayed one — the discrimination Trap 1 actually turns on.
`tests/input-forge.test.mjs` gained 3 for the swipe transform prefix §2.9 caches
at the latch, covering the string it produces, that it does not stack across
moves, and that a second stroke rebuilds it rather than inheriting the last.
Those are mutation-checked in both directions, because a cached value that is
never re-derived is precisely the failure this change could plausibly introduce
and the row would otherwise be asserting only that the code agrees with itself.

The six movements since then each pinned a gap that had been proven on the
live bundle before the fix existed: the probe's failed size gate never being
re-watched, a video inside an open shadow root being invisible to every
discovery path but the media events, a settle completed against a detached
video leaving the reconnect with no re-entry into adoption, a frame whose
context pipe had been swept by another client's touch burning its whole
deadline on the silent port and adopting its own URL instead of the top
page's (`tests/context.test.mjs`, `tests/sdk-engine.test.mjs`,
`tests/kernel-replay.test.mjs`), and a player the page re-parented — the
video moved alone leaving the HUD stranded in the old slot while marker and
the seen-set claimed it for the life of the document, or the whole subtree
moved leaving the removal watch's roots and sentinel on the old chain so the
new chain's teardown never destroyed the shell (measured live: stranded at
+799ms with zero hosts in the new location, orphaned at +903ms against a
+708ms control destroy; `tests/kernel-replay.test.mjs`), and a status
transition the element announced that never reached the channel: the rate
scalar read `target.rate`, a property HTMLMediaElement does not have, so the
value was pinned to the fallback, every `ratechange` compared equal and
skipped, and the whole rate axis stayed invisible on `pf:status` for the
element's life (measured live: `playbackRate = 2` produced zero rate
 transitions against a volume control that did; fixed to `playbackRate`;
 `tests/player-status.test.mjs`).

 The ninth movement unified the one rule two modules owned separately: the
 PlayerForge geometry reference (screen in fullscreen, container inline) lived
 in `shell.referenceBox` and in forge's `#zoneForPoint`, and the copies had
 already drifted — the shell read a bare `screen.width` that throws
 ReferenceError on a host with no `screen` global at all, while forge guarded
 the same read and fell back to `window.innerWidth`. `src/shared/geometry.js`
 now owns the fs-vs-inline decision and the guarded screen read behind
 `screenSize()` / `writeReferenceBox()` / `referenceWidth()`; both call sites
 delegate with byte-identical values everywhere the old code did not throw,
 and degrade to the container instead of throwing where it did
 (`tests/geometry.test.mjs`, 7: the fs-with-screen, fs-without-screen,
 zeroed-screen, raw-zero-inline, window-fallback, and pooled-rewrite cases).
 The same change completed the manifest rows the rule touches:
 `platform/capabilities.json` now names `src/entry.js` beside `panel.js`
 under `matchMedia` and beside `context.js` under `AbortSignal`, and
 `src/shared/geometry.js` beside `forge.js` under `screen` — bare calls the
 `typeof`-chain scan cannot see, so the manifest is what keeps them honest.

 The tenth movement hardened injection and SDK domination six ways, and the
 first of the six broke an integration test in a way that proved the fix was
 real. Parking focus with `preventScroll` (F1) stopped boot from scroll-
 yanking below-fold players into view — and the hotkey-broker focus test had
 been passing only because of that yank: with the player correctly staying
 occluded and detached, its probe focus silently no-oped inside `display:
 none` and the keystroke fell through to the playing sibling. The test now
 scrolls its target into view explicitly, waits out the occlusion resolve,
 and asserts the focus through the shadow root itself (`document.
 activeElement` retargets to the host and can never name the probe). The
 other five: the container becomes a stacking context (`isolation: isolate`,
 F2) so the host's INT32_MAX ceiling is actually contained as the stylesheet
 claims; the kernel no longer reads SHELL_MARKER as an adoption veto (F3) —
 ownership is the seen-set plus the registry slot, and a `cloneNode`d marker
 would otherwise refuse a shell-less clone forever; the null stays
 unmemoized (F4) so a subtree graft under a new SDK is detected on re-query
 instead of answered from a stale parent-only check; settle watches the
 container subtree (F5) so nested SDK builds re-arm the quiet window within
 the same cap; and every injection re-asserts the document stylesheet
 adoption a page script may have clobbered (F6). `tests/shell-boot.test.mjs`
 gained 3 (scroll-free focus, isolation, re-adoption), `tests/kernel-replay.
  test.mjs` 2 (cloned marker, subtree observe), `tests/sdk-engine.test.mjs` 2
  (the graft pair, one of which fails on any parent-only check).

 The eleventh movement took two Gecko-only APIs the tree had been leaving on
 the table, and pinned nineteen Chromium-only ones in `retired` so the
 manifest refuses them the way it already refused LoAF. Scrub drags rode
 precise `currentTime` per move, so every move paid a full seek cycle;
 per-move seeks now ride `fastSeek` (Gecko-only, keyframe-fast) with an exact
 `currentTime` settle on release — the release previously never re-sought, so
 without the settle a keyframe landing would have stood as the resting
 position (`tests/media-controls.test.mjs` for the arms, `tests/input-forge.
 test.mjs` for the settle-on-release). The screen stays awake while a video
 plays via `navigator.wakeLock` (126 desktop, 156 Android — inside the floor),
 held per bridge and released on pause, denial, revocation and teardown, all
 silent (`tests/media-controls.test.mjs`). No latency numbers are claimed for
 the scrub shape: the win is intent-matching (feedback vs settle, the class
 of argument §2.9 already accepts for rVFC occurrence), not a priced row.

 The twelfth movement unified teardown behind one vocabulary: every bare
 `AbortController` in the tree is now a `Scope` (lifecycle, scheduler facade,
 context pipes, keyboard broker, panel dismissal, entry hint), with
 `dispose()` in place of `abort()`. Extending the platform class was tried
 and reverted inside the same change: the jsdom hosts lend a realm-local
 constructor per case, which their brand-checked `addEventListener` requires,
 and a subclass freezes the base at module evaluation, ahead of any lending —
 so the primitive holds its controller and the rule is pinned structurally
 instead (`tests/teardown-guard.test.mjs`, in the posttask-guard idiom).
 `render.js` keeps the tree's only other construction, as a
 session-scope child a bare signal parameter cannot express. The same change
 pinned `performance.memory`, layout-shift records, prerendering markers and
 `interactionCount` in `retired`.

 The thirteenth movement declined a version-floor bump and proved the test
 target instead. With 158 in beta on the test machine (158.0b5 riding in
 `Firefox.app`), the temptation was `minFirefox` 158 — but the manifest's
 highest floor need is 149 and no 158 API (Sanitizer scoping, corner-shape,
 `random()`, deliveryType, streaming uploads) backs a feature, so the bump
 would have dropped the 157 promise for nothing; the floor stays put. What
 did change: the resolver derives bleeding-edge from the prerelease letter
 rather than the app-bundle name (a beta in release clothing reported as
 settled before), pinned by `tests/target-resolver.test.mjs` against fake
 binaries; `testTarget.verifiedOn` now names the measured 158.0b5; and the
 full integration suite ran green on it (90 pass, 1 skipped).

 The fourteenth movement hardened the settings store after a full audit of
 `src/shared/` found the resume store's discipline missing beside it:
 guarded GM reads/writes that report instead of throwing, rebase-on-write so
 a cross-tab write landing mid-batch survives (same-path races stay
 last-write-wins), strict plain-object documents with warned fallbacks, an
 abortable subtitle fetch that rejects instead of pending forever, and
 empty-batch/empty-segment guards — plus boolean write results plumbed
 through to the config helpers. The same audit closed the merge question for
 `src/shared/`: the config doc-diff and the resume entry-merge are different
 algorithms over different models, and the remaining Chromium surface was
 already absent. `tests/storage.test.mjs` gained 9, two of which (mid-batch
 race, removal-on-truth) fail on the pre-fix store.

 The fifteenth movement made the contract's line numbers fail instead of rot:
 a hygiene pass corrected fourteen cites at once (one change had shifted all
 of `shell.js` by +7), and symbols alone could not replace them — three
 `gmSetValue(KEYS.resume` calls need the number to disambiguate. `tests/doc-
 refs.test.mjs` pins every `file:line` cite to an anchor on that line and
 requires new cites to add rows, in the posttask-guard idiom; a one-line
 shift was verified to fail it.

 The sixteenth movement gave the kernel's per-video state a class:
 `VideoSession` owns the adoption claim, the boot-retry and settle-skip
 flags, and the removal watch (observer, anchors, sentinel, grace) behind one
 `WeakMap` keyed by the element, replacing five Weak collections with one
 lookup. The kernel keeps policy, the session keeps state and the watch
 machine; the moved code is verbatim, measured comments included. The same
 change extended the dropped-frame report with the decoder's
 `corruptedVideoFrames` beside dropped (a conditional segment, so clean
 windows read exactly as before) and pinned the Idle Detection API in
 `retired`. Temporal staleness math was evaluated and rejected alongside:
 Node lacks `Temporal` entirely, so the code would need an untestable dual
 path to fix a ±1-hour edge on a 14-day window — floor-safe is not the same
 as worth it.

 The seventeenth movement audited the scheduler, status and engine-host
 modules for allocation shape and native-direct design, and mostly confirmed
 them: the scheduler's per-task Scope and closures ride event-rate paths,
 the engine facts are a frozen singleton, and the status writer was already
 read-only on its hottest edge. Two latent robustness gaps closed in
 `player-status.js`: subscribing with an already-aborted signal no longer
 leaks a permanently-delivering callback, and `dispose()` isolates teardown
 errors like every other fan-out in the tree. A third candidate — hoisting
 the listener snapshot out of the flush loop — was weighed against its
 semantics and rejected: it would delay mid-batch unsubscribes to save one
 small allocation per extra transition. `tests/player-status.test.mjs`
 gained 2, both failing pre-fix; `tests/doc-refs.test.mjs` moved two cites
 with the code.

 The eighteenth movement audited the six remaining shared modules and fixed
 what was actually wrong: bridge nonces fall back to time plus entropy where
 `crypto.randomUUID` needs a secure context it does not have (an unguarded
 call threw out of the retry and hung the resolve on plain http);
 constructing an activity or subscribing to fullscreen with an
 already-aborted owner stays fully inert instead of leaking listeners past
 teardown. `primitives`, `tuning` and `geometry` were measured clean and
 untouched; the subtitle/i18n surface (locale auto-select, region cues, late
 tracks) needs product and frozen-markup decisions first and stays a design
 note. `tests/activity.test.mjs`, `tests/shadow-gate.test.mjs` (new) and
 `tests/context.test.mjs` gained 4, all failing pre-fix.

 The nineteenth movement audited the input, shell-UI and store hot paths for
 allocations and native-direct gaps, and found the tree mostly clean: the
 forge move path carries one guarded string plus the UA's coalesced array,
 the resume round trip is already wall-gated, and the toast/panel/history
 paths are diffed, pooled or structural-only. Two real fixes landed: bulk
 filter paths (preset, reset, config load) suspend per-stepper commits so one
 preset is one style write instead of ~10, and the panel mints its compact
 `MediaQueryList` once instead of per read (the reduced-motion query already
 set that precedent). `pointerrawupdate` joined `retired` beside the
 coalesced-events path it must never replace. `tests/video-filter.test.mjs`
 gained 2 and `tests/panel-compact.test.mjs` 1, all failing pre-fix; the
 shared stepper fake now cascades like the production widget.

 The twentieth movement audited the kernel, discovery, plugin and contract
 modules for allocation shape and native-direct design. Three small items
 stood: the added-node walk now drains its live NodeList by index (2.9× on
 Gecko 158, taken — the file's own header already mandated it), the
 deprecated `findContainer` alias is gone (its seven test call sites read
 the descriptor field directly), and the event table is frozen while the
 tuning stays mutable for timing tests. `pointerrawupdate` joined `retired`
 next to the coalesced path it must never replace.

 The twenty-first movement grew SDK coverage toward forks: Shaka Player and
 THEOplayer records (UI-build markers the SDKs' own code reads or writes),
 plus behavioral anchors on the existing Plyr (`data-plyr-config`) and
 Video.js (`.vjs-tech` at hop 0, the `video-js` tag) records, so a re-skin
 that drops every cosmetic class still resolves. The registry header now
 states the fork rule outright. Two candidates died in verification:
 Bitmovin and Kaltura UI roots are siblings of the video, not ancestors, so
 their classes would never match. Platform embeds (YouTube, Vimeo and kin)
 stay out pending a double-UI product call: adoption inside their frames
 would stack our HUD over their native controls.

 The twenty-second movement added the opt-in SDK-independent slow path:
 videos no record claims are adopted when playing, sized, visible and
 user-driven (sticky activation, FF120), placed by climbing box-similar
 ancestors with ambient-background and off-viewport refusals. No
 audio/duration heuristics by decision: muted users and short clips are
 legitimate viewing. The Detect Unknown Players setting defaults off so the
 registry stays the only default path; `userActivation` is a host probe.
 `tests/sdk-engine.test.mjs` gained 7, `tests/kernel-replay.test.mjs` 2
 (adopt-when-enabled, ignore-when-off).

 The twenty-third movement audited the slow path for speed and found one
 real flaw: zero-size ancestors (`display:contents` wrappers) were adopted
 as hosts nobody can see, or blocked the climb to a real box above. They are
 skipped through now, still counting toward the removal-watch depth. Three
 heavier redesigns were measured against their savings and rejected: a
 placement memo (resize staleness vs ~30 µs saved per video lifetime),
 async IO visibility (a two-phase kernel for a handful of flushes), and
 offer gating (the free early exits already order first).

 The twenty-fourth movement made generic adoption learn: a successful slow
 path records the player block as a domain-scoped print (tag, classes, id,
 depth), and the next visit matches it like a registry anchor - placement
 re-resolved live, admission gates still applied, behind the same
 off-by-default switch. Matching is class-subset (state classes churn) with
 exact tag/depth/id; staleness falls through to the slow path, which
 re-learns. `tests/sdk-engine.test.mjs` gained 5, `tests/kernel-replay.
 test.mjs` 3 (persist, second-visit-learned, dormant-when-off).

 The twenty-fifth movement inverted gesture ownership: the shell owns
 presses on the bare video surface, the SDK owns its controls. A press
 landing on a generic interactive element (buttons, links, form fields,
 editable text, interactive ARIA roles - no per-SDK list) is never owned,
 so control taps stay native, zero-latency and trusted with every intent
 armed; tap replay re-resolves its target at fire time instead of dropping
 re-rendered chrome; `touch-action` escalates to none per session rather
 than per lifetime; right-click and focus pass to controls unless a
 gesture session is live. `tests/input-forge.test.mjs` gained 5, and the
 doc-refs cites moved with the code (shell.js -1, shadow.js +30,
 forge.js latch pair 942/943 to 965/966).

 The twenty-sixth movement hardened the mount seams: post-prep placement
 is revalidated (connectivity, not boxes - relative-without-offsets and
 isolate are layout-identical, the race is detach), overlapping offers
 share one build per container (a WeakSet mount flight, since #pending
 clears before the factory runs and registration lands after ready), and
 the parasite watchdog takes a liveness predicate so an eviction racing
 removal grace lets the destroy land. `tests/kernel.test.mjs` gained 1
 (mid-build twin refused), `tests/shell-boot.test.mjs` 2 (mid-boot move
 aborts without stranding, watchdog yields when dead).

 The twenty-seventh movement made the fallback the default: the registry
 still answers first and learned prints second, but an unrecognized video
 now adopts with no opt-in. The guess pays for its uncertainty three
 ways - stricter admission (200x120, registry keeps 100x60), one hint on
 the first generic adoption pointing at its toggle (flagged, never nagging),
 and the same off switch, now opt-out. `tests/kernel-replay.test.mjs`
 gained the default-on adoption (plus the converted explicit-off refusal),
 `tests/sdk-engine.test.mjs` 1 (tiles refused), `tests/shell-boot.
 test.mjs` 1 (notice once).

 The twenty-eighth movement unified the offer: `resolvePlayer` fills the
 composed chain once and probes registry, prints and fallback against it,
 in that priority, through one descriptor constructor. The registry memo
 policy moved with it unchanged; every existing probe keeps its signature
 as a thin delegate, so the suite passed untouched before the 2 new
 priority tests. `tests/sdk-engine.test.mjs` gained those 2.

 The twenty-ninth movement reviewed the unified path for leftovers: three
 orphaned headers trimmed back to their functions (the memo essay lives on
 `resolvePlayer`, the placement essay on the climb), the print probe's
 rationale moved to the on-chain matcher, and two hot-path allocations
 removed (a shared empty prints default, an indexed class-subset walk
 instead of a closure per print per offer). No behavior changed; the pin
 is two new invariants - anchor/print probes read zero boxes, the memo
 keeps object identity. `tests/sdk-engine.test.mjs` gained those 2.

 The thirtieth movement put DOM ownership in one place without
 centralizing mechanism: scoped observers stay native (C++ subtree
 filtering, with gorhill's December 2025 surveyor fix as the field
 evidence for specificity over a generic feed) but register lifetimes in
 `src/shared/dom-manager.js`, whose live labels are a leak radar; the
 kernel's page listeners moved onto its own manager; the shared feed is
 pinned childList-only on the document node; the page realm gets a
 contract (no string-to-DOM sinks, no Xray-unwrapping primitives, every
 raw document/window listener a recorded singleton); and the discovery
 lifecycle is named in phases - probe, settle, mount, ride, teardown -
 with each phase's abort owner written down. `tests/dom-manager.test.mjs`
 gained 4, `tests/realm-contract.test.mjs` is new with 2, and §5 gained
 the two rows that verify them.

 The thirty-first movement gave every engine exactly one owner: the L0
 snapshot is probed explicitly by entry bootstrap instead of only at
 import, the keyboard broker is a per-document EngineBroker owned by the
 shell plugin (module globals gone, realm field deleted as
 unrepresentable), and Kernel.destroy() extracts the pagehide teardown
 for direct driving. `tests/engine-host.test.mjs` gained 1 (re-probe),
 `tests/input-forge.test.mjs` 3 (arbitration, empty teardown,
 cross-document filtering), `tests/kernel.test.mjs` 1 (idempotent
 destroy), and the doc-refs cites moved with the code (shell.js +4,
 forge.js +35).

 The thirty-second movement deleted the last ambient owner: the shared
 default broker is gone, so every InputForge takes its broker explicitly
 and sharing is always deliberate - one explicit broker across the
 multi-engine tests (which now state the one-pair-per-document invariant
 literally), fresh brokers everywhere else. Shells built directly keep a
 fresh owned broker that empties itself on teardown. `tests/input-forge.
 test.mjs` gained the per-broker routing pin; the count moved by one.

 The thirty-fourth movement wired PlayerStatus lifetimes through its own
 DOMManager: media listeners ride manager signals, the intersection
 observer registers as `status-intersection`, the fullscreen subscription
 is a manager cleanup, and the teardown array is gone. The owner signal
 still disposes the status, so shell-scope teardown releases everything
 even where dispose was never called. `tests/status-manager.test.mjs`
 gained the abort-releases-all pin.

 The thirty-fourth movement ends with the module renamed to match the
 role it grew into: `src/shared/player-status.js` is now
 `src/shared/status-manager.js` (`PlayerStatus` to `StatusManager`),
 §4's L2 section and the live cites with it; §6 history keeps the old
 names, like the log it is. No behavior change, no count change.

 The thirty-fifth movement closed two timing gaps: unclaimed structural
 videos arm a bounded class/id/data-attribute upgrade watch that
 re-offers on late SDK chrome (disarming on adopt, detach and teardown),
 and shells adopted inside a shadow root watch that root - and only that
 root - for late videos, re-offering through the kernel. Host overrides
 stay proof-gated: a record earns one only with fixture evidence its
 chrome lives outside the anchor. `tests/kernel-replay.test.mjs` gained 2,
 `tests/shell-boot.test.mjs` 2.

 The thirty-sixth movement unified discovery around one survey and proved
 the mount harmless: `surveyVideos` is the only sanctioned video walk
 (probe sweep, kernel replay and shadow watch enumerate through it, with
 per-video records and zero box reads), the probe hands its candidates to
 the kernel in discovery order instead of the kernel re-sweeping blind,
 and `#verifyPlacement` now compares pre-prep boxes post-yield, aborting
 on disturbance past subpixel tolerance. `resolvePlayer` stays exactly as
 it was - pure over video, prints and enabled - because chains are
 per-video by nature and a shared fill would save nothing. Tests gained 6
 across the four suites that own the path.

 The thirty-third movement cut L0 down to capabilities with live readers:
 engine brand, Gecko version, manager realm and postTask/yield presence had
 no production readers - only tests - so the fields, `parseGeckoVersion`
 and their seven tests went, the scheduler-postTask row lost its probe
 claim, the scheduler-yield row (whose whole premise was "recorded by L0")
 went with it, and the §4 L0 sketch now shows the three flags that remain.
 Net seven tests lighter.

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
- Scrub seeks ride `fastSeek` per move with an exact `currentTime` settle on
  release: a Gecko-only keyframe seek (absent on Chromium) matched to drag
  feedback, with precision restored where the stroke rests. No latency number
  is claimed for it; §2.9's rule against presenting a shape as a latency win
  holds, and the argument is intent-matching instead.
- The screen stays awake while video plays via `navigator.wakeLock` (126
  desktop, 156 Android — inside the floor), held per bridge and silent on
  denial, revocation, and teardown. Playback survives its absence, so it is a
  host probe rather than a floor claim.
- Performance claims are priced on Gecko or not at all, and a ratio on a
  negligible cost is not a win. This rules out justifying a `src/` change with a
  node benchmark, and it rules out presenting a shape-level speedup as a latency
  improvement. §2.9 has the measurements; `jit-shape.bench.mjs` is the instrument.
- The engine is realm-agnostic, because VM 2.49's default `auto` inject mode is
  CSP-dependent per site.
- No Chromium compositor assumptions anywhere. All timing reasoning is anchored
  to the Gecko refresh-tick order in §2.1.
- Work the main thread never does, and why nothing on this list gets expanded
  without a measured reason. Compositor: WAAPI eases and flashes, CSS
  transitions and opacity morphs, ViewTransitions, adopted sheets. Manager
  process: subtitle fetch, GM storage and its change fan-out. Native parsers:
  WebVTT cue parsing and scheduling, `getCueAsHTML` fragments. Observers, not
  polling, for everything watchable. Lazily built: panel sections, filter and
  subtitle wiring wait for first open; listeners are per-document
  (one GM registration per key, one window listener per frame) with deduped
  in-flight resolves. Deliberately not taken: a subtitle worker (loads are
  user-initiated and rare; the string pass is µs-scale beside network plus
  native parse), panel-chrome deferral past first open (~25 µs per page for
  two nodes and ten listeners, against teardown-ordering risk), per-document
  context caching (stale titles on SPA navigation, which the deliberate
  no-cache avoids), and anything CSS-side (frozen by §0).

## 8. Build and release policy

`dist/` stays tracked. Consequences accepted deliberately:

- Browser gates rebuild via `ensureBundle()` in `platform/run.mjs`, so a gate
  run leaves `dist/` dirty. That is expected, not a failure.
- Regenerated artifacts are committed with the change that produced them, once
  the gates have run — **not** only at release time, and not on a rebuild nobody
  looked at. The rule is that the committed bundle is the one the last green
  gate run measured. A browser gate rebuilds `dist/` on its way in, so
  committing that rebuild alongside the source change is what keeps the
  committed artifact honest; leaving it behind is what let `a9c975b` (a perf
  pass over four `src/shared` and `src/shell` modules, merged after `v2.0.0`)
  ship with `dist/` still built from the sources before it. The version bump
  still rides along at release time, because that is a different kind of edit
  (`tests/version-drift.test.mjs` pins banner, `package.json`, `package-lock`
  and `dist/` together, so a bump that skips the rebuild fails the unit run).
- `dist/` is intentionally **not** in `.gitignore`. If a build produces no
  change, the tree stays clean; if it does, the diff is reviewable and
  intentional.
- `@resource pfStyle` remains unpinned to the `firefox` branch for CSS hot-fixes.
  Do not pin it without revisiting `esbuild.config.mjs:173-177`.
- `npm run vm-smoke` is the only check that exercises the shipping target
  rather than the harness: a real Violentmonkey parsing the banner, resolving
  the grants, honouring `@run-at`, and injecting into all five embed
  topologies in the content realm. It runs 19/19 against VM 2.49.0. The xpi is
  fetched from AMO and never vendored, so it is a release-time command rather
  than a gate one.

Open item discharged: `@version` in the banner and `package.json` are still
separately maintained — deliberately, since the runtime reports
`GM_info.script.version` and package.json is what a version bump acts on — so
`tests/version-drift.test.mjs` pins the two together, and pins the committed
`dist/` bundle against the banner both are built from. A bump without a
rebuild now fails the unit run instead of shipping a bundle that reports the
old number.

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
- `src/shell/shell.js:367`, `src/shell/resume.js:702`, `src/shared/shadow.js:135` — `createActivity` call sites
- `src/shared/context.js:637` — the tree's only self-rearming `postTask`, delayed
- `src/shared/dom-manager.js` — mutation coalescing
- `src/shell/chrome/panel.js:116` — the only `setInterval` in the tree
- `src/shared/diagnostics.js` — debug-gated rAF frame-gap probe
- `src/kernel/contract.js:21` — `SHELL_MARKER`
- `platform/capabilities.json` — Gecko floor and manager contract
- `platform/run.mjs` — `ensureBundle()`
- `esbuild.config.mjs:173-177` — unpinned `@resource`

Source-scan guards, all four of which exist to make "the next change" fail rather
than the current one:

- `tests/idle-guard.test.mjs` — the rAF and `setInterval` inventories behind §1
  and §5's first row
- `tests/posttask-guard.test.mjs` — the `postTask` inventory and self-arm scan
  behind §5's `postTask` row
- `tests/teardown-guard.test.mjs` — the `AbortController` construction inventory
  behind the one-teardown-vocabulary rule (§1): only the primitive itself and
  the render gate's session-scope child may construct one
- `tests/doc-refs.test.mjs` — every `file:line` cite this contract carries,
  pinned to an anchor on that line: numbers rot on every nearby edit (one
  change shifted all of `shell.js` by +7), and symbols alone stay ambiguous
  exactly where precision matters (three `gmSetValue(KEYS.resume` calls)