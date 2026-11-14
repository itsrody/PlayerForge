# AGENTS.md â PlayerForge, the complete guide

Read this before touching code. It describes what the product is, how every
module fits together, the conventions that decide "is this a good change", the
full refactoring path the tree has walked (the OOP development program), the
HUD design law that still binds any visual change, and the testing tool that
proves a change real. Sections 1â3 and 5â8 are load-bearing; section 4 is the
history that explains why those conventions exist.

---

## 1. What PlayerForge is

A Userscript-exclusive HTML5 video player enhancer for **native Firefox** on
both platforms:

- **Firefox desktop** (macOS/Windows/Linux), **Firefox for Android**
- Firefox **159+** platform floor, **Violentmonkey 2.50+ (MV2)** manager
- Features: pointer/keyboard gestures, hotkeys, progress resume, watch
  history, subtitles (.srt/.vtt with per-cue placement, per-entry sync
  offset, URL/file restore), color filters with presets, fullscreen
  pinch-to-fill fill/fit, in-player settings panel, toasts, extensible
  shell surface
- Not a general browser tool: ad-heavy hosts and player platforms are
  excluded in the header (YouTube, Vimeo, Netflix, streams, socialsâ¦), and
  `entry.js` keeps a runtime skip list above that.

**Repo shape (24 source modules, ~15k LOC):**

```
src/
  entry.js            install-time contract: which frames run the script
  kernel/  (4)        contract, detection, discovery, kernel orchestrator
  shared/  (5)        core, runtime, dom, page, store â the data planes
  shell/   (15)       shell, media, resume, filter, forge+actions,
                      subtitles(2), chrome(6 + styles.css)
check/                the one testing tool (see Â§7)
dist/                 generated, not the review target
esbuild.config.mjs    single build: IIFE userscript + css resource
```

**Shipping artifact** (`dist/playerforge.user.js`, ~165 KB one IIFE +
`dist/playerforge.css` via `@resource pfStyle`): match-all userscript with a
24-pattern exclusion list (`@exclude-match`, VM's strict match-pattern
surface â the old `@exclude` glob any-character semantics is why the bare
apex pairs existed; the released matcher's `*.` covers the apex), 8 grants
(`GM_setValue/getValue/registerMenuCommand/unregisterMenuCommand/
addValueChangeListener/removeValueChangeListener/getResourceText/
xmlhttpRequest`), `@connect *` + subtitlecat,
**`@run-at document-start`** (real under VM's MV2 registration),
deliberately **no `@noframes`**: every frame gets the script (Â§2).
`@downloadURL` pins the branch dist for VM's updater. Version is
derived from `package.json` by the build; never hand-edit the header version.
The bundled sheet rides the hand minifier (`minifyCss` in esbuild.config.mjs),
whose whitespace stripping carries grammar-critical preservation rules
(build-pipeline AâZ sweep, probed on the floor): the run before `(`/`:` is
kept when the preceding character can END a selector unit â an
identifier-ish char (dropping it merges two tokens into one, `) and (` into
the function token `and(...)`, which Firefox silently rewrites to
`@media not all`; a media row that never applies; the coarse-pointer
bottom-sheet rows shipped inert for releases under this bug) or a selector
unit terminator â `]` (attribute selector), `)` (functional pseudo), `*`
(universal) â where the drop fuses a descendant combinator into a compound
selector that matches nothing (the forge hide rule's `] :not(` shipped as
`]:not(` and the whole chrome hide was inert until the class was caught
live by the forge probe; a glued `]:`/`):` can also be a legitimate
compound, so the gate's pin on this rule is the positive form), and the run
after `)` is kept when a letter or `+`/`-` follows â calc's `+`/`-`
infix demands whitespace on both sides of the operator even after a paren
(`)+ var(` dies at substitution time: the probe read the computed fallback
where the spaced form computes) â or a `:`/`(` follows, the pass-1
interlock (pass 1 kept the run before the compound-led token only because
of the `)` before it; stripping here re-fuses the descendant, and only a
run the source spelled is kept since a glued `):is(` is a legitimate
compound the author authored without the space). Stripping elsewhere still collapses to one
space; calc arithmetic and descendant selectors survive as single spaces. The
shipped damage this fixed: the bottom-sheet row's `bottom` and `max-height`
calcs and the landscape coarse compact-panel row were all inert. The bundle
gate pins both glue signatures as a static artifact row.
The headerâruntime cross-check (sweep): the 8 `@grant`s map 1:1 onto real
call sites â setValue/getValue/addValueChangeListener/removeValueChangeListener
(store.js's storage plane), registerMenuCommand/unregisterMenuCommand
(kernel.js's MenuCommands), getResourceText (mount.js's `pfStyle` warm),
xmlhttpRequest (store.js's `gmRequestText`, the CORS-bypass subtitle ingest);
`GM_info` needs no grant (entry's version mirror) and `GM_setClipboard` is
deliberately absent â the store.js docstring's dead-permission-surface record
and the banner agree. There is exactly one network egress family in the tree:
the subtitle `loadFromUrl` path, user-supplied URLs from arbitrary hosts,
which is what `@connect *` is FOR; there is no plain `fetch` or
XMLHttpRequest anywhere in src (all cross-origin text rides the manager, whose
Firefox-MV2 wrapper honors `timeout`/`ontimeout` and gates nothing). The
explicit `@connect subtitlecat` line predates the umbrella (`004bd6e`, a
per-domain pre-approval) and has no dedicated caller left â inert
documentation under the matcher, kept as a header surface (header edits are
interventions; sweep #5 re-verified the apex-coverage matcher semantics this
rests on). **The network floor is census-pinned (sweep #6)**: the census
stage derives the src-side counts (one `GM_xmlhttpRequest` relay site, one
`gmRequestText` consumer = the `loadFromUrl` voucher, zero plain
`fetch`/XHR/WebSocket/EventSource/`sendBeacon`/`importScripts`, zero
`.src =`/`srcset`/`createObjectURL` and script/iframe/img/track/link element
creation â closing the DOM-shaped channels the API can never grant â plus the
one `file.text()` drop-ingest read), and the bundle stage pins the header
half (exactly 2 `@connect` lines with the `*` umbrella among them; exactly 1
`@resource` â pfStyle is the one manager-fetched asset).

**Sweep #7 record (manager floor, premise-level, all verified against
Violentmonkey master at the v2.50.0-era HEAD â the same release the floor
names).** Five runtime premises the tree encodes as literal manager behavior,
each now source-cited: (1) the **echo contract** â `src/injected/web/
gm-values.js`: own writes call `notifyChange` with `remote = false`; the
background's `UpdatedValues` broadcast (`src/background/utils/values.js`) is
sent to every opener frame of every tab (sibling frames of the writing tab
included) and re-fires hooks through `changedRemotely(..., remote = true)` â
and self-receipt is deduped structurally: the writer's own `bridge.storages`
was updated at write time, so its broadcast re-read finds `oldRaw === raw` and
never re-fires (the "own-write echo arrives exactly once" shape the `gm` case
proves empirically in both directions); per-callback try/catch isolation is
the released behavior. (2) **the xhr relay gates nothing** â `src/background/
utils/requests.js` consumes no `@connect` vocabulary anywhere in the
background/injected request pair (`vetUrl` is URL-shape validation, not
host consent; the only "connect" in the pair is a forbidden-header regex), and
`timeout` is clamped and honored with `timeout` in `EVENTS_TO_NOTIFY` so
`ontimeout` propagates â the premise behind the store.js docstring and the
`gm` case's ontimeout row. (3) **the frame model's manager premise** â
`src/manifest.yml` the Firefox MV2 build ships `matches: <all_urls>`,
`run_at: document_start`, `all_frames: true`, byte-confirming "every frame,
top and cross-origin iframes, runs the full bundle". (4) **the `GM_info`
mirror** â `src/injected/web/gm-api-wrapper.js` sets `scriptHandler =
VIOLENTMONKEY` and `version = VM_VER`; the `gm` case's handler assertion and
entry.js's version mirror are manager-truth reads, not constants. (5) **the
matching surface** â sweep #5's `tester.js` record covers this floor's
matcher (`*.` apex coverage, strict `@exclude-match`). These premises are
what make Tampermonkey/Greasemonkey ports non-trivial: each is a
released-source behavior the runtime treats as given, and re-auditing them
against a different manager means re-proving each file's semantics from
that manager's released source (see the sweep's remote-verification
artifacts under `check/.tmp/`, left uncommitted per convention).

**Sweep #7 addendum (Nov 11 2026, re-audit against the RELEASED v2.50.0;
user direction "VM floor re-audit"; audit-clean, one wording refinement).**
The five premises were re-derived from the released v2.50.0 source itself
(`check/.tmp/vm250-audit/` â the nine premise files fetched at the tag,
uncommitted per sweep convention), not master HEAD, the first re-check
against a real release since the premises were pinned. The release's
v2.49.0âv2.50.0 commit log (53 commits) touches our planes in exactly four
commits: `3f9ae1b` (#2716, matcher), and three xhr-plane fixes (`a003039`
reqId strip on redirect, `b77352e` large incognito response, `5ce39a4`
dlInTab abort); the rest are sync/cron/MCP/locale. Per premise:

1. **Echo contract holds byte-true.** `gm-values.js` at the tag: own writes
   fire `notifyChange(..., remote = false)` via the default parameter,
   foreign updates ride `changedRemotely(..., remote = true)`; the
   own-write echo is still deduped structurally (`raw !== oldRaw` â the
   writer's `bridge.storages` was updated at write time); per-callback
   try/catch isolation intact in `notifyChange`'s dispatch loop. The
   background half (`values.js`): `broadcast()` walks `openers[id]` per
   script â per tab â per frame, one `sendTabCmd('UpdatedValues')` per
   opener frame, sibling frames of the writer included.
2. **The xhr relay still gates nothing by metadata â one wording
   refinement.** Zero `@connect` vocabulary across the whole pair at the
   tag; the clamp survives verbatim
   (`Math.max(0, Math.min(0x7FFF_FFFF, opts.timeout)) || 0`); the notify
   event list still carries `'timeout'` (now in `injected/web/requests.js`,
   the file that moved) so the user's `ontimeout` arms `events[0].timeout`
   and propagates through `initXHR`'s handler wiring. The refinement: the
   released `vetUrl` applies `testBlacklistNet(res)` â the
   **user-configurable net blacklist** (`BLACKLIST_NET`, default-empty,
   opt-in) can return a `Blacklisted` error for a host the user themselves
   banned. So "vetUrl is URL-shape validation, not host consent" now reads:
   no metadata consent; the one host gate is the user's own net blacklist,
   which gates nothing on a stock install. New engine facts recorded:
   `limitConcurrency(4-per-host)` applies ONLY to the `Request`
   own-command (extension's own fetches) â the gmxhr `HttpRequest` path is
   not throttled; every `__.MV3` branch (DNR rules, offscreen document,
   chunked responses) skips on our Firefox-MV2 floor where `initXHR` runs
   directly.
3. **The frame model holds byte-true.** `manifest.yml` at the tag:
   `matches: <all_urls>`, `run_at: document_start`, `all_frames: true`.
4. **The `GM_info` mirror holds byte-true.** `makeGmInfo` sets
   `scriptHandler = VIOLENTMONKEY` and `version = __.VM_VER` (the release
   build's version define), plus the additive `userAgent`/`userAgentData`
   getters.
5. **The matcher surface holds, and the #2716 port fix is now measured
   engine fact.** `RE_STR_ANY = '(?:|[^:/]*?\\.)'` (the `*.` apex
   coverage) and `RE_GLOB_HOST_SUFFIX` are unchanged; `@exclude-match`
   still rides the strict `MatchTest` surface (the new `testScriptDetailed`
   is an additive MCP-tool wrapper over the same builders). The port fix:
   `MatchTest` now `splitPort`s the host and `test()` matches when
   `!this.port` â **a portless pattern matches any port**. All 24 of our
   `@exclude-match` patterns are portless, so their ban coverage formally
   widened to explicitly-ported URLs â the safe direction for exclusions
   (we ban platforms, any port included); no pattern needed a change.

New surface notes, none premise-relevant: MCP integration (#2699/#2715) and
the cron update schedule are dashboard/updater planes the runtime never
rides. Disposition: record-only, no src change earned adoption; the store.js
docstring's "gates nothing" sentence stays correct under the refined
reading (stock install = no blacklist). Artifact: `check/.tmp/vm250-audit/`
(the fetched tag sources), uncommitted per sweep convention.

The two exclusion vocabularies are complementary, not
redundant: the 24 `@exclude-match` patterns ban the player *platforms* the
match-all lets sitewide, while `entry.js`'s runtime skip
(`AD_HOST_SUFFIXES`/`AD_HOST_PREFIXES` + the about:blank/data: gate) does the
hostname-anchored work the header cannot â rejecting ad/captcha *frames* of
sites the header allows, whose hostnames may appear only in a path or query
of a legitimate video page.

**Sweep #5 record (exclusion-vs-registry non-overlap, audit-clean).** The two
ban surfaces were cross-checked against the 15-record `SDK_REGISTRY` per
banned platform, both directions exhaustively: (A) no host is spelled on both
surfaces â `facebook.com`/`fb.watch` (header, platform) vs `facebook.net`
(runtime skip, the SDK-loader embed family) are complementary families, not a
dual spelling; the skip's 10 suffix families + `adservice.google.` prefix
touch no header pattern and vice versa. (B) no record is unreachable behind a
ban â every banned platform runs a proprietary player (studio DRMs, feed
players, the bilibili in-house player that is not the third-party DPlayer SDK
it shares history with; v.redd.it serves bare video files, correctly unbooted
under the no-generic-fallback law), and record identity rides names + CSS
anchor vocabulary, which cannot host-match â no record scopes a banned host.
(The registry's growth after this sweep â Shaka Player, OpenPlayerJS â
carries the same identity shape: names + anchor vocabulary only, so the
non-overlap invariant holds without a re-walk.) The sweep also re-verified the matcher ground truth the banner comment rests
on against Violentmonkey's released source (`src/background/utils/tester.js`):
`hostMatcher()` maps `*.` to `RE_STR_ANY = (?:|[^:/]*?\.)`, whose empty
alternative covers the apex domain, so `*://*.youtube.com/*` bans
youtube.com itself; `RE_GLOB_HOST_SUFFIX` rejects trailing-`*` TLD hosts in
favor of the `.tld` vocabulary â none of the 24 patterns is at risk. No gate
row added: the bundle stage already pins the strict `@exclude-match` surface
(and fails on any `@exclude` glob returning), and the audit surfaced no
further machine-enforceable invariant â the check's artifact is this record
(`check/.tmp/overlap-audit.mjs`, left uncommitted per sweep convention).

**Commands:** `npm run build` (or `--watch`), `npm run lint` (eslint src/),
`npm test` â the alias for `check/run.mjs`, the repo's one testing interface.
`npm run check:browser`, `check:flaws` (the syntax+flaws pair),
`check:census` â the individual quick gates.
A clean run is ~60s.

---

## 2. Frame model (the most load-bearing fact)

The manager injects the script into **every frame** of every page â top and
iframes, same-origin and cross-origin:

- Each frame document runs the full bundle: its own kernel, its own bridge
  installation, its own GM realm. A kernel boots only when **its own
  document** holds a qualifying video, and it adopts exactly **one main
  video per document** â the product's scope law: the first qualifying
  candidate wins (identity + presence proven together at the boot probe â
  the pick; the kernel boots adopted, not discovery-first), later
  qualifying candidates are refused while a shell is live or mid-boot, and
  the registry-empty edge re-arms discovery so the next candidate adopts
  when the main leaves. Enforcement is **per document only** â cross-frame
  coordination machinery does not exist, so a Top video plus a
  separate-iframe video still yields two shells. Exactly one document boots
  a shell per embedded player, neighbors stay inert, a video-less host
  page never boots, and neither does a page whose only videos carry no SDK
  anchor â the probe's identity ask makes that literal, where the old
  pipeline booted a kernel that then refused every candidate.
- Menu commands install **top-frame only**.
- `window.top !== window` frames push fullscreen provisioning up the chain on
  shell creation: every ancestor document grants `allowfullscreen` on its
  *direct child* iframe only (`installContextBridge` /
  `requestFullscreenProvision` in `page.js`).
- Page context (`domain/path/title`) is read from `window.top` directly when
  same-origin-capable; cross-origin frames go through the frame bridge
  (postMessage `pf:`-prefixed, MessageChannel ports; a nonce-broadcast belt
  survives only for a genuinely refused port transfer, with no chain memo â
  the refuse-to-remember arm retired with its jsdom premise), so the resume
  entry always carries the **top document's** context. Zero timed retries:
  the bridge resolves event-driven â one send,
  then a `pf:ready` announce-down (install + relay echo to pending
  requesters, parent-hop-limited) re-issues requests and re-arms latched
  fullscreen provisions when an ancestor's handlers armed late; an
  ancestor's armed state is script-fact invisible to layout, so the
  announcement is the real reading (the deadline watchdog settles null for
  bridgeless embeds). The bridge's returned teardown is deliberately never
  consumed at its entry install â the same page-lifetime arrangement as the
  kernel shell-ready handle: the bridge must stay armed across kernel boots
  and bfcache restores, and a real unload disposes the realm with it. When
  nothing answers, the frame falls back to its own
  context rather than losing resume.
- Navigation: `pagehide` tears the kernel down unless `event.persisted`
  (bfcache keeps it); `pageshow` re-arms it â restoration re-adoption rides
  the orphan reconcile (`#reconcileOrphan`: a detached shell video is
  destroyed and the registry-empty edge re-arms the full discovery tap) â
  and the non-persisted hide tears the probe's capture listeners down with
  the realm (entry.js). The bfcache/freeze-recovery plane sweep (AâZ) probed
  the Page Lifecycle vocabulary on the floor: **Firefox 159 exposes
  `freeze`/`resume` in no realm and has no `document.wasDiscarded`** â
  Chromium-only surfaces â so every arm keyed to them retired: the kernel's
  `resume` reconciliation listener (its work was one duplicate of the
  pageshow reconcile), resume.js's `freeze` flush, forge.js's `freeze`
  session interrupt (blur + `visibilitychange` hidden cover the swallow
  classes on Firefox; the freeze interrupt could never add a third onset),
  and `#onPageShow`'s `wasDiscarded` guard clause (a Chromium discard-restore
  is a reload â a fresh realm boots a fresh kernel â so the clause bought no
  reconciliation even hypothetically). Recovery on the floor is exactly:
  `visibilitychange` hidden + `pagehide` flushes (the pagehide belt is live
  on the persisted leg only â a real pagehide dispatches the kernel's own
  pagehide listener first, whose scope dispose aborts the tracker belt
  mid-dispatch, and that leg's final save rides the shell destroy inside
  the kernel's destroyAll), persisted-hide state preserved, `pageshow`
  reconcile + registry-empty re-arm.

## 3. Module map (AâZ)

### shared/ â five data-shaped planes, import-clean of each other
- **core.js** â clamping `P()`, tuning constants (`TUNING`, resume cadence,
  gesture timings, `RESUME_*` floors), formatters (`formatTime`,
  `fmtPercentOrOff`, â¦), error classification, `delay/debounce` moved out
  (they live in runtime's scheduler). Zero imports.
- **runtime.js** â the scheduling engine: a `postTask` faÃ§ade over
  `scheduler.postTask` (single native arm, no emulation anywhere â the real
  engine is the check's proof surface; the retirement audit is re-probed live:
  no upstream sunset movement, priority tiers honored natively on 159, the
  two-controller shape load-bearing because an abort landing inside the task
  body rejects the completed task's promise, and the `yield_()` guard still
  recovers what raw `scheduler.yield()` rejects in an own-aborted task â
  pinned by the `scheduler` check case), `delay()`/`debounce()` handles (the
  one timer backend), `runSteps`/`runStepsAsync` (ordered declarative step
  lists for every boot/teardown sequence), `Scope` (one destroy-root per
  feature, every listener/timer/observer routed through it; the cleanup
  verb is `defer(fn)` â the platform's DisposableStack vocabulary on this
  floor, with the queue deliberately NOT the platform's: a disposed stack
  refuses late registration where the contract runs it immediately, and the
  platform rethrows disposer errors where the treaty isolates and logs every
  throw; the `#disposed` flag died into `signal.aborted` â the abort flip
  completes synchronously before any listener runs, so a re-entrant dispose
  no-ops from the flip onward), `Fan` â the ONE plain-fan-out
  owner, a native `EventTarget` carrying one event per instance
  (`emit(payload)`/`subscribe(cb, { signal })`; the FsGate, FilterSession,
  ResumeStore, ConfigStore, SubtitleSyncState,
  SubtitleSession, and kernel shell-ready audiences all rode it â the
  kernel's per-listener try/catch retired with the conversion, native
  dispatch isolation is the real thing). Audited census: ten instances â
  kernel shell-ready (entry's page-lifetime only; its returned handle is
  never consumed), FsGate, ReferenceBox change-ticks (exactly ONE
  subscriber: the subtitle renderer; every gesture consumer
  reads-and-discards via `get()` â the emit heat is scroll-frequency but
  one-tap-deep), FilterSession, the three SubtitleState grains +
  SubtitleSession's presentation state, ConfigStore's `settings` bus (the
  echo-storm hot path: 1000 foreign writes ride the robust row inside
  400ms) and ResumeStore's entry set.
  **Subscriber census (the audience axis, recorded alongside the instance
  axis)**: fs-gate 5 (ReferenceBox's fs-flip re-seed, the pinch wheel's
  fill-release, `ViewershipTransform`'s reset, the panel's close-on-fs,
  the ForgeBar's show/hide ride); sync grain 2 (session offset apply + panel stepper echo); placement
  grain 2 (the grain's forward into the session + the panel position
  echo); settings bus 2 (the action layer's hotkey recompute + the
  panel's cross-tab sync); resume store 2 (the sync grain's re-resolve
  via the tracker + the subtitle restore); kernel shell-ready 1
  (multi-boot across destroy-readopt and registry-empty recovery);
  reference-box ticks 1; FilterSession 1 (the VideoFilter section);
  style grain 1 (the panel echo â the five values boot-apply directly at
  bind, no subscription); session presentation state 1 (the section's
  hint refresh; the renderer's crank re-reads state, it does not
  subscribe). Five relays, five true fans. The relays stay on purpose
  (the few-fans review batch): a direct callback drops native dispatch
  isolation (a throwing subscriber strands the notify chain) and
  hand-rolls signal teardown the Â§5.6 census retired â and three of the
  five exist because of import direction (`shared` cannot import
  `shell`; `dispose` has no reverse surface on this floor). The one true
  reducer audited and declined: merging the four subtitle-module Fans
  into one grain-tagged bus (10â7) â robustness identical, but the
  saving is a few EventTarget allocations per frame, the same noise
  scale the pooled-dispatch measurement declined (~1Âµs/emit), while the
  per-grain event identity that makes the one-owner-per-grain record
  audit-checkable would live in payload tags instead. The one deliberate
  non-fan: DomWatch
  cannot ride it â EventTarget exposes no listener census, which the feed
  needs three ways (liveness-gated observer teardown, tombstone
  compaction, logged throw containment). The subscribe handle is a
  Disposable (`[Symbol.dispose]` on the old callable â FF 134, floor-real;
  `using` verified live on the 159 page realm; one shape on every subscribe
  path â the already-aborted no-op returns the same Disposable over a
  release spent at once, the bare-closure fast path this once kept was a
  second shape whose protocol was aliasing luck); pooling the dispatched
  CustomEvent was measured (~680 ns/emit vs ~1690 fresh) and declined: an
  in-dispatch event re-dispatched synchronously throws InvalidStateError,
  and the settings bus is exactly the re-entrant shape, while ~1Âµs/emit is
  noise against the delivery-dominated budgets. Observable/
  `EventTarget.when()` stays un-adoptable â Mozilla's negative standards
  position (bug 1871732) keeps it off this floor, so Fan remains the
  fan-out definition the platform doesn't ship â `DebugRuntime` (the
  one debug flag, private to the instance; the LoAF arm retired â probed
  unreachable: Firefox 159 exposes the entry type in no realm, page or
  worker), logger facade.
  **Sweep #13 record (core + runtime AâZ, audit-clean; the sweep map
  closes).** core.js and runtime.js read front-to-back â the last pair
  without a series record. **core.js**: the zero-import leaf claim holds,
  and the pass's one mechanical audit ran reference-counted: every
  `TUNING` leaf key, every timing constant, and every formatter carries at
  least one live consumer â the dead-constant class this file's own history
  records (13 exports retired once, which was where "single source of
  truth" went honest) has not regrown. `isBenignMediaPolicyError` is
  exactly the two-name classification the media record names. One
  ownership note verified deliberate: `FRAMEWORK_TUNING` (contract.js) is
  the kernel's single constant â `removalGraceMs`, consumed once at
  kernel.js's removal-grace delay â disjoint from the behavior `TUNING` by
  domain and by owned key, so no duplicate-tuning-table drift exists.
  **runtime.js**: the facade choreography verified at statement level â
  the fire path aborts ONLY the release controller (the two-controller
  shape's measured reason: aborting the task signal inside the body would
  reject the completed task's promise); `end()` aborts both on the
  handle/owner paths; and every rejection lands behind
  `task.catch(() => {})`. Newly pinned: that swallow IS the timer-callback
  boundary semantics â a throw inside a `delay`/`debounce` callback lands
  silent, never on the page error surface (the deliberate inverse of Fan's
  native-dispatch reporting sentence; both real debounce consumers'
  writes â filter's `#writePersist`, subtitles' `#write` â carry their own
  log-then-continue classes, so nothing depends on a callback throw
  surfacing). `debounce`'s `.flush()`/`.cancel()` hold their
  sinks-with-owners shape â exactly one real consumer each (filter destroy
  flush; subtitles destroy cancel), matching the trailing-write-before-
  teardown premise spelled in the export. Scope's abort-flip idempotency
  and the late-`defer`-runs-now path verified against `#runDisposer` (the
  census's one catch-log-never-rethrow isolation site); Fan's handle
  carries `[Symbol.dispose]` unconditionally â the same Disposable over a
  spent release on the aborted fast path, exactly the one-shape contract
  the Â§4 record pins. `DebugRuntime` is the one console-flag owner; the
  `setRuntime` alias survives as the consumed path (`setDebugRuntime` â
  `setRuntime` â `setLogs`), not a dead surface.
- **dom.js** â the shared mutation feed (`onDomMutations`: ONE page-level
  MutationObserver; its three real subscribers are discovery's media tap +
  detached-target prune and the page.js pipe diff â the feed's fourth
  subscriber, inject.js's reconnect watchdog, retired with the shell-mount
  adoption (the host's own custom-element lifecycle replaced it) â the
  module's other exports ride the same plane, not the feed),
  `DomPool`
  (element recycling; the three reusable DOM pools are the toast pill, the
  panel's history cards, and the subtitle cue slots â the first two are
  DomPool consumers, the cue slots are pool-by-construction: a
  MAX_SLOTS-bound fixed pre-allocation that never acquires/releases, so a
  grow-on-demand recycle fits nothing there), `ReferenceBox` â the ONE
  fill-box identity and ONE read in
  both modes: the same SDK container discovery resolved (detection's
  composed-ancestry `host`/anchor walk), a single `getBoundingClientRect()`
  filling dims AND origin â the read the discovery presence gates use on
  the same element. The fullscreen convergence is structural: the fs gate
  only arms in the video's own document now, and there the fullscreened
  tree IS the SDK's container tree â the SDK's fullscreen expands the
  container edge-to-edge, so its rect becomes the gesture space on its own
  and the class needs no fs branch at all (the letterboxed-frame /
  document-kind shapes the former viewport arm served are dark under the
  API-only gate by construction); the fs `layoutViewport()` arm, the
  `(0,0)` origin rule it carried, and the inline clientWidth/Height
  "untransformed layout numbers" dual-source all retired with the
  direction (a site-scaled container now reports the scaled box the real
  gestures land in);
  pools per invalidation so the hot path stays layout-free; carries the
  full rect â `x/y` origin at the same reveal-on-invalidation instant, the
  consumer class that anchors against it rather than merely sizing needs
  the position â and broadcasts change ticks over the one Fan at exactly
  its four invalidate sites (container RO, fs flip, orientation,
  and scroll â the origin-bearing arm: scroll repositions the viewport
  origin with no size signal, so the size-only cache the pool once was
  was silently wrong for anchor consumers; the audited subscriber census:
  every gesture consumer
  read-and-discards per flow, the subtitle renderer is the tick
  subscriber) â and
  `layoutViewport()`: the ONE real-world viewport read (the root element's
  laid-out box first, reported innerWidth/innerHeight as fallback; kernel
  presence and the inline gesture-zone width consume it). Real-reading candidates audited against the floor and
  declined: `devicePixelContentBoxSize` (delivers live on the floor, probed
  via the boxes option â device-pixel units no CSS-px consumer can
  couple), IO (intersection-clipped, episodic),
  anchor positioning (a positioning surface; its styles.css verdict), vv
  (the Â§4 witness-absence verdict; the sheet's mirror, not this class).
  Headless so far: reports a real synthetic screen (1366Ã768 probed â the
  old screen-width-0 note died). The `fs` gate (FsGate) keeps ONLY the
  native fullscreen API's own surfaces, by user direction: truth is
  `document.fullscreenElement` (per document â the video's own top/frame
  document) read per update from `fullscreenchange` and the lifecycle
  pageshow re-seed, and both fullscreen media queries retired with the
  probe record from this batch's run: the old `(fullscreen)` query never
  evaluates on Firefox under ANY kind (probed element/document/frame/exit,
  headed + headless; the "Chromium evaluates both" note was Chromium-side
  on a Firefox-only floor), and `(display-mode: fullscreen)` â probed
  Firefox's universal fullscreen witness (both kinds, a fullscreened frame
  and its parent, false on exit, the letterboxed frame under a fullscreened
  window too, where the frame viewport stays the gesture space) â is a
  display-mode surface, not the API, so it left with the rest; window
  fullscreen (F11) presents no fullscreenElement and fires no
  fullscreenchange, so the gate goes dark there by construction (the same
  reading real Firefox shipped before the probe run; the gate's own
  breadcrumb names the blind kind).
- **page.js** â site identity (`getDomainKey`, `domainsMatch`, `domainScore`,
  `hashEntry`, title sanitizer), page context, the frame bridge (`pf:` prefix,
  `ContextPipe` class owning pipe state, context responders,
  fullscreen provisioners). The Navigation-API `onNavigate` surface (plus
  resume's whole route-follow chain it armed) is retired: same-document
  navigation is outside the product's topology â the swap machinery's one
  unique value was the route-change + in-place-swap conjunction, an in-place
  src swap without a route change never had a watcher even then, and a
  route change with document unload is the kernel's pagehide + fresh boot.
  Reintroducing it needs new scope direction: a same-document URL change is
  now a blind spot, accepted.
- **store.js** â the storage data plane: `KEYS` = three roots (`pf:configs`,
  `pf:resume`, and the transient `pf:diag` â NOT a state; each write is a
  one-shot "dump now" gesture consumed by its own echo, `randomUUID` values
  mean no read ever re-acts and a stale residue is inert, so it owes no
  cleanup deadline),
  `gmSetValue`/`loadJsonObject`, and `watchStorageKey(key,
  handler)` â the cross-instance subscription that filters own-write echoes
  (`remote === false`) in exactly one place. The echo contract is VM-truth
  (read from its released GM-values source): own-instance writes flag false,
  every foreign instance â another tab OR another frame of this tab â hears
  `remote=true`, so a top-frame menu flip reaches sibling frames. Storage is
  **synchronous GM storage, deliberately not IndexedDB** (manager-space
  portability; a cross-tab live-reload needs echo events, not thread offload).

  **Sweep #10 record (store.js proper AâZ, audit-clean).** The module read
  front-to-back with every seam reconciled against the wider records, no src
  gap: the **grant guards are the deliberate survivor class** â the Â§4
  single-backend census retired double-typeof *platform-capability* checks but
  kept "grant guards (manager policy, not platform)", and every GM wrapper
  here (`gmRegisterMenu`/`gmUnregisterMenu`/`gmAddValueChangeListener`/
  `gmRemoveValueChangeListener`/`gmGetResourceText`, plus `gmRequestText`'s
  route) is exactly that shape: `typeof GM_*` guards the grant surface, not a
  platform capability â a missing grant degrades to a null handle / null
  resource, never a throw. `watchStorageKey` owns the echo contract the tree
  rides: the `args[3] === false` own-write filter in exactly one place, the
  lenient default (a 4th-arg-omitting implementation behaves as foreign writes
  â the contract only ever widens deliverability, never silently drops), the
  `{ stop() }` handle idempotent across double-stop and failed-install
  (callback-first order: an install throw still returns a usable stop), and
  its premises are the sweep-#7 source-cited manager truths (per-tab+frame
  broadcast, `remote=false` only on the writer's own delivery). `ConfigStore`
  carries the census's storage claims exactly: the parse-once `#cache`
  (`loadJsonObject(configs, { version: 1 })` boot default) served from the
  module cache with `invalidate()` as the cross-tab refresh arm; the
  copy-on-write descent (whole-doc `structuredClone` was the dominant CPU cost
  of one stepper-step write) with the for-in-with-own-guard attr-walk repeating
  ui.js's measured ~78â~20 ns/op finding; the `isSafeKeySegment` guard is
  applied along BOTH the read path (get â "a hostile stored doc must not turn
  a read path into prototype traversal either") and the write/delete paths
  (`__proto__`/`constructor`/`prototype` rejected as segments), with
  `Array.isArray` gates in the `setFields`/`deleteField` walkers refusing
  arrays as intermediate nodes (the strict-CSP census's dead `structuredClone`
  vocabulary is gone â the walkers ARE the shape guarantee). The two-dot
  divergence is deliberate and stays unshared: `setFields` warns-and-drops the
  whole batch on an unsafe segment ("a write must stay visible"), while
  `deleteField`'s walker silently no-ops â the documented "four behaviors
  under one mode flag" refusal where a shared walker with a mode flag would
  tie two error verbs to one table. `#persist` is the log-then-continue class
  (log, return `false`, keep the cache as-was â a failed write leaves memory
  ahead of disk, and the next cross-tab echo re-serves the foreign doc).
  `loadJsonObject` itself is the plain truthiness-object read â missing/corrupt
  yields the fallback; no array-read gate exists at load level because the
  tree's writers project through field whitelists (the resume entry
  projection; the configs doc's setFields shape guards) and the walkers make
  an array-valued segment inert rather than polluting.

  **Sweep #12 record (shared geometry/context planes AâZ, audit-clean).**
  dom.js and page.js read front-to-back â the last two shared planes without
  a series pass â and both seam rings reconciled against the wider records,
  no src gap. **dom.js**: the census claims re-derived live exactly as
  recorded â one mutation feed with its four real subscribers (discovery's
  media tap + detached-target prune, the iframe registry's added-node diff,
  inject.js's detach watch â the feed's fourth subscriber retired with the
  shell-mount adoption; three ride it now), ten Fans, eleven Scope roots with the
  DOMManager as the shared-side root. Newly pinned: the feed's two
  proven-bug stories are measured engineering record, worth holding â the
  pooled batch double-buffer swaps then re-arms the incoming buffer EMPTY
  (without it, every flush from the third onward re-delivered stale records
  witnessed as `[1,1,2,2,3]`; each a redundant DOM walk over already-handled
  mutations), and the `PUSH_APPLY_LIMIT` index walk exists because
  `apply()` spread on a mass-DOM-teardown batch hits the engine's
  applied-args RangeError (measured: V8 at ~124k) that would escape the
  observer callback before `#queued` is set â the whole batch silently
  dropped (the fast path stays apply, the walk is the safe arm); the 4:1
  tombstone compaction rides slot-IDENTITY unsubscribe (the returned
  `off()` closes over its slot object, so reindexing can never orphan a
  handle â the positional-tombstone zombie the comment records); the
  hidden-tab belt parks dispatch on a background-priority postTask capped
  500ms and resumes on visibilitychange (the zero-timer census's
  coalescer class, armed only while the feed awaits). FsGate: the
  persisted-pagehide force-false writes the `fs` binding DIRECTLY, not
  through `#set` â silent by design: no emit to subscribers on a page going
  away, the restore's `#update()` then no-ops (fs already false), and the
  erased on-claim was a stale future anyway (the browser exits fullscreen
  on navigation; the belt exists because a persisted restore would never
  fire fullscreenchange to correct it). ReferenceBox's four invalidate arms
  verified (container RO, fs flip, orientation, capture-phase scroll), its
  audience is exactly the four fullscreen subscribers the census names
  (ReferenceBox, the forge pinch fill-release, `ViewershipTransform`'s
  reset, the panel close-on-fs â the count the sweep measured; the ForgeBar
  joined as the fifth after it), and the two traversal helpers + the ONE
  layout-viewport read hold their consumer lists (forge's control-focus
  gate and zone width, the panel's focus-return, shell's shadow-host
  check, discovery's presence gate). **page.js**: the census holds â zero
  timers; both of the module's deadline classes are activity-paired, not
  polled (TopFrameResponder evicts idle pipes inside `#touchPipe` on
  request activity â a truly idle pipe closes only on messageerror or a
  later request; FrameRelay's nonce TTL sweep runs per incoming
  request/ready echo). Newly pinned: `isOwnFrame`'s nested-frame walk caps
  at depth 4 and only while layers stay same-origin-readable â a
  cross-origin `contentDocument` catch ends the subtree (the strict vouch
  posture unchanged, merely visibility-bounded); the single-bridge-handler
  ordering is load-bearing (iframeRegistry.arm runs first inside the
  dispatch so the synchronously-seeded cache lands before the next
  handler's vouch, re-establishing the old listener-registration-order
  guarantee the three-listener shape got for free); and the
  fullscreenerror remediation seam is closed on both sides â the gate's
  own docstring names shell.js as the HUD-layer owner, and shell's
  `#watchFullscreen` re-arms + re-hops via `retryFullscreenProvision`
  exactly on the failure path the provision latch re-opens for.

### kernel/ â policy layer
- **contract.js** â the shared vocabulary both layers import in isolation:
  gesture registry (`GESTURES`/`GESTURE_IDS` are formula-derived from `{id:
  label}` pairs â six families: hold, scrub, swipe, dbltap, pinch, tap),
  `GESTURE_EVENTS` (`pf:gesture-<id>`), `DEBUG_HASH_TAG =
  "pf-debug"`, tuning knobs, `BARE_SDK_NAME` (the bare tier's descriptor
  name, the adoption identity both the shell's surface takeover and the
  input gate's bare-space open read), and `AdoptionHome` â the frozen adoption
  identity the kernelâshell watcher protocol carries (one record per
  adoption through the provider, the `RemovalWatch` anchors, and the
  destroy-readopt compare; every seam previously re-spelled the
  `{video, container, sdk}` shape by hand). The record's single
  vocabulary is `video` + `sdk.<fact>`: the descriptor (`name`/
  `container`/`hops`) is the one holder of the SDK facts and no alias
  getter re-spells them (user direction â rely on the sdk descriptor
  alone; the container hop-count facts are per-match resolved and
  cannot derive from the name alone). The frame bridge's message types derive from
  their own single prefix inside `page.js` (module-local by documented
  design); key bindings derive in `actions.js`. No machine-facing string is
  hand-spelled anywhere else.
- **detection.js** â the SDK identity engine, registry-driven, importing its
  contract plus the one configs read the bare-video tier gates on
  (`BARE_VIDEOS_KEY` through `getConfigValue`; the import graph stays
  kernel-plane downward into shared).
  23 supported SDK records (JW Player, Video.js, Plyr, ArtPlayer, DPlayer,
  MediaElement.js, XGPlayer, Aliplayer, Fluid Player, Flowplayer, Clappr,
  Vidstack, Mux Player, Radiant, Laravel Video Embed, Shaka Player,
  OpenPlayerJS, OvenPlayer, Bitmovin Player, Kaltura PlayKit, NPlayer,
  AblePlayer, Jellyfin), each a set of
  **SDK-namespaced anchor selectors** resolved by the native `closest()`
  walk â the primary arm: `closest(ANCHOR_PROBE)` answers the nearest
  matching ancestor-or-self in ONE C++ call (light DOM AND shadow-internal
  trees; the answer is the fewest-hops answer by construction, since any
  boundary-crossing match is strictly more hops), with the composed
  parentNode/`.host` walk kept as the shadow-boundary arm for exactly the
  shapes `closest()` cannot answer â an anchor above the video's shadow
  host, and detached videos. Identity at the matched element comes from
  the ordered per-record tie loop (`RECORD_PROBES` â each record's anchors
  joined into one list, one C++ `matches()` call per record answering
  "any of this record's anchors match"; registry order is the tie law,
  and anchor order within a record is internal to the join); measured
  ~2Âµs â ~1Âµs per first-resolve in Â§7's hotpath row (the composed arm's
  miss path stays hop-ascending, one `matches()` call per hop). The join
  constraint: an anchor must carry no top-level comma (a separator spelled
  into an anchor would silently become two arms under the record's name; a
  comma inside a quoted attribute value is one selector to the engine and
  fine). There is deliberately **no generic fallback** â a bare
  `<video>` with no SDK anchor never boots. The ONE deliberate exception is
  the opt-in **bare-player adoption tier** (Nov 12 2026, user-directed): with
  `discovery.bareVideos` ON (default off, the menu flips it), an anchor-less
  `<video>` qualifies on the evidence bar `URL.parse(currentSrc)?.protocol
  === "blob:"` AND `played.length > 0` â all native reads, all required; the
  blob leg is the deliberate-player discriminator (MSE hands out exactly
  these URLs; plain/data/empty src and `mediastream:` never qualify), the
  played leg is the junk killer (decoder/canvas textures and preload-never-plays
  embeds never reach it), and presence stays discovery's unchanged job. The
  qualified descriptor is `{ name: "Native Video", container:
  video.parentElement, hops: 1 }` â the page's own container adopted as-is,
  the video NEVER moved, zero DOM surgery (user direction "Adopt page
  container, video stays" + "Take the parent as-is"); once blob+played
  qualify they stay qualified, so the positive caches parent-stamped like
  any other, while a null NEVER caches while the tier is on (the evidence is
  time-varying) and the tier-off negative cache stands byte-identical. The
  tier flip is the one invalidation the parent stamp cannot express â
  `clearDescriptorCache()` reassigns the matcher's WeakMap, called by the
  entry's flip applier before re-running discovery. Record provenance is
  source-verified, not assumed: Clappr's compound lead anchor
  `.container[data-container]` (the vendor-set `{ class: "container",
  "data-container": "" }` Container element, one hop closer than the Core's
  `data-player` fallback arm â verified in clappr/clappr main) resolves the
  shell home to the tight video box. The kernel AâZ audit re-proved the
  ring against current vendor releases: XGPlayer's `xgplayer` root class
  (v3 source + docs, the `xg-` elements are plain non-canonical elements),
  MediaElement's dual namespace (`mejs__` default + the legacy `mejs-`
  stylesheet route, verified through 7.1.0), Flowplayer's `.flowplayer`
  setup container (the OSS release's own minimal-setup markup), and
  ArtPlayer's `art-video-player` (256 occurrences across the current 5.x
  dist) all hold; the audit found one record GAP â Radiant's single
  custom-element anchor covered only its secondary WC install route, so it
  gained `.rmp-container` (the primary script route's appended wrapper,
  verified in the served rmp 10.7.9 `wc.rmp.min.css` class set), and the
  media element's own `.rmp-video` is deliberately not an anchor â a 0-hop
  match would resolve the video element as the shell home, a box the shell
  cannot host its DOM in. The two newest records carry the same vendor
  receipts: Shaka Player rides `[data-shaka-player-container]` (the
  Overlay constructor stamps it on EVERY programmatic use, ui/ui.js)
  leading `.shaka-video-container` (the auto-setup div's class,
  ui/less/containers.less), and OpenPlayerJS rides `.op-player` (the
  wrapper `createUI` injects on both the audio and video paths,
  packages/player/src/ui.ts â the media's own `.op-player__media` stays
  off the list, the 0-hop law). THEOplayer was verified and DECLINED as a
  record: v5 through v11 (the OptiView-era latest) all document the
  container as `<div class="video-js theoplayer-skin">` (npm README +
  ui.css, both releases read) â THEOplayer is Video.js-based at every
  release, the existing Video.js record already covers the topology, and
  a `.theoplayer-skin` record would be dead on real pages (the video.js
  wrapper resolves nearer). The registry's second growth round verified
  three more records from vendor source: Bitmovin Player rides
  `.bmpui-ui-uicontainer` (the UI container `UIManager.ts` appends into
  `player.getContainer()` BESIDE the video â the sibling relationship is
  the vendor's own comment that display:none on the outermost UI
  container must not "block any events on the video"; the class ships
  95Ã in the built bitmovinplayer-ui.css, prefix default `bmpui` from
  _variables.scss), Kaltura PlayKit rides `.playkit-container`
  (playkit-js's `_createPlayerContainer` stamps it and the README mount
  contract appends `player.getView()` â that same div â into the page's
  target; the video carries `.playkit-engine` ON itself, the 0-hop law
  keeps it off), and NPlayer rides `.nplayer` (`player.ts`:
  `this.el = $('.nplayer', â¦)` with the video appended directly into it;
  the media's plain `.video` class is not vendor-namespaced and stays
  off). Three more candidates verified and DECLINED: dash.js carries no
  container vocabulary at all â the auto-embed attribute
  `[data-dashjs-player]` rides the video element itself (the `create()`
  requires `nodeName === VIDEO`, the 0-hop law) and the one
  "dashjs-player" hit in the dist is the `_dashjs_player` JS expando, not
  a DOM anchor; hls.js carries zero DOM vocabulary (no className/
  classList writes anywhere in the min dist); Pillarbox is
  Video.js-based (`<video-js class="pillarbox-js">`, `.video-js` Ã293 +
  `vjs-*` throughout its CSS) and is covered by the existing Video.js
  record â the THEOplayer verdict shape. One deliberate exception stands, closed: Laravel
  Video Embed's anchors are Inertia's `data-page` vocabulary, not
  the package's own (every Laravel embed package renders iframes), so the
  record matches any Inertia app with a bare video â it was added for a
  real-target site with a named fullscreen fix. The record-and-weigh-later
  path rode the problem-site diagnostics pass that served the
  reverted fs-ui plan; with that pass closed (not master work â it died with
  its branch), retire-vs-narrow has no standing re-open: the exception is
  deliberate, and re-opening it needs a new named site with real markup
  facts. The registry is
  exported as `SDK_REGISTRY` so the check's registry-coverage case proves
  every record against a real anchor-satisfying stub per record.

  **Registry-coverage batch 3 (Nov 12 2026, user direction "suggest batch"
  â "Registry batch 3"; src â detection.js + sdk case; two records added,
  four verified declines; the tie law's first cross-record split).** The
  batch-2 verification method over the embed ring. **OvenPlayer added**
  (OvenMediaLabs dist bundle): the ViewTemplate renders the player root
  into the caller's container â `<div class="ovenplayer op-wrapper"
  tabindex="-1">` â and inside it `<div class="op-player op-clear">` around
  the media; `.ovenplayer` is unambiguous vendor vocabulary (OpenPlayerJS
  ships no such class), and the second arm `.op-player.op-clear` exists
  because the inner root ALSO matches OpenPlayerJS's `.op-player` anchor â
  the first cross-record collision in the registry, resolved by the tie
  law: the record is placed BEFORE OpenPlayerJS, whose wrapper is
  `className="op-player op-player__keyboard--inactive"` (2.14.12 dist;
  `op-clear` appears nowhere in its dist, so the compound can never
  misattribute an OpenPlayerJS page â the ovenplayer-tie sdk row proves
  the split live: the vendor-shaped stub resolves OvenPlayer at the
  `.op-player` element, not OpenPlayerJS). **AblePlayer added** (ableplayer
  v5.0.0 `injectPlayerCode`, vendor inline comment naming the layers):
  video â `.able-media-container` (the player box that also carries
  captions/controls; leads as the fewest-hops tight home) â `.able` â
  `.able-wrapper` (outer fallback arm); `.able` itself is deliberately NOT
  an anchor â a single unprefixed English word is not SDK-namespaced
  vocabulary. Four candidates verified and DECLINED: **Amazon IVS Player**
  is headless â the standard path is
  `attachHTMLVideoElement(theIntegratorOwnVideo)`, and the only
  vendor-owned DOM (the gpu-feature `surfaceContainer` div and the
  `ivs-player-canvas-surface` canvas) is classless or an optional overlay;
  no vendor-namespaced container ever enters the page DOM (v1.58.0 dist) â
  a record would need the generic fallback the tree refuses. **Brightcove
  Player** is Video.js-based at every release: video.js itself stamps the
  `video-js` class onto the `<video-js>` element in the custom-element
  path (`De(i,"video-js")||Pe(i,"video-js")` in the Player constructor,
  v8.23.4 bundle), so the existing Video.js record covers the standard
  embed (the THEOplayer verdict shape). **TCPlayer (Tencent)** is
  Video.js-based â the dist CSS is the video.js `.video-js` sheet and the
  bundle carries the `video-js` vocabulary (tcplayer.js 5.3.4, Brightcove
  copyright + `vjsstandard` lint). **Bunny Stream Player** is an iframe
  player â the host page carries no video DOM at all
  (`player.mediadelivery.net` iframe per the docs receipt), and the
  in-frame player is closed-source with no verifiable anchor vocabulary,
  the no-generic-fallback law leaving it alone. Registry is now 22
  records; sdk case rows 260 â 263. Two export faces, one engine:
  `resolveAdoptionHome` is the kernel's wrap face (one `AdoptionHome` per
  adoption attempt), `findSdk` the boot probe's descriptor face â the
  cached matcher answer with no record wrap, because the probe's #consider
  runs per surfacing event and its repeat path must stay allocation-free
  (the descriptor cache's own contract); the ONE `AdoptionHome` is built at
  the probe's finish, where the adoption decision lands.

  **Registry batch 4 â the self-hostable media-server ring (Nov 13 2026,
  user direction "Registry batch 4: media servers"; src â detection.js + sdk
  case; one record added, seven verified declines).** The batch-2/3
  verification method over the media-server/app ring. **Jellyfin added**
  (jellyfin-web master, `src/plugins/htmlVideoPlayer/plugin.js`
  `createMediaElement`): the plugin builds a
  `<div class="videoPlayerContainer">` â inserted as
  `document.body.firstChild`, styled fixed full-viewport flex by the
  plugin's own `style.scss` â with the `<video class="htmlvideoplayer">` as
  its direct child (hop 1). The video's `.htmlvideoplayer` class stays off
  the list (0-hop law). The vocabulary predates the fork: jellyfin-web
  descends from Emby's web client and the class is verifiable on Emby's own
  theming surface (Emby community custom-CSS threads style
  `.videoPlayerContainer > div`, Emby themes reference it), so **one record
  covers both servers** â the servers differ in the app shell, not the
  player dialog this record adopts. Seven candidates verified and DECLINED:
  **PeerTube** is Video.js-based â the client depends on `video.js ^8.24.0`
  (client/package.json) and `@peertube/player`'s `peertube-player.ts` rides
  `videojs(playerElement)`; video.js stamps the `.video-js` class itself
  (the THEOplayer verdict shape). **MediaCMS** is Video.js-based â the
  project's own README says "customized video.js player", and the player
  component is `frontend-tools/video-js/src/components/video-player/
  VideoJSPlayer.jsx`. **Owncast** is Video.js-based â
  `web/components/video/VideoJS/VideoJS.tsx` rides `videojs(videoElement)`
  with the `video-js vjs-owncast` class on the media element.
  **Audiobookshelf** has NO video player surface at all â `client/players/`
  is `LocalAudioPlayer`/`CastPlayer`/`PlayerHandler` (audio-only topology;
  the web app plays audiobooks and podcasts, no video-container vocabulary
  exists). **Plex web** declines closed-source â the served bundle is
  minified with no stable vendor-namespaced container vocabulary
  verifiable. **Wistia API embeds** are the Bunny shape â the integrator's
  host div (`wistia_embed`) carries no video DOM (the video lives in the
  cross-origin iframe), and the in-frame player is closed-source with no
  verifiable vocabulary. Registry is now 23 records; the sdk case's
  per-record rows derive from the registry loop, so the battery grew
  279 â 280 rows.
- **discovery.js** â presence machinery: min-size thresholds (100Ã60),
  on-screen/layout deferral gates (`PresenceGate`, per-instance
  MutationObserver check), the media feed (`DiscoveryTap`: lazy escalation â
  cheap tap first, full listeners only for rendered candidates), the
  identity-aware boot sentinel â the probe asks detection's descriptor face
  TOGETHER with presence at every consider and fires the kernel boot with
  the ONE frozen `AdoptionHome` (identity re-asked at the finish so deferred
  fires hand a fresh answer; a page whose videos carry no SDK anchor never
  boots the kernel at all), and ONE presence ask per consider â the
  painted-box fact answers both the size gate and the escalate branch
  (`boxAtLeast` is the size-only compare; the old shape ran
  `checkVisibility` twice per consider on the hidden candidate's media-event
  repeat path), `RemovalWatch` (grace-per-disconnect observer, re-parent
  aware, and `moveBefore`-aware by derivation: state-preserving moves land
  as the same remove+add record shape, both primitive forms live on the 159
  floor, and the watch's decisions re-derive from live DOM state â no
  per-shape code exists). The boot sentinel grew the bare-tier re-arm:
  `VideoProbe.refresh()` re-runs the seed walk under the current setting
  posture (no-op once a candidate fired â the kernel's own discovery tap
  owns later candidates; the media taps and gates stay armed, `stop()` is
  the only detach), and `installVideoProbe` returns `{ stop, refresh }` â
  the flip applier drops the matcher's descriptor cache first, so every
  re-consider asks identity live under the new posture. The probe's watch
  guards (Nov 2026, the bare-surface batch) skip re-watching a present +
  already-minimum box in the layout gate â such a target delivers on the
  next frame and re-runs `#consider` with no new fact, and re-observing a
  target inside its own delivery fired one Firefox RO-loop page error per
  cycle (the burst was 12â13 errors per bare boot). That accidental cycle
  was also the bare tier's identity poller, so `watchMediaEvents` carries
  `playing` + `timeupdate` capture listeners â the events where the
  `played.length` leg can actually complete (`play` fires when play() is
  invoked, before playback starts; the tap fires on the invocation edge and
  is why the played leg never rode it) â identity arrives by media event or
  DOM change, both of which route through the taps.
- **kernel.js** â the orchestrator: `whenDomSettled` boot sequencing
  (`runSteps`), the one-main-video scope guard on adoption â the pick policy
  "first-qualifying wins": a candidate meeting SDK identity is refused while
  a shell is live or mid-boot (`#registry.occupied || #booting != null`), never
  pinning a presence gate on a refused video, and recovery is the
  registry-empty edge re-arming the full discovery tap â identity flows as
  ONE frozen `AdoptionHome` (`resolveAdoptionHome` resolves at adoption and
  at the re-wrap seam; the provider, `RemovalWatch`, and the
  container-equality compare all read the same record, whose container
  fact is read through the `sdk` descriptor after the alias getters
  retired) â the boot itself receives the probe's handed home
  (`init(home)` â `#adoptVideo(video, home, true)` skips the detection
  re-scan and both presence re-proofs, all proven in the same synchronous
  boot task; the destroy-readopt hand-off rides the same seam identity-only
  â `#onRewrap` passes its compare's resolution as the readopt's identity
  proof, while presence stays re-proved because a live re-home can move the
  box; the seed walk becomes recovery-only â `#armDiscoveryTap` runs at
  the registry-empty edge, and init-without-home keeps the discovery-first
  posture) â the `ShellSlot`
  (one shell per session; a displaced shell is **destroyed**, never
  orphaned; the adoption guard makes the displaced-destroy a backstop),
  `MenuCommands` (debug toggle + the bare-videos tier toggle + the two
  one-shot reset
  commands + the frame-state diagnostics dump, installed from script eval
  and resolving their shell host through the entry's kernel reference â
  works even kernel-less; menus
  are top-frame only, and `#armDebugWatch` rides the storage echo to
  propagate the debug flip into sibling frames mid-flight), the bare
  toggle among them riding a hooks channel (`installMenuCommands(
  resolveKernel, { onBareFlip })`): the writing realm applies its own flip
  through the entry's applier â `watchStorageKey` filters own echoes, so
  the writing realm's matcher cache and probe would never hear the write
  otherwise â while sibling frames apply through the entry's storage echo
  watch,
  `installFrameDiagnostics` + `dumpFrameState` â the one-tap field triage:
  the dump command writes `pf:diag`, the top realm answers by direct call
  (its own write is echo-filtered), and every script realm
  â another tab or another frame â answers through the echo with one
  `logger.warn` state line (warn rides the NOT-debug-gated belt on purpose;
  the dump must land on a stock install â that gate is the surface's
  premise: it exists because the fs-ui field loop burned ten console probes
  answering "which document holds the player's state"). Page-lifetime
  install like the frame bridge; per-realm record carries realm/domain,
  videos with per-video SDK identity + min-size + on-screen, the live
  shell's SDK name, the mid-boot latch, fullscreenElement, and the debug
  flag),
  pagehide teardown, pageshow recovery (the orphan reconcile; the freeze/
  resume arm retired â its reconcile duplicated the pageshow one and Firefox
  exposes no Page Lifecycle events), per-boot
  manage-ability downgrades, and the universal-container-identity seam on
  `RemovalWatch`'s re-parent branch: container identity is a shell-lifetime
  fact resolved by detection alone â a live re-home re-runs
  `findSdkForVideo` (the parent-stamped cache invalidates on exactly this
  parent change), and a DIFFERENT container destroys the boot-identity
  shell and re-adopts through the boot path (destroy-readopt; the
  equality shape and the unresolvable shape stand untouched). The boot
  hands itself its `RemovalWatch` and carries an explicit shell-less-exit
  release (`#abandonBoot`): a settle that resolves disconnected, and a
  mid-boot `shell.create` throw / `ready` reject, never touch the
  registry-empty edge (nothing registered), so without this the pre-boot
  pin refuses every later event for that video and the downgrade strands â
  the release stops the watch (onStop = pin release, exactly-once) and
  re-arms the full tap when the registry is empty; skipped under pagehide
  (the scope defers already stopped it).

### shell/ â the feature layer
- **shell.js** â composes the boot step list (realm â settle â DOM layers â
  HUD wiring â media session â sections â markers), stamps managed markers,
  owns destroy and re-anchor paths. The shell stores the frozen
  `AdoptionHome` the provider hands it and exposes `video`/`container`/`sdk`
  as read-only aliases of the same record (identity is a shell-lifetime
  fact; the container alias reads through the record's `sdk` descriptor
  since the record's alias getters retired). The `#boot` step constructs
  `attachInputActions` (whose returned `ShellActions` instance feeds the
  `ForgeBar`'s skip entries) and then the `ForgeBar` itself â the bar holds
  no shell field: its listeners and sweep timer ride the shell scope signal
  and its DOM lives in the hud layer. `enterFullscreen()` is EVERY shell's
  forge entry: center dbltap in normal view is the forge verb for the SDK
  player and the bare surface alike, and the verb requests REAL fullscreen
  on the shell's own container (the gesture's trusted activation supplies
  the user gesture script-launched requests lack; rejection surfaces on the
  existing fullscreenerror watcher, the catch only keeps the promise off
  the unhandled lane). In fullscreen the document-realm hide rule clears
  the SDK chrome and the forge bar is the shell-owned control surface.
  The panel-section destroy loop rides ONE uniform bare `catch` (the
  release-tail class): a section destroy that throws must not strand the
  inputs/panel/toast/DOM teardown steps behind it â they are the shell's
  only unregister on that path, so the broken member dies contained and the
  tail gets everything below it done (a future member without an honest
  destroy surfaces as leftover DOM in the rows, not as a leak). Destroy
  releases an active fill right after the scope flip (`#view.exitFill(false)`): the
  reachable mid-fill destroy is the destroy-readopt seam, and a video left
  riding its inline fill transform + claimed object-fit would carry them
  into the re-adoption â the fresh shell's ViewershipTransform boots
  `#fillActive=false`/`#priorObjectFit=""` and never sees the hostage.

  **Sweep #8 record (shell lifecycle AâZ, audit-clean).** The module read
  front-to-back with every seam reconciled against the wider records:
  the boot contract is two-phase (`#mountDom` â one `yield_` â the eager
  component set + lazy `PANEL_SECTIONS` builder â the watcher `runSteps`
  with the managed-marker stamp as its tail), and `#mountDom`'s three
  deferrals (host disposal, `SHELL_MARKER` on the host, the staticârelative
  position fix) all ride the shell's `DOMManager` â the fourth, the parasite
  watchdog's cleanup defer, retired with the shell-mount adoption (the
  host's one `dispose()` verb latches the lifecycle dead before the removal,
  merging the removal and the watch teardown into a single defer).
  The teardown ownership matrix is the record's real deliverable â five
  components, five disjoint release stories, each pinned to exactly one
  root: `resume`/`subtitles`/`filters` own their `destroy()` verbs and are
  nulled in build order; `MediaSession` listeners ride the `claimMediaSession`
  `signal`; the input machinery (forge engine + `attachInputActions` +
  `ViewershipTransform`'s fullscreen/resize/loadedmetadata arms, whose
  `attach(signal)` is handed the forge's signal at the `attachInputActions`
  call site) dies at `#inputs.destroy()`; `ReferenceBox` tears down from
  the kernel scope abort alone (its RO disconnect rides the abort
  listener, orientation/scroll/capture-scroll ride `{ signal }` options)
  and needs no explicit destroy; and the `DOMManager` is the eleven-root
  census's second shell-side `new Scope(` â a separate machine disposed
  by its own `destroy()` verb at the destroy tail, after the `#scope`
  flip, with no cross-cascade between the two roots (the never-disposed
  `#dom`-without-`#scope` shape cannot happen: `shell.destroy` is the
  only caller and runs both). The re-entrant destroy guard rides
  `#scope.disposed` returning early; mid-boot destroys are legal (every
  post-`#mountDom` field guards `?.`, the sections array is empty by
  construction). Idle-state facts recorded for the next reader:
  `#home` stays intentionally (identity is a shell-lifetime fact),
  `#view` is not nulled because `exitFill(false)` restores every byte
  it can mutate (transform + claimed object-fit) and it holds no
  listeners of its own (they die with the forge signal). One subtlety
  kept deliberately rather than "fixed": a section destroy that throws
  mid-loop abandons its later siblings before the array clears â the
  documented belt premise, not a bug to repair.
- **media.js** â the media plane AâZ's single-writer population: every
  HTMLMediaElement property write in the tree (7) lives in this file â three
  clamped `currentTime` writes (stop/seekTo/latched-scrub), clamped volume,
  muted flip, and two playbackRate writes whose release (`endBoost`) is
  deliberately UNGATED so a mid-hold source swap cannot strand a boosted
  rate; the reads outside are shell aliases and resume/cue consumers, and
  the one second play call is forge's bare-tap â native parity: its silence
  logs real rejections to debug instead of rethrowing (media.play's
  throw-through serves gesture/panel callers that own a failure surface; a
  gesture surface with nothing to degrade into does not). Readiness is two
  gates: `#isReady()` (readyState â¥ HAVE_METADATA) for everything
  timeline-independent, and `#canSeekNow()`, which additionally recognizes
  the MSE window (duration set, readyState still 0) where the spec's
  default-playback-start parking makes a restore issued there real. Benign
  media policy errors classify as exactly AbortError/NotAllowedError
  (load interruptions, autoplay policy). The MediaSession bridge pushes a
  1s-epsilon-deduped position state (~1 IPC/s steady vs 4; state changes
  bypass the quantum immediately) and clears ONLY its six registered
  actions on teardown (prev/next stay the page's); the two metadata
  witness observers (documentElement subtree for the title, `poster`
  attribute for artwork) ride the HOST page's mutation axis for their
  fingerprint compare â that page's userscript tax (2 getter reads + 1
  template per mutation batch), the tree's one per-host-mutation cost
  surface, with the candidates (title-node-only observer, part-compare
  without the concat) parked unless a site surfaces real cost. `URL.parse`
  as the null-guarded poster parse and `fastSeek` under the seekto
  handler's `fastSeek` detail are the floor-era surfaces; PiP keeps the
  `pictureInPictureEnabled` runtime policy read (enterprise/embed can
  disable) while the method-presence checks that died floor-dead (70) stay
  dead. â `MediaControls` (play/pause/seek/scrub-latch/volume/rate/
  boost/PiP/stop), `MediaSessionOwner` claim/lifecycle â the bridge carries a
  plain disposal boolean, not a Scope root: every listener it owns rides the
  claim's caller signal and the had-scope held no signal consumers and no
  disposers (the roots census's one retirement, 12â11). The wake-lock and
  fullscreen orientation-lock companions retired by user direction:
  Firefox already keeps its screen awake during media playback and handles
  fullscreen orientation on its own (the ReferenceBox orientation-change
  listener in dom.js stays - it is the fill-rect's geometry feed, not the
  lock).
- **resume.js** â the resume tracker: store warm â context resolve â entry
  match/create â restore â progress drive. One adoption per tracker
  lifetime â a same-document route change is out of scope (see the page.js
  bullet), so there is no route-follow/`#adopting` machinery. The restore
  pipeline is lean by construction: context and store warm run eagerly in
  the constructor (parallel to shell construction + paint), the duration
  wait is event-driven and owns the duration proof â `#adoptEntry` follows
  it synchronously and consumes the fact, not re-proves it. Save cadence
  = 10s checkpoint span; flushes on `seeked`, on pause, on visibility loss,
  on pagehide (persisted leg; the freeze leg retired â Firefox exposes no
  freeze, and pagehide is the belt's one suspension surface);
  `RESUME_MIN_POSITION` (5s) floor; bounds cutoff; the entry
  carries per-viewing extras (`subOffset`, `subsUrl`); cross-tab merges
  arrive through `watchStorageKey` and require the tracker's `#loaded`
  latch (`#adoptExternal`, which announces so grain consumers re-resolve).
  The merge adopts REMOVALS too â a foreign doc omitting a known entry is a
  deletion made elsewhere, adopted under doc-side LWW (entry revision older
  than the foreign doc's stamp) so a background tab's next checkpoint
  cannot resurrect a panel-deleted entry; the "Start over" toast action
  writes its reset through the store (an explicit boundary outranks the
  drift epsilon, like the completion state does). The never-written
  `pending` entry field (entrance-only across the whole repo history) is
  retired with its load-time sweep â the one wall-clock read that went with
  it is the Date.now census 10â9. The resume-plane AâZ sweep read the
  module end to end and verified the whole seam ring against the shared
  planes â no src gap: the store's persistence shape (fixed-whitelist
  entry projection blocks field injection and prototype traversal since
  `__proto__`/`constructor` are outside RESUME_ENTRY_FIELDS; foreign and
  future writers adopted with a restamp, malformed entries dropped with a
  count-warn, the echo attestation never minted on a load), the merge's
  exact invalidation contract (in-place LWW updates touch only `updatedAt`,
  so `#byId`/`#byPath` stay exact and only the sorted snapshot drops; the
  doc-side removal adoption keeps the entry when it is exactly-recent -
  under `<=`, deliberate), the strict four-field echo fast path
  (docUpdated + version + count + maxEntry stamp; any foreign writer bumps
  one), the checkpoint mathematics (span = clamp(durationÂ·0.01, 10, 60)s,
  completion 0.95 outranks the 3s epsilon on the terminal state, the
  store's no-op guards churn-skip repeats), the id-trust rule (an
  `hashEntry` id matches only when `domainsMatch` agrees, so legacy
  domain-less ids and true collisions fall through to the fuzz-scored
  path-bucket match), and the two classified subtleties the sweep cleared
  rather than fixed: destroy's `currentTime ?? NaN` fallback is
  unreachable (`#shell` is never nulled) and even a fired NaN write would
  be Number.isFinite-guarded at every consumer, and the `#persist`
  embedded foreign-merge window (an echo-miss race) rewrites the disk
  with the converged set immediately after, without a structural notify â
  the remote-write path proper announces, so History staleness is bounded
  to a same-instant race whose writer is the writer tab itself.
- **filter.js** â `FilterSession` (eager state machine: values, apply,
  trailing persist, the menu reset gesture) + `VideoFilter` (the lazy panel
  section over it). The filter lives on the video from first play â a
  stored preset needs no panel open â and reset works with none.
- **inputs/forge.js** â the pointer/keyboard gesture engine: the stream
  router (passive press/move streams under the prevent-scope rule â a plain
  tap's whole native sequence passes unclaimed, no press-time cancel
  anywhere; the SDK-control exemption lattice â the tag/role shape list
  plus the affordance-cursor clause (pointer/grab on a small box outside
  the gesture-surface family) â sorts SDK surfaces out of gesture ownership
  so their streams stay theirs; the touchmove belt, the wheel pinch
  listener, and the post-gesture activation suppressors are the only
  cancel-default listeners), pointer tracking, the session
  latch feeding the shared `fs` gate, and click/dblclick suppression, over
  per-story recognizer
  machines: `ScrubStroke` (pointer move-stream scrub with coalesced samples,
  the exp-smoothed velocity filter, and the bounded predicted-events wash;
  the move stream is pointermove+coalesced alone â `pointerrawupdate` is
  live on the floor but fires 1:1 with pointermove over real driver
  strokes (probed) and is non-cancelable, so a second stream buys no
  samples and the committed seek stays rAF-bound),
  `SwipeStroke` (the translate-drag transform writes and their eased
  restore), `TapWindow` (the dbltap window: observation only, no seed and
  no replay â by the prevent-scope rule there is nothing held back to hand
  back), `PressHold` â the ONE press-hold qualifier (timer + latch + pooled
  hold/release dispatch) both trigger shapes ride â and `KeyHoldSession`
  (the INPUT_ACTIONS session keys â today the hold-speed row's Space:
  hold-to-speed + bare-tap toggle, settle-on-next-press hygiene for a
  swallowed keyup; the KeyHoldSession copy it replaced was the keyboard
  spelling of a story the engine's pointer press owned inline, with the
  same null-check timer-clear body spelled twice â the channel-shape facts
  are constructor options (`method`; `zone` as a string for keys or a `()
  =>` live reader for the pointer shape) and the per-press facts are
  `arm()` parameters (`gate`, and the pointer's `onArm` claim effect, so
  the claim is a parameter, not a second class)). Gesture detail carries
  `dx` and the mirrored `dy` as
  engine geometry (the detail payload shape is source-table fixed); pinch
  and trackpad-pinch handshake stay engine-core; hold/scrub timers ride
  the shared scheduler. Keyboard arbitration filters its candidates by
  engine liveness (`#isActive`: `readyState > 0 && !ended` â an ended
  engine must not steal keys from a live one), deliberate for the
  multi-engine case, but answers **vacancy outright**: when no engine
  holds a playable video (`candidates === 0` â every live video ended or
  not yet loaded), playback arbitration is vacuous and the method returns
  true, so the page-level chrome keys (panel/history/settings) still work
  after the credits roll â exactly when the keyboard has nothing else to
  do; one shell per realm-document (the scope law) makes vacancy
  single-engine, so no cross-engine routing question survives. The
  yield lattice carries the focused-`<video controls>` arm (the
  bare-tier batch, Nov 2026): a focused video that carries the UA controls
  is a native keyboard surface of its own â Space toggles, arrows
  seek/volume â and yielding there is the SELECT-typeahead class; the
  native-controls floor probe (`check/.tmp/bare-controls-probe.mjs`,
  real Firefox 160 driver taps) measured the two planes: with `controls`
  present the UA-controls overlay owns the whole POINTER surface (page
  and container listeners see nothing â E1âE4 empty recordings, the
  engine structurally blind, no conflict clause needed on the pointer
  plane, native click-to-play intact), while the KEYBOARD plane
  double-acts on a focused controls-video (Space play-then-pause,
  ArrowRight seeks past the engine's +10 to the duration clamp; KeyM
  clean) â the yield arm is the fix; no fixture video carries `controls`,
  so no existing row rides the branch. The
  gestures case proves the shape: seek to duration marks `ended` on the
  paused fixture video, the real driver KeyS still opens the panel, and
  the row restores (seek-back + panel close) before the hold-speed rows.
- **inputs/actions.js** â the action layer: the unified `INPUT_ACTIONS`
  table (one row per user-facing function, each gathering every trigger
  under its `inputs` â pointer families and key codes, one-shot or
  hold-session; the hold-speed row defines 2x hold-to-speed ONCE, its
  pointer hold and Space hold both riding it; the dbltap row carries TWO
  inputs â the fs-armed family and a zone-pinned `zone: "screen"`,
  `fs: false` forge-entry arm, both riding `GESTURES.dbltap.setting`, so
  `allowsIntent(gesture, zone)` can refuse the inline edge dbltap while
  arming the center forge entry) + `IntentGates`,
  and the per-story state machines `SkipStreak`, `ScrubSession` (the input/
  commit decoupling: moves accrue `#pendingDelta`, requestAnimationFrame â
  the compositor tick â commits one clamped seek per display refresh (the
  pump's clock probed against rVFC and declined: 30 pipelined paused-seek
  writes over 500ms landed as ONE `seeked` + ONE presentation callback while
  rAF held 60 commit ticks over the same window, rVFC idles outright on a
  paused video with no presented frames, and its playing cadence is content
  fps â 50 fires vs rAF's 241 across a 2s play window on a 120Hz display â
  so a presented-frame pump either quantizes to the decoder's display rate
  or strands at pause, while the UA coalesces burst seeks with zero dropped
  frames, making the rAF pump the efficient shape already), the
  readout shows the authored target, `end()` flushes the backlog; a dead
  zone with a residue accumulator keeps slow strokes alive while holding
  jitter nets to zero) â and the pump's idle arm measured and declined
  (a still hand keeps a 120Hz early-return tick whose self-time rounds to
  0 at the probe's resolution â the noise scale the pooled-dispatch verdict
  declined at higher frequency â so a dynamic disarm buys nothing), while
  the native guarantees the floor hands the pump for free are recorded
  (the rAF argument IS the frame clock â equal to document.timeline.currentTime
  to the digit, so a callback never buys a second clock read; cadence is
  pinned to the display's vsync with 8.34ms median interval and no drift;
  a hidden tab pauses rAF outright and resumes within 11ms of re-show), the hold bookkeeping (`#activeHolds` first-source-
  wins boost; any real pause mid-hold cancels through the release teardown â
  a paused video resuming must not carry a stale boost), and
  `ViewershipTransform` (the fill-mode cover scale composed as one
  `scale(s)` â pinch-to-fill's transform, released on pinch-in or fullscreen
  exit) â the one class allowed to write the video transform, exposed on
  the shell as `shell.view`. The dbltap dispatch is zone-aware: normal-view
  center dbltap IS the forge entry (the engine passes `#gestureZone` into
  the ask, the dispatch fires, and the activation suppressors cover the
  SDK's own double-tap â the first tap's native click still reaches the
  player, native-standard and accepted), while inline edge dbltaps stay
  refused in normal view (the native inline edge dblclick keeps belonging
  to the player) and fullscreen edges skip / center toggles playback.
  `skipStep(direction)` is the ONE skip owner â the arrow-key gesture
  dispatch and the forge bar's skip buttons both ride it (streak + step +
  toast, one story) â and `attachInputActions` returns the `ShellActions`
  instance so the `ForgeBar` wire can reach it.

  **Sweep #11 record (inputs plane AâZ, audit-clean).** Both modules read
  front-to-back â the pair's first dedicated series pass â and the seam
  ring reconciled against the wider records, no src gap:
  the pooled-detail rewrite discipline holds at every dispatch site
  (advance/hold/release/scrub-end/pinch/swipe/dbltap/key each rewrite every
  field its payload owns, the no-stale-carry contract stands intact), the
  pool boundary is exactly the allocation record's (events per engine via
  the per-instance `GestureChannel` â the in-flight-re-dispatch hazard is
  event-scoped; details module-level singles whose consumers never
  retain), and the two release-tail bare catches the error census named
  ARE the pointer-lift races (`#pointerOp`'s NotFoundError lift race, the
  lost-capture `hasPointerCapture` read â the farewell subtlety that a
  stale pre-subtlety docblock over `#handleLostCapture` duplicated; the
  stale block deleted, the surviving one carries the hasPointerCapture
  story). Newly pinned facts: the engine idempotently pairs its zone
  pointerup/pointercancel with window-level twins (both run the same
  handlers; the second dispatch no-ops on emptied tracking state); the
  `#gestureFsActive` session latch is dropped on every session-end path
  (up, cancel, lost-capture, destroy teardown, pinch re-entry,
  blur/hidden release); the hold bookkeeping's `#savedRate` ordering is
  proven safe (the second-source attempt returns BEFORE the rate
  capture, so a foreign release can never restore a rate it didn't
  save); `#cancelHoldOnPause`'s set-drain makes a trailing stray release
  a no-op, as the docstring claims; `attachInputActions` runs exactly
  once per shell (no re-attach duplication risk for
  `ViewershipTransform`'s video listeners, which the single call's
  signal owns); and `detail.timestamp` has exactly ONE consumer
  (ScrubSession's per-move clock, with its in-situ synthetic fallback).
  Recorded product fact: the swipe verb has TWO consumers, one per
  direction â the down direction exits fullscreen through ShellActions,
  and the UP direction toggles the panel (the section's `#wireEvents`
  consumes `GESTURE_EVENTS.swipe` detail.direction "up"); the engine's
  fs-gated swipe intent makes both fullscreen-only, as the README's
  gesture table now states. The IntentGates snapshot plan stays
  verified-as-recorded (bus re-sample + per-query fs revalidate; keys
  live-read per keystroke); the stacked TransformEase docblocks
  re-classified as prologue + class doc (both live, left).
- **subtitles/** â `forgevtt.js` = the parse engine (~.srtâWEBVTT normalizing)
  whose async variant IS the ingest arm â a 50ms block budget hands the
  thread back through scheduler.yield, so even a multi-megabyte track drains
  without stalling playback or paint (the dedicated-Worker offloader retired
  with the subtitles AâZ batch: its 512KiB floor gate fired virtually never
  â real .srt/.vtt files are tens of KB and offsets/memo reparse nothing â
  its one real-floor row could not produce a spawn in the shipped bundle,
  and the in-band fallback rendered byte-identical cues; the native `<track>`
  parse stays ledger-rejected on ingest ownership, so the cooperative arm
  is the whole decision space). The timing-line recognizer is ONE
  single-exec regex twin (the T2 reopen adoption, Nov 2026: 12-15% on
  the ingest tripwire shape, 7-11% on real SRT/prose/VTT corpora, exact
  cue-output parity + hostile column; the manual charCode scanner and its
  `timecodeToSeconds`/`isDigitCode` engines died with the verdict), with the
  `indexOf` pre-guard kept as the intake admission gate; `subtitles.js` â the main-thread surface:
  eager `SubtitleSession`
  (ForgeTrack renderer 8 concurrent cue slots, cue scheduling is OURS â no
  native TextTrack anywhere on the path: the file never enters the video's
  track list, so a host can never list/restyle/mode-flip our captions;
  the presented-frame rVFC crank (re-adopted by the clocks direction â
  samples the callback's `mediaTime`, the painted frame's own timeline
  position, so the active set is answered by what the eye sees; a paused
  seek carries its own `seeked` rider, and the cross-source gap rides the
  presentation-lag epsilon), a sorted-start walk with an amortized dead
  floor, the
  W3C relation `start <= t < end`; slot entry/exit rides the hidden flip in
  the HUD sheet itself â `@starting-style` +
  `display allow-discrete` over `&[hidden]`, transitioning ONLY the motion
  lane (opacity/translate â centering lives in `translate` so `transform`
  stays free), never the anchor lane, so posture corrections land instantly;
  picture-anchored cue
  placement â percent cue fields resolve against the displayed video
  picture derived from the ReferenceBox rect + the element's own
  box/intrinsic/object-fit re-derived per render, slots laid in the
  env-inset layer space; unreadable geometry and zero-area clips fall back
  to the old layer-relative resolution â re-anchoring rides the ReferenceBox
  change tick, video-relative marks ride the renderer's own signal-scoped
  RO + the media `resize` event, and canvas-relative marks (the cue
  layer's own box moving: the forge bar's `:has()` flip, the height-tier
  tokens, env insets) ride the cue-canvas RO — the paused gap's one
  trigger, since the playing cadence re-derives per presented frame but
  a paused video presents nothing and the bar touches neither the video
  box nor the ReferenceBox; drag-drop/URL ingest with
  per-entry restore, parsing memoized, the `SubtitleSyncState`,
  `SubtitleStyleState` (all five values boot-apply at bind; the former
  partial font/stroke boot left a stored custom size/color/shadow unapplied
  until the section built), and `SubtitlePlacementState` grain singletons â
  one owner per grain, no mirror fields between session and section) + lazy
  `SubtitlesSection` (panel UI).
- **chrome/** â `config.js` (state: `SETTINGS_SCHEMA`, `getSetting`,
  `onSettingsChanged`, `SETTING_KEYS`, cross-tab live-reload cache;
  `SETTING_KEYS` is the ONE key-vocabulary table â the four machine-read
  root handles plus the `subtitles` group the subtitle state machines ride
  through raw-config handles, and the key-census sweep proved the handle
  discipline: every `getSetting`/`setSetting` site passes a table handle
  (`SETTING_KEYS.*`, `definition.key` from the schema,
  `GESTURES.*.setting`/`SETTING_KEYS.hotkeys` in INPUT_ACTIONS) â zero
  raw strings. The other dotted families of the configs doc each keep
  exactly one spell site derived from their own source table (the real
  source-table-law claim; this rewords the formerly over-broad "no second
  table spells a dotted key"): `settings.<row>`
  via the schema + `SETTINGS_PREFIX` in config.js, `gestures.<id>`
  formula-derived contract-side (`gestures.${id}` like the event names),
  `filter.<channel>` via the filter defs + `CONFIG_PREFIX` in filter.js;
  the only hand-spelled literals are entry's `meta.firstRun` plus the
  two legacy names (`pf:first-run`, `firstRun`) its boot absorbs and
  sweeps once â all three spelled in exactly that migration line),
  `panel.js` (the `Panel` builder + settings/history section renderers;
  `startViewTransition` runs `{ types: [PANEL_VT_TYPES.open|close], update }`
  â the flips carry their direction as a view-transition type and the sheet's
  `:active-view-transition-type()` rules key directional motion on them:
  open arrives from below on the bounce curve, close sinks back on the plain
  ease-out, endpoint pose identical, ink untouched (the redesign-verdict
  ledger's earlier
  "types with no CSS reader" record closed its adoption on reader-absence;
  Firefox 159 ships both faces and the reader landed with the redesign
  decision â the un-typed `::view-transition-old/new(pf-panel)` pair stays
  as the fallback for any future untyped flip). The UA schedules
  each flip's update callback on its own clock, so both flips are
  null-guarded against the destroy-between-scheduling-and-callback window
  (a shell destroyed mid-flight nulls the DOM refs before the UA runs the
  update; an unguarded throw there rejects `updateCallbackDone`/`finished`
  unhandled â the media case proves the race with a 120ms-delayed spy and
  a +30ms destroy-readopt); the open-restore
  and containment focus fallback share one `#focusFallback()`;
  the product sections return their instances into the shell's
  section-handle table â the `PANEL_SECTIONS` entries are the build *and*
  teardown source of truth, so attempt-rollback and shell destroy call
  `section.destroy?.()` on real handles, and the history subscription rides
  the shell scope's signal into the resume store's Fan),
  `ui.js` (`el`/`button` construction, the SVG icon factory), `mount.js`
  (`ShellStyle` sheet lifecycle: adopt-once, monotonic
  `@resource` upgrade; viewport-fit-cover; the shell host is a custom
  element â `PfShellHost`, lazily built and defined under the
  `pf-shell-host` tag ladder â whose own attachment lifecycle is the
  eviction defense; the old watchdog is retired; named for its primary
  verb `mountShell` â the file was `inject.js` before the shell-mount
  adoption), `toast.js` (`ToastManager`,
  pooled custom element), `forgebar.js` (`ForgeBar` â the shell-owned control
  bar. Visibility is the shell's mode fact: an SDK shell shows the bar while a
  fullscreen chain contains its container (fullscreen IS forge mode â the
  player owns its inline chrome) via `subscribeFullscreen` + a
  `contains(container)` re-check per flip; a **bare shell shows the bar in
  EVERY mode** â the adoption tier stripped the native controls, so the bar
  IS the control surface inline as much as in forge mode, under the same
  sweep. A floating pill in the hud layer
  (inset 8px from the region edges, pill radius, hairline border all around â
  the toast's pill grammar; the height/inset tokens live on the hud scope so
  the cue-shift sibling rule can read both), `[back][play][fwd][seek+ball][time][settings][mode]` wired through
  the one `data-action` router â play/pause calls `shell.media.togglePlay`,
  skip buttons ride `ShellActions.skipStep` (the SAME streak+step+toast story
  the arrow keys ride, one owner), seek is the native `<input type=range>`
  with the ball as its styled `::-moz-range-thumb` committing
  `scrubToLatched` per input event, settings opens the panel, and the 7th
  button rides the mode: inline it is the fullscreen ENTRY
  (`shell.enterFullscreen()` â a discoverable verb beside the center-dbltap
  entry; the stripped controls took their own button), in forge mode it is
  the EXIT (`shell.exitFullscreen`); both verbs ride the button's trusted
  click (script-launched `requestFullscreen` is activation-denied). The
  button's mode swap is `#syncFsButton()` â data-action/label/icon attrs per
  flip, one call per flip â so no mode-specific button exists; idle auto-hide rides ONE self-extending `delay()`
  with the WCAG 2.2.1 holds (pointer-over bar, focus-within, paused video
  each disarm the sweep) re-armed on release, window-capture
  `pointermove/pointerdown/keydown` witnesses stamping an activity stamp
  (window capture: the engine's own document listeners cannot hide the
  stamp), and a visible bar shortens the cue canvas from the bottom edge
  through the sheet's `:has()` sibling rule (the pill's inset is part of
  the shift: `calc(--pf-forge-bar-h + --pf-forge-bar-inset)`) â
  picture-anchored cue slots follow with zero bar-aware JS, riding
  `#derivePicture`'s universal canvas clip; the bar's responsive posture
   is the pocket's stage-band ladder (widths ≤400/≤340/≤260 tighten chrome,
   drop the time readout, shrink targets; ≤280 tall drops the strip to
   44px — the measured overflow onset was a ~323px stage; the height
   tokens are set on BOTH the bar and the cue layer, a container cannot
   style itself)), `panel.js`
  (the `ui.panelScale` write rides `#applyCompactSetting()` as the panel
  root's inline `style.zoom`, per-open like compact), **styles.css** (the
  HUD â Â§6; the section labels carry the `text-box-trim` cap rule; the
  forge-mode document-realm hide rule: while a fullscreen chain contains a
  shell, every element in that subtree dies unless it carries video or a
  `[data-pf-shell]` marker â one generic rule instead of a per-record chrome
  vocabulary, `:has(video)` protecting the video's ancestor chain, fs-keyed
  and fully reversible on exit; plus the letterbox floor `background: #000`
  on the fullscreened shell container and the bar's cue-canvas `:has()`
  shift).

  **Sweep #9 record (chrome/ AâZ, audit-clean).** The three small modules
  read front-to-back with no src gap:
  `ui.js` â the construction helpers are the measured-allocation shapes
  the allocation sweep pinned (`el`'s for-in + hasOwn over the attr map,
  the ~78â~20 ns/op finding; `button`'s one-mutated attrs object with
  forwarded rest keys, so the `data-action` contract never silently
  drops); the icon plane is the two-table vocabulary (`ICONS` +
  `ALIASES`, `canonicalName` hasOwn-gated) feeding the document-keyed
  WeakMap template cache with cloneNode derivation â the string path
  (toast markup) and the element path (panel buttons) hit the same
  cache; `DOMParser`-not-innerHTML is the strict-CSP/Trusted-Types belt
  (the census's 7th bare catch includes this file's) with
  `importNode` keeping the parsed node in the requesting realm;
  `flashElement` is the WAAPI restart grammar (cancel finished
  background animations + scan running ones for `backgroundColor`, the
  null-effect half kept spec-nullable; `!el` the only guard; FLASH
  constants from core, no re-spelled durations).
  `toast.js` â singleton `DomPool(initial: 1)`; `acquire` is consumed at
  construction and never released (the held-side contract the pool's
  destroy comment names); pointer-events follow the stylesheet's
  hidden/interactive state so no inline writes go stale across reuse;
  the repeated-show skip is the 4-field render fingerprint (irrelevant
  churn is the ~100ms scrub-hint tick); auto-hide rides the scheduler's
  `delay` (feature-timer class) with the WCAG 2.2.1 hover/focus hold
  carried uniformly on (this is behavior, not an a11y branch â the
  pause machinery runs on every realm); destroy cancels the pending
  delay and latches `#paused` before `#pool.destroy()` (available-side
  only â the held pill rides the hud-removal defer in shell.js); the
  four pointer/focus listeners are element-owned and die with the layer
  at natural GC.
  `mount.js` â `ShellStyle` is the one-object sheet story (adopt-once,
  the strictly-monotonic `@resource` upgrade with its parity guard and
  last-good-keep on a bad `replaceSync` â the log-then-continue class
  the error-path census pins; `settled()` never rejects); the container
  pockets ride a real `<style>` element because `@container` size rules
  do not evaluate inside `adoptedStyleSheets` in either harness engine
  (gate-probed), restating the sheet's old tie order as source order
  (density â landscape adjustment â compact reader LAST; the forge-bar responsive bands joined the pocket in the Nov 2026 responsive batch â the stage-width ladder over `pf-stage` and the â¤280px-tall height tier whose height tokens are set on BOTH `.pf-forge-bar` and `.pf-cue-layer` â a container cannot style itself);
  `watchShellHost` retired with the shell-mount adoption (Nov 2026) â the
  container childList MO + the shared-feed detach leg it carried are now the
  host element's own custom-element lifecycle: every connectivity
  transition of the host delivers a callback (floor-probed on 160,
  `check/.tmp/shell-mount-probe.mjs` â eviction, container detach/reattach,
  connected re-home and `moveBefore` moves all deliver d/c around the move),
  so the steady state carries ZERO observers; the one lifecycle-invisible
  shape â eviction while the container itself is detached, which the
  container's re-insertion cannot recover â arms a container childList
  observer for exactly that detached window, whose immediate re-append into
  the detached container lets the container's own re-insertion announce
  recovery through `connectedCallback`. No timers, no surrender â the same
  indefinite-fight posture the hand-rolled watchdog carried, one native
  machine instead of observation machinery around one;
  `ensureViewportFitCover` is idempotent, and *forcing* cover over an
  embed's own fit keyword is the point, not an overreach.
  One classified surface (kept, not fixed): `pf-toast` is never
  registered in any `customElements` registry â it is a valid
  unregistered tagname styled by tag selector â and it is created in
  the PAGE document (`hudLayer.ownerDocument`), so a page that
  pre-registered the `pf-toast` name could upgrade it. The reach is
  toast behavior only, by a page that already owns every other byte of
  the document; the shadow-host isolation story does not require
  creating the element in a different realm, so no new registry or
  realm-juggling was added for the theoretical shape.

## 4. The OOP development path (AâZ chronicle)

The tree was rebuilt by a sequence of review-and-unification passes. Each pass
had one rule: prove the current shape wrong first, then move code, then prove
behavior unchanged by gates. This is the reason for every convention in Â§5.

**HUD design era.** The redesign started from an Apple Liquid-Glass
applicability audit, landed the still-current rules (Â§6), then retired the
accessibility honors it discovered: the HUD now renders and animates uniformly
(no cpu-tier detection, no reduced-transparency/motion/contrast branches â the
collapse machinery went to `--pf-surface`-style flat tints and then away).

**Vocabulary unification.** Key vocabularies collapsed onto single sources:
one gesture registry; `BRIDGE_MSG_PREFIX` for all bridge message types;
`DEBUG_HASH_TAG`; `SETTING_KEYS`; `KEYS` imported by consumers instead of
retabled. All derived strings were asserted byte-identical to the hand-spelled
ones.

**Architecture steps.** Boot/teardown sequences became declarative lists
(`runSteps`), the two observer gates collapsed onto one `PresenceGate`
engine, the discovery taps onto one `DiscoveryTap` with `escalate()`.

**Layer reviews, three rounds.** Kernel first ("one detection cache, one
provider check, one seeding walk"), then shared ("one registry owner, one
response gate, one close path"), then shell ("one session-end path"):
each round found the duplicated ownership in a layer and owned it.

**Module consolidations (whole-tree, several rounds).** The tree went from
45 modules to the current 24 with these absorbed/merged shapes, always by
_subtype or data shape_, never by feature-share:
- Wiring/lifecycle-only files absorbed into their single consumer (`guard`,
  `lifecycle`, `time`, `viewport`, `haptics`, `probe`, `menus`).
- Data-shape splits keep honest names: `sdk.js` split into `detection.js`
  (identity engine, import-free) + `discovery.js` (presence machinery);
  `context.js` split `domains.js` primitives later folded into `page.js`.
- Layer unifications: shared 20â5 planes, kernel 5â4, chrome 8â5,
  subtitles 5â3, each keeping exactly the build-boundary files separate.

**Closure-machines â classes (the OOP turn).** Every stateful factory whose
state was split between module-level `let`s and closure variables became one
class owning its story, with public factory names kept stable so consumer
churn was import-paths only:
`ContextPipe`, `DebugRuntime`, `FullscreenProvisioner`,
`PresenceGate`, `DiscoveryTap`, `RemovalWatch`, `ShellSlot` (state kept as a
class because its displacement/`onEmpty` contract is unit-pinned),
`ShellStyle`, `HoldRepeater`, `MediaControls`,
`MediaSessionOwner`, `TransformEase`, `ForgeRegistry`/`GestureChannel`,
`ConfigStore`, `VideoProbe`, `DomSettleWatch`, `MenuCommands`, plus the
DomWatch/FsGate/Settings/SdkMatcher/panel-section family and â in the input
pass â `IntentGates` + `ShellActions`.
Rule applied everywhere: a class may own mutations; a consumer that just
calls a function must NOT be forced to spell `new` (plain-function wrappers
stay for those seams).

**Single-backend contract.** Production ships exactly one platform-native
implementation per platform capability; the jsdom check harness owns all
emulation (see `check/lib/node-realm.mjs`). The method: census every
dual-arm/dual-check probe in the tree; keep the arm whose semantics are real
(and pin it with a test), delete the harness-only arm, and make jsdom win by
having genuine matching semantics elsewhere. What stayed vs died:
- Stayed: grant guards in store.js (manager policy, not platform), and
  the down-ownership checks (deliberate, each pinned by a test). The signal
  plane ships one arm: every deadline and
  composition rides native `AbortSignal.timeout`/`AbortSignal.any`
  unconditionally (the manual-deadline arm this record once kept died with
  the harness-only consumers).
- **Zero-timer pipeline (closed by census).** The architecture carries
  zero poll-style timers â `setTimeout`/`setInterval` never appears in src;
  the cadence that was once a wall clock (resume checkpoints every 10s)
  rides the native `timeupdate` broadcast + `currentTime` (the element's own
  media clock, ~4Hz while advancing, idle while paused/stalled; the rVFC
  presented-frame crank retired with user direction), and the bridge's
  retry ladder died into the `pf:ready`
  announcement (event-driven, last commits). Every timer that remains is
  one of three deliberate classes: a **coalescer** â the `DomSettleWait`
  trailing quiet period re-armed per mutation (no native "settled" event
  exists), removal-grace one-shot deferrals, and the three persist
  debounces that batch trailing writes under stepper drags; a **deadline**
  over witness absence â bridge watchdogs (bridgeless embed settles null),
  and the hidden-tab flush cap with its
  `visibilitychange` resume; or a **feature timer** whose semantics the
  product defines as temporal â hold-to-speed, press qualifying, toast
  auto-hide, the first-run hint cap. All ride the shared scheduler
  (`postTask`/`delay`/`debounce`, abort-scoped). A future timer needs to
  name one of these three classes, not merely be a `delay`.
- Died: the `postTask` faÃ§ade's whole setTimeout arm, `yield_`'s
  schedulerârAFânoop ladder, `onNavigate`'s popstate/hashchange backend that
  could never see a pushState-only change, `MessageChannel`/MutationObserver/
  `isInputPending`/`vibrate`/window-resize double-typeof checks, and all
  manual `Date.now()` deadline math behind watchdogs. The gate family's
  fallback arms joined them (the jsdom host that swapped `MutationObserver`
  and the "harness deletes the globals" exercising both died): the
  ResizeObserver/IntersectionObserver null-observer stand-ins with their
  `fallbackWatch` synchronous-rect/inert-gate arms, the per-instance
  `#pruneSupported` read, and `checkVisibility`'s API-less permissive arm
  (floor: 79/51/105 all below 156). The element-level capability arms
  followed (`requestVideoFrameCallback`/`cancelVideoFrameCallback` 83,
  `getCoalescedEvents`/`getPredictedEvents` 58/92, `getAnimations` 84,
  `requestPictureInPicture` 70, `setPositionState`'s optional-chain field 73
  â "jsdom elements honestly lack them / some host surfaces" died with the
  jsdom host), leaving the guard family to genuine refusals: PiP's
  `pictureInPictureEnabled` policy flag, the GM grant read,
  and null/parameter-shape guards
  like the stream router's non-element eventTarget check.

**Native allocation & subscription hygiene.** The 129-listener census
produced signal-scoped teardown everywhere (`{ signal }` options, native
aborts with no per-path removal loops), document-keyed WeakMaps for icon
templates, a lazily-armed `onDomMutations` prune that `unobserve()`s detached
observer targets natively, and direct iteration over pointer sweeps.

**Method consolidation.** Duplicated and dormant methods deleted across
layers (unused sections, clipboard passthroughs, twin gate builders), shared
paths promoted to formatters, destroy paths routed through the timer helpers.

**The check tool era (most recent).** The old `tests/`, `bench/`,
`platform/` suites were retired wholesale (`7d33d32`) in favor of the
`check/` tool (Â§7), whose browser gate replaced the entire behavioral test
surface with real-Chromium proofs; the glass measurement harness rides the
same retirement (its target state is recorded in Â§6 instead). The frames
round added per-frame injection (Â§7), and chromedriver robustness hardened
launch (Â§8).

**Redesign-verdict ledger (final; closed).** The redesign-class questions the
tool era left open are closed on evidence, in-repo. The canon that decided
them (user direction, batch 19): a platform surface earns adoption only when
it is BOTH native-backed AND universal across every topology the frame model
serves (top-frame big page, same-origin, cross-origin embed) â native but
context-scoped retires, the same test that killed the emulation arms in the
single-backend contract. Reopening any of these needs new user direction AND
new code-level evidence:
- **`<dialog>` panel migration â rejected on modal scope, not stack doctrine.**
  `showModal()`'s `::backdrop` is unconditionally document-modal: while the
  panel is open the entire frame document goes inert. That happens to match the
  iframe topology (embed document â¡ player region), but is fatal for the
  top-frame/same-origin big-page topology â the panel must stay
  *player-region* modal, where an outside press on the host page acts on the
  site AND closes the panel (the shell-local shield's whole point); a
  top-layer backdrop absorbs the press and hands the page to the dialog. No
  API scopes `::backdrop` to a region. The earlier recorded ground (toast
  3<4 repaint arithmetic) was incidental â the z tokens put panel(4) >
  toast(3), so a top-layer panel *matches* the doctrine instead of fighting
  it; the verdict stands on the weaker reason alone. Non-modal `show()` buys
  nothing (no top layer, no close-request wiring). The dismissal machinery is
  already native-honest: `CloseWatcher` is the close-request API on the floor,
  per-open arming costs a never-opened panel zero document budget, and the
  `pfEscArmed` revert-then-close lattice maps onto `cancel`.
- **Native `<track>` VTT parser migration â rejected on ingest ownership.**
  Subtitle ingest is `GM_xmlhttpRequest` (CORS bypass, `@connect *`); a native
  `<track src>` fetch rides only the media element's own fetch path and can
  bypass neither CORS nor the GM grant. The fallback (fetch text â blob-track)
  is async and media-lifecycle-timed, which strands boot-restore behind a
  fetch/parse round-trip and forces the sync-offset stepper off its
  zero-await `parseSubtitles(text, offset)` reparse path â that sync path IS
  the product; parsing costs were never the complaint the main-thread parser
  fixes.
- **Toast popover migration â rejected on top-layer push.** `popover` surfaces
  render in the top layer, so a toast could then paint above the open panel,
  inverting the documented z doctrine (`panel(4) > toast(3)`) the panel owns;
  staying in the HUD layer keeps the order the tokens express.
- **`visualViewport` retirement in favor of real-world reads â rejected on
  witness absence.** The vv mirror serves the portrait bottom sheet's two
  needs â staying above the on-screen keyboard and inside the collapsed-URL-bar
  visible area â and both are *out-of-layout occlusions*: no DOM element or
  laid-out box carries them, so the real-world reads the geometry plane
  unified (root client box, element rects, ReferenceBox) cannot witness them;
  vv IS the real reading for that datum. The only non-vv arm â merging
  `interactive-widget=resizes-content` into the host page's viewport meta
  (keyboard resizes the layout viewport, Chrome 108+) â redefaults the entire
  host page's keyboard layout and covers the keyboard alone (not the overlay
  toolbar, not pinch zoom). The mirror stays, hardened: coarse-pointer boot
  gate (the sheet block is the vars' only consumer and exists behind
  `(pointer: coarse)` â a desktop arms nothing) and a pinch-scale guard
  (readers emit the CSS-default neutrals `"100vh"`/`"0px"` while
  `vv.scale !== 1`, real values at scale 1).

**The allocation drift re-audit (Nov 2026, record-only; the sweep-series
close).** The pools-and-shared-scratch record from the allocations sweep
(`2369e3f`) re-derives over the tree as shipping now, driven by a fresh
comment-stripped ripgrep inventory (`check/.tmp/alloc-slim.mjs`,
uncommitted per sweep convention â ~310 slim hits over the seven true
allocator vocabularies: spread, map/split/slice array-builds,
map/set/controller constructors, event constructors, clone/JSON/site-walk
APIs, rest params; every hit carries line context for the axis
classification). The census-proven drift fact comes first: between the
allocation sweep and this audit exactly ONE commit touched src (`4f2ea18`,
the Page Lifecycle retirement) and it is pure subtraction â three listener
arms deleted, comment prose swapped, no new statement that can allocate.
So the hot axes were re-verified, not re-measured: forge's pooled per-name
gesture event + detail (module scratch, the per-engine scope still the
safety contract), media's `setPositionState` scratch, dom's pooled
mutation buffer + DomPool + ReferenceBox's one-read pooled box, and
toast's pooled pill all hold byte-true; the declined poolings (fresh
CustomEvent per emit for the re-entrancy rule, the per-render picture
derive, the sync-offset cue-list rebuild) stay declined and their hotpaths
tripwires â the only honest re-measuring surface â sit green in the gate
battery. The inventory's claims not already in the sweep record, audited:
(a) every `logger.log` site sits at boot/refuse/gesture-start boundaries â
zero on a per-event or per-render path â so the disabled-logger cost is
one rest-array per human gesture (the disabled-path doc's promise held
beyond its own wording; `log`'s rest param allocates before the gate, but
nothing hot ever calls it); (b) every `getBoundingClientRect`/
`getComputedStyle` read on the tree is claimed by an explicit rule â
ReferenceBox's one-read-per-invalidation, forge's press-arm/session-start,
the subtitles render (the measured shape), discovery's boot gate,
shell's inject-time style read; no unclaimed hot read; (c) page.js's
iframe-registry diff is already added-node-scoped (`#diff` walks only the
added element's subtree â the full-document reseed is retired prose), so
the per-mutation-batch host tax is one `nodeType` check per added node and
zero on text/attribute batches; (d) the remaining hits are boot/
module-init derived tables (config's schema maps, filter defaults,
media's sync-event set, panel's section maps) or per-subscription release
controllers â the human-rate tail the sweeps already classify. No
allocation change on the tree earned adoption; the sharing posture is
maximal under the recorded constraints, and the sweep's artifact is this
record plus the inventory scripts under `check/.tmp/`.

**The native-operator saturation audit (Nov 2026, record-only; post-`75437f2`,
audit-clean).** After the adoption probe batch took the matrix's last
hot-path JS loop into the C++ selector engine, every remaining JS-facing
call site was re-inventoried per operator family over comment-stripped
source (`check/.tmp/native-saturation.mjs`, uncommitted per sweep
convention; 23 modules) with one question per row: is this call already a
single native-engine operation, and if JS work survives around it, does a
named native operator exist that can take the rest? Verdicts, each with its
rate axis: **(1) DOM-query families are fully native-delivered** â the
three matcher `matches()` sites (the probe, the tie loop, the host-override
walk), forge's press-arm `closest(SDK_CONTROLS_SELECTOR)` (module-static
selector string; the affordance-cursor clause's one `getComputedStyle` read
is the claimed press-arm shape), page.js's iframe-registry `#diff` riding
native `node.querySelectorAll("iframe")` per added subtree, flashElement's
element-scoped `el.getAnimations()`, and the panel/toast builders' scoped
`querySelector` meshes â no per-anchor JS loop survives anywhere.
**(2) The cleared-family backend is native wholesale** â `replaceChildren()`
is the pooled-clear backend at every pooled render site (panel title/meta,
toast icon/actions), leaving no `removeChild` loop or `textContent=""`
reparse in src. **(3) The relational operators already ride the sheet** â
the compact band's `:not(:has(...))` style query is the live `:has()`
adoption (inject.js), `:is()` rides the matcher probe, and `Map.groupBy`
is the derived-table backend at both real sites (the `POINTER_INTENTS`
family map at module scope, resume's `#buildByPath` on the merge path) â
the constructor's C++ hashing replaced the hand loops the derived-table
law used to spell. **(4) The survivors audited and DECLINED**, each recorded
so none re-opens silently: entry.js's skip-probe `new URL` parses (boot-rate
â the try is the cross-origin `top.location` read belt, not a parse guard;
`URL.parse` would index null into the identical TypeError arm with zero
call-site saving), `hashEntry`'s djb2 `charCodeAt` loop (checkpoint-rate,
~30 short strings, and no native in-realm hash exists â `crypto.subtle.digest`
is async and sized for the wrong job), `shouldSkipUrl`/`URL.canParse`
(the two-call form duplicates a parse `URL.parse` already does in one),
the forgevtt timecode `charCodeAt` fast paths (measured engine-tight at
11ms/1.1MB â the census's own tripwire row), a `Float64Array` numeric sort
for the 19k-cue ordering (no native key-sort API exists; the comparator
closure is log-n and the whole parse is budgeted), and the subtitle
placement/re-anchor rects (getBoundingClientRect reads all claimed per the
drift audit's reading rule, and `anchor()`/`position-anchor` cannot express
object-fit picture math anyway â the earlier anchor-positioning verdict
stands with no JS-positioned consumer). The sheet side already saturates
the CSS-native operator ledger (`contain` variants, `overscroll-behavior:
contain` Ã2, the scroll-timeline R4 band, `@property` tokens, the
`@container` style query bus) with nothing left that a native operator
claims. No src change earned adoption; the artifact is this record plus
the saturation inventory script.

**The C++-operators-first re-audit (Nov 2026, record-only; post-`eb2f34c`,
  audit-clean).** The user-directed re-audit asked one question of the whole
  tree: is every JS-facing operation already one Firefox C++/engine operation,
  and where it is not, does the operator floor now supply the named operator?
  Three artifacts under `check/.tmp/`, uncommitted per sweep convention:
  `cpp-ops-census.mjs` (comment-stripped call-site census over all 23
  modules, prior families re-derived + the new twin classes scanned),
  `cpp-ops-floor-probe.mjs` (the candidate operator ledger evaluated in REAL
  Firefox 159.0.1), and `cpp-ops-scanner-ab.mjs` (the ingest scanner's A/B,
  below). **(0) The floor probe pinned the ledger** â Firefox 159 ships the
  full modern operator surface: `Promise.withResolvers`/`Promise.try`, the
  whole Set-integration family (`union`/`intersection`/`difference`/
  `symmetricDifference`/`isXSubsetOf` + `isDisjointFrom`), the whole Iterator
  helpers family, the Array copy verbs (`toSorted`/`toReversed`/`toSpliced`/
  `with`) + `findLast`, `RegExp.escape`, `URL.parse`/`canParse`,
  `Object.groupBy`/`hasOwn`, well-formed-string verbs, `structuredClone`,
  `using`. Every one audited for a matching tree shape: all
  **declined on consumer-absence** â runtime.js's one `new Promise(`
  consumes its resolver inside the constructor (not a deferred shape; no
  stored-resolver site exists), the tree's nine `new Set(` sites are
  module tables or work-carrying walks (the one algebra candidate,
  resume's `foreignIds` removal predicate, is bounded by `updatedAt`
  comparisons, not pure membership â `Set.difference` cannot express the
  predicate), every iteration is for-of (already the single native op;
  helpers would ADD wrapper allocation), the three `.sort(` sites are
  deliberate in-place (resume's 0.1Hz snapshot, cue ordering under the
  parse budget â a copy verb is strictly more allocation), and no untrusted
  string is ever built into a regex (the two `new RegExp(` sites assemble
  from the module-constant `SUBTITLE_EXTS`; `RegExp.escape` has no input,
  no twin exists). The `hasOwnProperty`-class census also came back empty â
  every ownership probe already rides `Object.hasOwn`/`hasOwn`-gated shapes
  from the allocation sweep. **(1) All prior saturation families re-derived
  clean over the reverted tree** (the only src commit since the audit is
  the readout revert â pure subtraction, no new statement that can carry a
  loop). **(2) The ingest engine's manual scanner is the one place a
  full C++-regexp rewrite could claim, and the A/B proved the recorded
  verdict holds live**: the `CUE_LINE_RE`-removal docstring's history
  (a capture-heavy regex state machine once ran over every line of every
  block) re-applied on today's floor with one-exec twins built from the
  corpus both engines agree byte-behavior on (0 mismatches across 38k
  timecodes + 19k timing lines): the timing-line twin is ~3x faster at the
  narrow unit (1ms vs 3ms / 19k lines) but that unit is ~2ms of the
  11ms/1.1MB whole-parse tripwire, at ingest rate â once per explicit
  subtitle load, under the file's own 50ms block budget â so the shave is
  noise-scale on the recorded rate axes, and the twin's hybrid-gate shape
  (an `indexOf` pre-guard to keep the regex off the 57k non-candidate
  lines, or the twin's 8 capture-slice allocs Ã19k per load) is strictly
  more code and allocation than the landed scanner; declined, measured.
  The timecode unit is parity (2ms vs 2ms / 38k tokens) and the
  blank-line pre-scan twin is fused into the line walk with no separate
  pass to claim (manual â regex/`.test` per line, all sub-ms at 76k
  lines). **(3) The two not-yet-shipped CSS operator words re-probed
  unchanged** on 159.0.1: `corner-shape` and `interpolate-size`
  (and `text-wrap-style: pretty`) still false â the redesign-floor
  probe's NOT-SHIPPED set holds. No src change earned adoption; the
  artifact is this record plus the three census/probe scripts.

**The belt-and-suspenders loop-body walk (Nov 2026, user-directed;
post-`d9e229f`, record-only, audit-clean).** A per-module re-read at the
narrowest grain the earlier audits can be wrong at: every loop body in
every JS module spot-read against the module's own sweep/saturation/
drift record, asking not "is there a faster shape" (the saturation and
C++-ops scans answered that exhaustively) but "does the shipped body
still match the shape its record claims" â a trust-but-verify pass over
the records themselves. All 22 JS modules read whole or spent at their
bodies (styles.css carries no loops); every flagged site reconciled;
**no adoptable site and no record drift found** â the verdict is
byte-true confirmation, recorded because an unverified record is a
premise, not a fact. The walker's bar held throughout: a body earns
adoption only on a measured win or an unclaimed behavior, for-of is
already the single native op, and pool/dirty-check shapes are recorded
allocation contracts, not candidates. The confirmation roll, per module
against its record:

- `subtitles/subtitles.js` (1584) â pooled dirty-checked slot render,
  amortized dead floor, ParseMemo FNV-1a keyed hash: the drift audit's
  record classes, byte-true. `forgevtt.js` (447) â the C++-ops A/B
  record confirmed live-shaped: charCode timecode walk (measured
  parity), single-capture timing scanner (the regex twin declined on
  the live A/B), blank-line pre-scan fused into the one-pass line
  walk, shape-stable `DEFAULT_CUE_SETTINGS` frozen default, in-place
  `sortCues` (copy-verb decline), the 50ms budget with the `(i & 127)`
  yield throttle; the sync fast path / async ingest split stands.
- `inputs/forge.js` (1778, effectively whole) â pooled detail walk,
  ScrubStroke's coalesced samples without a materialized array, scalar
  exp-velocity filter, indexed wheel-panel scan, `#shouldHandleKeys`
  vacancy arbitration, `#ownedKeyCodes` repeat shield: all engine-tight
  or recorded contract.
- `chrome/panel.js` (1449) â Stepper drag `while` payback (bounded,
  scalar), `#rollbackTo` spread confined to failure rate, History's
  pooled positional index reconcile + `replaceChildren()` clears, the
  indexed `querySelectorAll` walk kept spread-free as its comment
  records.
- `page.js` (1275) â `DomainKeyCache` quarter-bounded eviction, bounded
  Levenshtein over reusable `Int32` scratch (no native exists),
  `hashEntry` djb2 (the declined no-seed shape), `stripNonAscii` 8
  single-native regex passes + one-slot memo, bridge resolves already
  on `Promise.withResolvers()`, depth-4 capped `isOwnFrame`,
  added-node-scoped `#diff`.
- `inputs/actions.js` (1068) â ScrubSession's sqrt fast path (measured
  ~1.6Ã, gated on the exact exponent), pooled toast payload refilled
  in place, dirty-checked toast string cache, the rAF commit pump,
  IntentGates' early-break recompute at settings-bus rate, the
  `Map.groupBy` derived tables.
- `resume.js` (868) â `toSorted` adopted where the record claims it;
  `foreignIds` walk (the `Set.difference` decline â the removal
  predicate bounds on `updatedAt`, not membership); deliberate
  in-place `#enforceBounds` sort; allocation-free `#diskEchoMatches`/
  `#stampDiskEcho`; the groupBy path bucket.
- `kernel/kernel.js` (1013) â `RemovalWatch`'s bounded parent-chain
  walk (â¤8 hops + margin, multi-root native observe), live-DOM
  re-derivation (`#checkAnchors`, zero queued-record reads),
  `DomSettleWait` on `Promise.withResolvers()`.
- `dom.js` (860) â the pooled double-buffer with the re-armed-empty
  swap (the `[1,1,2,2,3]` proof), `PUSH_APPLY_LIMIT` index walk (the
  ~124k RangeError story), slot-identity tombstone compaction,
  `ReferenceBox.get`'s ONE read into the pooled box.
- `discovery.js` (578) â `forEachVideoInMutations`' indexed NodeList
  drain (the generator allocation decline recorded in-file),
  PresenceGate's WeakMap + lazy prune, `entryBoxSize` delivering
  observation (no forced reflow), `isOnScreen`'s claimed rect read,
  the probe gates all floor-guaranteed single-native arms.
- `detection.js` (270) â `#fillComposedChain`'s indexed flat walk into
  the reusable scratch (length truncated against detachment),
  hop-ascending one-native-`matches()`-per-hop probe + the ordered tie
  loop: the measured ~2Âµs/walk / ~70ns/hit budget shapes, byte-true.
- `entry.js` (242) â the ad-host suffix/prefix scans: boot rate, one
  realm eval. `contract.js` (136) â module-init derived tables only.
- `core.js` (205) â zero loop statements exist in the file;
  `formatTime` is the recorded integer-arithmetic + concat shape.
- `filter.js` (323) â `presetMatches`' ~11ns/op literal-field shape,
  the closure-free index scan, native joins; per-key table loops at
  human/interaction rate over the 9-key schema.
- `shell.js` (607) â `cssVarSyncer`'s for-of over a â¤2-spec array with
  the Map-diff invalidation-only guard (the measured shape); the
  `MEDIA_SESSION_SYNC_EVENTS` loop arms nine listeners once per shell;
  the section destroy loop under the release-tail belt;
  `PANEL_SECTIONS` construction at first-open rate.
- `media.js` (498) â the `CLEAR_ACTIONS` teardown loop, the pooled
  `#positionState` scratch on the ~4Hz clock (the recorded alloc row),
  scalar clamp/quantum/dedup math, `URL.parse` adopted as the one-call
  null-guard.
- `runtime.js` (534) â loops only at boot/teardown rate
  (`runSteps`/`runStepsAsync`, `Scope.dispose`'s reverse walk); the
  per-task `AbortController` pair is the recorded measured
  two-controller contract, not a pooling candidate; `debounce`'s
  bookkeeping scalar.
- `store.js` (337) â byte-true to sweep #10: the for-in +
  `Object.hasOwn` walk (the measured ~78â~20 ns/op finding), the
  copy-on-write descents with the deliberate two-dot divergence,
  `split(".")` at interaction rate, `gmRequestText` on
  `Promise.withResolvers()`.
- `inject.js` (380) â one `[...adoptedStyleSheets, sheet]` copy at
  boot; `watchShellHost`'s nested walk riding the scoped childList
  observer at eviction rate; the viewport-fit regex passes at boot
  rate.
- `ui.js` (259) â `el`/`button`'s measured for-in + one-mutated-attrs
  shapes verbatim; the document-keyed WeakMap icon-template cache
  with `cloneNode` derivation; `flashElement`'s `getAnimations` scan
  at per-human-flash rate with its scan rule in the comment.
- `toast.js` (217) â the action-button build loop at per-show rate,
  the 4-field render-fingerprint skip, `replaceChildren()` pooled
  clears, scalar timer bookkeeping; `config.js` (219) â schema walks
  at constructor + echo rate (the budgeted 1000-echo storm path),
  derived tables at init.

The walk's one structural observation worth holding (no action): the
operator floor is saturated enough that every remaining loop on the
tree is either (a) the recorded allocation contract itself, (b)
rate-bounded below measurement, or (c) the semantics the feature
means â and none of the three classes can be rewritten native without
deleting the behavior. The allocator/operator record series is
re-verified all the way down; no artifact script was produced (the
reads were full-file reads, and the committed census scripts remain
the machine-checkable distillation).

**The C++ substrate audit (Nov 2026, user-directed "deeper than operators";
post-`23c0cb2`, record-only, one drift surfaced).** The operator audits
proved every JS-facing call is ONE native op; this probe descends a layer
and re-measures the load-bearing *engine-behavior premises* â what Gecko's
C++ actually does UNDER the ops â on real Firefox 159.0.1 headless.
Artifacts: `check/.tmp/substrate-floor-probe.mjs` (7-axis PLAN runner,
per-axis try/catch with an in-body watchdog that always fires `done`;
`node ... [axis ...]` filters) and its `check/.tmp/substrate-report.json`,
plus `check/.tmp/substrate-isolate.mjs` (the harness-semantics single-taps),
all uncommitted per sweep convention. Harness premises worth holding for
any future floor probe: an `executeAsyncScript` body that never settles its
`done` strands as a ScriptTimeout (a missing `done` call or a never-ending
await â both ship as a bare timeout, not an error), so bodies ride the
watchdog `done` belt; an abort scheduled before a postTask task starts
prevents the task from ever running (the yield-inheritance re-probe aborts
AFTER the park, not synchronously after scheduling); MutationObserver
callbacks deliver at microtask checkpoints, so any count read needs a
settle before it; and page-realm `performance.now` on this build quantizes
coarsely, so sub-Âµs per-op rides many-iteration division and premise rows
must run at a subtree scale (A was re-run at 4200 nodes) where any flush
dominates quanta rather than contesting them. Verdicts, one per axis:

- **(A) style substrate â the engine SKIPS same-value writes; custom-
  property inheritance is the expensive axis.** On a 4200-node descendant
  tree: clean rect read 250ns; same-value `setProperty`+read 375ns (the
  write API call itself, no flush â same-value class-add 187ns and
  attr-set 187ns read the same); a CHANGED custom property costs
  ~379Âµs/pair (â90ns/node â the invalidation walks every inheriting
  descendant even with no consumer of the var), while a changed
  class/attribute on the host costs ~333ns/pair (element-local
  invalidation). Premise reconciliation: the shell's `cssVarSyncer`
  docstring claims a same-value setProperty "invalidates (recolors) the
  host subtree even when the value matches" â **contradicted on this
  floor** (same-value â clean read). The guard itself stays exactly
  right-shaped: the Map-diff write-on-flip is what keeps the 379Âµs
  value-change flush entirely off the per-event path, and a `state.get`
  compare is free against the write's ~125ns â but the docstring's flush
  rationale is written as an engine fact the probe now measures false
  (docstring correction landed with user direction, post-record: the
  comment now states the measured skip + the inherited-tree flush axis,
  riding 3x green battery runs).
- **(B) selector substrate â `matches()` scales linearly in list length;
  NO hit-position discount.** list1 100ns â list15 900 â list60 2900 â
  list120 5600 (~47ns per selector entry); a hit costs ~3000ns regardless
  of position (hitFirst 3000 â hitLast 3000 â a full 60-miss scan) â
  Gecko charges the whole list, no ordering shortcut. ANCHOR_PROBE's
  folded-list premise holds proportionally, and the tie loop's
  registry-order law was never engine-assisted â this confirms nothing
  was lost by assuming it isn't.
- **(C) layout substrate â the flush amortizes.** Clean read 250ns;
  write+rect-read 1600ns/pair; write+2 reads 1133ns/3 ops (the second
  read ~free â layout happens once); write+`checkVisibility` 700ns/pair
  (flushes too, but cheaper than a rect read â no box construction).
  ReferenceBox's one-read-per-invalidation law confirmed at substrate
  depth: reads after the first within one invalidation window cost
  ~nothing, so the layout-free hot path is real, and a second read in
  the same window buys nothing extra.
- **(D) dispatch substrate â delivery-dominated, no boundary tax.**
  EventTarget: 0 listeners 133ns/emit; 10 â ~1233 (~110ns/listener);
  100 â ~11400 (~114ns/listener) â dispatch cost is pure delivery,
  linear in audience. Node dispatch (`bubbles`+`composed`): 250ns at 0
  listeners, ~195ns/listener at 10. Dispatching ON a shadow host with an
  empty outer audience: 250ns â no shadow-boundary crossing tax when no
  outer listeners exist. Fan's recorded premises (delivery-dominated,
  the zero-subscriber warm read, the audience snapshot) hold.
- **(E) mutation substrate â per-turn coalescing is absolute; the C++
  filter never wakes on unrelated churn.** One document-level observer +
  one 5000-append turn = ONE callback invocation carrying all 5000
  records; four rAF-separated turns = four invocations of 1000 each
  (turn granularity, the shared-feed batch-per-turn premise).
  **Filter locality: an `attributeFilter`'d subtree observer over 402,000
  unrelated writes woke 0 times (121ms of churn), while 200 related
  writes produced one ~1ms delivery sweep** â filtering is engine-side,
  so container-scoped attribute observers are invisible to unrelated
  host churn; the shared-feed premise holds.
- **(F) scheduler substrate â honest deadlines, absolute priority, the
  yield divergence exactly as recorded.** `postTask` delay:100ms over 30
  sequential samples: median drift 0ms, max 2ms. A 400-task mixed burst:
  all 200 user-visible tasks landed before the first background
  (`firstBgIndex` 200/400) â priority honored absolutely at burst scale,
  not probabilistically. Yield inheritance: yield called inside an
  own-aborted task **rejects AbortError** (the runtime.js `yield_()`
  guard recovers exactly this), and a yield parked while pending
  **resolves** when an external abort fires after the park â the
  two-controller shape's reason (an abort landing in/after the parked
  yield does not reject the aligned completion) confirmed in both
  directions.
- **(G) sheets substrate â replaceSync propagation wins per root.** 100
  shadow roots adopting one sheet: `replaceSync` â 2Âµs/root;
  per-root re-adopt of a fresh sheet â 3Âµs/root. The inject.js
  warmStyles parity guard's premise (re-parsing + re-adopting buys
  nothing) holds with the measured margin â the adopt-once,
  replace-on-upgrade shape is also the cheaper path.

Sweep disposition: no src change earned adoption â every re-measured
premise is the shape the tree already rides, except the one record drift
surfaced (A): the cssVarSyncer docstring's "even when the value matches"
flush claim. That correction landed on user direction (docstring-only:
the comment now records the measured same-value skip and the real
value-flush axis, guard shape unchanged) after 3x green full-battery
runs (79.4/79.5/79.6s).

**The kernel-plane substrate audit (Nov 2026, user-directed "deeper than
operators", scoped to src/kernel/ + src/entry.js; post-`20b07da`,
record-only, audit-clean).** The same substrate discipline as the
tree-wide audit, descended on the boot/adoption plane's own engine
premises â the claims written into detection.js, discovery.js,
kernel.js, and entry.js. Artifacts: `check/.tmp/kernel-substrate-probe.mjs`
(a 7-axis PLAN runner â H entry skip surface, I ANCHOR_PROBE at
substrate depth, J removal record shapes, K observation gates, L1/L2/L3
sequencing-timer + moveBefore semantics â each axis filterable on the
CLI), isolates `kernel-substrate-isolate{,2..6}.mjs` (the bisection
trail), and `kernel-substrate-report.json` (the consolidated,
all-axes-green run), all uncommitted per sweep convention. Harness
lessons worth holding for any future floor probe: a replica must ride
SIGNAL-abort (native `TaskResult.abort()` from inside a running task
throws `TypeError` on self-abort, and an abort on an unrelated PENDING
task does not cancel it â two bisection isolates pinned each; a replica
built on direct handle-aborts hangs by construction, the same
first-fire-wins lockout shape in miniature); a subtree re-home
observation needs `{ childList: true, subtree: true }` (a stage-level
childList-only watch sees nothing on grandchildren â the cross-parent
arm's first pass recorded empty on exactly this miss); and the page's
timers fire exactly on a steady page (a sanity isolate landed a
delay-50 `postTask` at 50.0ms â the hard-hang shape earlier in the
batch was the replica's own backend mischoice, not throttle/cache).

- **(H) entry skip substrate â boot-rate trivial, audit-clean.** A
  `data:`-iframe cross-origin realm throws `SecurityError` on
  `top.location.href` at ~1000ns/throw-catch; warm `new URL` parse
  800ns; `hostname` getter 50ns; the suffix/prefix scan misses at
  ~150ns (the common miss walks most of the 10-suffix list) and hits at
  ~0 (the first suffix's `endsWith` short-circuits the ad-host case);
  the whole skip-probe pass lands 0â500ns. `shouldSkipUrl`'s shape and
  cost premises hold at substrate depth.
- **(I) detection ANCHOR_PROBE substrate â the compiled-selector cache
  IS the module-constant string.** The REAL 27-arm registry list, warm
  `matches()` at 375ns median per call, hit or miss, zero
  hit-position discount (re-confirming substrate B's whole-list charge
  at this list's length); a FRESH unique selector string per call costs
  3333ns (~9x) â Gecko's compiled-selector cache is the warming, so the
  single-constant probe string is a measured caching decision, not
  style. The full 16-hop miss walk lands at 8500ns (~530ns/hop including
  the chain build). The descriptor-cache steady state (the ~70ns/hit
  repeated-resolve budget) is a distinct plane and stays pinned by its
  own hotpath row.
- **(K) observation substrate â PresenceGate's gates are all
  frame-scale, audit-clean.** MO delivery for an append lands within
  0â2ms across runs; RO initial 1â7ms / grow 1â8ms; IO initial 1â7ms
  all run-to-run bands inside one-frame territory. Delivered-box reads
  over one captured RO batch: `borderBoxSize` read â rect read (â5ns/
  entry at 200 entries) â the layout flush amortizes across the batch
  (substrate C's law at observer scale), so `entryBoxSize`'s served
  form and a rect re-read cost the same inside one invalidation window
  and the one-read law stands on the hot-path frequency argument it
  always carried, not a per-window flush gap. The
  `contentvisibilityautostatechange` event fires exactly once on
  reveal, target = the `cv:auto` element, non-bubbling â capture-at-document is the only delivery
  route, confirming discovery.js's reveal-listener wiring as the
  measured necessity, not a convention.
- **(J/L3) removal substrate â record-shape identity confirmed in all
  four shapes; one engine finding.** Every state-preserving move
  delivers the IDENTICAL one-batch pair (removed:1 then added:1, targets
  naming the two parent DIVs): `moveBefore` reorder, cross-parent
  `appendChild` re-home, and remove+reinsert-in-one-task alike â
  RemovalWatch's "lands as the same removed/added records" docstring
  premise confirmed at the batch level. Hot reads: `isConnected`
  30â80ns, `parentElement` 30â60ns median. **The engine finding:
  Firefox 159's `Element.moveBefore` performs a CROSS-PARENT
  state-preserving re-home without throwing** â `p1.moveBefore(el,
  null)` with el parented in p2 FLIPS the parent (probed twice,
  isolated + in-axis; the element stays connected) â while
  `document.moveBefore` (a parented child) and a detached-parent call
  both throw `HierarchyRequestError`, and the cross-parent move STILL
  delivers the standard removed/added pair. This is more permissive
  than the same-parent-only reading the era's prose assumed. No src
  premise binds a throw there â the watch re-derives from live DOM
  state and carries no per-shape code, so the extra freedom costs
  nothing and needs nothing; recorded so a future reader does not
  "harden" a TypeError arm into existence at the cross-parent shape.
- **(L) sequencing-timer substrate â DomSettleWait's realized edges
  land where the tuning claims, audit-clean; the facade's cancellation
  channel gains its substrate citation.** On a replica of the kernel's
  quiet/cap shape: a quiet page settles at 50â53ms (â quietMs 50); a
  churning container (1 append/10ms) settles exactly at the cap
  (150â152ms), the deadline winning over the churn as designed; a
  burst-then-quiet container settles 49â50ms after the LAST mutation,
  the trailing window re-armed per mutation. `AbortSignal.timeout(1200)`
  (the entry hint cap's deadline class) fires with median 0ms drift,
  max 1ms over 10 samples; `AbortSignal.any` costs ~2.6â7.3Âµs/creation
  and propagates an abort synchronously (0ms). The measured caveat is
  the harness finding above: the CANCEL channel on this floor is
  signal-abort â a task's own `signal`, which is exactly the facade's
  release-controller shape â because a native `Task` handle cannot
  cancel (pending-abort is a no-op) and cannot even be touched from
  inside its own task (self-abort throws TypeError). DomSettleWait and
  every other postTask consumer on the tree ride the facade, so nothing
  is exposed to the unusable channel.

Sweep disposition: no src change earned adoption â every re-measured
premise is the shape the tree already rides, the one engine finding
(cross-parent `moveBefore`) widens a spec-reading rather than moving any
src claim, and the two docstring premises named in the axes (RemovalWatch
record identity, the capture-only reveal route) were re-proven, not
corrected. Artifact scripts under `check/.tmp/`, uncommitted per sweep
convention.

**The shell-plane substrate audit (Nov 2026, user-directed "deeper than
operators", scoped to `src/shell/` â media, resume, subtitles, chrome,
inputs â plus the chrome sheet's engine premises; post-`ea5a8f1`,
record-only, with three premise-wording corrections and one src-relevant
finding flagged for user direction).** The kernel-plane batch descended on
the boot plane's engine premises; this one does the same for the feature
layer's. Artifacts: `check/.tmp/shell-substrate-probe.mjs` (a 7-axis PLAN
runner â S1 media clock, S2 cue motion lane, S3 picture geometry, S4
pointer/click substrate + S6 Esc lattice driven by REAL geckodriver input
in node mode, S5 WAAPI flash grammar, S7 R4 scroll-edge timeline â every
evaluated body self-contained, watchdog-belted) and
`shell-substrate-report.json` (the consolidated all-axes-green run; the
trailing `done` line stripped at write time), all uncommitted per sweep
convention. Verdicts, one per axis:

- **(S1) media-clock substrate â the resume drive's clock reads exactly as
  recorded; the clamp guards are engine-required.** Flight `timeupdate`
  fired 4.0Hz (16 ticks / 3.97s, median inter-tick 280ms â the ~250ms
  doc constant is the same neighborhood, no correction), PAUSED read
  ZERO ticks over a quiet second (the first version of the axis measured
  3+ ticks â it had not paused the video before its quiet window; the
  pause ordering is part of the harness lesson), and the tick stream
  carries seek-injected ticks (the seek targets 5/9/9.5 appear verbatim:
  the clock broadcasts on seeks too â harmless for the tracker, whose
  checkpoint math is span-clamped, but worth knowing before anyone reads
  tick counts as a cadence witness). `fastSeek(9.5)` landed 9.5 in 44ms.
  `setPositionState` throws TypeError on `position > duration` AND on a
  negative duration, while negativeRate/zeroDuration/missingPosition are
  all ok â media.js's quantize/clamp (`currentTime < duration` cap) is
  measured-necessary, not defensive.
- **(S2) cue motion-lane substrate â the ENTER fade is real; the EXIT
  fade is not, and the exit prose needs its correction.** The replica
  matched the shipped rows byte-for-byte (`transition: opacity, translate,
  display â¦ allow-discrete`, `@starting-style`, mirrored `&[hidden]`
  targets). Enter: the curve tweens from the starting-style pose
  (opacity 0â0.09ââ¦â0.9 over ~15 frames with the 3px settle-in), reaching
  rest inside the authored 0.2s; a mid-exit un-hide re-fades cleanly from
  0. Exit: the display:none flip creates NO transition â the synchronous
  in-flush probe (the flip's own forced recalc, the exact instant a
  transition would be created) returns an EMPTY `getAnimations()`, display
  none, opacity 0 from that first frame, identical for the attribute
  flip and a class flip, while a control that flips opacity/visibility
  WITHOUT touching display creates two running transitions at that same
  flush (translate progress 8ms, opacity mid-flight 0.037). So on 159
  Gecko builds enter transitions through `@starting-style` and the
  allow-discrete lane, but never an exit transition across a display:none
  flip â the sheet's "holds to a real fade" claim for cue exit is
  measure-false, and shipped cue exit is an instant removal, not a 200ms
  fade (invisible at cue cadence; no check row pins it; acceptance is
  live). Correction candidate: the styles.css exit prose.
- **(S3) picture substrate â the transform-split reading confirms; the
  "any ancestor transform" universality does not.** GBCR carries the
  element's OWN transform scale (1000Ã562.5 under scale(1.25) vs the
  untransformed offsetWidth 800Ã450) â the rect-vs-offsetWidth
  transform-split premise confirmed. Ancestor `translate(50px,50px)`:
  the layer-relative delta equals the local write exactly (the shipped
  formula lands 487.5 on screen â deltas cancel). Ancestor `scale(2,
  origin 0 0)`: a viewport-derived delta written as a local px
  OVERSHOOTS â a video top 450 local px lands on screen 1000 vs the
  intended 775 (delta error = (sâ1)ÃviewportDelta). `#derivePicture`'s
  "deltas stay truthful under any ancestor transform" docstring is
  measure-false for scale (true for translate). The mismatch class is
  bounded on this tree â the reference and the layer live inside the SDK
  container's own compose surface, which no known SDK puts under an
  ancestor transform â but the universal wording needs its correction
  (prose-only, correction candidate). The fill-claim premise confirmed:
  the 1.25Ã-scaled stream clipped to the container yields exactly the
  800Ã450 box, i.e. the stage clip is a no-op when fill/contain is
  aspect-aligned with the container.
- **(S4) pointer substrate (real geckodriver Actions input) â the
  prevent-scope rule gains its click-survival pin; the lift-race belt is
  unexercised by every tried shape.** Real driver taps: pointerdown/move/
  up all `cancelable: true`; a plain tap keeps its whole sequence AND the
  UA click; a pointerdown preventDefault suppresses the compat mousedown
  (absent from the event census) but still delivers exactly 1 click â
  forge's time-based `#suppressClickUntil` suppression is
  measured-necessary: pointerdown cancellation does not own the click.
  Lift race: release-in-up, double-release-in-up, and a DEFERRED release
  (setTimeout-0) after the implicit release ALL landed `ok-noThrow` with
  `hasPointerCapture` false â no NotFoundError shape was reachable from
  any race tried on this floor/driver; the two recorded lift-race catch
  belts stay as defensive release-tail machinery (teardown must complete,
  the census's classification), now with the record that their named
  shape did not fire under either probe arm.
- **(S5) WAAPI flash substrate â flashElement's finished-cancel leg is a
  belt with zero measured debt, and the restart pass is trivial.** A
  finished fill:`none` animation is AUTO-REMOVED from `getAnimations()`
  (count 0 after finish) on 159 â nothing accumulates for the scan to
  reap; `cancel()` on finished and running entries surfaced zero
  unhandled rejections and zero page errors across full cycles; the
  restart pass (scan + cancel + animate) measures ~13â43Âµs on the page's
  coarse clock with the animation count pinned steady at 1 through an
  instrumented 30-pass growth probe (no accumulation).
- **(S6) dismissal substrate (real trusted Esc through the driver) â the
  lattice's ordering premise holds, but the keyup wording and one
  sentence about cancellation are both due.** Three readings: (1) the
  CloseWatcher's cancel+close deliver INSIDE the keydown â plain Esc:
  keydown â `cw-cancel` â `cw-close` all at the same ms, keyup 1ms
  later. panel.js's "the watcher fires on the Escape KEYUP" engine
  sentence is measure-false; what the lattice actually needs â close
  lands AFTER the page's keydown listeners ran, so a field's
  `pfEscArmed` is already set when close re-enters â is measured TRUE,
  and the design's own close-handler armed re-check
  (`active.dataset.pfEscArmed`) is exactly the guard that defers the
  watched close on the armed press; only the keyup wording needs
  correcting (correction candidate). (2) A page's capture keydown with
  stopPropagation cannot shadow the close request â both keydown
  listeners ran, then `cw-cancel`/`cw-close` delivered anyway (the UA
  close-request stage rides outside the DOM dispatch tree). (3)
  **Cancellation is asymmetric on the keyboard path: the Esc-path cancel
  arrives `cancelable: true`, but preventDefault on it does NOT suppress
  close** (close fired, same ms), while a prevented `cancel` on the
  programmatic `requestClose()` path DOES suppress close (close absent).
  On 159 the keyboard-path close is not gated on cancel prevention. No
  impact on this tree â the panel never relies on cancelled cancels
  (its guards are armed-state re-checks inside the keydown and close
  handlers) â recorded so a future consumer of cancel-prevention against
  real Esc is not burned by this floor.
- **(S7) scroll-edge substrate â the batch's src-relevant finding: the
  shipped R4 band's ramp is arithmetically dead.** The replica carried
  the shipped rows byte-for-byte (`@property --pf-scroll-edge: <percentage>`
  / inherits false / initial 0%; keyframes animating it; `opacity:
  calc(var(--pf-scroll-edge) / 1%)` over `scroll(nearest)` at `0px
  24px`). Measured: the animated var interpolates PERFECTLY on this
  floor (8.33333% at 2px â 16.6667% at 4px â 50% at 12px â 100% at 24px,
  clock progress 0.4999â¦ at the 12px sample) â the interpolator is not
  the problem; the SHIPPED DIVISOR is. `calc(8.33% / 1%)` = 833 (the
  idiom multiplies the 0â100% share by 100) and opacity clamps to [0,1],
  so the band's computed opacity is exactly 0 at rest (0%/1% = 0) and 1
  at ANY other timeline position: the 24px ramp never paints; the band
  turns fully on with the first pixel of scroll. Both control routes
  that carry the intended mapping ramp byte-identically â direct scalar
  opacity keyframes AND the same var route with `/100%` (0.083 â 0.167 â
  0.5 â 1.0 against scrollTop/24). Two replica-artifact classes closed
  on the way: an UNregistered custom property animates discretely by
  spec (midpoint flip between 12â14px â the first run's "hard flip"
  verdict was the missing `@property`, corrected with a registration
  control), and `%/% division evaluates fine (0%/1% = 0) â the failure
  mode is the size, not invalidity (a div-by-invalid reading would have
  pointed the fix the wrong way). Impact: visually benign in normal use
  (passing content and scrolled state coincide; the 24px gradient tail
  itself still fades), but the R4 engagement story ("ramped by the
  scroll timeline") is not what ships. The one-line fix is `/ 1%` â
  `/ 100%`, pending user direction (record-only batch).

Sweep disposition: record-only at write time â no adoption earned; every
re-measured premise held except four flagged items, ALL LANDED with user
direction in the same batch: the styles.css cue-exit prose rewritten to
the measured instant-removal fact (S2), the `#derivePicture` and
`ReferenceBox` wording split into its report/write halves with the
translate-true / scale-overshoot boundary and the probe numbers (S3), the
panel's Escape ordering sentence corrected to the measured keydown
post-dispatch delivery (S6), and the R4 divisor one-line fix `/ 1%` â
`/ 100%` (S7) â the src pass rode 3x green full-battery runs
(79.8/79.5/79.5s). Harness lessons worth holding for any future
shell-floor probe: a
media-clock quiet window must PAUSE first (the axis's own first version
counted flight ticks into its paused bucket); exit-transition questions
need synchronous in-flush `getAnimations()` probes at the flip's own
forced recalc â per-frame sampling alone cannot separate "no transition
created" from "not yet ticked" (S2); a CSS anime replica must carry its
`@property` registrations or it answers a different question (S7's first
verdict was a replica artifact); real-driver pointer taps ride
`raw.actions({ async: true })` with viewport-origin moves (an
element-origin move in the `bridge` chain delivered nothing in this
harness) â and S6's real-Esc legs ride `sendKeys` over the same action
chain. Artifact scripts under `check/.tmp/`, uncommitted per sweep
convention.

**The redesign-class decisions (Nov 2026; user direction opened the ledger).**
The saturation audit closed with "everything further is a redesign
decision of its own" â this batch is that decision, taken with receipts.
**The floor probe** (`check/.tmp/redesign-floor-probe.mjs`, uncommitted)
ran the real Firefox 159.0.1 through the redesign-class operator set:
SHIPPED â view-transition `types` + `:active-view-transition-type()`
(the `types` slice is a live `ViewTransitionTypeSet`, not an array â the
first probe's `Array.isArray` test misread it), `scrollbar-color`/
`scrollbar-width`/`scrollbar-gutter`, `text-wrap-style: balance`,
`text-box-trim`/`text-box-edge`, `field-sizing`, `scroll-snap-type`,
`zoom`, `color-mix()` + relative color, and the full CSS anchor-
positioning module (`anchor-name`/`position-anchor`/`position-area`/
`position-try-fallbacks`/`position-visibility`/`anchor-center`); NOT
SHIPPED â `corner-shape` (the squircle HUD radii stay unclaimable),
`interpolate-size`/`calc-size()`, `text-wrap-style: pretty`. The `popover`
reflection probe corrected: the attribute ships (the first check compared
the wrong default value). **Adopted: directional panel motion** â the
one closure on the ledger the floor now unblocked, the frame model's own
vocabulary completing itself rather than a new feature: the panel flips
carry `PANEL_VT_TYPES` (open `pf-panel-open`, close `pf-panel-close`) and
the sheet's `:active-view-transition-type()` rules key route-specific
motion on them â open arrives from below on `--pf-ease-bounce`, close
sinks back on `--pf-ease-out`; endpoint pose identical in both
directions, zero ink movement (R1/R4/R6 untouched, no gradient, no
backdrop-filter â the panel motion is a motion-lane change only), and
the un-typed `::view-transition-old/new(pf-panel)` pair stays as the
fallback for any future untyped flip. R9 asserted at full depth in the
menus case: types delivered per flip (spy on the real
`startViewTransition`), both type words consumed by the sheet, and the
panel's computed surface/border ink pinned identical across the motion
endpoints. Staying open on the ledger until their own product direction:
pointer-anchored readouts (which would CREATE the first
JS-positioned consumer for anchor positioning), balance/trims, steppers'
`field-sizing`, history `scroll-snap`, `zoom` density. (Scrollbars
corrected: the panel and history list already ride `scrollbar-width: thin`
+ `scrollbar-color` in the sheet â that ledger entry was a miss against
the shipped rows, caught on the dist-CSS review.)

**Adopted: Balance + snap (the second redesign batch, same receipts).**
  A shipped-sibling re-verification over the dist caught one more ledger
  miss first: `content-visibility: auto` already rides `.pf-history-card`
  (`contain-intrinsic-size: auto 56px`) â it never was an open item. And
  `field-sizing` is DECLINED on a consumer-absence axis: every HUD text
  input is flex-filled (`width: 100%`/`flex: 1`), so no unconstrained
  auto-sizing input exists for `field-sizing: content` to change.
  **`text-wrap-style: balance`** adopted on the two multi-line prose
  surfaces that exist â the cue slot (`.pf-cue`, after `text-align:
  center`) and the panel hint (`.pf-panel-hint` base arm; the
  load-row's nested nowrap arm is unaffected by construction) â balance
  reflows internal line breaks only, so line count/height and the
  anchored slot geometry stay identical (the subtitles case's pixel-top
  rows are the geometry guard and stayed whole: top=557.5px etc.;
  computed `text-wrap-style: balance` pinned on the visible slot in a
  new row). **`scroll-snap-type: y proximity` + `scroll-snap-align:
  start`** adopted on the History list/cards â a rest near a card edge
  settles it to the top edge, motion away is untouched (proximity, not
  mandatory: the list still scrolls freely); asserted as a computed pin
  (list snap-type + card snap-align) riding the open-panel pool stages
  in persist.mjs, with the floor fact recorded: Firefox 159 computes
  `y proximity` as `y` (the default strictness elides in the computed
  form; `y mandatory` would show whole) â the row accepts both
  serializations and documents this.

**Adopted: trims + zoom; the anchored readout shipped and was reverted
  the same day by user direction (the third redesign batch, closing the
  ledger).** Two of the three remaining items ride the sheet; the third
  rode the probe record the furthest before real use returned the
  verdict:
  - **Pointer-anchored scrub readout â shipped, then REVERTED by user
    direction.** The gesture-scrub pill rode CSS anchor positioning at a
    zero-size `.pf-gesture-point` element (a fixed sibling inserted
    BEFORE the pooled pill â anchor validity is tree order): the
    producers wrote ONLY the point's inset at the ~100ms beat cadence,
    and the pose class carried
    `position-anchor`/`position-area: top center`/
    `position-try-fallbacks: flip-block, flip-inline` â above the point,
    flipped inside the viewport at both edges, ink untouched. Two engine
    defects had to be dodged and diagnosed, both gate-probed with
    receipts â the durable survey artifacts of the batch (kept because
    they bind any future anchor-positioning retry; the per-poke exhaust
    and the fs geometry census live under `check/.tmp/
    anchor-warm-probe.mjs` and `fs-box-census.mjs`, uncommitted per
    sweep convention): (a) the anchor lattice does not resolve inside
    `adoptedStyleSheets` under a scoped sheet's `@scope` (scoped+adopted
    falls back to the static position; the verbatim rule set in a real
    `<style>` anchors live, unscoped doc-level and scoped shadow-level
    both proved) â the pose rules therefore rode a real-`<style>` pocket
    (`ANCHOR_POCKET_CSS`) joined into the same carrier as the container
    pockets; (b) **Gecko re-derives an element's anchor plan only at
    frame construction** â a pose claimed on an element already in the
    tree resolves as static fallback forever, and the per-poke exhaust
    proved every restyle arm stale (sheet re-cascade, pocket re-adopt,
    class retoggle, inline anchor-name/position-anchor rewrites, hud
    paint writes, anchor-element reinsertion): only reinserting the
    QUERY element (the pill) re-plans it. The repair was a one-arm
    structural rewarm at the pose-claim transition â the pose class add
    re-appended the pill to its parent (an already-parented appendChild
    is a pure move: same parent, same last-child slot, listeners live).
    Also probed and recorded: anchor geometry reads from the
    untransformed layout box (the point must move via left/top â a
    transform-moved point parks the readout at the origin) and per-move
    cost is ~13Âµs. The revert landed on the user's one-line report
    ("the scrub broke the toast?! it follows the pointer" â a real-fs
    repro, `fs-scrub-repro.mjs`, entered REAL fullscreen headless
    through a trusted WebDriver `sendKeys("f")`: script-launched
    `requestFullscreen` is denied for missing user activation, not for
    headless â the trusted keydown grants it, a harness fact worth
    holding for any future real-fs row) whose full diagnosis proved
    the report was the design verdict itself, not a defect: detail x/y
    == client coords == the written inset, the hud layer sits at the
    viewport origin in real fullscreen (the box census; the "â40/+15
    drift" the first repro chased was geckodriver move-interpolation
    comparing a mid-drag beat against the final move target), the seek
    commits, the pose clears â mechanics sound end to end, and the
    product question was the one the user answered: the readout made
    the resting toast follow the pointer, and the resting pose stays.
    All readout surfaces retired wholesale â toast.js/inject.js/
    forge.js/actions.js/styles.css byte-true from the pre-batch commit,
    gestures.mjs's readout row removed; trim + zoom stay.
  - **`text-box-trim: trim-both` + `text-box-edge: cap alphabetic`** on the
    section labels (`.pf-panel-label`) â the label's content box
    tightens to the cap height, computed serializations pinned verbatim,
    with the height assertion on a zoom-immune ratio band
    (`h/fs` in a range covering the zoom variants) so the row holds
    under the zoom write below.
  - **`zoom` panel scale** as the new `ui.panelScale` setting (0.9, 1,
    1.15, 1.3, default 1, percent format), applied per-open as inline
    `style.zoom` on the panel root next to compact. NOT a compact-reader
    replacement (declined on semantics: compact is non-uniform â
    thumb-sized coarse targets and the bottom-sheet swap â while zoom is
    a uniform monotone scale). The R9 row pins the R5 identity at full
    depth: rects scale by the seeded factor while computed radii and
    font-size read unzoomed authored px, computed `zoom` reads the
    inline write, and the resting ink is byte-identical before/after (a
    zoom-immune motion lane).
  With trim + zoom landed and the readout reverted, the redesign-class
  ledger is closed; nothing further remains open on it.

**The native-replacement wave-2 audit (Nov 2026, user-directed "explore
more Firefox's C++ replacing JS loops"; post-`5479871`, record-only,
audit-clean).** The three loop-catalog walks (saturation audit,
C++-operators-first, loop-body walk) closed the space from the JS side â
every surviving loop was an allocation contract, rate-bounded, or product
semantics. This wave re-entered from the engine side on the one lens
those walks never priced: **the JS-callback re-entry tax inside native
array verbs** â the assumed standing reason callback-shaped verbs
(`findLastIndex`/`some`/`filter`) can never claim a manual walk even
though the OUTER loop of a verb is engine code. Artifacts:
`check/.tmp/native-wave2-probe.mjs` (G1/G0 sanity + three axes) and
`native-wave2-report.json`, both uncommitted per sweep convention.

- **Harness findings worth holding.** (a) The page-realm
  `performance.now()` quantizes to EXACTLY **1ms** on this floor (G0:
  every distinct step 1.000ms; a 20M-element burst reads 12ms on both
  `performance.now()` and `Date.now()` â G1's clock cross-check). Any
  measurement must size raw totals to â¥ ~20ms and derive per-element by
  division, and every row carries its raw total plus a `quantized` flag
  (min round < 20Ãgrain) so an under-grain reading cannot masquerade as a
  number. (b) The corpus must force honest work on BOTH arms â the first
  draft ended its corpus on a predicate match, which let the
  reverse-scanning `findLastIndex` answer after ONE element and read
  0ms/scan while the manual walk paid the full N; the fix is structural
  and recorded in the probe: an all-miss corpus (both arms walk all N)
  with parity sanity rows (same answer from both arms) before any cost
  comparison, plus a one-match corpus as its own honest row.
- **(T1) the callback tax is ZERO on 159 â the old standing reason is
  dead; shape, not per-element cost, defends the manual walks.** On an
  all-miss 2M-element Float64Array (predicate never matches, so the verb
  and both manual walks pay the full N): manual constant-folded walk
  **0.46 ns/element** (23ms raw), the same walk calling the SAME
  predicate through a JS closure **0.46** (+0.00), and the C++ verb
  `findLastIndex` scanning the whole array with that JS predicate per
  element **0.45** (â0.01, 72ms raw). SpiderMonkey inlines a simple
  numeric predicate to parity with the hand loop â the callback re-entry
  costs nothing beyond the scan. What stays for the manual walks: the
  tree's scans answer at amortized windows (16-entry gesture/HUD
  scale: manual window 0.59 ns/elem â 9.4ns/window vs the verb paying the
  forced full 16 at 0.92 â 14.7ns/window), the loop body carries state
  the verb's contract cannot (the sorted-start walk's moving dead floor),
  and most tree scans ride strings/DOM/cue structures where no array-verb
  shape exists. Engine finding recorded: `findLastIndex` scans BACKWARD
  and stops at the match â forced match at N/2 lands 0.42 ns/elem while
  walking half â the verb's native direction IS an amortized floor, the
  shape the tree's manual dead-floor rides already; nothing to adopt,
  a premise to know.
- **(T2) scanner primacy re-derived with the shipped unit verbatim â the
  regex return-path decline stands, now with a floor reading.** The
  shipped `timecodeToSeconds` + `parseTimingLine` replicated verbatim
  over a 38k-line corpus (19k timing lines + 19k junk): **13.2 ns/line**
  (30ms raw), 0 semantic mismatches. The capture-array + `Number()`
  regex twin â the shape the scanner was written to replace â measured
  **27.2 ns/line** (62ms raw): 2.1Ã SLOWER today; the JIT did not shrink
  the twin's per-line allocation tax (two capture arrays, three regex
  entries, eight `Number` coercions per timing line). The unit is a
  0.25ms share of the ~11ms/1.1MB whole-parse budget at ingest rate â
  the same axis the original A/B declined on. The manual scanner is
  re-recorded correct, not re-opened.
- **(T3) flash-scan native identity â cancel-by-scan has no native
  replacement, now measured above grain.** A runtime WAAPI
  `Element.animate()` animation carries `animationName` = `undefined`
  (`kindOf Animation`); a foreign looped CSS animation carries a readable
  `@keyframes` name (`"wf-foreign"`, `kindOf CSSAnimation`). No native
  filter can select only flashElement's flash â name-selecting would
  INVERT the scan (drop the foreign background-animating animation the
  scan must reap too). The shipped `getAnimations()` +
  `getKeyframes().some(backgroundColor)` scan measured **3.8Âµs/pass** on
  the loaded element (ours + a foreign loop running; bare
  `getAnimations()` alone 1.4Âµs) at per-human-flash rate, zero unhandled
  rejections across 150k passes.
- **(T1b, same-day extension by user direction "take on T1") the zero
  tax generalizes to tree-real predicate shapes.** T1 proved the re-entry
  tax zero for the JIT's best case (one numeric compare); T1b re-asked
  the question for the four predicate shapes the tree's scans actually
  carry, all-miss corpora with parity asserts, all rows above grain:
  (a) **string-suffix scan** â the entry.js `isAdHost` shape replicated
  verbatim (the exact 10-suffix loop with its per-check template
  allocation) over 50k hosts: manual inline 70.0 ns/element, the same
  loop through the `isAdHost` closure 72.5 (+2.5 = the observable closure
  call, 3% against the work), the verb `some(isAdHost)` 72.5 â callback
  tax over the closure **0â2.5ns across runs**; (b) **object field
  reads** (the cue-lookup start/end shape, 200k): inline 0.97, pred 1.06,
  verb 1.03 â tax â0.03 (absorbed); (c) **megamorphic property shapes**
  (50/50 shape churn, 200k): inline 3.13, pred 3.38, verb 2.88â4.25 â
  tax â0.5..+0.9, the JIT installs the closure fine inside the verb over
  shape churn; (d) **DOM getter reads** (`isConnected`, 40k detached):
  inline 36.9, pred 37.5, verb 38.1 â tax +0.63. The verb's apparatus
  (dispatch + element bookkeeping) adds NOTHING on top of the closure
  call itself on any shape; the only visible "tax" is the closure call,
  and its ceiling here is ~2.5ns/element against a 70ns/element body.
  Harness lesson worth holding: the first T1b draft's megamorphic verb
  read O(1) with parity false â the predicate returned a NUMBER and
  `some()` coerces truthiness, so it early-EXITED at the first truthy
  sum; parity asserts before every cost comparison are what catch a
  silently early-exiting corpus.

Sweep disposition: no src change earned adoption. The wave-2 probe
re-measured the one premise the saturation audits never priced and the
floor answers it at zero on 159 â but every callback-shaped verb row
still loses to the manual shapes on the axes that matter (windows pay
delta, the walks carry floors the verbs cannot, and the per-element
predicates ride string/DOM data no array verb accepts). The scanner
primacy and the flash scan's cancel-by-scan identity re-recorded with
floor numbers. Artifact scripts under `check/.tmp/`, uncommitted per
sweep convention. Postscript (same-day, user direction): the
`flashElement` surface axis T3 priced is now RETIRED wholesale â design
language: a press's feedback is the action's own surface (the state
change, the toast), not a layered background pulse on the button; the
identity finding above stands as the record of why name-selecting could
never replace the scan it measured.

**The census-premise substrate audit (Nov 2026, user-directed "explore
firefox' C++ audit for censuses", record-only, audit-clean;
post-`ef8393e`).** The census stage (check/stages/census.mjs) is pure
source counting â comment-stripped literal occurrences â so its real
premises live in the engine-behavior cells BEHIND the recorded counts
and constants, exactly the layer the earlier substrate batches (which
went after the kernel/boot/media planes) never descended to. Artifacts:
`check/.tmp/census-substrate-probe.mjs` (a 5-axis PLAN runner â G0 grain,
C1 wall-clock, C2 apply-args, C3 catch belt, C4 table units; every
evaluated body self-contained and watchdog-belted) and
`census-substrate-report.json`, all uncommitted per sweep convention.
Verdicts, one per axis:

- **(G0) grain â `performance.now()` quantizes to EXACTLY 1ms on this
  floor** (re-derived live: distinct steps {1, 3, 5}ms, median/min 1ms â
  the 3â5ms steps are scheduler hiccups, not finer grain), confirming
  wave-2's G0 premise; every axis sizes totals â¥20Ã the latched grain.
- **(C1) the wall-clock floor â `Date.now()` reads at ~36ns;
  `performance.now()` reads at ~425ns on the page realm (12Ã more
  expensive), both at exactly 1ms resolution.** The zero-timer deadline
  class (page.js nonce/TTL + pipe idle eviction, resume staleness
  cutoffs, the 9 `Date.now()` sites) rides the CHEAP clock at call
  time â the measured-correct choice, not incidental; the 1ms
  resolution is irrelevant at the class's scales (3s drift epsilon,
  10s checkpoint, seconds-scale deadlines). The wave-2 harness
  premise â that page-realm `performance.now` is the expensive read â
  is now a pinned floor number.
- **(C2) the apply-args RangeError floor on THIS engine is exactly
  500,000 (verified at the boundary: 500000 applies, 500001 throws) â
  the dom.js `PUSH_APPLY_LIMIT` guard (65536, sized against a V8-era
  ~124k reading) rides at 13% of the Firefox floor.** The fast path
  (`push.apply` under the limit) can never die under a real
  MutationObserver batch on Firefox: the V8 reading was the
  conservative one, and the Firefox margin is 7.6Ã. At limit scale the
  fast path costs 1.9ns/record vs the index-walk fallback's 3.8ns â
  the walk's safety premium is ~2Ã/record on a path that exists only
  above 65k records.
- **(C3) the bare-catch belt unit â a thrown-into `catch {}` cycle
  costs ~52ns warm; the miss path (try entry, no throw) ~1.9ns.** The
  error census's release-tail/witness classes sit under a 28Ã hit/miss
  ratio: misses are engine-free at the belt's real rate, each hit is a
  rare edge priced at ~52ns â the 7 verb-less belts' cost model is
  measured, not assumed.
- **(C4) module-table unit costs, all in the declared boot/
  interaction-rate band** â `new Set(ten words)` ~54ns, an
  `Object.hasOwn` 4-key attr walk ~20ns (~5ns/key, the measured shape
  behind the attr-walk rows), `Map.groupBy` over a 10k-row
  50-group-bucket shape ~83Âµs per construction (~8.3ns/row) â none competes with
  a real scan; the census's "boot/interaction-rate trivial"
  classifications hold on the floor.

Sweep disposition: record-only, no src change earned adoption â every
re-measured premise is the shape the tree already rides (the cheap
epoch clock, the conservative apply guard, the belt cost model, the
trivial table units). Artifact scripts under `check/.tmp/`, uncommitted
per sweep convention.

**Deepening round (same day, user direction "take on the 4 items"; the
four axes extended in place as C1bâC4b in the same probe, record-only,
audit-clean).** Second-round probes over the same five-axis harness,
no src change. Verdicts:

- **(C1b) the real call-site shapes land 38â41ns per check** â the
  eviction-walk shape (one `Date.now()` read at fn top + 10 stamp
  compares) 39ns, the merge-stamp field write (`updatedAt =
  Date.now()`) 41ns, the per-echo staleness compare 38ns. Derived duty
  budgets: the 4Hz checkpoint drive spends ~40ns per 250ms (0.016%);
  a 1000-echo storm spends ~40Âµs total against the 400ms window
  (0.01%). The class rides the cheap clock in its cheapest shape â
  one read amortized over the whole check, never per compare.
- **(C2b) the guard's limit operates on RECORD count, not record
  payload â two live batches on the real engine decide it.** Fragment
  hydration of 70,000 nodes delivers as ONE coalesced childList record
  whose `addedNodes` carries the whole count: `records.length` = 1, the
  fast path drains it for free (`applyFastPath65535` = 1.9ns/record;
  the walk's safety premium holds at 3.8ns/record on plain-array
  object-record sources). Individual `appendChild` calls in one task
  (70,000 of them â the E-axis per-append precedent scaled) reach
  `records.length` = 70,000: the WALK arm engages on a real batch and
  drains all 70,000 records intact in ~6ms â correct, not merely safe.
  Engine note: this refines the shell-substrate E-axis premise â
  its per-append-records shape holds for a loop of separate append
  calls; a whole DocumentFragment append coalesces into one record
  with multi-node `addedNodes` (the feed's downstream pipes walk
  `addedNodes`, so the payload survives either record shape).
- **(C3b) the belt's edge shapes: depth-5 unwind ~200ns/cycle, and the
  fresh-code cold reading is an honest UPPER BOUND ~2Âµs/cycle**
  (fresh `new Function` parse+compile amortized into the throw â
  subtraction-based cold estimates proved meaningless: a no-capture
  arrow's allocation is elided on discard, so a create-only baseline
  measured ABOVE create+call). Warm ~52ns (C3); the rare-edge price
  holds to ~2Âµs at the absolute coldest credible fire.
- **(C4b) the tables at TREE scale: AD vocabulary `Set(11)` ~194ns**
  (longer strings hash slower than the generic ten-word probe's
  ~54ns), **resume's `Map.groupBy` at real bounds** â ~19Âµs per merge
  at 500 entries, ~85Âµs at 2000 (~40ns/entry on real path-string
  keys) â and the config schema's 30-row derive loop ~780ns. All
  boot/interaction-rate; the merge-path window (one groupBy per
  foreign-write merge) is within microseconds at the store's real
  entry bound, never a hot path.

Deepening disposition: record-only, no src change earned adoption â
every axis lands on the shape already shipped; the one NEW engine fact
(C2b's fragment record coalescing) refines the XML-mutation-batch
premise recorded for the shared feed without moving any src claim.

**The C++-internals delegation probe (Nov 2026, user-directed "explore
firefox' C++ internals usage possibilities to improve native-like
performance", record-only, audit-clean; post-`d5c2b81`).** The audit
series walked the space from the JS side (every call site already one
native op); this batch walked it in reverse â jobs still EXECUTED by
JS that a Firefox C++ facility could take over WHOLE, priced with
both-arms parity asserts before every cost row (axes D1âD4 + G0 grain
in `check/.tmp/cpp-internals-{probe.mjs,report.json}`, uncommitted per
sweep convention; rows auto-sized by geometric-batch sizing). Verdicts:

- **(D1) the cue comparator sort CAN be a comparator-free native sort
  â and it is not an adoption.** The 19k-cue
  `sort((a,b)=>a.start-b.start)` vs a `Float64Array` of
  `(ms-start << 21 | input-idx)` packed keys under the TypedArray
  DEFAULT sort (pure C++ numeric per spec, no callback at all):
  parity exact at both scales including ties â the low-bit index
  reproduces `Array.sort`'s stability, and ms-quantized starts are the
  real parsing output so the pack is order-preserving (exact in
  float64 to 2^53). **8.4ns/record vs 34ns (4Ã) at ingest scale,
  7.5 vs 32.6ns at live scale.** But the raw saving is ~0.5ms against
  the recorded 11ms/1.1MB ingest tripwire â noise on the rate axis â
  and the adoption code carries two extra encode/decode passes plus an
  ms-quantize premise: declined on rate, the scanner-A/B verdict class.
  The C++-ops record's decline wording ("no native key-sort API
  exists") is refined: one exists via the pack; the decline stands on
  rate.
- **(D2) the compiled C++ alternation beats the suffix loop 3.6Ã/host
  and still declines.** One prebuilt `RegExp` (suffix alternation +
  prefix lead) reproduces the entry.js `isAdHost` semantics EXACTLY
  (5/5 hit agreement + the full 20k miss corpus, throw-guarded):
  **24.5ns/host vs the loop's 90.5** â but the scan runs once per
  realm and the kernel-plane substrate H axis measured the whole skip
  probe at 0â500ns total; a ~0.06Âµs saving at boot rate is nothing
  against a regexp semantics twin that must stay in lockstep with the
  loop's prefix/suffix vocabulary. Declined on rate.
- **(D3) Intl delegation loses 23Ã â and DurationFormat is shipped but
  not the product's shape.** A cached `Intl.DateTimeFormat` (hour/
  minute/second UTC) measured **305ns/call vs formatTime's 13.2ns**
  concat (the per-read `Date` allocation is the shape) â migrating the
  HUD formatter to ICU pays 23Ã on the hotpath battery's 250k-call
  synthetic for zero real gain at human-gesture rate.
  `Intl.DurationFormat` IS shipped on 159 but costs **706ns/call**
  and its `digital` style does NOT produce the numeric composite
  (default and digital both sample the same "1 hr, 23 min, 47 sec")
  â the one ICU surface shaped like h:mm:ss can neither express the
  product's format nor beat the concat. Declined.
- **(D4) `structuredClone` declines as a device at batch scale,
  re-affirming the walker decisions.** 1000 flat cue-shaped records:
  structuredClone **594ns/obj**, JSON round-trip 281ns, manual spread
  loop **19ns** â the native deep-copy device is 31Ã slower than the
  spread at the shapes the tree would face; the copy-on-write walker's
  adoption re-prices as correctness, not just pruning.
- **Delegations already complete (verified from source, not probed):**
  the fill-transform eased snap rides WAAPI `fill: "both"` (a
  compositor animation, one owned cancel handle, final commit on
  finish); the scrub/readout rides the native rAF pump; resume
  checkpoints ride the native `timeupdate` media clock; cue slots ride
  the CSS engine (`@container`, `@starting-style`, scroll-timeline,
  `text-box-trim`, view-transition types); every remaining JS loop is
  one of the recorded allocation contracts, rate-bounded below
  measurement, or the feature's semantics.

Harness lessons worth holding for future probes: (a) nested template
literals inside an eval'd body TERMINATE the outer `makeAsync`
template â string concat only (the D2 first draft hung the parser);
(b) single-call timing reads are invisible under the page's 1ms clock
(a 160Âµs arm reads 0ms), so sizing rides a geometric batch (Ã4) until
the total crosses 5ms, and the sizing helper's first draft carried a
Âµs/ms unit mismatch that turned a 100ms budget into 65s rounds; (c)
the hit corpus initially included `adservices.google.com` (plural
"services") â the shipped prefix vocabulary claims only continuations
OF "adservice.google.", so that host is claimed by NEITHER arm: a
vocabulary fact, not a parity failure (the throw-guard's 5/5
agreement surfaced it).

Sweep disposition: record-only, no src change earned adoption â the
delegation surface is already maximal on every rate axis that matters;
the one genuinely faster native unit (D1's packed sort) saves noise at
its real rate and the placed margins (D2/D3/D4) lose to the shipped
shapes. Recorded so any future "hand the whole job to C++" argument
must first beat these numbers.

**Adoption addendum (user direction: "Adopt the 2 winners" â D1 and D2
landed in src; D3/D4 stay declined per the record).** The record's
declines were rate-motivated, not semantic; the user direction overrode
the rate call on the two networks that also pay back in shape:

- **D1 landed â `sortCues` rides the packed-key native sort**
  (`forgevtt.js`). The `Float64Array` of `(ms-start Ã 2^21 + input-idx)`
  keys sorts comparator-free under the TypedArray default sort and
  scatters back through held references (an in-place scatter would let
  a permuted read observe an earlier write â one scratch pass commits).
  The order-preserving premise is now the docstring's: starts arrive
  ms-quantized (textual timing parse + the 0.25s sync-offset vocabulary,
  `shiftTime`'s clamp to 0 stays on the grid; both parse call sites are
  fed offset 0 by the parse memo â sync offsets rebuild through
  `subtitles.js`'s own `#applyBase` comparator sort, untouched), exact in
  float64; two starts closer than 1ms would tie by input index â a
  sub-ms window the presented-frame crank cannot see. Lives in the file
  as content, not a procedure: the parity story (equal starts keep
  input order = `Array.sort`'s stability) rides the probe record + this
  addendum.
- **D2 landed â `isAdHost` rides one compiled alternation**
  (`entry.js`), derived from the two source tables (the suffix
  alternation **end-anchored**, the prefix alternation lead-anchored;
  dots escaped so a suffix's literal dots stay literal;
  `new URL().hostname` is spec-lowercase, no flag). The end anchor is a
  semantic fix over the probe draft, which used `(?:\.|$)`: that form
  accepts a trailing-suffix trap `doubleclick.net.evil.com` the loop (=
  the shipped semantics) refuses; the adoption pins `(?:^|\.)(suffixes)$`
  and node-verified exact agreement with the loop on that trap, the
  neither-arm `adservices.google.com` vocabulary shape, case handling,
  and the hit/miss corpus. The tables stay the ONE source vocabulary â
  they are now consumed exactly once, by the regex build. The tree
  carries a third `new RegExp(` site (joined to the two `SUBTITLE_EXTS`
  assemblers the C++-ops record names); the census carries no
  `new RegExp` row, so no gate move was needed.
- **D3/D4 stay declined** â 23Ã and 31Ã slower than the shipped shapes
  on the floor; adoption never earned.

**The native-robustness probe (Nov 2026, user-directed "explore native
firefox cpp operators and internals can be useful in polished and improve
the project's robustness"; post-`a85dbc0`, record-only, three adoption
candidates flagged for user direction).** The audit series priced SPEED
(operators, saturation, callback tax, delegation, substrates); this probe
prices HARDENING â which native Firefox operators/engine behaviors polish
the tree's robustness surfaces (hostile inputs, non-finite data,
cross-realm payloads, exotic strings). Artifacts: `check/.tmp/
native-robustness-probe.mjs` (8-axis PLAN runner, R0âR7, every body
self-contained and deadline-belted) and `native-robustness-report.json`,
uncommitted per sweep convention. Harness lesson worth holding: the
WebDriver wire's own serialization rejects lone surrogates BOTH in the
command payload and the response value ("unexpected end of hex escape") â
hostile-string corpora must be composed in-page via
`String.fromCharCode` and returned as code-point summaries, never as raw
strings (the probe's R4/R5 bootstrap documents the shape). Findings, one
per axis:

- **(R0) clock grain â both clocks quantize to exactly 1ms** (`Date.now()`
  and `performance.now()` alike; the C1/G0 records re-derived live). An
  earlier sampler shape (a summing spin before a tight loop) was
  dead-code-eliminated and sampled zero steps â the probe now
  busy-waits until the clock crosses a step, which cannot be elided.
- **(R1) RegExp.escape totality â the adoption candidate #1.** The floor
  ships `RegExp.escape`; an escape-per-entry rebuild of the shipped
  `AD_HOST_RE` shares EVERY verdict with today's hand-escape build over
  both table families and the full legal/illegal host-shape column
  (0 parity misses) â adoption is byte-parity on today's tables. The
  future-table column is where the shipped build fails: over an
  11-entry metachar corpus (`a+b.c`, `[a-z].com`, `a|b.com`, â¦), the
  escape build is truthful everywhere (escLie 0/11) while the
  dots-only hand-escape lies on EVERY row â ten entries silently DROPPED
  by the metachar's grammar reinterpretation (a future table entry like
  `a+b.c` would simply never match any host) and one (`{2}.com`) throwing
  a SyntaxError AT REGEXP CONSTRUCTION â a future table entry that kills
  the realm's boot instead of degrading. The subtree sites carry the same
  class worse: `subtitles.js`'s two `SUBTITLE_EXTS` assemblers do NO
  escaping at all (a future `ext` value is constructed into the lattice
  raw). Totalizing all three build sites through `RegExp.escape` per
  table entry is the adoption; today's behavior is unchanged by
  construction, tomorrow's table write becomes total.
- **(R2) groupBy hostile keys â pollution-inert by spec.** Firefox 159's
  `Object.groupBy` result carries a NULL prototype (the final-proposal
  grounding; a plain `{}` control still matches `Object.prototype`) â
  `__proto__`, `constructor`, `hasOwnProperty`, `toString` all land as
  own data properties whose value is the group array (each own-key count
  1, groups are plain arrays, `poisoned.__proto__` READS the group, the
  object's own prototype link untouched; `Map.groupBy` control keyed the
  same row set cleanly). The recorded derived-table premise holds at the
  hostile pole: no adoption needed, the read is a floor fact.
- **(R3) stamp comparator table â Infinity is the immortal shape
  (adoption candidate #3).** The full semantic column over
  NaN/Â±Infinity/""/null/undefined/0/1e13 through the tree's comparator
  vocabulary (`(s || 0)`, `>`, `<=`, eviction cutoff, strict echo):
  NaN/""/null/undefined/0 degrade to epoch-0 â they lose every LWW
  compare and ride an immediate eviction cutoff (poisoned toward
  removal, bounded damage); -Infinity degrades the same. **Infinity (and
  any finite stamp beyond the horizon, e.g. 1e13) wins every `>` compare,
  is never `<=` the doc stamp NOR the eviction cutoff â a
  removal-adoption never lands and eviction never fires: an
  Infinity-stamped resume entry is immortal in both merge planes**, and
  the strict `===` echo fast path can never pin it either (Infinity
  === Infinity dismisses, so no echo storm â the entry just silently
  outlives every boundary). The count is a one-line
  `Number.isFinite(stamp)` gate at resume's entry projection (the
  load/projection path the resume record pins as the field whitelist),
  not per-comparer surgery.
- **(R4) lone surrogates â the persistence/bridge corpus, whole.**
  `structuredClone` CARRIES them intact â no throw, no U+FFFD (the
  DataCloneError class is NOT reachable through lone-surrogate strings on
  this floor; the clone path preserves loneliness exactly, both the bare
  string and an object carrier). JSON.stringify/parse round-trips them
  EXACTLY (ES2019 well-formed JSON escapes; length arithmetic exact), so
  the gmSetValue/realm decode surface is safe on the
  surrogate axis by the floor's own default. `String.prototype`
  ships both verbs: `isWellFormed()` witnesses the corpus false,
  `toWellFormed()` delivers the U+FFFD twin (well-formed output). And the
  pointer-recorded title note CONFIRMS: the sanitizer's `NON_LATIN_RE`
  (u-flag Script=Latin/Common complement, script Unknown/Cs) strips
  lone-surrogate code points whole â `sanitize()` output is well-formed,
  the stored/bridged title path is already total. No adoption on the
  title axis; the earlier note retracts to a confirmed claim.
- **(R5) the bridge post surface â the hostile-path class pinned,
  narrowed (adoption candidate #2).** The platform's structured-clone
  gate is measured at the exact sites the frame model rides:
  lone-surrogate-carrier payloads post through `window.postMessage` AND
  `MessageChannel` ports delivered INTACT (no throw, no replacement â
  the echo witnesses the d800 byte verbatim), so surrogates are not the
  re-post hazard; **Symbols and functions throw `DataCloneError`
  SYNCHRONOUSLY at the post site** ("unsupported type for structured
  data" / "Function object could not be cloned"), which is exactly
  `mapContextPayload`'s seam: its other fields are type-gated by
  `looksLikeContextResponse` but `data.path` passes through unvalidated
  onto the context re-post â a hostile in-frame document poisoning
  `path` with a Symbol/function makes the TOP-frame re-post line throw
  into the tree. The adoption is the same shape the gate already
  enforces elsewhere: a `typeof data.path === "string"` admission
  (lone-surrogate strings ride fine per this axis, so string admission
  alone covers the measured classes).
- **(R6) URL/host totality â the two-call identity is exactly already
  total.** `URL.parse(u) === null` and `URL.canParse(u) === false` land
  on precisely the constructor-throw rows (empty, port 65540, **a
  lone-surrogate URL â the URL layer itself refuses them**, a space
  host, a bare-userinfo host), while IDN/punycode parses to its punycode
  form and a trailing-dot host lowercases cleanly. The AD matcher over
  the lookalike column (soft-hyphen split, Cyrillic homoglyph, punycode,
  wrong TLD, carrier suffix) reads 0/12 â the literal-matcher isolation
  holds over the homoglyph class (an isolation record, no security
  claim; punycode/soft-hyphen hostnames simply do not spell the
  suffixes).
- **(R7) the operator floor ledger â every prior-record operator
  re-witnessed present on 159.0.1** (RegExp.escape, URL.parse/canParse,
  Promise.withResolvers/try, both groupBys, the well-formed-string
  verbs, Set algebra, iterator helpers, the Array copy verbs, findLast,
  structuredClone, `using`, randomUUID, hasOwn).

Sweep disposition: record-only at write time â no adoption earned on the
floor's OWN behavior (the groupBy spec, the URL totality, the JSON and
clone paths, the title sanitizer are all already total or exactly the
shape the records claim); three adoption candidates carried to user
direction because the measured gap is in src, not the engine: (1)
`RegExp.escape` totalization of the three table-driven regex build sites
(parity exact today, totality tomorrow, `{2}.com` is the construction
throw the totality kills); (2) a `typeof data.path === "string"`
admission gate in `mapContextPayload` (the Symbol/function
DataCloneError class is measured real and unguarded); (3) a
`Number.isFinite(stamp)` gate at resume's entry projection (the
Infinity-immortality class is measured real). Each is small, each is
behavior-additive only on today's flows, and each needs its own green
battery run if adopted.

**The native-robustness wave-2 probe (Nov 2026, user-directed "explore more
native-robustness adoption"; post-`29906fb`, one adoption carried and
landed).** The first robustness batch re-entered at the axes its column shape
suggested; this batch re-enters at the axes the column never reached. Artifacts:
`check/.tmp/native-robustness2-probe.mjs` (N1 insecure-origin engine leg + N2
delay-totality leg + a node-side C2 census, all uncommitted per sweep
convention) and `native-robustness2-report.json`. **Harness finding worth
holding: the loopback fixture origin is a SECURE CONTEXT â every probe, gate
row, and screenshot in the battery's history ran where the trust-gated API
surfaces hold â so any real-world trust-class gap is invisible to the gate by
construction.** The insecure leg rode a tiny 0.0.0.0-bound http server
navigated to the machine's LAN IP, the one way to reach a genuinely
non-trustworthy origin without leaving the fixture harness. Findings:

- (N1) **`crypto.randomUUID` is Secure Context Only â the wave-2 adoption.**
  On a plain-http origin: `isSecureContext false`, `typeof crypto.randomUUID`
  `"undefined"`, calling it throws `TypeError: "crypto.randomUUID is not a
  function"` at the call site; `crypto.getRandomValues` ships in the same
  realm and the fallback recipe builds a string. The three src consumers were
  the pipe nonce (page.js, inside the transfer try â protected), the
  first-attempt nonce (page.js `attempt()` at the boot resolve â a synchronous
  TypeError), and the `pf:diag` dump write (kernel.js â the menu tap dies).
  The blast radius mapped statically: `getPageContext`'s catch-block
  `return await requestPageContextFromParent()` re-throws into a REJECTED
  `#contextPromise`, whose `await` lands inside `#init()` â its `.catch`
  logs `resume Init failed` â so on any insecure page with a cross-origin
  embed, resume silently lost that document (no restore, no progress drive).
  Battery/loopback runs never saw it because the fixture is trustworthy.
  **Adopted: `randomNonce()` in core.js (a new Fresh-value mint section),
  consumed at all three sites.** randomUUID stays the first choice (the
  well-known shape on every trust level that has it), so secure pages are
  byte-unchanged; the fallback rides `getRandomValues` (insecure realms ship
  it) with a module counter making uniqueness exact rather than
  probabilistic â the cross-reboot collision needs the same counter AND the
  same 64-bit hex, and the `pf:diag` protocol only needs "fresh â no read
  ever re-acts".
- (N2) **`postTask` delay totality â native-honest, no adoption.** For
  computed-delay future callers: `{delay: NaN}` and `{delay: Infinity}` throw
  `TypeError: 'delay' member of SchedulerPostTaskOptions is not a finite
  value`; `{delay: -5}` throws the out-of-range class; `{delay: true}` is
  accepted (coerced). `AbortSignal.timeout(NaN)` builds (fires at ~grain).
  Every current caller is a named constant; the engine's crash classes are
  an honest floor, recorded so a future computed-delay call site chooses
  deliberately.
- (C2) **the static census over comment-stripped src**: 18
  `.replace`/`.replaceAll` sites, ZERO with a dynamic replacement argument â
  the native `$`-pattern injection class (`$&`/`$'` reinterpreting
  host-authored text) is unreachable; every substitution rides a literal or
  a callback. Zero `JSON.parse` in src â stored docs arrive manager-parsed
  (`loadJsonObject`'s truthiness-object read documented in sweep #10), so the
  hostile-JSON column has no intake. Both numeric parse intakes sit behind
  measured gates (the stepper's `Number.isFinite` commit gate; forgevtt's
  entity `parseInt` inside the shape scanner). Waves the census closes.

Sweep disposition: one adoption (`randomNonce` totalization of the
trust-gated API call sites), two record-only verdicts (N2 native classes, C2
census closure). Proved on 3 consecutive all-green battery runs (234 rows
each, ~86s).

**The uBO-grade additive wave (Nov 2026, user-directed "all functions that
can't be native to be built on native ones with robust additives, uBO-like";
post-`bcb4dc0`, five admission gates landed).** The audit series
(saturation, C++-ops, callback tax, loop-body walk) had already closed the
"can it be one native op" side: every remaining manual function is engine-
tight, an allocation contract, or product semantics. The actionable side of
the direction is the second half â every manual engine that takes EXTERNAL
data now carries uBO-style total admission at its intakes, and every one of
the landed gates is a single native operation (typeof, `length` read,
`slice`, `size`, `URL.parse`) â no new manual machinery anywhere; hardening
rides the C++ substrate to the last byte. The intake census first (what was
audited and needed nothing): forgevtt's scanners are shape-total (digit-only
fields, bounded decode), the dual stepper intakes ride their `Number.isFinite`
commit gate, the placement grain's `readPlacement` is index-gated and the
sync/style seeds coerce at their seeds, `coerceSetting` annihilates wrong-type
bool/options rows (no numeric rows exist in the schema â nothing to add),
`domainScore` is band-bounded with early exits over short keys, and the
title/hash planes were proven total by the first robustness batch's R4/R6.
None of those earned a change. The five landed gates, per intake:

- **Subtitle ingest ceiling â `TUNING.subtitles.maxFileChars` (16 MiB of
  UTF-16 text).** The drop and URL paths converge at `#ingest`, whose belt
  fires before NFC normalization or the parser own the string; `load()` adds
  a `file.size` byte pre-gate so the hostile byte bomb dies before the
  whole-input `file.text()` allocation spends it. Real tracks (tens of KB;
  the >512KiB cooperative-parse case rides far below) unaffected â a drop
  of 18 MiB of junk now lands the ordinary fail toast instead of taking
  the frame's memory down with it.
- **URL-layer admission in `loadFromUrl`** â `URL.parse(url)` refuses a
  garbage scalar before the manager request ever sees it (the restore URL
  and the panel input arrive from foreign-writable surfaces; a typo'd panel
  input keeps its fail-toast feedback, a hostile stored value stays
  bounded and network-silent).
- **`#nameFromUrl` percent-decode totality belt** (the census's eighth
  bare catch, named why) â a served pathname with a bare `%`
  (`http://host/sub%`) is left in place by URL parsing but throws `URIError`
  in `decodeURIComponent`; today that poisoned an otherwise good fetch with
  the parse-fail toast for a display NAME. The raw segment is the fine
  fallback.
- **`#tryRestore` string admission** â a non-string `subsUrl` in the
  foreign-writable resume entry is refused outright instead of riding
  `String()` coercion into a "[object Object]" fetch attempt.
- **`mapContextPayload` deterministic truncation** â domain 256 / path
  2048 / title 512 chars at the bridge arrival: every downstream consumer
  (the context re-post, resume hashing, the snapshot sort, the title regex
  strip) had been working on the whole hostile value; the caps fire once at
  admission and stay stable (a same-input truncation keeps entry ids
  consistent across visits). Proven by the census and the frames case's
  cross-origin rows, which ride real short payloads (236-row battery
  all-green three times over).

The battery grew one honest row to prove the ceiling on the floor
(subtitles case): an over-cap synthetic drop through the REAL panel path
lands the fail toast and renders no bomb cue. Battery note: run 1 came
back with two robust-case clock-row fails (hidden-flush, checkpoint
cadence) â clean captures (no console/page errors, shell present), a green
isolated rerun of the case, no src path into those rows, and neither recur
in three subsequent all-green runs: environment-correlated scheduling flake,
recorded so the next reader does not chase a ghost. Proved on 3 consecutive
all-green runs (236 rows each, ~86s).

**The Native-first bar law ledger â batch 1 (Nov 2026, user-directed "open a
ledger for Native-first implementation bar law audit exploring the first
sweep batch"; post-`6bbe8a3`, audit-clean, record-only).** The law (Â§5.1)
became a receipt-bearing ledger: the first sweep batch audited the whole
tree against it in three planes â the day-of-law delta, a per-module
machine inventory, and the residual manual-engine roll â and certified the
tree audit-clean. Artifacts: `check/.tmp/law-ledger-batch1.mjs` (the
comment-stripped inventory; uncommitted per sweep convention), **one
census addition**: `RegExp.escape build sites = 4` (the two
`AD_HOST_RE` arms in entry.js, the two `SUBTITLE_EXT` assemblers â the
reasoning-commit row pinning the totality adoption: a future table entry
with a metachar must degrade as a literal, never reinterpret the grammar
or throw at `RegExp` construction; a hand-dot-escape twin or an
unescaped assembler returning is the law regression the row catches).
Measurement note for the inventory class: template-interpolation content
COUNTS as code (`RegExp.escape(ext)` lives inside a template literal;
a naive comment-strip ate it until the stripper lifted `${...}` contents
out of the backtick span before dropping it).

1. **The day-of-law delta audit.** Every src commit between the loop-body
   walk (`d9e229f`) and the law commit (`6bbe8a3`) â 7 commits, 15 files,
   +252/â124 â classified from the diff, each native-ward, subtraction, or
   a recorded prose/docstring correction: `20b07da` (shell.js docstring
   only â the measured same-value skip), `5479871` (the four shell-plane
   flag fixes: the S7 R4 divisor `/ 1%` â `/ 100%` one-line, S2/S3/S6
   prose), `eb90825` (flashElement retirement, pure subtraction),
   `a85dbc0` (the two delegation winners â forgevtt's packed-key sort
   verified live in working src as `keys.sort()` on the `Float64Array`,
   comparator-free per spec, and entry.js's compiled `AD_HOST_RE`
   alternation with node-verified parity incl. the trailing-suffix trap),
   `29906fb` (`RegExp.escape` Ã3 build sites + the `typeof data.path`
   admission + the `Number.isFinite` stamp gate), `bcb4dc0`
   (`randomNonce()` + its 3 consumers), `b8e53c9` (the five uBO
   admission gates), `6bbe8a3` (the law itself, AGENTS only). No commit
   regressed toward hand-rolled work; the delta is the law's own history,
   not a violation pool.

2. **The machine inventory** (23 modules; 16 ride the counted
   native-operator vocabulary, classified by verdict not by raw counts):
   - **Native-delivered** (the implementation IS the operator: detection's
     ONE `matches()` probe per hop; resume's `Map.groupBy`
     path bucket + `toSorted` + seven `isFinite` gates; page's bridge
     with `withResolvers` + `AbortSignal.any` + the truncation
     `slice` caps; subtitles' escape-built tables + `URL.parse`
     admission + the decode belt; media's `URL.parse` null-guard;
     actions' `Object.groupBy` pointer-intents; panel/toast's
     `replaceChildren` pooled clears; forge's `closest` press-arm and
     kernel/entry/core's operator-floor sites).
   - **Platform-API planes** (primaries are platform APIs the operator
     vocabulary never counts; zero counted native hits is expected, not
     a violation): dom (ResizeObserver/MutationObserver/FsGate â the
     native observers story), runtime (the `scheduler.postTask` faÃ§ade â
     the native scheduling engine), store (the GM storage plane and its
     echo contract), inject (`adoptedStyleSheets` + the `@container`
     pockets), discovery (presence gates over MutationObserver), config/
     contract/ui/shell (source-table derives, EventTarget Fan
     construction, composition â init/interaction-rate loops in the
     loop-body walk's recorded classes).
   - **Manual engines, law-clean through receipts**: forgevtt's scanner
     (the C++-ops A/B + wave-2 T2 measured declines; intakes shape-total;
     its one native adoption = the packed sort), page's
     Levenshtein/`hashEntry` (no native in-realm equivalent; band-bounded
     over short keys; the string planes R4/R6-proven total), resume's
     stamp comparators (the R3 `isFinite` gate over the immortal shape).

3. **Verdict: audit-clean.** The residual manual set is exactly the
   recorded declines â nothing on the tree violates the bar, no manual
   engine duplicates a named native op, and every external-data intake
   carries its admission gate. Next batches append to this ledger per
   the delta-audit shape (each src commit classified at its law
   surface), instead of re-walking the whole tree.

**Ledger batch 2 â the subtitles family (Nov 2026, directed batch; two
seed-clamp adoptions + the CSS intake receipt; proven on 3 consecutive
all-green runs, ~86s each).** The family read at its own intakes with the
law's two-halves bar: the manual engines (forgevtt scanner, the rVFC
sampler, the placement derive) ride their recorded receipts unchanged; the
new ground was the three state grains that consume FOREIGN-WRITABLE
storage at their seeds. **The seed-bypass class â adopted (2 adoptions).**
Both `SubtitleSyncState` and `SubtitlePlacementState` clamped their
COMMIT intakes (`set()`'s Â±`SYNC_BOUNDS`, the steppers' 0â100) but their
seed paths â the field initializer, `#resolve()`'s entry-grain read, and
`readPlacement()` â consumed storage values past the same bounds: a
hostile `pf:configs` key or resume entry could ride a Â±1e8 sync offset or
a 1e7 placement override straight into the render math a commit could
never reach (cues shifted out of existence, slots pushed off the picture â
bounded damage, but the bound the owner already owned was not applied at
every intake). The adoptions are the same native `clamp` op at the same
bounds, three one-line sites, no new machinery; legit storage (steppers
write in-range) is byte-unchanged. **The CSS intake receipt (row added,
no adoption).** `SubtitleStyleState` writes stored size/color/shadow/
font/stroke strings into custom properties via `setProperty` â the floor
probe (a battery row after the over-cap refusal row) replicates the exact
call with hostile token streams (`url()` fetch attempts, a selector-shape
value, an overflowing unit, an unterminated string): computed color falls
back to the sheet default (IACVT), computed font-size reads 14px, and the
before/after `performance` resource census moves ZERO â the consume chain
(color/font-family/font-size/text-shadow/-webkit-text-stroke) paints
only, so the CSSOM value parser is the total engine and the string
pass-through degrades safely; a `url()`-carrying custom-property value
has no fetch surface on this floor. **The astral truncation boundary
(node-verified, no change).** A `.slice()` cap can split a surrogate pair
(locally ill-formed); the title strip's u-flag Script regex removes the
lone halves whole, so every stored/bridged context value stays
well-formed after truncation â the R4 record re-derived at the new cap
sites. The remaining family intakes re-verified against their landed
records: the ingest ceiling + `URL.parse` admission + decode belt +
`#tryRestore` string admission (b8e53c9), the scanner's shape-total
digit-only fields, and `MAX_SLOTS`' active-set bound over any parsed
list.

**Ledger batch 3 â the inputs family (Nov 2026, directed batch;
record-only + one battery row, no src adoption; proven on 3 consecutive
all-green runs, ~86s each).** The family read at its own intakes with
the law's two-halves bar: the manual engines (ScrubStroke's
coalesced-sample wash, SwipeStroke's transform writes, the pinch
comparator, KeyHoldSession) ride their recorded receipts unchanged
(saturation/loop-body swept, rate-bounded, or the feature's semantics);
the question was the EVENT-STREAM plane â page-originated event payloads
whose numeric members a hostile page can synthesize with garbage, and
every math sink they feed. The full intake trace: the engine's numeric
reads are `clientX/clientY` (press/move â pointer tracking, ScrubStroke
samples, the hold-cancel distance), `deltaY` (trackpad pinch â sign
read only), and the detail members forge itself re-spells from those
raws (`dx`, the velocity filter); `movementX/movementY` are consumed by
ZERO src code. The sinks behind them all own their bounds: ScrubSession
accrues `#pendingDelta` and commits `clamp(currentTime + pending, 0,
duration)` per rAF (clamp returns NaN for NaN input, but NaN is
unreachable per the premise below); `scrubToLatched`'s unguarded clamp
is the same shape and unreachable on the same grounds (media's
`#clampTarget` carries the explicit isFinite gate: cold duration 0 â
target 0); SwipeStroke writes the drag number into `translateY(px)`
strings the CSSOM drops silently when unparseable, and `easeTransformTo`
keyframes read the clean computed `#baseTransform`, never a hostile
value; pinch dispatches `detail.direction` â a string derived from
compare result, no number crosses; the wheel handler reads the deltaY
sign only. **The load-bearing premise â the IDL conversion IS the
native admission gate (pinned by a new gestures battery row).**
`PointerEventInit`'s `clientX/clientY` and `WheelEventInit`'s `deltaY`
are non-unrestricted doubles: a synthetic `new PointerEvent("...",
{ clientX: NaN })`/`{ clientX: Infinity }`/`{ clientY: NaN }` and `new
WheelEvent("wheel", { deltaY: NaN })` all throw TypeError at the
dictionary conversion (measured, real realm, the row machines all four
rejections against a finite-control ACCEPTED so it cannot pass
vacuously) â a hostile page cannot deliver a non-finite coordinate into
the engine at all. **The measured witness: `movementX` is an
unrestricted double and rides NaN through** (the row carries it as a
non-gated attempt) â inert by non-consumption today, recorded so any
future engine reader of `movement*` knows that intake is NOT
engine-gated and must carry its own bound. Finite garbage beyond the
gate (1e308 coords, huge deltas) degrades through the same
bounds-owning sinks: seek clamps saturate at the duration, a
`translateY(1e9px)` string is real CSS and renders off-picture only for
a session the user is already driving. No gate belonged in the engine.

**Ledger batch 4 â the kernel/discovery plane (Nov 2026, directed
batch; record-only, audit-clean, no rows, no src; one green battery run
(~86.4s) as the receipt since nothing gate-relevant changed).** The
family read at its intakes with the law's two-halves bar. The kernel
plane's intake map, exhaustively: **the storage reads** â `debug.logs`
(boot truthiness-OR with the hash tag, the mirror's strict `=== true`
behind the value-neutral compare latch, the menu's boolean flip), the
`pf:diag` echo (the value is NEVER read â the delivery itself is the
one-shot trigger, exactly the sweep-#10 "no read ever re-acts"
contract, and `dumpFrameState` stringifies own-realm data only: realm
label, `getDomainKey` of the platform hostname, `fullscreenElement`'s
tag name, `=== true` booting compare), and entry's first-run chain
(`meta.firstRun` truthiness for the welcome pending plus the two legacy
names each swept once, one `false` write, the hint flow bounded by the
1.2s cap + the interaction abort â the feature-timer class). Every sink
is a truthiness or strict-compare read; the configs getter's
`isSafeKeySegment` read-path guard (sweep #10) covers the descent;
manager-parsed docs carry no getters/Symbols; so a hostile truthy value
flips debug on (bounded by the disabled-logger cost record) or shows
one welcome hint â nothing crosses into numeric math, object descent,
or a throw surface. **The DOM plane** (discovery.js, detection.js)
delivers platform-computed numbers only: rects under the two
witness-absence belts (`meetsMinSize` fails CLOSED â catch returns
false, no boot; `isOnScreen` fails OPEN â catch defers to the
screening gate's optimism, the recorded census class), ResizeObserver
entry boxes, unsigned-long `videoWidth/videoHeight` with log-only
consumers, and `matches()` over the constant ANCHOR_PROBE list â the
C++ selector engine. No page-authored string/number crosses as data
anywhere in the plane. **The machine surfaces** (MenuCommands click
call sites, the frozen `AdoptionHome` identity, the derived
`GESTURE_EVENTS` handles the menu resets dispatch) carry no foreign
intake. The negative direction closed too: every catch in the four
modules is a recorded lifecycle/witness class (boot-failure
log-then-continue, the entry bridge install belt, the two rect belts,
the URL skip-probe guard, native dispatch isolation) â none guards a
hostile-data sink, so there is no admission-gate gap hiding under a
belt. No adoption and no row: the eviction classes here are
already covered by standing coverage (the gm case's foreign-write
debug-flip mirror and the diagnostics-reach rows), and the shapes are
statically total.

**Ledger batch 5 â the shell plane's top modules (Nov 2026, directed
batch; one adoption â the filter seed clamp; proven on 3 consecutive
all-green runs, ~86â89s each).** The family read at its intakes:
shell.js, media.js, resume.js, filter.js. **The adoption** â the
seed-bypass class (batch 2's) regROWN one grain over: `FilterSession`
carried the same shape `SubtitleSyncState`/`SubtitlePlacementState` had
â commit intakes bounded (the panel Stepper's clamp-at-every-write-path
`roundTo(clamp(parsed, lo, hi))`, consuming the `FILTER_SCHEMA` row's
own min/max) but the STORAGE SEED bypassing the same bound: `#load()`
accepted any finite stored value, so a hostile `pf:configs
filter.brightness = 1e9` applied `brightness(1000000000%)` straight off
the video at boot (paint-bounded damage, but the bound the schema row
already declares was not applied at every intake). The adoption is the
one native `clamp(num, FILTER_SCHEMA[key].min, FILTER_SCHEMA[key].max)`
at the seed â no new machinery, legit storage (steppers write in-range)
byte-unchanged. **Per-file verdicts.** shell.js: the one non-DOM read
is `getSetting(edgeToEdge) !== false` (boolean semantics; the
cssVarSyncer's map-diff write-on-flip guard is the measured substrate
record); the boot/watcher lists and the frozen `AdoptionHome` carry no
foreign intake. media.js: zero storage reads â the entire module rides
the media element and the gesture/API callers (scrub/seek targets are
the batch-3 sinks); the metadata build is the recorded native-total
pair (`document.title` trimmed into `MediaMetadata` â platform data,
no throw surface â and the `URL.parse`-null-guarded poster artwork).
resume.js: the restore chain is bound-complete â the whitelist entry
projection + the `Number.isFinite` stamp gates (29906fb) + the
`subsUrl` string admission (b8e53c9), the tracked `subOffset` read
served unclamped to exactly one render consumer that carries the
batch-2 clamp, and a hostile huge `position` restore value clamps at
the media sink (`#clampTarget`'s duration clamp); `updateSubOffset`'s
write is caller-bounded (the sync grain clamps at commit). The one
intake beyond these is the metadata Witness observers reading
`document.title`/`video.poster` â platform strings at fingerprint-compare
rate, R4/R6-proven total. No roster moves needed: census unchanged.

**Ledger batch 6 â the chrome family (Nov 2026, directed batch; three
adoption sites landed in resume.js â the History render's unadmitted
feed; proven on 3 consecutive all-green runs, ~86.5s each).** The
family read at its intakes. **config.js: total, stays clean** â the
SETTINGS_SCHEMA is all bool/options rows, so `coerceSetting`'s two arms
(`typeof value === "boolean"`, strict `options.includes`) annihilate
every wrong-type stored value including the zoom row's `[0.9, 1, 1.15,
1.3]` (the batch-2-era "no numeric rows" note still holds verbatim:
`panelScale` landed as an options row, not a number row); the cache is
seeded/refreshed/set through that one coercion, so every
`getSetting()` consumer (the gesture toggles' truthiness read, the
`stepSeek` options member Ã the streak clock, `style.zoom` = a
coerced member) trusts it as recorded. The SettingsSection stepper
branch is dead for the current schema â a future number row must add
its coerce arm in the same commit as the row (the schema's own
docstring demands the single edit; recorded so the passthrough
fallthrough is never taken as a number admission). **panel.js: total**
â every text surface is `textContent`/`replaceChildren` (no markup
vocab anywhere; `formatTime`'s `!(seconds > 0)` gate is a total numeric
intake â NaN/strings/negatives all read "0:00" â and a 1e308 duration
truncates through the bitwise ops in place); the zoom read is coerced;
the `#rollbackTo`/build-rollback belt is the recorded release-tail
class; the CloseWatcher lattice is armed-state-rechecked inside its own
listeners. **ui.js / toast.js / inject.js: no foreign intake beyond
their recorded surfaces** â the DOMParser-not-innerHTML belt and the
document-keyed icon cache, the pooled toast payload refills,
`ensureViewportFitCover`'s beltless totality (regex test + literal
replacement + `setAttribute` â the C2 census's zero-dynamic-replacement
record is exactly why no hostile meta content can throw any of the
three ops), and the monotonic `@resource` upgrade with its bad-
`replaceSync` keep. **The one real gap â adopted (3 sites,
resume.js).** The History card's render is the family's downstream
consumer of the resume doc, and the store's two foreign arrival seams
(`toFixedShape` for a fresh adoption, the LWW update walk for a known
entry â inside the one `#mergeRaw`) admitted `domain`/`title` as-is:
a hostile `pf:resume` doc with `domain: 5` rode straight into
`formatDomain`'s `.charAt(0)` â a TypeError inside the panel render
(the Fan isolation contains it, but the history row is broken and an
uncaught error sentence is on the page surface). The adoption is the
`subsUrl` admission shape (b8e53c9: refuse outright, never
String()-coerce into "[object Object]" garbage) applied at BOTH seams â
string-field admission for `domain`/`title` â plus the R3-class stamp
gate extended to the LWW branch: the copy loop ran BEFORE any
reshaping, so a hostile non-finite `updatedAt` won the compare and
rode into the known entry, the immortal shape the R3 floor probe
measured; `stampOf` (awaiting the projection's epoch-0 degradation)
now anchors the second seam too, and the comment records the honest
posture â a finite beyond-horizon stamp stays the R3 posture, not
re-decided. Our own writers are untouched: `createEntry` routes through
`toFixedShape`, and the bridge context is type-gated upstream
(`mapContextPayload`). Census unchanged.

**Ledger batch 7 â the shared planes (Nov 2026, directed batch;
record-only, audit-clean, no rows, no src; one green battery run
(~86.6s) as the receipt).** The last family without a dedicated law
pass, read at its intakes. **core.js: no intake** â the zero-import
leaf is pure functions: `clamp` (the batch-2/5 admissions' own op),
TUNING constants (own tables), `formatTime` (`!(seconds > 0)` is its
total numeric intake â the batch-6 record), the two-name media-error
classification. **runtime.js: no intake** â scheduling/scope/Fan
control planes take no external data; the timer/deadline classes ride
named constants and the batch-3-recorded engine commitment (N2's
computed-delay totality note stands for any future caller).
**dom.js: DOM-shaped observations only** â the shared mutation feed
delivers platform records to its recorded four subscribers, DomPool
recycles feature-owned elements, ReferenceBox's one read is
platform-computed geometry, FsGate reads only the fullscreen API â
nothing the host page can author as a VALUE crosses (the C2b fragment
record and the E-axis filter-locality premise already pin the feed's
shape). **page.js: the context plane â measured and gate-carved.**
`getDomainKey` reads the platform hostname; the bridge context carries
its three field admissions (`looksLikeContextResponse`'s domain gate +
`mapContextPayload`'s path/title in-map strings, slice-capped 2048/512
â the R5 adoption); `ownPageContext` reads platform strings; hostile
window `postMessage` spoofing the bridge vocabulary is structurally
narrowed â every route source-checks (`window.parent` for ready/relay,
`iframeRegistry.child(event.source)` for context requests plus the
string-typed nonce, origin/`isOwnFrame` for the tie-break arm), and
the context REQUESTER narrows more than that: it listens on its own
dedicated MessageChannel port, a channel the page cannot hold, so the
answer surface is channel-structural; `hashEntry`/`stripNonAscii`/
Levenshtein ride the truncated/band-bounded shapes the audits
measured (the length-diff early exit + rowMin band prune + the
`domainsMatch` ordering gate mean hostile-scale operands exit before
the DP runs; only our own capped path/title strings ever hash).
**store.js: the sweep-#10 record re-derived live** â `loadJsonObject`
is the truthiness-object read (arrays pass `typeof "object"`, and each
consumer gates: `isValidStore`'s `Array.isArray` refuses an array
resume root, the configs walkers make array segments inert, and
JSON-parsed docs cannot carry prototype-traversal getters â the
`isSafeKeySegment` guards hold both read and write descents);
`gmSetValue` passthrough serves only tree-shaped values; the echo/
`randomNonce`/grant-guard rows are the recorded surfaces. No adoption:
every shared-plane intake either rides a landed gate or is native-total
in the recorded shape.

**Law-ledger close-out (Nov 2026, user direction "close ledger";
closes at family depth â every src module family has carried its
dedicated pass).** Seven batches, the tally: **batch 1** the whole-tree
audit-clean certification + the census's `RegExp.escape build sites`
row; **batch 2** the subtitles family â two seed-clamp adoptions
(`SubtitleSyncState`'s field seed + `#resolve()`, `readPlacement()`)
plus the CSS hostile-value IACVT/no-fetch receipt as a battery row and
the node-verified astral truncation note; **batch 3** the inputs
family â the event-stream IDL conversion pinned as the engine's native
admission gate (gestures row: the four rejectable init members + the
unrestricted `movementX` witness) with the intake map audit-clean;
**batch 4** the kernel/discovery plane â the intake map exhaustively
total (storage truthiness/strict-compare sinks, platform-shaped DOM
numbers, machine surfaces) and every catch reconciled as a non-data
belt; **batch 5** the shell plane's top modules â the filter seed
clamp (the seed-bypass class's third catch) with resume/media
bound-complete; **batch 6** the chrome family â config/panel/ui/toast/
inject total, three `pf:resume`-doc admission sites adopted (string
fields at both `#mergeRaw` arrival seams + the LWW stamp gate); and
**batch 7** the shared planes â core/runtime intake-free, dom
platform-only, page gate-carved (the channel-structural requester
narrowing recorded), store per sweep #10. Net adoption ledger:
**six src adoption sites over five landing classes** (the seed clamp
Ã3 catches, the string-field admission Ã2 seams, the merge-stamp gate
Ã1 seam, the trust-gated `randomNonce` totalization, the three earlier
robustness-wave gates) â all one-native-op, no machinery, legit flows
byte-unchanged. **Protocol going forward:** per batch 1's shape,
future src work appends as per-commit delta classification at its law
surface instead of tree walks â and anything on this tree violates
the bar only if a live intake grows, so *every new external-data
intake must land with its admission gate in the same commit, and its
_consumer-side sink_ naming why manual reads are total.* **Reopen
rule mirrors the redesign-verdict ledger:** reopening (a new audit
series, a batch against the whole tree again, or re-litigating a
recorded decline) needs explicit user direction AND fresh code-level
evidence; recorded declines stand.

**The Firefox 160 release floor probe (Nov 10 2026, release-day batch;
user direction "read the 160 release notes and explore a batch";
post-`e8f3570`, record-only + one docstring correction; audit-clean).**
The fleet engine moved: the machine's Firefox is 160.0, so the battery
gate itself now runs the shipped bundle on 160. Artifacts:
`check/.tmp/firefox160-floor-probe.mjs` (10 axes â G0 grain, OP
operator ledger, CSS template check, TYPESETS types-slice shape, LIFE
Page-Lifecycle vocabulary, MQ fullscreen media queries, IDL admission
gates, ENGINE substrate facts, NEW160 platform deltas, OPRAW/DRIFT/
MOVEMENT raw-witness axes for the suspect readings) and `firefox160-
floor-report.json`, uncommitted per sweep convention. The 160 delta
review first: SpeechRecognition (on-device, desktop) shipped â
presence/shape recorded (`SpeechRecognition` + `webkitSpeechRecognition`
both functions, constructor works with defaults `lang: ""`,
`continuous/interimResults: false`, start/stop + the four event
props), no tree scope direction carries it; the
`::-webkit-input-placeholder` alias works (its computed
`::placeholder` color reads the alias row) â the HUD sheet spells
`::placeholder` nowhere, zero vocabulary surface; the
`MozScrolledAreaChanged` removal â zero matches in src (grep); the
experimental surfaces (`<video loading="lazy">`, render-blocking,
Typed-OM arithmetic) are off by default and out of floor scope.
Premise re-witness, one per axis: **G0** both clocks quantize to
exactly 1ms (unchanged); **OP** the R7 operator-floor ledger is fully
present on 160 (RegExp.escape/URL.parse+canParse/Promise.withResolvers
+try/Set algebra/iterator helpers/array copy verbs/findLast/hasOwn/
both groupBys/iso methods/structuredClone/randomUUID/checkVisibility/
postTask+yield/vv) â RegExp.escape's escape phase now witnessed by raw
value (`"a+b.c"` â `"\x61\\+b\\.c"`, the spec's `\x61` leading-
alphanumeric prefix; the adoption sites compare nothing by hand, so
nothing there is touched); hostile groupBy keys still land on a null
prototype (R2 holds). **CSS** the closed redesign ledger's NOT-SHIPPED set is
still NOT SHIPPED on 160 (`corner-shape`, `interpolate-size`,
`text-wrap-style: pretty` all false â the reopen trigger did not
fire), and every adopted/shipped surface stands (balance, trim+edge,
zoom, view transitions, allow-discrete, scrollbar pair, snap pair,
content-visibility, contain, scroll-timeline, anchor trio, color-mix +
relative color, `:has()`, calc infix). **TYPESETS** the panel-motion
premise holds byte-true: `{ types: [...] }` drives `vt.types` as a live
`ViewTransitionTypeSet` (Set-like, not an Array, size 2, constructor
name read). **LIFE** the Page-Lifecycle retirement premise holds:
`freeze`/`resume` exposed nowhere in the page realm, `wasDiscarded`
undefined. **MQ** the FsGate premises hold: `(fullscreen)` and
`(display-mode: fullscreen)` both false, `(pointer: fine)` true. **IDL**
the batch-3 admission gates hold (clientX NaN/Infinity + clientY NaN +
deltaY NaN all TypeError, finite control ACCEPTED) â with the batch's
one genuine 160 delta: **`movementX: NaN` init no longer rides NaN â
it delivers 0** (finite init honored verbatim: 7/â2; default 0), the
measure-false sentence corrected in the gestures case comment (both
floors' readings recorded in that comment; the intake's inertness is
by NON-CONSUMPTION, not NaN passage â zero src consumption either
way). **ENGINE**: apply-args boundary still exactly 500,000 (fast path
green at 65536 = 13% margin unchanged); `moveBefore` cross-parent
still FLIPPED (no structural change toward the TypeError the prose was
warned not to harden); postTask delay-100 drift median 0ms max 1ms
(F holds); one MO callback across 5000 per-turn appends (E holds);
listener-throw containment in raw EventTarget delivery (D holds);
200-user-visible-before-background burst consistent (the precise
priority-choreography row remains the F-batch record). **Receipt:**
the battery's own three documented runs on 160 are the behavioral
floor proof â before any record landed, the 2.0.0 bundle shipped and
the FULL battery proved itself on the new engine (239 rows, ~86â89s),
then two more after the docstring correction (3 consecutive all-green:
88.6/86.3/86.6s). Probe lessons: the serialized-body law is enforced
at the page-realm stringifier (the first draft rode a node-side `body`
closure and every axis answered "body is not defined" â each axis body
is now fully self-contained); a CSS.supports declaration must carry a
property (color-mix read false until `color:` was prefixed); the
`RegExp.escape` verifier string ignored the `\x61` phase (verify by
raw value, not a recomputed literal); the drift axis's first shape
measured its own `setTimeout` cadence, not postTask (read inside the
task). Historical sweep records stay as date-stamped truth as
measured on 159; the gate's own floor moves with the fleet engine it
launches.

**The C++ budget small-run on Firefox 160 (Nov 10 2026, release day;
user direction "open the C++ budget small-run"; post-`4952c7c`,
record-only, no src change, audit-guard resolved).** The recorded
budget rows were all priced on 159 â the census-premise axes (C1
clock prices, C3 belt unit, C4 table units), the delegation declines
(D1 packed sort, D2 alternation, D3 Intl, D4 structuredClone), and the
wave-2 re-prices (T1 callback tax, T2 scanner twin). This small-run
re-priced each on the new fleet engine and re-asserted the parity
behind the two LIVE adoption sites (`sortCues`' packed-key sort,
`isAdHost`'s alternation) â an adoption's semantics must hold on the
engine that now ships it. Artifact: `check/.tmp/
cpp-budget-160-smallrun.mjs` + its report JSON, uncommitted per sweep
convention. The draft round consumed six probe-bug classes before any
recording â each now a harness lesson worth holding: (a) the
serialized-body law again (the first draft rode module helpers and
would have died "body is not defined"); (b) a `r & mask` indexing
off-by-one (4095 mask over a 4000-row corpus reads `undefined` â use
`r % rows.length`); (c) a "miss" arm that inherits the thrower's
condition (`thrower(i + 1)` goes even half the time â hitâmiss
hero-shape readings must assert the miss arm NEVER throws, e.g. odd
arguments only); (d) fresh `new RangeError` per throw is object+stack
construction (~290ns), not belt cost â preallocate the throw value;
(e) a parity comparator that checked the wrong record index
(`[0]` vs `[7]`) reported `parity: false` against correct engines â
line-check the comparator against the asserted rows; (f) sub-grain
raws (D2 re-arm 11ms, D1 packed 6ms, T2 8/15ms drafts) and a 50/50
junk-mixed corpus (dilutes the priced unit) fail the sizing/corpus
rules â bump passes to â¥20ms per arm and time the unit the budget
names; plus arm-order cold-pass bias (report the pass-2 pair, both
arms warm). Final values, one per axis:

- **(G0quick) grain unchanged**: `performance.now()` steps 1ms on 160
  (both clocks, re-derived live).
- **(C1) the deadline class's clock holds**: `Date.now()` 39ns,
  `performance.now()` 374â381ns (159: ~36/~425) â the zero-timer
  deadline class still rides the 10Ã-cheaper clock, unchanged in shape.
- **(C3) the belt unit holds**: preallocated-value throw-into-catch
  60â73ns/cycle; miss path ~1ns (159: ~52/~1.9) â the miss is even
  engine-freer on 160 and hits stay the rare-edge class; the ratio
  widened (recorded 28Ã, now ~60Ã).
- **(C4) table units**: `new Set(11 words)` 73â81ns (159: ~54, 1.4Ã);
  4-key hasOwn walk 16ns (159: ~20, holds); `Map.groupBy` over 10k
  rows/50 buckets 325â353Âµs (159: ~83Âµs â ~4Ã the 159 row). Linear
  scaling puts the store's real bound (the RESUME_MERGE at â¤2000
  entries) at â¤ ~70Âµs/merge, and the robust row (400 remote-adoption
  merges < 800ms) then carries ~30Ã headroom â the boot/interaction-
  rate classification is unchanged.
- **(D1) the packed-key adoption HOLDS and got cheaper**: parity 0
  mismatches, tie-stability true (50ms-wide bands exercised);
  packed 1ns/rec (150Ã190k = 26ms raw) vs comparator 24ns (23ms raw)
  â 25Ã (159: 4Ã at 8.4 vs 34). `sortCues` stands on the new engine.
- **(D2) the alternation adoption HOLDS and got cheaper**: zero
  disagreements over the hostile corpus incl. all trap anchors
  (trailing-suffix, apex, `adoubleclick.net`, sub-suffix); alternation
  10â11ns vs loop 51ns â 4.6Ã (159: 3.6Ã at 24.5 vs 90.5).
  `isAdHost` stands on the new engine.
- **(D3) the Intl decline holds**: concat 27â29ns vs
  DateTimeFormat 248â253ns (9Ã; 159: 23Ã) and DurationFormat
  633â706ns still shaping "1 hr, 23 min, 47 sec", not h:mm:ss.
  Declined on both price and shape, as recorded.
- **(D4) the structuredClone decline holds**: spread 29â35ns / JSON
  148â165ns / clone 628â695ns per flat record (159: 19/281/594) â
  clone still ~20Ã the spread (159: 31Ã), JSON ~5Ã (159: 15Ã); the
  gap narrowed but adoption stays far behind the walkers. Parity
  green after the comparator fix ended the draft's false negative.
- **(T1) the callback-tax premise holds**: numeric all-miss 20M Ã8
  passes â manual 0.45ns/elem (73ms raw), the same predicate through
  a closure ~1.8ns, the verb ~0.4ns; parity miss + one-match control
  both true. Tax â¤ ~1.4ns on the JIT's best case on 160 â the manual
  walks still win on shape, not cost.
- **(T2) the scanner-twin decline HOLDS on rate, but the A/B's
  DIRECTION FLIPPED on this replica** â the one divergence recorded,
  flagged for any future re-open. The manual arm replicates the
  shipped `timecodeToSeconds` + `parseTimingLine` verbatim
  (slices/trimEnd/closure fielders included); 0 parity mismatches
  over timing and junk corpora; both-warm pass-2 numbers: manual
  188â204ns per TIMING line vs the 8-capture regex twin 132â136ns,
  stable across runs and arm order â the twin is the FASTER unit on
  160's replica, while the recorded 159 decline had the manual arm
  ahead (13.2 vs 27.2). Reconciliation is not possible: the wave-2
  probe files were consumed (uncommitted convention) and its per-line
  metric can't be re-derived â these numbers stand as measured, with
  the corpus-metric difference unresolved. The mixed reality (real
  tracks interleave ~50% text lines: 10ns manual / 30ns twin per
  junk line) narrows the twin's lead to ~19ns/line averaged, and the
  absolute saving is ~0.4â1.1ms against the ~11ms/1.1MB whole-parse
  ingest tripwire â single-digit-percent on the recorded rate axis.
  **The decline stands** (the walk-into-adoption threshold the series
  used was a measured win on the tree's real axes, not a direction
  flip at sub-decision scale), and the flip is now measured evidence
  on file for the reopen rule if the user directs a real adoption
  probe against the hotpaths tripwire.

Sweep disposition: record-only, no src change earned adoption â both
live adoptions hold with widened margins (D1 25Ã, D2 4.6Ã), every
decline's rate classification survives (C4's 4Ã groupBy bounded by
store-scale math; D3/D4 ratios narrowed but unchanged in direction;
T2's twin saving still single-digit-percent of the ingest tripwire),
and the two budget classes the probes priced (the cheap epoch clock,
the belt cost model) hold within shape on 160. Battery receipt: src
untouched; the batch rides one green full-battery run per the
record-only rule.

**The T2 reopen adoption (Nov 11 2026, user-directed reopen of the
small-run's flagged divergence; adoption landed).** The probe the
flagged row asked for: the real engine, both arms pinned to HEAD source
(ship = the pre-adoption charCode scanner verbatim, twin = that source
with `parseTimingLine` swapped for one single-exec regex twin), real
corpora plus the exact hotpaths tripwire corpus mirrored line-for-line
(`check/.tmp/t2-reopen.mjs` + report, uncommitted per sweep convention).
**Parity is exact on every collection**: cue-output JSON equality on
all four corpora + the 0.25-offset rebuild, and a hostile column
covering the manual scanner's every grammar asymmetry (the start-side
gap general `\s` vs the end-side `[ \t]`-only; the end fraction's
3-digit cap whose overflow becomes settings text â reproduced by the
twin's greedy `\d{1,3}` + free-tail backtracking; `000-->` traps,
NBSP/CRLF/FEFF shapes, leading junk, multi-arrow lines). **Measured
savings per parse, five alternating collections, bulk 40-parse
readings at ~0.2% resolution**: the tripwire shape itself
(19,349 cues / 1.07MB) **8.2ms manual â 7.2ms twin (12-15%)**, real SRT
(19k cues, two long text lines) 9.6-10.7%, prose-heavy 7.0-8.5%,
VTT-with-settings-tails 9.8-11.3%. The wave-2 direction flip was real,
not replica luck â but the honest instrument lesson surfaced first:
per-parse quantized readings at the 1ms page clock could not resolve
the 0.3-1.5ms delta (spread 0-14% across runs); bulk totals firmed it.
The wave-2 harness lesson also transferred: its "averaged ~19ns/line"
steer predicted ~1.8ms on the mixed corpus; measured ~1.0-1.2ms â same
ballpark. **Adopted in src** (`forgevtt.js`): `parseTimingLine` is the
single-exec twin with the `indexOf` pre-guard kept as the intake
admission gate (no regex runs on an arrow-less line â the same guard
the manual scanner opened with); `timecodeToSeconds`, `isDigitCode`,
and the code-point const table died with the verdict (â~90 lines, the
bundle â1KB). The 4-assembler `RegExp.escape` census row is untouched â
the twin is a module-constant literal, not a table-derived build.
Historical records above stay date-stamped truth as measured on their
floors. Battery receipt: 3 consecutive all-green full-battery runs
(86.8/86.5/86.5s, 239 rows).

**The detection native-walk batch (Nov 11 2026, user direction "make the
SDK registration more native and dynamic"; src â detection.js + check rows;
scope chosen: mechanism + new records).** The kernel AâZ audit had priced
the engine's probe shape (`ANCHOR_PROBE` joined list, one `matches()` per
hop); this batch moved the walk itself into the engine and grew the
registry on vendor receipts. **Mechanism (2 arms, one law).** The primary
arm is `closest(ANCHOR_PROBE)` â ONE C++ fewest-hops call answering the
nearest matching ancestor-or-self, covering light DOM AND shadow-internal
trees; the answer is the fewest-hops answer by construction (any
boundary-crossing match is strictly more hops), and the hop count
re-derives by the native parent walk over an in-tree ancestor-or-self (the
walk cannot overrun). The composed `parentNode`/`.host` walk stays as the
shadow-boundary arm for exactly the shapes `closest()` cannot answer â an
anchor above the video's shadow host, and detached videos â hop-ascending,
one `matches()` per hop, the fewest-hops law intact. Identity at the
matched element comes from `RECORD_PROBES` (each record's anchors joined
into one list; one C++ `matches()` call per record answering "any of this
record's anchors match"), registry order remaining the tie law, anchor
order internal to the join; the drift-guard null stands in both arms. The
join constraint is now written where the probes derive: an anchor must
carry no top-level comma (a separator spelled into an anchor would
silently become two arms under the record's name; a comma inside a quoted
attribute value is one selector to the engine and fine). **Two new
records, vendor-verified.** Shaka Player (`[data-shaka-player-container]`
leading `.shaka-video-container` â the Overlay constructor stamps the
dataset on EVERY programmatic use, ui/ui.js; the auto-setup div carries
the class, ui/less/containers.less) and OpenPlayerJS (`.op-player` â the
wrapper `createUI` injects on both the audio and video paths,
packages/player/src/ui.ts; the media's own `.op-player__media` stays off
the list, the 0-hop law). **THEOplayer verified and DECLINED**: v5
through v11 (the OptiView-era latest) all document the container as
`<div class="video-js theoplayer-skin">` (npm README + ui.css, both
releases read) â THEOplayer is Video.js-based at every release, the
existing Video.js record already covers the topology, and a
`.theoplayer-skin` record would be dead on real pages (the video.js
wrapper resolves nearer). **Check rows.** The sdk case gains the two stub
builders plus a shadow-boundary row: a video inside a custom element's
shadow tree under a `.jwplayer` div resolves Vidstack at the in-tree host
(hop 1), not JW at the boundary-crossing hop 2 â the composed arm
provable, and the fewest-hops law riding across arms. The hotpaths
adoption-identity budgets re-pinned to the new engine: **~1Âµs per
first-resolve** (1000/1000 in 1.0ms; was ~2Âµs under the hand composed
walk, ~5Âµs under the per-anchor loop) and **~60ns/hit** steady state
(6.0ms/100k). Battery receipt: consecutive all-green full-battery runs
with all 17 registry rows, no-fallback, Clappr, Laravel, and the
shadow-boundary row green.

**The registry-coverage batch 2 (Nov 11 2026, user direction "explore
next batch" â "adopt all 3"; src â detection.js + sdk case).** The
registry-verification method from the detection native-walk batch was
run over the next candidate ring: six majors not yet in the registry,
each verified from vendor source. **Three records added.** Bitmovin
Player (`.bmpui-ui-uicontainer` â `UIManager.ts` appends the UI
container into `player.getContainer()` beside the video, the sibling
relationship proven by the vendor's own display:none comment, the class
shipping 95Ã in the built CSS), Kaltura PlayKit (`.playkit-container` â
`_createPlayerContainer` stamps it, the README's
`playerContainer.appendChild(player.getView())` is the mount contract,
and the video's `.playkit-engine` stays off under the 0-hop law), and
NPlayer (`.nplayer` â `player.ts` line 75, the video appended directly
into the player el). **Three declines recorded.** dash.js (no container
vocabulary; `[data-dashjs-player]` rides the video itself â the 0-hop
law â and `_dashjs_player` is a JS expando), hls.js (zero DOM
vocabulary over the full dist), and Pillarbox (Video.js-based, covered
by the Video.js record â the THEOplayer verdict shape). Registry is
now 20 records; the sdk case carries a stub builder for each. Battery
receipt: consecutive all-green full-battery runs with the three new
stub rows green.

## 5. Conventions (the change bar)

1. **Native-first implementation bar.** Every new or rewritten behavior asks
   one question first: is there a Firefox C++ engine operation or platform
   API that owns it natively? When there is, the implementation IS that call
   â no JS hand-off machinery may grow around it, and a manual engine that
   duplicates it is a defect, not a style (the operator-floor records name
   the vocabulary: `RegExp.escape`, `URL.parse`/`canParse`,
   `Map.groupBy`/`Object.groupBy`/`structuredClone`, the abort-composition
   family, `replaceChildren`, the C++ selector/cParsing engines the probes
   priced; the substrate series is the receipts). Only where no direct
   native approach has been named may a manual engine be built â and THAT
   build must then be uBO-graded: every intake where hostile or over-large
   data can arrive carries ONE total admission gate (a typeof/length/shape
   read, itself a native op), so unbounded work, boot-reaching throws, and
   whole-value downstream consumers are unreachable from the outside. A
   manual engine is warranted native-side only through the audit series
   (saturation, C++-ops, callback tax, loop-body walk); the recorded declines
   stand until reopened with evidence, so the law cannot silently regress
   into hand-rolled work.
2. **Comments explain WHY with reasoning** â the rejected alternatives and
   the measured/probed finding. No restating code, no TODOs, no status
   adjectives.
3. **One owner per behavior.** A duplicate is either absorbed or, if both
   are real users, promoted into the shared plane. There is one registry,
   one response gate, one close path, one timer backend, one mutation feed,
   one storage watch contract.
4. **Everything machine-facing is derived from a source table** (Â§3 lists
   them). Adding an SDK = one record + check rows (the registry-coverage case
   demands a stub builder for every record, so the fixture promise is
   machine-enforced). Adding a gesture = one
   table row; the schema, bindings, and events derive.
5. **Stateful ownership = private classes.** If state is mutated in more
   than one public flow, it belongs to one object with `#`-fields, not to
   module-level lets. Given a choice between a stateful factory (closure
   machine) and a class, choose the class; keep the factory as a plain
   enclosing function only when one thin wrapper name must not change.
6. **Signal-scoped teardown.** Every listener accepts `{ signal: scope }`;
   teardown paths call `scope.dispose()` and nothing else; the single
   abort-fire tears everything down. Never build removal-list pairs. The
   deliberate-machines census holds this byte-true: every hand-rolled
   release/teardown machine now rides native abort compositions (an internal
   release controller per machine â `postTask`'s owner bridge (task signal +
   release), `DomSettleWait`, `DomWatch` (its subscribe release and its defer
   machine), the pinch wheel, Fan's own subscribe handle, the page.js pipe
   family (per-request settle signals, per-pipe entries, the bridge install
   mount), the panel's per-open dismissal scope, the layout-gate reveal and
   media-tap scopes, the entry hint's composite source, and the per-scope
   roots â
   its `{ once: true }`+`{ signal: release.signal }` composition detaches the
   owner listener natively on whichever path ends first), and the census of
   `removeEventListener` across src comes back empty: zero live manual
   removals remain, Fan's handle included â its handle now tears down by
   abort like every other machine's. The steady-state listener & observer
   census (sweep): 124 static registration sites (the count survives the
   shell-mount adoption byte-identical at the site level â the shell host
   module's one
   container childList observe swapped for the PfShellHost detached-window
   armed observe, a transient that never arms in steady state, so the
   steady-state observer count is one LOWER while the raw site count holds);
   the cue-canvas RO joined at 125 with the bar-flip batch (the forge
   bar's :has() flip needed a paused-gap render trigger), 28 at document/window
   level, zero manual removals â and every unscoped-looking site verified
   either `{ signal }` on a continuation line, an options-var binding,
   the panel's per-open dismissal scope, or a deliberate page-lifetime
   plane â three exist, all load-bearing: the bridge's ONE window `message`
   listener (`installContextBridge`; its returned teardown is consumed
   nowhere, the same page-lifetime arrangement as the kernel's shell-ready
   handle â sibling routes are isolated inside the single handler, and the
   two other page.js `message` listeners ride per-request settle signals),
   the FsGate singleton's three listeners (document `fullscreenchange` +
   the pagehide/pageshow pair on the document's *view* â those lifecycle
   events fire at the Window and never traverse the tree â with the `#doc`
   latch making a double script eval re-seed without stacking), and
   DomWatch's one page-level MutationObserver (the shared mutation feed IS
   the page plane). Everything else is scope-settled or element-owned â
   listeners on nodes the feature DOM discards ride natural GC teardown; a
   signal there would be ceremony, not scope. Per-state live table:
   pre-boot = bridge 1 + DomWatch MO + 1 visibilitychange + discovery's 5
   document media taps (the bare-tier playing/timeupdate pair joined the
   loadedmetadata/loadeddata/play trio on the one controller) + the
   kernel's pageshow/pagehide pair (the resume
   arm retired - freeze/resume unreachable on the Firefox floor) +
   the entry hint trio (armed only in the first-run hint window) + the 5
   `watchStorageKey` consumers (the GM echo channel, not DOM events; the
   fifth is the entry's bare-tier echo watch - sibling realms re-arming
   discovery under the flipped tier posture);
   live shell = resume's 6-event drive cluster + its IO + media's
   loadedmetadata listener + 2 witness MOs + subtitles' rVFC crank (an
   arm, not a listener) with its video RO/IO + the cue-canvas RO (the
   bar flip's paused re-anchor) + 4 video events + 2 host
   gesture relays + ReferenceBox's RO/orientation/scroll + forge's
   machine-owned streams + the forge bar's plane (3 window-capture
   activity witnesses + 6 video events + the click router + the 4 WCAG
   pointer/focus holds + the range input handler, all scope-settled, plus
   its fs-gate subscribe) + the shell's document-level wires; panel open
   adds exactly the dismissal trio + the CloseWatcher close listener on a
   per-open scope; scrubbing adds zero listeners (the rAF commit chain is
   one callback swap, not a socket).
7. **Imports:** one per realm-form, combined; `shared` below package imports;
   module files import only downward across planes (kernel â contract,
   shell â shared/kernel-contract), never sideways into a sibling's consumer
   (the import graph is enforced by the flaws gate's isolated import
   smoke).
8. **No comments in check/ code beyond the why-docstrings it already
   carries; `installGMRealm` must stay a single self-contained function**
   (it ships as an executeScript payload â no closure references).
9. **ES target floor: Firefox 159.** `?.` chains, top-level field syntax,
   `data-transfer` file APIs, View Transitions, CloseWatcher â all in scope;
   nothing below the floor, no polyfill arms.
10. **Version is derived** (esbuild reads package.json). Header updates are
   interventions, not edits.

## 6. HUD design law (binds any visual change)

Still in force from the design process â rewritten ink-style by user direction
(the glass era's audit, budget, and contrast machinery are history below);
`src/shell/chrome/styles.css` is the only surface, scales/tokens
`@property`-typed, gradients banned in the HUD:

- **R1 Ink budget: zero `backdrop-filter` surfaces, anywhere.** Every sheet â
  panel, toast, and every in-panel control â paints opaque ink or a flat
  surfacing on top of it; the compositor never blurs video under HUD geometry
  (the glass era paid a per-frame `blur(16/24px) saturate(1.7/1.8)` on its two
  sheets plus a masked band; that cost is why ink won the resource audit). A
  `backdrop-filter` returning is a redesign decision with its own justification.
- **R3 One resting ink (`--pf-sheet: #0e0e10`), unchanged by focus** â opaque,
  content-independent; text legibility is a fixed material property (white on
  the ink â 18.9:1, the 64% secondary â 9.9:1 â both past WCAG AAA at 7:1 over
  any video). The `ui.glassTint` setting (Clear/Medium/Opaque alphas on
  `--pf-tint-alpha`, GLASS_TINTS) is *retired*: translucency was the only thing
  it could parameterize, and the glass era's two-state focus split was already
  retired before it. Stale stored `ui.glassTint` keys stay harmlessly unread
  (the schema coerce ignores unknown keys).
- **R4 Every scrollable sheet keeps its scroll edge** â the pinned panel
  header rides the one sanctioned gradient: solid ink at the rail fading down
  a 24px tail, engaged by the scroll timeline at `--pf-scroll-edge` only while
  content actually passes under it (0% at rest â the band paints nothing).
  No blur, no mask: with the sheet opaque the gradient alone carries the fade,
  and the weaker-era "one notch darker" derivation died with the transparency
  it arbitrated.
- **R5 Nested radii are concentric and derived:** container radius R with
  inset padding P â inset elements use R â P (panel 16 â strip/close 8 â
  tab 5). Derived, not chosen, so container changes stay correct.
- **R6 The panel (sheet) has the largest radius in the HUD's derived
  sheet-radius chain (16px, lg > md > sm > xs); the pill element class
  (toast, forge bar) rides `--pf-radius-pill` above that chain â a pill
  container's own inset hover targets stay pills (the R5 derivation
  degenerates at 999px, so the pill carries through).**
- **R7 Section headers are title case** (no uppercase transform).
- **R9 Every HUD change needs a measured contrast assertion**, not a
  screenshot. The opaque ink makes the assertion content-independent (spectral
  ratios above); geometry (resting radii, control positions) may not move as a
  side effect of appearance work.
- The current set is **opaque ink + hairline border, nothing else**
  (separation from video is the `--pf-sheet-border` hairline alone â the rim
  era and the soft drop shadow died by direction, the shadow's glass-era
  48px ancestry with them), **zero linear-gradients with one sanctioned
  exception**: the R4 scroll-edge band is the single solid-to-faded
  linear-gradient â the only gradient permitted in the HUD. **No inset white
  highlights anywhere** â the rim era (`--pf-header-rim`, `--pf-sheet-inner`'s
  rim insets) retired by direction. Zero blur layers, zero shadow layers.

The HUD token sweep (census) re-derived the token plane from both sheets
(styles.css + inject.js's compact band), comment-stripped: **zero orphaned
tokens** â every declared `--pf-*` has a reader, with one census-relevant
shape: `--pf-compact` is read through a **container style query**
(`@container pf-compact-bus style(--pf-compact: 1)`) rather than `var()`,
so a var()-only counter would misreport it dead. Six tokens read without a
sheet declaration, all legitimate: the five `@property`-registered ones
(`--pf-cue-top/left/x`, `--pf-media-paused` â registration provides the
initial value, e.g. the paused-opacity dampener is correct before any JS
write arms) and the vv pair (`--pf-vv-height`/`--pf-vv-inset-bottom`),
whose only writer is the coarse-pointer-gated vv mirror (shell.js) whose
readers exist only inside the `(pointer: coarse)` bottom-sheet block, with
the var() fallbacks being exactly the spec-spelled `100vh`/`0px` neutrals
the pinch-guard defers to. Ink law re-census: exactly one `linear-gradient`
in the sheet (the R4 scroll-edge band), zero `backdrop-filter`/`box-shadow`
(the two other grep hits are R1's own tombstone comments). The z doctrine
tokens hold their declared order (`--pf-z-hud` 2 < `--pf-z-toast` 3 <
`--pf-z-panel` 4) and the R5 radii chain its derived values (pill 999,
lg 16 â md 12 â sm 8 â xs 5).

## 7. check/ â the testing tool

`check/run.mjs` is the repo's one testing interface. Gates run in order and
stop at the first failure:

1. **syntax** â parse-only V8 check of every src module (parallel children).
2. **flaws** â repo eslint + isolated module-import smoke per module.
3. **census** â the executable census: the recorded AGENTS.md counts
   (ten Fans, eleven Scope roots, the zero-timer pipeline, zero manual
   teardowns, the empty-catch belt, the wall-clock reads, the network
   egress floor) re-derived statically as literal occurrence counts over **comment-stripped** source â
   prose that names a pattern (`runtime.js` mentions `catch {}` in a
   docstring, `kernel.js` names `removeEventListener` in a comment) must not
   count, so a naive grep would misreport the record. Each row carries its
   why-docstring: a red row is answered by updating the gate's expect **and**
   the AGENTS.md census in the same commit, with the change's why â never by
   bumping the number alone. The error-path AâZ sweep classified every
   throw/catch under comment-stripped src (6 throws, 34 catches) into
   eight named classes, each with its why: **throw-through** (media's
   play/PiP rethrow non-benign after the AbortError/NotAllowedError
   filter â callers own a failure surface), **release-tail bare
   catches** (panel-section destroy loop, MediaSession destroy belt,
   forge's two pointer-lift races â teardown must complete, not report),
   the **Scope isolation site** (`#runDisposer`: catch-log-never-rethrow,
   the only machine given that verb), **witness-absence fallbacks**
   (shouldSkipUrl's belt-owns-the-contract, discovery's rect
   try/returns, page.js's cross-origin contentDocument subtree-end),
   **port-lifecycle races** (the bridge's five postMessage/port sites â
   re-establish the pipe, not an error path), **log-then-continue
   persistence** (resume/store persist, inject's monotonic resource
   upgrade, panel's build rollback+toast, subtitles' three-stage #fail
   toasts, entry's bridge-install isolation with the probe still
   running), **feature-degrade** (CloseWatcher null with the keydown
   path still dismissing, DOMParser belt, session-metadata skip until
   the next key change), and **fan-out isolation** (dom-watch's
   per-subscriber belt; the bridge dispatch's `reportError` rehome â
   the platform's own out-of-band report verb keeps deliberate error
   sentences on the page error surface the audit ledger reads, while
   sibling routes inside the dispatch stay isolated). Tool-facing
   metric this feeds: the browser cases fail on any page error, so a
   rethrow or reportError sentence must always be deliberate by
   construction â the classes are the map behind that ceremony.
4. **bundle** â real esbuild build (version derivation) +
   artifact shape validation (header fields, IIFE shape, css companion) and
   the manager-contract pins: the exclusion list only ever rides the strict
   `@exclude-match` surface, `@downloadURL` stays present for the updater,
   exactly the 2 `@connect` lines ship with the `*` umbrella among them (the
   census's network block's header half â a dropped umbrella kills every
   user-supplied subtitle URL against CORS with no error a user could act
   on), exactly 1 `@resource` ships (pfStyle; a second resource is new
   manager-lifecycle egress), and the HUD class-vocabulary agreement scan â every `pf-*` class the
   source JS spells must have a reader on styles.css or the inject-side
   sheet (a class no CSS consumes is a dead vocabulary token, the same
   audit shape as the grant-coverage check; `pf-debug` is the
   `DEBUG_HASH_TAG` vocabulary, never a class, and trailing-hyphen tokens
   are template id prefixes); plus the sheet-fidelity row â the shipped
   sheet must contain no grammar-token glue (`)and(`/`) or`-family after a
   `)`, `)[+-]` for the calc infix), the signature of a minifier regression
   that shipped the two compound coarse-pointer media rows inert â the
   mobile coarse bottom-sheet block and the landscape coarse compact-panel
   block never applied, and the two calc infix glues inside the bottom-sheet
   block died double-covered, dead rows owning the glued declarations â
   plus the positive pin on the forge hide rule's descendant separator
   (`:has([data-pf-shell]) :not(` must ship with its space; the `]:not(`
   glue this guards is a legitimate compound shape, so the scan for it is
   the positive form).
5. **browser** â real browser + real bundle in a GM realm: **real native
   Firefox 159** headless, driven by geckodriver (this branch's floor, not a
   fork shim). Proves: boot, gesture contract, media semantics, resume,
   menus, GM env, frame scenarios, subtitle picture anchoring, edge
   robustness. ~60s.

### Browser gate mechanics
- **Row statuses are binary: only an explicit `"pass"` passes.** A case file
  returning a boolean or shorthand status reads as fail (a real failure this
  once shipped as a false row the aggregator skipped past, and four
  all-green runs stood behind it).
- Launch ladder: disk geckodriver â Selenium Manager (geckodriver majors are
  cross-version, so there is no version-matching gate to fail), with a
  browser-aware `ensureFirefoxDriver()` probe, a selective
  `brew reinstall geckodriver` heal when the disk is empty, and a
  real-session sentinel (`window.__checkReady === true` via `return`-ing
  script â expression-only bodies return `undefined`, the historical bug).
  Window rect via the native `setRect` command (no `--window-size` exists on
  Firefox); startup-tab hygiene closes any session-restore extras;
  `navigate()` verifies the landing (origin+path, one retry) because a
  `get()` that resolves before navigation can eat a whole case.
- **Ceremony per case:** `navigate(page?boot=<ts>)` (query-bust, same-URL
  reload would eat the bundle) â GM realm â bundle (everything after
  `==/UserScript==` in the dist IIFE) â `wakeVideos` (dispatch `loadeddata`
  so the probe sees present videos) â `.pf-shell` up to 9s.
- **GM realm** (`check/lib/gm-realm.mjs`): a faithful per-`@grant` surface â
  exactly the shipped grants, no more; a synchronous `__pfBacking` store;
  `__gmTest` audit surface (`remoteWrite`, `usage()`, `aliveMenuIds`); timeout
  + cold-cache wiring; forensics hooks (`__pfErrors`, `__pfConsole`, capped
  `__pfConsoleLog` capturing console chatter incl. `Shell registered: <sdk>`);
  `installGMRealm` is one self-contained function by design (Â§5.8).
- **Fixture server** (`driver.mjs`): dual-loopback listener â the same
  handler and port on `127.0.0.1` **and** `::1`, so `http://localhost:P` is
  a genuinely cross-origin route versus `http://127.0.0.1:P` with zero second
  server. Range-request support (206) is load-bearing for seeks (a
  non-rangeable stream silently discards `currentTime`). The video fixture
  (12s, `-movflags +faststart`, h264+aacs) is built once with the machine's
  ffmpeg.
- **Frame scenarios** (`cases/frames.mjs`): `injectGMRealmFrame`,
  `evalInFrame(path, fn)`, `waitForFrame` (poll re-enters the frame chain â
  a swapped document resets the script target anyway), `snapshotFrameState`
  forensics. Fixtures: `embedHostPage` (deliberately **no**
  `allowfullscreen` â the kernel must add it), SDK anchor stub pages
  (registry CSS classes only, no vendor lib), and the `switchboard` host
  whose placeholder iframe swaps between three SDK stubs playing the same
  video. Proven rows: only-innermost-boot, cross-origin bridge context in
  the resume entry (`domain=127-0-0-1` proves the TOP answered; a fallback would
  write `localhost`), fullscreen provisioning on every ancestor, per-variant
  single-shell, a 6s attach-latency budget row, and the VM echo reach: a
  foreign settings write live-reloads the running frame's kernel and the
  event-time hotkeys gate sees it (blocked mid-flight, then re-armed), and
  the diagnostics reach: the top's menu tap answers top (own write
  echo-filtered), and the frame realm's responder answers an IN-FRAME
  foreign `pf:diag` write through the audit surface â cross-realm delivery
  itself stays manager-truth (every harness realm is an echo island;
  the same premise the settings live-reload row rides).
- **Cases (14):** `boot` (install contract, positive/negative discovery),
  `discovery` (min size, no-anchor, tiny-video â the negative rows assert
  the FULL unbooted contract: no shell AND `window.PlayerForge` undefined,
  the probe's identity ask keeping anchor-less and sub-floor pages
  kernel-less), plus the bare-player tier's four rows (Nov 2026): a real
  blob-URL feed through the page (fetch â `createObjectURL` â src â
  muted play) with the tier seeded ON boots through the page container
  (shell inside `#player`, video's parent unchanged, `data-pf-shell`
  stamped), while tier OFF + blob+played, tier ON + plain-src playing,
  and tier ON + blob-never-played all stay fully unbooted â each
  evidence leg and the tier gate itself proven load-bearing,
  `fan` (the fan-out owner unit, imported into the page realm: positional
  fan, callable handle, native signal teardown, aborted-signal no-op,
  Symbol.dispose presence+use, `using` release (a live and a dead handle),
  mid-dispatch batch join, 10k-emit budget, and the dispatch-isolation
  witness: a throwing subscriber strands neither followers nor `emit`, its
  throw reports to the page error surface by design, and the deliberate
  error sentences itself out of the uncaught-error ledger),
  `sdk` (the registry-coverage gate, imported into the page realm through the
  served working-tree module: every registry record resolves against a real
  anchor-satisfying stub â name, container element, and one hop â the bare
  video keeps its null answer, the Clappr compound beats the Core on fewest
  hops, a record without a stub builder fails its row, and the
  shadow-boundary row proves the composed arm still reaches across the
  ShadowRoot â a video inside a custom element's shadow tree under a
  `.jwplayer` div resolves Vidstack at the in-tree host (hop 1), not JW at
  the boundary-crossing hop 2),
  `frames` (Â§ above),
  `gestures` (skip/mute/volume/panel/PiP/scrub with real driver input,
  plus the non-finite intake row: the four rejectable init members â
  clientX NaN/Infinity, clientY NaN, WheelEvent deltaY NaN â throw
  TypeError at the IDL dictionary conversion against a finite control
  ACCEPTED, the native admission gate behind the engine's event-stream
  intakes, with the unrestricted movementX rider as a measured
  non-gated witness; the dbltap rows carry the forge semantics â the
  inline edge dbltap stays refused (no dispatch), the fs dbltap suppresses
  the SDK's native dblclick at the surface, and the inline center dbltap
  IS the forge entry: real container fullscreen on the taps' trusted
  activation (focusWindow first, the document-focused lesson), zero
  native dblclick, the bar shown, then a script `exitFullscreen` +
  center re-derivation re-seats the inline posture for the later
  viewport-coordinate rows),
  `hotpaths` (the hot-path budgets: the per-frame/echo loops the tree rides,
  benchmarked in the REAL engine as regression tripwires â fan dispatch at
  100k emissions (10-subscriber echo-audience shape and the zero-subscriber
  warm read; the fresh-CustomEvent ~2.9Âµs/emit re-measured and the pooling
  decline re-recorded), the ingest engine's full 1.1MB / ~19k-cue parse and
  its offset reparse (double-digit ms), 250k HUD formatter calls, and the
  zero-alloc allocation probes â the fresh-vs-pooled measurement pairs that
  answer every zero-alloc rewrite candidate: the per-render picture-derive
  box (fresh object at rVFC cadence vs one-retained-picture + one-scratch
  ping-pong; PARITY at 1M renders, ~5ms harness-precision floor both) and
  the sync-offset cue-list rebuild (#applyBase's fresh Array + object per
  cue per stepper commit vs list+object reuse with a module comparator;
  PARITY at the pathological 19k-cue scale x 15 commits) â both poolings
  DECLINED as noise, the same verdict the fresh-CustomEvent pooling
  decline recorded, and every budget a multi-x multiplier over the
  measured baseline, so the tripwire catches shape regressions (an
  accidental allocation loop, a megamorphic rewrite) and never CI jitter;
  nothing earned an adoption â the loops are already engine-tight and the
  measured verdicts are the batch's record). **The adoption identity
  plane rides the same gate** (the kernel's uBO-grade path pinned as
  budgets): 1000 first-resolve resolves over the REAL served
  registry resolve whole at the measured ~1Âµs/resolve (the primary arm is
  ONE native `closest()` call over the registry-wide selector list â the
  C++ fewest-hops walk â plus the per-record tie loop; the hand composed
  walk measured ~2Âµs, the per-anchor `matches()` loop ~5Âµs; a walker
  regression shows at ~10x), and 100k
  repeat resolves ride the descriptor cache's steady state at the measured
  ~60ns/hit (unchanged by the probe â one WeakMap read + one parentNode
  compare + the record alloc â the ~30x hit/miss ratio IS the cache's
  value measured; the
  hit row is the tripwire for "the walk leaked into the steady state").
  The measured audit behind the budgets: the plane's remaining
  candidates (cached-home identity, early occupied-guard refuse,
  shared gate rect) were explored and DECLINED as noise-scale, each
  recorded with its rate axis in the exploration record. The end-to-end allocation
  sweep inventoried every spread/map/split/slice/pool site across the 24
  modules against the frequency axes and found no unmeasured hot
  allocator: the per-event axis rides pooled scratch end to end (forge's
  per-name pooled gesture event + detail, the pooled toast payload,
  scrubToLatched = clamp + `currentTime` write with no object on the
  path, the setPositionState scratch against the 4Hz clock), the
  per-render axis is preallocated-or-scalar (the walk's count-mutated
  active-pool array, per-slot scratch, dirty-check-gated string builds)
  plus the measured-declined picture box, the per-tick echo axis stays
  fresh by the re-entry rule; everything fresh-and-allocating left on the
  tree is human-rate (menu/reset dispatches, wheel-pinch session options,
  subtitle drop spreads, module-init derived tables, per-save stringify at
  the 0.1Hz checkpoint), so pools own every real-frequency axis and the
  audited population is complete. The shared/reusable pass then asked which
  sites could pool beyond themselves; most already pool at the strongest
  scope: the per-name detail payloads and the pinch-pair scratch are
  module-level singles shared by every engine and shell in the realm (each
  src file evaluates once per realm, and objects cannot cross a realm
  boundary - the same fact the pool's realm-safe lazy CustomEvent
  resolution rides), so the only per-instance machinery left is the
  gesture event pool whose per-engine scope is the safety contract itself
  (one gesture per name in flight per engine; multi-touch can drive two
  engines over the same name at once, so cross-engine sharing would
  corrupt an in-flight read), the hold machines are durable one-per-table-
  row rather than rebuilt per press (autorepeat arms the existing machine),
  and panel rows build once and sync by assignment. The two fresh-but-
  shareable survivors are declined as human-rate: the kernel menu/reset
  dispatch details ({ method: "menu" } per menu tap) and a formatter
  memoization, which would trade a measured-bounded HUD loop for an
  unbounded-by-duration cache.
  `gm` (info mirror, own-echo exactly-once shape, remote-write cross-tab
  adoption surviving a seeked-flush save, the debug mirror: a foreign
  configs write flips the running kernel mid-flight (mirror line + real
  debug chatter), the reverse flip is proven silent, and a value-neutral
  rewrite never re-mirrors, xhr shape + `ontimeout` on a
  held route, pfStyle resource warmth, menu-handle census (five live
  commands: debug toggle, the bare-videos tier toggle, the frame-state
  dump, the two resets), the
  diagnostics dump row (one menu tap prints the realm's own state line
  through the warn plane â identity, live registry, per-video attribution
  parsed whole), harvest-seeded
  reboot), `media` (stream, gesture events, kernel re-anchoring onto a
  replacement video, the containment re-wrap (a second SDK container â the
  destroy-readopt seam, one shell ends in the new home), the one-main
  refusal row (a second Plyr wrapper with a second video appended while the
  main is live â still exactly one shell, the second video unstamped â a
  refusal is an absence, so the row samples to a stable no-adoption), the
  refusal-recovery row (the refusal leaves the candidate unpinned â no
  seen-pin, no gate â so once the live shell's owner is really removed and
  the registry-empty edge fires, the re-armed full tap's seed walk adopts
  the surviving candidate, whichever video the doc-order pick left
  unshelled; the strand shape, a refusal surviving its refusal with no
  recovery path, is the row's fail), and the
  state-preserving move: a `moveBefore` reorder
  in place and a cross-parent re-home of the running shell, both
  floor-real), `menus` (menu command â panel effect; the targeted
  reset row seeds a non-default color filter and proves the bare command
  restores it â no panel involved, and the directional-motion row: the
  panel flips spy-deliver their view-transition types (open=
  `pf-panel-open`, close=`pf-panel-close`), the HUD sheet carries a
  `:active-view-transition-type()` reader for both words, and the R9 ink
  pin rides the row (the panel's computed surface/border identical
  before-open vs after-close â motion-lane-only, asserted at full depth);
  the trim row: a seeded section label's computed
  `text-box-trim: trim-both` / `text-box-edge: cap alphabetic` serializations
  plus a zoom-immune height ratio band (`h/fs` bounds hold across the zoom
  variants); the zoom row: the panel measured open vs `ui.panelScale: 1.15`
  seeded â computed `zoom` reflects the inline write, rects scale by the
  factor while computed radii/font-size stay unzoomed authored px (the R5
  identity), and resting ink unchanged â with a panel-open wait and a
  close-panel restore before the typed row keeps later rows undisturbed),
  `persist` (storage seeding, resume restore across reboot, the sync-grain
  row: one nudge gesture lands `subOffset` in the tracker's entry, the
  Start-over row proving the explicit boundary writes past the drift
  epsilon, and the foreign-omission row proving a removal adoption with no
  write-back resurrection, plus the scroll-snap pin riding the open-panel
  pool stages: the History list's computed snap-type (`y` â Firefox 159
  elides the default proximity strictness in the computed form) and a
  card's `snap-align: start`),
  `responsive` (the container-band case: baseline fit + full chrome at a
  640px stage, computed band values live at 390/320/240 (gap 2px, padding
  6px, time readout hidden, 32px targets), the â¤280px-tall height
  tier's bar + cue-shift token coherence (44px/50px) and its byte-true
  release (56px/64px), overflow refusal (spill 0, scroll clean) at every
  swept width, panel containment at 330x240 and 300x200 embed regions; the
  page is the bare-tier shape â the bare shell's bar is the inline
  control surface, visible while paused, so the geometry rows need no
  fullscreen stub; headless Firefox cannot emulate `(pointer: coarse)`,
  so the coarse-path panel bounds are static, justified by region-bound
  arithmetic â the case documents this),
  `subtitles` (the picture-anchor case: a letterbox stage â square element
  in a taller stage â proves percent cue fields land on the displayed
  picture rect, not the layer box, with the panel drop as the real ingest
  path; a motion-lane row proving a visible slot's computed
  `transition-property` is exactly opacity/translate/display, the anchor
  lane absent; a resize row (video element + stage widening) proving the box
  ticks re-anchor the running slots without any cue change; the own
  scheduler's boundary rows â one seek into a second cue's window lights
  the enter, the window passing drops the exit â plus the V-stepper
  placement row (typing "90" into the panel stepper's live-commit field
  re-anchors the running slot the same frame) and the scale row, a
  >512KiB drop through the real panel path proving the cooperative
  parse (the arm the retired Worker offloader left as sole backend)
  drains and lands its overloaded cue, the over-cap refusal row (an
  18 MiB synthetic "subtitle" through the same real drop path refuses at
  the admission ceiling with the fail toast and renders no bomb cue), the
  hostile-style-value row (the CSS intake receipt: url()/selector-shape/
  overflowing-unit token streams through the exact `setProperty` call the
  style state uses carry no fetch surface on the resource-entries census
  and degrade IACVT to the sheet defaults), and
  the balance pin: the visible
  cue's computed `text-wrap-style` is exactly `balance` (vocabulary
  presence — the pixel-top rows are the geometry guard balance must not
  move), and the canvas-awareness row: the fixture reshapes to a
  picture-to-bottom stage, the video parks paused inside the scale cue
  window, and the forge bar's `hidden` flip re-anchors the running slot
  through the cue-canvas RO (top 557.0 → 499.5 with the bar visible —
  the picture clipped at the lifted canvas — and back; the paused posture
  is the row's isolation), `robust`
  (the robustness case, both planes on one file â merged Nov 12 2026 from the
  former `robust` + `robust2` pair, every row preserved byte-identically, the
  two normal-install planes sharing one boot; four boots: **Boot 1** the
  storage floor + the interruption plane on one normal install â the
  hidden flush without a user pause (a real second tab sets the document
  hidden and the native visibilitychange flush must land the position; the
  freeze surface the row once dispatched synthetically is Chromium vocabulary
  Firefox 159 has no realm for, probed), the checkpoint cadence on the native
  timeupdate media clock at 4x, the completion reset persisting the zero with
  a bumped doc stamp (parked on a real sub-ratio baseline first so a
  zero-to-zero no-op write cannot read as an eaten write), then the
  session-end plane live â a window blur mid-hold releases the 2x boost with
  the stray keyup a no-op (the forge blur belt), panel churn x10 ends closed
  with the toggle still live (per-open dismissal scopes under overlapping
  view transitions), a scrub storm x30 ends every stroke with playback state
  untouched, pointercancel mid-drag/mid-swipe/mid-pinch-session each ends the
  stroke cleanly with no stranded transform or latch and the recognizer
  working for the next stroke (the pinch row pins the exact close contract:
  after the live pair's recognition, the one-finger cancel plus the trailing
  orphan release ADD nothing to the semantic event stream and a fresh pair
  recognizes exactly once), a fullscreen exit mid-fill releases the fill with
  the box handed back (the staged embed-owned inline object-fit is the
  released value, not an empty-vs-empty coincidence; the stage shape must be
  an explicit mismatched wrapper box â the fixture video's
  width/height:100% CSS auto-heights the wrapper to the video's own aspect at
  any width, an aspect-matched box whose cover scale is exactly 1), a
  destroy-readopt thrash x20 converges to exactly one shell at the last
  home, and the echo/merge budgets close boot 1 (1000-echo < 400ms, 400
  remote-adoption merges < 800ms â last, so the earlier playback sweeps have
  loaded the tracker and every write pays the real LWW merge); **Boot 2**
  seeds a hostile pf:configs (brightness 1e9 clamps at the FILTER_SCHEMA
  bound the steppers commit with â the seed-bypass class the ledger adopted â
  contrast/hue non-numeric values degrade to the defaults, saturate -50
  clamps at 0); **Boot 3** seeds a hostile pf:resume doc (a 1e9 saved
  position restores clamped at the media sink, and an entry with a
  non-string domain/title rides the string-field admission into a clean
  History render with no [object Object]); **Boot 4** seeds non-object docs
  ("garbage"/42) which degrade to filter defaults (buildFilterString's
  all-defaults string is the literal "none") and no restore artifact, with
  playback parked first so the witness cannot read drift as a restore;
  uncaught errors from any row fail the case through the stage's audit net),
  `scheduler` (the postTask faÃ§ade unit, imported into the page realm:
  firing order and delay honors, dead-handle/release/rejection-swallow
  choreography, the two-controller shape surviving an abort inside the
  task body, and `yield_()` recovering what raw `scheduler.yield()`
  rejects).
- **One `sleep` helper** (check/lib/driver.mjs): every node-side wait
  between driver commands and case steps buys the one promise shape; the
  three local twins it absorbed (a `settle` in two case files plus ~40
  inline one-liners) went with it. In-page probe sleeps stay self-contained
  on purpose â the evaluated bodies serialize into the page realm and can
  never close over a check-module import.
- **Per-case audit rows** follow every case file: uncaught page errors
  become fails, `console.error` becomes informational rows, a GM-usage
  census row; failing cases get a screenshot + page-state dump into
  `check/.tmp/`.

### The working cycle (this is the workflow law)
1. Implement: all gates run; **â¥2â3 consecutive all-green runs** before any
   summary or commit.
2. Rows are honest: a red row reveals a real gap â only then touch kernel
   source, never to make a row green.
3. Summarize results and **wait for an explicit "commit and push"** â never
   commit proactively; never amend a failed commit, create a new one.
4. Development environment facts ride with the tool: Helium auto-updates
   mid-flight (155â156 happened); do **not** adopt Chromium's IndexedDBâ
   SQLite backend backing for userscript storage; Chromium failed-module
   retry policies are irrelevant (single-file bundle).

## 8. Quick diagnostics

- **Gate fails at syntax/flaws:** run the concatenation of the isolated
  import child output; if a module brings a consumer it doesn't use, that's
  the import-graph smoke catching it.
- **Gate fails at census:** a recorded count moved â the red row names it and
  prints the why it guarded. The fix is a reasoning commit: update the gate's
  `expect` in `check/stages/census.mjs` and the AGENTS.md census together,
  with the change's why in the message. Bumping the number alone is what the
  gate exists to make visible, never the fix.
- **Browser gate launch refused:** `driver probe` prints the disk geckodriver
  and the Firefox binary version; geckodriver is cross-version so there is no
  stale-major shape â a repeated `handshake failed (no marionette port)`
  after a browser update is the known mid-update shape; relaunch after the
  browser finishes updating.
- **A case's shell never attaches:** the boot ceremony dumps
  `{readyState, shell, video, pf, lastInjectError}` before throwing; the
  `.tmp/last-failure.png/json` capture adds `frame[0]`,
  `frame[0][0]` state via `snapshotFrameState`.

---

*AGENTS.md replaces DESIGN.md (the HUD guide it restates in Â§6). Committed
story: see `git log` â the pass era is `8c560e6..a044fe1`, the tool era
`b226fe8.."1dbf397"`, the input pass `3971636`/`1637549`, the stateful-class
turn `cff0ab0` + `c95db6a`, the layer unifications `4737f84`-`6a9411d`, the
redesign `3d0a772`-`c439fec`, and the tool hardening `b226fe8`..`98b17fa`; and
then the review-sweep series â twenty-one AâZ/census
passes, each recorded in place above: kernel layer (`7ffd3eb`), rVFC/rAF
floor probes (`3177185`), fs-ui branch closure (`dfaceee`), allocations
end-to-end (`2369e3f`), media plane (`90c8a62`), listener/observer census
(`28a408a`), error-path census + headerâruntime cross-check (`49e1f80`),
settings key occupancy (`d7d82b0`), HUD token sweep (`b61ec2c`), resume
plane (`980d6d1`), build pipeline â the minifier fix (`ecc36a8`),
bfcache/freeze-recovery plane (`4f2ea18`), exclusion-vs-registry
non-overlap (`f8149cf`), network egress census (`1b95cc2`), manager floor
at premise level (`b52821c`), shell lifecycle (`b89b8bd`), chrome modules
(`b92c7a0`), and store.js proper (`a68f076`), closing with the allocation
drift re-audit (Nov 2026, record-only â see Â§4's drift block), the inputs
plane (`2d67422`), the shared geometry/context planes â dom.js + page.js
(`4893b78`), and core + runtime â closing the sweep
map with every src module family carrying a dedicated record â plus the
adoption identity plane (`0f06dbd`, the measured hotpath budgets) and the
two post-close record-only audits: the allocation drift re-audit and the
native-operator saturation audit (post-`75437f2`, the probe batch), then
the substrate series (C++ `20b07da`, kernel-plane `ea5a8f1`, shell-plane
`5479871`) and the native-replacement wave-2 probe (post-`5479871`,
record-only), then the census-premise substrate audit (post-`ef8393e`,
record-only), the C++-internals delegation probe (post-`d5c2b81`,
record-only), the native-robustness series and the Native-first law
ledger (batches 1â7), the Firefox 160 release floor probe (`4952c7c`)
and the C++ budget small-run on 160 (record-only), then the T2 reopen
adoption (Nov 2026, src â the scanner twin landed on its measured
verdict), the VM v2.50.0 floor re-audit addendum (record-only â the
five manager premises re-derived from the released source), and the
detection native-walk batch (Nov 2026, src â `closest()` primary arm,
per-record probes, Shaka + OpenPlayerJS records), and the
registry-coverage batch 2 (Nov 2026, src â Bitmovin, Kaltura PlayKit,
NPlayer records; dash.js/hls.js/Pillarbox verified declines), and the
quality-and-robustness batch (Nov 2026, check-only â the new `robust2`
browser case, 14 rows over four boots, no src change; the battery grew
to 15 cases / 260 rows / ~107s), and the registry-coverage batch 3
(Nov 2026, src â OvenPlayer + AblePlayer records, the tie law's first
cross-record split; Amazon IVS/Brightcove/TCPlayer/Bunny verified
declines; the battery grew to 263 rows). The batch pinned the Native-first
ledger's admission adoptions live on the floor (the filter seed clamp,
the resume string-field admission + media-sink restore clamp, the store
truthiness-object read) and drove the engine's recorded session-end
paths (blur, pointercancel, destroy-readopt, fs-exit-mid-fill) as
interrupted-state rows. Two honest instrument findings worth holding:
the pinch close contract needed the row to snapshot the live
recognition as the baseline â the array is not re-seeded between the
strokes, so the "phantom dispatch" the first draft counted was its own
live recognition event, and the correct contract (cancel + orphan
release ADD nothing) needed the per-step count compare; and the
mismatched-fill stage must be an explicit wrapper box â the fixture
video's width/height:100% CSS auto-heights the wrapper to the video's
own aspect at any width, an aspect-matched box whose cover scale is
exactly 1 (media.mjs's mismatch came from a fresh video that did not
carry that CSS). Battery receipt: 4 consecutive all-green full-battery
runs (107.0/106.9/107.1/106.8s), the shell-mount adoption (Nov 2026, src â
`PfShellHost` custom element replaces the hand-rolled `watchShellHost`
watchdog; `inject.js` renamed `mount.js`), the robustness-case merge
(Nov 2026, check-only â robust + robust2 folded onto one boot, every row
preserved, battery 266â265 rows), the lean boot pipeline batch (Nov
2026, src â the probe resolves SDK identity together with presence and
hands the kernel the frozen `AdoptionHome`; `findSdk` descriptor face,
kernel boots adopted, recovery-only seed walk), and the all-pipelines
lean sweep (Nov 2026, src â the destroy-readopt identity hand-off and
the resume duration-proof ownership; every other pipeline traced to the
one-proof shape), and the same-task double-proof housekeeping (Nov 2026,
src â the probe's one-presence-ask consider and `#onVideoFound`'s
dead shell re-checks deleted; the deliberate multi-path asks recorded),
and the progress-drive review (Nov 2026, src â the volumechange dead arm
left the MediaSession sync set; the read-direction impossibility and the
deliberate boundary asks recorded), and the bare-player adoption tier
(Nov 2026, src + check â the opt-in `discovery.bareVideos` tier adopting
bare blob/MSE videos through their page container, the focused-video
keyboard yield arm, five menu commands; four new discovery rows).

**The progress-drive review + the volumechange dead arm (Nov 12 2026, user
direction "review how we currently track the video progress to have leaner
pipeline relying on firefox' native media session API"; src â media.js +
shell.js comments; one adoption).** The review walked the resume tracker's
progress drive (the read plane) and the MediaSession bridge (the write
plane) end to end. **The verdict on the API direction:** the Media Session
API cannot carry the READ half â `setPositionState()` has no getter
counterpart anywhere in the spec or Firefox, so the element's own clock
(`timeupdate` + `currentTime`) is the only progress read that exists, and
that is exactly what the drive rides; the WRITE half is already maximal
(1s-epsilon-deduped ~1 IPC/s, pooled scratch, boundary events bypassing
the quantum). Riding the tracker's cadence on the bridge's sync clock was
declined on both grounds: the bridge is a lifecycle-displaced surface
(newest-claim-wins), and the saving is ~3 no-op compares/second. The
one-main-video/one-shell law's existing collections recorded: the claim
registry's displacement machinery is a backstop (the adoption guard's
displaced-destroy class, not a live path), and the drive's 6-listener
boundary set is complete â every flush earns its keep (pause = the most
common user stop; seeked = the explicit position choice; ended =
terminal; visibilitychange hidden = the tab-hide throttle belt; pagehide
= the bfcache leg), and the off-screen IO gate stops GM storage churn for
unseen autoplay embeds. **The one adoption â `volumechange` left
`MEDIA_SESSION_SYNC_EVENTS` (10 â 9 events):** both consumers it fed
were verified â `sync()` writes playbackState + position state and reads
volume in neither, and the shared handler's css sync writes only
`--pf-media-paused`, which volume cannot flip â so every volume-drag
step paid two provably no-op closures (a dedup return + a same-value
var skip). One fewer video listener, zero behavior lost; the two stale
comments that justified it (shell.js's "three hottest state events",
predating the css sync's narrowing to the paused var) rewritten to the
live shape. Kept deliberately: `play` + `playing` both live in the set
(`play` fires at the paused-flip even when start stalls, `playing`
covers stall-end/buffering resumption â both directions real, the dedup
makes the redundant one a ~free read-batch); the per-tick span hoist
candidate (recompute â per-entry scalar) declined at ~25ns/tick Ã 4Hz â
the same noise scale the tree's measured declines record. No counted
census vocabulary moved. Battery receipt: three consecutive all-green
full-battery runs (265 rows each; 106.0/105.9/105.8s).

**The shell-mount adoption (Nov 12 2026, user direction "which is more
native efficient and reliable and lean approach to adopt shell into sdk
inject or mount"; src â inject.js + shell.js + styles.css; adoption
landed).** The question: should the shell host keep riding the hand-rolled
`watchShellHost` watchdog (inject-side observation machinery around the
attachment) or mount as a custom element whose own lifecycle owns the
defense? **The floor probe first**
(`check/.tmp/shell-mount-probe.mjs` + `shell-mount-report.json`,
uncommitted per sweep convention; real Firefox 160): it overturned two
analysis premises â (a) a connected re-homing DOES fire
`disconnectedCallback`/`connectedCallback` (any remove+insert delivers
callbacks), and (b) `moveBefore` (same-parent and cross-parent) also
delivers the pair â so the lifecycle covers eviction, container
detach/reattach, connected re-home and `moveBefore` moves with ZERO
observers; M3's six-shape coverage matrix showed MutationObserver misses
the container-detach shape entirely (woke 0) â which is what justified the
feed arm in the watchdog â while catching evict-while-detached + connected
re-home; M4's churn census measured the lifecycle at **0 wakes over 200
churn batches vs the feed's 1** (per-checkpoint coalescing); M5 pinned the
hostile pre-define shape (`NotSupportedError` at define, the
alien-upgrade hazard real â a page-authored element of our tag upgrades
and runs `connectedCallback` with `isConnected` true, hence the
`#dead`/`#container` no-op guards); M6 proved re-append is
state-preserving (shadow root + adopted sheets + text survive; cross-parent
`moveBefore` carries the shadow intact); M7 pinned callback-time
`parentElement` as the detach-vs-eviction discriminator (`d:still-child`
vs `d:parentless`). The lifecycle's ONLY gap â **evict-while-detached**
fires nothing on the host, and the container's re-insertion cannot recover
a host that is no longer its child â is covered by a container childList
observer armed ONLY inside that detached window, whose immediate re-append
into the detached container lets the container's own re-insertion announce
recovery through `connectedCallback` (end-to-end in probe axis M7).
**Landed:** `PfShellHost` (lazy-built class â the isolated import smoke
evaluates inject.js in Node where `HTMLElement` does not exist;
`shellHostClass()` constructs on first tag resolution only) with
`adopt(container)` (must precede insertion â `connectedCallback` reads
`#container`), `dispose()` (dead-latch â drop armed watch â remove; the
old watchdog's separate cleanup defer merged into one verb in shell.js's
`#injectDom`), and the two callbacks armed by parent-equality signatures;
`shellHostTag()` defines once per realm and walks counter names
`pf-shell-host-1..` past a taken primary (the hostile-define belt â
unreachable in the shipped document-start eval, live for managers and
later-injected ceremonies). The sheet spells `display: block` on
`.pf-shell` explicitly (custom elements default inline; layout never rides
blockification). The class-census and import-smoke gates absorbed the new
surface with a `customElements` eslint global; no counted census row
moved (no MutationObserver/queueMicrotask/feed-subscriber rows exist â
the feed subscriber count is prose-recorded 4â3 above). Battery rows: the
media case gained three â plain eviction re-attach, evict-while-detached
recovery through the armed watch (whole detour ~20ms, inside the kernel's
500ms removal grace), and the hostile pre-define ladder row (via a new
`pre` hook in the browser stage's boot ceremony). Battery receipt: four
consecutive all-green full-battery runs (266 rows each; 107.6â107.9s).
Same-day follow-up (user direction): the file renamed to its primary verb â
`inject.js` â `mount.js`, `injectShell()` â `mountShell()`, `#injectDom` â
`#mountDom`, the logger channel `inject` â `mount` â pure rename, import
paths and comment references only (styles.css/dom.js/bundle-gate corpus
path/media case comment); dated audit records keep the old filename as
date-stamped truth, and the bundle gate's class-vocabulary corpus follows
the renamed file.

**The robustness-case merge (Nov 12 2026, user direction "merge robust and
robust2 in one well-optimized module"; check-only â `robust2.mjs` retired,
every row preserved byte-identically, no src change).** The two robustness
cases shared the same fixture and the same normal-install ceremony but
booted separately (the former `robust`'s storage-floor plane and
`robust2`'s Boot 1 interruption plane), so the merge folds both normal
planes onto ONE boot and keeps the three hostile boots unchanged:
storage-floor rows first (hidden flush â cadence â completion reset, before
any fs stub is installed so no row can interfere with another's backing
reads), then the interruption plane (blur â panel churn â fs stub + pointer
driver â scrub storm â cancel drag/swipe/pinch â fill release â stage
restore â thrash), then the echo/merge budget rows last (the earlier
playback sweeps have loaded the tracker by then, so every write pays the
real LWW merge), then hostile boots 2/3/4 verbatim. Shared helpers deduped:
one page-side pointer driver `window.__pfFire(id, type, dx, dy, buttons,
isPrimary)` replaces the four per-row `fire` closures (deltas relative to
the video center read per call; `isPrimary` passed per call so the pinch
pair's second pointer keeps its original non-primary semantics), plus
node-side `status`/`waitDuration`/`settle`/`storeResume`/`fireKeys`/
`wireGestureRecorder`/`armFsStub`/`restoreStage`. Row interplay verified
during the merge design: the completion-reset row tolerates the cadence
row's stale baseline by design (its own sub-ratio re-arm parking), the
gesture recorder's page-lifetime listeners survive every row of boot 1 (the
array is re-seeded per row), and after the thrash the video is re-homed
with the `#check-video` id and store reads intact. The battery count moves
266 â 265 (one fewer GM-usage-audit row: two cases became one). Battery
receipt: three consecutive all-green full-battery runs (265 rows each;
105.7â107.3s).

**The lean boot pipeline batch (Nov 12 2026, user direction "explore leaner
cycle with same allocation â probe the video and its sdk together, adopt
them, create shell and mount it in lean pipeline"; src â detection.js +
discovery.js + kernel.js + entry.js, check â discovery case; adoption
landed).** The cycle used to prove the same facts three times: the probe
qualified a candidate by size+screen, booted the kernel, and the kernel's
init re-walked the document (seed walk), re-detected the same video, and
re-measured size+screen before settling â a bare video even booted a kernel
whose detection then refused every candidate. The lean pipeline collapses
those passes into one proof at the probe. `findSdk` is detection's new
descriptor face (the cached matcher answer, no record wrap): the probe's
`#consider` runs per surfacing event and its repeat path must stay
allocation-free â the descriptor cache's own contract, now actually
consumed without the per-call `AdoptionHome` wrap. The probe fires
`onCandidate(home)` exactly once, for a candidate proven identity+size+
screen together (identity re-asked at `#finish` so the deferred
scroll-in fires hand a fresh answer; a null there falls back to the
watching posture, not a stranded candidate), and the kernel boots adopted:
`init(home)` â `#adoptVideo(video, home)` skips the detection re-scan and
both presence re-proofs (all proven in the same synchronous boot task â
probe finish â entry boot â init, no intervening task), the seed walk
becomes recovery-only (`#armDiscoveryTap` now runs at the registry-empty
edge; init-without-home keeps the discovery-first posture), and the
boot-time full tap is never built-and-dropped â the handed adoption
downgrades straight to the media-event tap. Net per boot: one
`AdoptionHome` instead of two, one tap build instead of two, zero
redundant rect reads, and pages whose videos carry no SDK anchor (the
bare-page shape the discovery case rows pin) never boot the kernel at all.
Row updates: the two negative discovery rows now assert the FULL unbooted
contract (`window.PlayerForge` undefined alongside no shell) â the row
names document the stronger fact. The settle â create â ready â register
tail is untouched (the settle is the measured mid-build protection, and
`#watchVideoRemoval` stays pre-settle: the abandon path's seen-pin release
rides its watch). Battery receipt: three consecutive all-green full-battery
runs (265 rows each; 106.1/105.8/105.7s).

**The all-pipelines lean sweep (Nov 12 2026, user direction "boot pipeline
is lean now explore same approach for all pipelines"; src â kernel.js +
resume.js; adoption landed).** The boot batch's lens â each fact proven
once, at the earliest owner, handed forward frozen â walked every other
pipeline in the tree. Two same-task double-proofs found and adopted:
**the destroy-readopt pipeline** â `#onRewrap` resolved the adoption home
for its container compare, then `#adoptVideo(video)` re-resolved the SAME
home in the same synchronous task (destroy() reaps the HUD host without
touching the SDK anchor ancestry, so the answer cannot change) â two
detection passes and two `AdoptionHome` wraps per rewrap; now the
compare's resolution rides into the readopt as its identity proof, while
presence stays re-proved (a live re-home can move the box â the
`presenceProven` flag separates the boot probe's full proof from the
rewrap's identity-only hand-off, and the deferral gates stay live for the
off-screen re-home shape); and **the resume restore pipeline** â
`#adoptEntry` re-checked the duration that `#waitForDuration` had just
guaranteed (its only caller, no await between), the dead belt deleted
with the proof-ownership named in the docstring. Every other pipeline
traced and already in the one-proof shape, recorded so the walk stands
somewhere: resume restore (context + store warm eager in the constructor,
parallel to shell construction; the event-driven duration wait; the
native `timeupdate` cadence; boundary flushes â the eager-parallel shape
the boot batch's probe â kernel hand-off mirrors), subtitle ingest/
restore (the content-hash parse memo, the `#restoreAttemptedUrl` latch;
the restore path's cross-realm re-fetch is inherent â no text cache by
design, and the immediate `#tryRestore()` at session init is an
audited-and-kept ordering belt: the tracker's announce always lands after
the session's subscription by microtask ordering â the announce follows
an await the subscription does not â but the belt costs one early return
and covers a future ordering drift), subtitle render (pooled slots +
dead floor + dirty-check), filter (boot-apply at bind, seed clamps), panel
(lazy section builder + rollback), media session (epsilon-deduped position
state), bridge context (one eager caller, event-driven announce-down),
toast (pooled pill + fingerprint skip), teardown/recovery (the pagehide
runSteps and the bfcache orphan reconcile â whose re-derivation is
NECESSARY, not redundant: facts can change across a hide, unlike the
same-task shapes the lens deletes). The `#adoptEntry` false return path
dies with the belt; `#init`'s `!(await â¦) || !this.#adoptEntry(context)`
shape is untouched. No counted census vocabulary moved. Battery receipt:
three consecutive all-green full-battery runs (265 rows each;
105.7/105.7/105.7s).

**The same-task double-proof housekeeping (Nov 12 2026, user direction "a
housekeeping batch to ensure no same-task double-proofs leftover"; src â
discovery.js + kernel.js).** The tree walked with the one lens â the same
fact asked twice with no await/observer gap between the asks (facts
cannot change, so one ask is dead) â over every fact-verb call site:
`resolveAdoptionHome`/`findSdk`, `meetsMinSize`/`isOnScreen`/
`hasPresentBox`, `getByVideo`/`#seenVideos`, the media verbs' readiness
gates, the `#scope.disposed` checks, the panel open/close idempotence
guards, `#armLoop`'s re-arm guard, the toast fingerprint, FsGate's `#doc`
latch, Scope's abort-flip. **Three dead re-proofs deleted, two adopted as
src changes:** (1) **the probe's double presence ask** â `#consider`
read the painted-box fact twice in one task (inside `meetsMinSize`, then
again for the escalate branch), so a hidden candidate's media-event
repeat path â the common repeat path â paid two `checkVisibility`
computations per event (three reads on the present-but-small shape);
`boxAtLeast` is now the size-only compare, `meetsMinSize` = presence +
`boxAtLeast`, and `#consider` hoists ONE `hasPresentBox` ask that answers
both decisions â one read per consider on every shape; and (2)
**`#onVideoFound`'s entry + post-settle shell re-checks** â the entry
`getByVideo`/`#booting === video` checks re-asked facts `#adoptVideo`
established one call-frame earlier in the same task (the occupied guard
refuses every arrival while a shell is live or booting, so both answers
were provably false), and the post-settle `getByVideo` re-asked a fact
the seen-pin holds across the whole settle window (the pin is added
before the call and released only by paths that cannot run mid-boot:
`#onRewrap` needs a registered shell, `#abandonBoot` fires from the
boot's own exits, pagehide disposal is caught by the disposed check);
the deleted checks cannot affect the refusal-recovery or one-main-refusal
rows (they pin `#adoptVideo`'s guards, not these). The provider-null
check stays â it is the framework-invariant belt, not a re-proof (no
earlier ask in the task carries it), and the two await-gap-separated
re-reads (kernel disposed, video/container disconnected) stay â the
settle gap is exactly where those facts can change. **The deliberate
multi-path asks recorded so the next walk does not re-litigate them:**
`#finish`'s `findSdk` re-ask (one site serving the direct path â same
task, descriptor-cache hit â and the deferred gate path, where the gap
is real), the probe's fallback-branch `hasPresentBox` re-ask (same
multi-path shape), the media/action `canSeek` double-ask (two owners â
the feedback surface and the command verb â each owning its ask), the
subtitles session's immediate `#tryRestore()` (the ordering belt),
`boot()`'s `window.PlayerForge` guard (the module-boundary belt), and
ScrubSession's clamp + media's `#clampTarget` (idempotent normalization
at two ownership boundaries, not a proof). Every other audited site is
gap-separated (necessary) or single-asked (clean). No counted census
vocabulary moved (the one try/catch moved with `boxAtLeast` â count
unchanged). Battery receipt: three consecutive all-green full-battery
runs (265 rows each; 105.9/106.0/106.1s).

**The bare-player adoption tier (Nov 12 2026, user-directed; user shape
pinned via question tool â "Adopt page container, video stays" +
"Take the parent as-is"; src â contract.js + detection.js + discovery.js +
kernel.js + entry.js + inputs/forge.js; check â discovery +4 rows, gm menu
census 4â5, sdk/hotpaths served-neighbor additions).** The question: bare
MSE videos (`<video controls playsinline src="blob:https://â¦">` â the
page-built player with NO SDK anchor) never boot under the
no-generic-fallback law. The adopted design: an **opt-in tier** that
replaces the registry's identity leg with a measured evidence bar, and
adopts the video through its OWN page container â the video never moves,
zero DOM surgery, no synthetic wrapper (the earlier `data-pf-bare-wrap`
wrapper design and the `moveBefore` wrap are dead, user-pinned).

- **The tier gate and evidence bar (detection.js).** `BARE_VIDEOS_KEY =
  "discovery.bareVideos"` in contract.js (default off â the
  no-generic-fallback law governs every default install), following the
  `DEBUG_LOGS_KEY` kernel-plane pattern. With the tier ON, an anchor-less
  video qualifies on `URL.parse(currentSrc)?.protocol === "blob:"` AND
  `played.length > 0` â all native reads, all required. The blob leg is
  the deliberate-player discriminator (MSE hands out exactly these URLs;
  plain/data/empty src never qualify; `mediastream:` deliberately
  excluded â the conferencing/capture class is a different topology, not
  a player). The played leg is the junk killer (decoder/canvas textures
  and preload-never-plays embeds never reach it). Presence gates
  unchanged â the 100Ã60 painted box and the finish on-screen check stay
  discovery's job. The descriptor is `{ name: "Native Video", container:
  video.parentElement, hops: 1 }` â the page's container taken as-is.
- **The cache law.** The qualified positive caches parent-stamped like
  any SDK answer (once blob+played qualify they stay qualified); a null
  NEVER caches while the tier is on (the evidence is time-varying â src
  can be assigned late by an MSE pipeline, played accumulates with
  playback); the tier-OFF negative cache stands byte-identical (a page of
  many non-SDK videos never re-runs the ancestry scan). The tier flip is
  the one invalidation the parent stamp cannot express â
  `clearDescriptorCache()` reassigns the matcher's WeakMap, the flip
  applier calls it before re-running discovery.
- **The flip plumbing.** `VideoProbe.refresh()` re-runs the pre-boot seed
  walk (no-op once a candidate fired â the kernel's own discovery tap
  owns later candidates under the one-main law; the media taps and gates
  stay armed, `stop()` is the only detach); `installVideoProbe` returns
  `{ stop, refresh }`. The fifth menu command `ð¬ Bare Videos: Off/On`
  rides a hooks channel (`installMenuCommands(resolveKernel, hooks)` â
  the menu installs before the probe, so the entry passes a ref-boxed
  applier): the WRITING realm applies its flip through `onBareFlip` â
  `watchStorageKey` filters own echoes (`remote === false`), so the
  writing realm's matcher cache and probe would never hear the write
  otherwise â while sibling frames and other tabs apply through the
  entry's `watchStorageKey(KEYS.configs, â¦)` echo watch, whose one
  latched read dedupes value-neutral config rewrites (a doc write that
  did not touch the key must not clear every cached descriptor). The
  pre-boot `probeRef`/`applyBareFlip` definitions moved ahead of the menu
  install for exactly the TDZ the closure would otherwise hit.
- **The native-controls floor probe** (`check/.tmp/bare-controls-probe.mjs`,
  real Firefox 160 geckodriver input, 9 axes N1/N2/E1âE4/K1âK3 â the
  durable survey artifact for any future bare-tier control work; kept
  uncommitted per sweep convention). Findings that shaped the shipped
  code: (1) with `controls` present, Firefox's UA-controls overlay owns
  the whole POINTER surface â page/container listeners see NOTHING
  (empty recordings across E1âE4), so the gesture engine is structurally
  blind and no conflict clause is needed on the pointer plane; native
  click-to-play works, there is no native dblclick-fullscreen. (2) the
  KEYBOARD plane double-acts when the video is FOCUSED: Space
  play-then-pause (t advanced 0.2â0.3 â the native keydown toggled play,
  the engine's keyup toggled pause), ArrowRight seeks past the engine's
  +10 to the duration clamp (tâ12), KeyM clean. (3) the adopted fix is
  one yield arm in `#keysAllowedForTarget` â a focused `<video controls>`
  yields like the SELECT-typeahead class; no fixture video carries
  `controls`, so no existing row rides the branch.
- **Check rows.** discovery case: four bare-tier rows over a real blob
  feed (fetch â `createObjectURL` â src â muted play) â tier ON boots
  through the page container (shell inside `#player`, video's parent
  unchanged, `data-pf-shell` stamped), tier OFF + blob+played stays
  unbooted, tier ON + plain-src playing stays unbooted (played leg
  alone never adopts), tier ON + blob-never-played stays unbooted
  (blob leg alone never adopts). gm case: the menu census row pins five
  live commands (the Bare caption present). sdk + hotpaths cases serve
  the two shared neighbors detection.js's new import chain needs
  (`store.js` â `runtime.js`; both load side-effect-free in-page â the
  ConfigStore read is lazy â and the positive SDK paths never reach the
  tier read).
- **No counted census row moved** â the echo/menu counts are
  prose-recorded, not census patterns; the prose rows updated in the same
  change (the live table's fifth `watchStorageKey` consumer, the menu
  census wording). Battery receipt: three consecutive all-green
  full-battery runs (269 rows each; 114.8/115.0/114.9s).

**The bare-surface gesture batch (Nov 12 2026, user report "Gestures not
working" + user-pinned direction via question tool â "Strip at adoption"
+ "Open for bare shells"; src â contract.js + detection.js + shell.js +
inputs/actions.js + inputs/forge.js; check â gestures +5 rows; README).**
The report's diagnosis came first, and the engine was NOT the defect: the
registry deliberately carries no single-tap pointer family, and
scrub/swipe/dbltap are fullscreen-gated by design, so the first probe's
"engine dead on bare adoption" readings (G1/G2) were wrong expectations â
re-probed against the product's ACTUAL gate surface
(`check/.tmp/bare-engine-probe.mjs`): fs-armed scrub commits a seek, fs
center-dbltap toggles, focused Space toggles, hold-to-speed boosts â all
PASS on a no-controls bare adoption. The real gap is structural and lives
only with `controls` present: **the UA controls widget consumes
pointerdown/up inside its closed shadow tree before the page sees them in
EVERY posture** â re-measured under the fullscreen gate too
(`check/.tmp/bare-ctl-fs-probe.mjs`: C1 only stray `pointermove`s escape,
C2 no seek), so a controls video has no gesture surface anywhere and the
keyboard plane yields on focus (the earlier double-act arm). User
direction resolved both product questions: the tier strips `controls` at
adoption (restore on destroy), and the fs-flagged intents open in normal
view for bare shells.

- **The surface takeover (shell.js).** `#adoptBareSurface()` in the boot
  step list, bare identity only (`BARE_SDK_NAME` â now contract
  vocabulary, moved out of detection.js so the shell plane and the input
  gate read the adoption identity from the one source): one IDL write
  `video.controls = false`, restore deferred onto the destroy scope â
  every teardown path (kernel destroyAll, destroy-readopt, abandon-boot)
  hands the video back native. `enterFullscreen()` is the bare surface's
  fullscreen entry (the stripped controls took their button with them):
  `container.requestFullscreen()` under user activation, rejection
  surfaced by the existing fullscreenerror watcher; SDK shells never call
  it.
- **The gesture-space gate (actions.js).** `IntentGates` owns the bare
  fact (`setBareSpace`, set once per shell at the one `attachInputActions`
  call site, riding the one-shell-per-realm law); `gateOpen` folds
  `spaceOpen = fs || bare`, the snapshot stamp compares against the
  composite, and the exported `spaceOpen()` replaces every engine `fs`
  read for intent eligibility â the bare shell's fs-flagged intents
  (scrub/swipe/dbltap/pinch rows keep `fs: true`) arm in normal view
  because their gesture space IS the adopted surface; SDK shells keep the
  fullscreen-only law byte-identical. `isBare()` serves the zone
  reference: a bare surface's edge zones resolve against the VIDEO box
  (the cached press rect), not the viewport â the behavioral edge
  consumers are no longer fs-only, so the inline telemetry-only zone
  excuse no longer covers the bare shape.
- **The tap family.** `tap: "Tap Play/Pause"` in `GESTURE_LABELS` (the
  sixth family; schema toggle + panel label derive); a `tap-toggle`
  INPUT_ACTIONS row (`fs: false`); the engine dispatches the pooled tap
  detail on an owned plain tap (elapsed < hold timeout, distance â¤ the
  hold-cancel bound); the action layer's `#tap()` refuses non-bare shells
  â an SDK player's click-to-play is its own native surface, so the
  dispatch is inert there by consumer contract, and the prevent-scope
  rule still passes the plain tap's whole native stream through
  untouched. `#dbltap` gains the bare normal-view arm: center dbltap IS
  the fullscreen entry; in fullscreen the existing semantics stand. The
  keyboard yield arm needs no change â it live-reads `el.controls`, and
  the strip removes it.
- **Check rows.** gestures case second boot (controls fixture + real blob
  feed): strip at adoption, tap toggles in normal view, scrub commits a
  seek in normal view (no fs stub â the space gate itself is the row's
  subject), center dbltap enters REAL fullscreen (the gesture supplies
  the activation; no stub), video removal destroys the shell and restores
  controls (held detached reference â the restore writes the attribute
  back on the removed element). The discovery blob fixture carries no
  `controls`, so its four rows are untouched by the strip. The bare-surface
  boot rides the manual boot ceremony (the discovery case's `bootAttempt`
  shape) â the stage's `boot()` throws when no shell attaches, and the bare
  tier needs the blob feed BEFORE the shell can exist.
  The forge-bar batch (Nov 13 2026) added six bare-bar rows after the
  dbltap row's fs exit: the bar stays shown inline with the ENTER verb on
  the 7th button (fs exit re-pokes the bare leg; the paused hold parks it
  too); the same idle sweep applies inline (playing + pointer away hides
  at ~2.5s, the next pointermove reveals); a trusted tap on the enter
  button enters REAL fullscreen with the button flipped to EXIT (focus
  asserted first â the recorded document-not-focused denial class; events
  compared as a delta over the earlier rows' seeds); the time readout tap
  dispatches zero gestures and moves no clock (the video parked so the
  readout is a stable witness; bar visibility asserted so a hidden bar
  cannot turn the tap into a vacuous video press); the range drag commits
  the seek through the native input path with zero gestures (the
  committed clock must track the dragged thumb â t â value â and the
  value must sit at the drag target's ~80% band; the thumb's start
  position varies with earlier rows, so a before-delta is not the
  contract). Bar-interaction neutrality rides the engine's hud rejection
  (`isInsideShell` â `rejected = "hud"`), the same mechanism the forge
  probe's E1 rows pin in fullscreen. The enter icon itself was redrawn
  onto the exit twin's 512 grid (same corner boxes 64..192/320..448, arm
  thickness 42.667, 64px margins; enter arms hug the corner box's outer
  edges, exit arms the inner edges) â the old path was 299Ã341 ink on a
  "0 0 300 280" viewBox, clipping the bottom ~20% of both bottom corners
  and sitting edge-to-edge against the twin's 12.5% margins. The render
  is pinned at the shown-bar postures (a hidden bar's `getBBox` reads
  zeros, so the hidden I0 posture pins the viewBox attribute only): the
  probe's S1 row asserts the exit twin's live bbox (64..448), the
  gestures B1 row the enter verb's.
- **The RO-churn fix that rode the batch (src â kernel/discovery.js).** The
  gestures case is the first case to END on a bare page, and the audit net
  reads only the case's final page â which surfaced a pre-existing bare-tier
  burst: 12â13 Firefox "ResizeObserver loop completed with undelivered
  notifications" page errors per bare boot. The mechanism: for a present +
  already-minimum-sized but identity-less candidate, `VideoProbe.#consider`
  re-watched it in the layout gate â the gate delivered immediately (the box
  already qualifies) â re-ran `#consider` â re-watched â an
  observe/deliver/re-observe cycle per media event, and re-observing a
  target inside its own delivery is the exact shape the spec limits to one
  delivery per frame (one error per cycle). The accidental cycle was ALSO
  the bare tier's accidental identity poller: the media tap listened only
  for loadedmetadata/loadeddata/play, and `play` fires when play() is
  INVOKED â before playback starts, so `played.length` is still 0. The fix
  is two-sided: the watch guards skip re-watching a present + minimum box
  (`#consider` tail and `#finish`'s null-sdk arm â the latter's caller
  `#tryFinish` proved the box one call-frame earlier), and `watchMediaEvents`
  gains `playing` + `timeupdate` capture listeners â the events where the
  played leg can actually complete. Both fire only while playing, and every
  consider short-circuits at the identity+size check once a candidate
  qualifies, so the steady-state cost is the repeat path's one WeakMap read
  per event until the boot fires. Floor-probed clean (bisect probe: the
  exact discovery blob page boots AND reports errs=0 on both the margin and
  no-margin shapes; the no-userscript control never fired the burst, and
  the pre-fix observation logged the 13 watch cycles at ~8ms cadence).
- **The focused-document denial (check only).** The dbltap-fullscreen row
  failed 3/3 in the battery while passing every probe replica; failure-time
  diagnostics (gesture-event recorder + a `requestFullscreen` rejection
  wrapper) pinned it: taps + dbltap all dispatched, activation
  active+transient, but `TypeError: Fullscreen request denied` â the spec's
  document-not-focused rejection. A headed battery run minutes deep loses
  OS focus to the user's own window; a fresh-launch probe never sees it
  (the same environment-correlation class the hidden-flush clock row once
  recorded). Fix: `BrowserSession.focusWindow()` (driver.mjs â switchTo on
  the current handle plus the tiling manager's focus verb, best-effort)
  called before the row, and the row note carries
  hasFocus/activation/gesture/fs-event state on fail. The inline hold row's
  one-off empty-recorder failure the same pair of runs was the same class
  at a different row and did not recur in any subsequent run.
- **No counted census row moved** (no new listener/observer/timer
  vocabulary; the tap dispatch rides the pooled per-family detail; the two
  new media-event listeners ride the existing page-lifetime controller).
  Battery receipt: three consecutive all-green full-battery runs (274 rows
  each; 121.0/121.4/121.0s).

**The responsive-posture batch (Nov 14 2026, user direction "focus on css
and how to make our forgebar and HUD preserve their layout with different
devices' screen sizes responsively"; src â styles.css + mount.js pocket;
check â new `responsive` case; adoption landed).** The review found the
adaptive system entirely one-sided: the PANEL carried five viewport blocks,
two container bands, and the compact bus, while the FORGE BAR carried zero
responsive adaptation â fixed 56px height, fixed 40px targets, a 63px time
readout â with a measured overflow onset at a ~323px stage (the floor
probe's sweep: range starved to 39px at 360, 0px + scroll overflow at 320,
32px child spill at 280; fixed chrome â 305px over 5 targets, not 6 â
back/play/fwd/settings/mode). The bar's geometry is stage-true (the hud IS
the player region), so the fix is container bands, not media queries.

- **The floor probe** (`check/.tmp/responsive-probe.mjs`, real bundle + GM
  ceremony, uncommitted per sweep convention) swept stage widths 640â160,
  stage heights 400â180, fullscreen at a small window, and the panel across
  embed regions and the portrait breakpoint edges. Floor facts it pinned:
  (a) `container-type: size` block-size queries evaluate on this engine in
  a plain `<style>` â the height bands are viable; (b) the bar overflow
  onset arithmetic above; (c) the bar height is fixed 58px (56+2 borders)
  at every stage height â 32% of a 180px picture; (d) the panel is already
  fully contained on the fine-pointer path at every embed region and
  window edge measured (`calc(100% - 24px)` / `calc(100% - 16px)`); (e)
  fullscreen bar healthy at full-screen width (the window cannot shrink a
  real fullscreen â the stage-true bands cover small screens there).
- **The width ladder (pocket bands over `pf-stage`, each threshold the
  width the previous one buys back):** `â¤400px` tightens chrome (padding
  sm, gap 2px â targets untouched; onset 323â~305); `â¤340px` hides the
  time readout (onset ~240); `â¤260px` shrinks the targets to 32px (18px
  glyph; the 24px AA floor band â a region this narrow cannot carry five
  40px targets plus a range; onset ~200). Below ~200 stays degenerate by
  design. Bands live in the container pocket (size conditions never
  evaluate inside the adopted sheet) and touch only shadow-hud classes, so
  the document-realm adoption stays inert like the panel pockets.
- **The height tier (`â¤280px` tall, pocket):** `--pf-forge-bar-h: 44px` +
  `--pf-forge-bar-inset: 6px` set on BOTH `.pf-forge-bar` and
  `.pf-cue-layer` â the bar reads its height var on itself while the
  sheet's cue-shift rule reads the vars on the cue layer, and a container
  cannot style itself, so no single element both consumers can inherit
  from. Enabled by switching the hud's stage container `inline-size` â
  `size` (inset:0 makes both axes content-independent â the containment
  requirement â with zero geometry change).
- **The coarse-path panel bounds (static fixes, record-only headless):**
  the bottom-sheet block's `min(62vh, calc(var(--pf-vv-height, 100vh) â¦))`
  and the landscape block's `70vh` are window readings â on an embedded
  player the region can be far shorter than either â so each gained
  `calc(100% - 2 * var(--pf-space-md))` as the final min() arm; the
  pocket's compact bottom-sheet gained the same bound plus the R6 radius
  token (`var(--pf-radius-lg)`, replacing the pre-token `14px` literal).
- **The `responsive` case (8 rows):** baseline fit + full chrome at 640;
  computed band values live at 390/320/240 (gap 2px, padding 6px, time
  hidden, 32px targets); the height tier's bar + cue-shift token coherence
  (44px/50px) and its byte-true release (56px/64px); overflow refusal
  (spill 0, scroll clean) at every swept width; panel containment at
  330Ã240 and 300Ã200 embed regions. The page is the bare-tier shape â
  the bare shell's bar is the inline control surface, visible while
  paused, so the geometry rows need no fullscreen stub.
- **No counted census row moved** (no listeners/timers/Fans; the bands are
  sheet+pocket declarations). Battery receipt: four consecutive all-green
  full-battery runs (282 rows each; 134.1/134.1/134.2/134.2s).

**The bar-flip batch (Nov 14 2026, user direction "forge bar to disappear
after 1.5 seconds from lose focus" + "subtitle cues aware of the bar when
visible and reposition well"; src â core.js + subtitles.js; check â
subtitles +1 row; adoption landed).** Two changes, one timing and one
trigger:

- **The idle window: 1.5s.** `TUNING.forgeBar.hideMs` 2500 â 1500 (the one
  constant; both use sites in forgebar.js read it). The bar is an overlay
  band across the picture's bottom, so the covered cue band stays short; a
  hold release (pointer leaving the bar, focus out, resume) re-arms a fresh
  window, so "1.5s from lose focus" is exactly what ships. The WCAG 2.2.1
  holds stay byte-identical â hover/focus-within/paused park the sweep,
  and the paused hold is load-bearing: the bar is a paused surface's only
  control strip (a bare shell stripped its native controls).
- **The cue-canvas RO: the paused gap's one trigger.** The cue-awareness
  machinery already existed â the sheet's `:has()` sibling rule lifts the
  cue layer's `bottom` by the bar band while the bar is visible, and
  `#derivePicture`'s universal clip ends the picture at the canvas box, so
  percent-anchored slots re-anchor on the next render. The gap was the
  trigger: while playing the presented-frame crank re-derives per frame,
  but a paused video presents nothing, and a bar flip touches neither the
  video box nor the ReferenceBox (the video-relative RO and the fill-box
  tick both stay silent) â a paused shell's slots hung stale over the bar
  until the next cue/seek event. `ForgeTrack` now carries a cue-canvas
  ResizeObserver (its own box change IS the canvas fact; the render writes
  slot styles only, absolute children, so the layer never loops it),
  signal-scoped with the other observers. This also covers the
  height-tier token changes and env insets under the same observer.
- **Check row** (subtitles case, the last row): the fixture reshapes to a
  picture-to-bottom stage (video height = its 16:9 picture height) so the
  bar's 64px band overlaps the picture; the video parks paused inside the
  scale cue window so slot 0 stays lit; the bar's `hidden` attribute
  flips directly (the same attribute #show/#hide write) â the row
  machines the rendering path, not the visibility policy. Expected tops:
  557.0 baseline â 499.5 with the bar visible (picture clipped at
  619-64), slot bottom above the bar's top edge, and the restore back to
  557.0. The paused posture is the row's isolation: with the crank
  running, the flip would be picked up next frame regardless.
- **No counted census row moved** (no Fans/Scopes/timers; the static
  registration site count moves 124 â 125 in Â§5.6's prose â the
  cue-canvas RO). Battery receipt: four consecutive all-green
  full-battery runs (131.7/131.8/131.3/131.5s; 290 all-gate PASS rows
  each, stable across the three counted runs - the +1 case row over the
  prior tree, whose same-method A/B reading is 288; the historical
  record figures predate this count basis).

**The shadow-native / clone-warp probe (Nov 14 2026, user-directed "explore a
new record-only probe batch for Firefox-specific native surfaces: shadow
piercing (>>>), the clone/move family, other unexplored native operators";
post-`81ae26f`, record-only, no src change, audit-clean).** Interpretation
note recorded up front: "clone warp" is read as the clone/move modern-DOM
family (structuredClone, cloneNode/custom-element semantics,
`Element.moveBefore`) â if the direction meant a different surface, the
record re-aims. Consumers grounded BEFORE probing (the batch method â a
candidate must name a real tree consumer first): detection.js's composed arm
(`#fillComposedChain`/`#matchSdk`, the upward parentNode/.host walk),
discovery.js's `videoFromEvent` composedPath scan and its two seed walks,
dom.js's `deepestActiveElement`/`isInsideShell` compositions, ui.js's ONE
DOMParser site (icon markup, XML mode, target-realm resolution, WeakMap
cache), the ~20 `setAttribute("aria-*")` construction sites through the
generic attr helper, and toast.js's cloneNode template derivation. Artifacts:
`check/.tmp/shadow-native-probe.mjs` (a 4-axis PLAN runner â PIERCE,
CLONEWARP, QUADS, SURFACE; every body self-contained and booleanized) and
`shadow-native-report.json`, uncommitted per sweep convention. Harness
lessons worth holding for any future floor probe: a returned DOM element
serializes as a WebDriver element reference that goes STALE once the axis's
own fixture teardown runs before the script completes (the first PIERCE draft
failed "element no longer attached" on exactly that â booleanize every
element read); and the boundary fixture must be BUILT light-DOM-anchor-above-
host â the first draft's anchor sat inside the video's own shadow tree,
where `closest()` trivially answers and the boundary row tested nothing.
Verdicts, one per axis:

- **(PIERCE) `>>>` is not on Firefox 160 in any query surface, and the
  upward crossing detection.js's composed arm needs has no native operator
  at any posture.** `querySelectorAll("body >>> *")`/`matches`/`closest`
  with the combinator all throw `SyntaxError`; `CSS.supports("selector(div
  >>> video)")` and `:has(>>>)` are false. The combinator, even if shipped,
  is DOWNWARD-piercing â it could only have served the seed walk
  (`document.querySelectorAll("video")` measurably misses a shadow-internal
  video; MO `addedNodes` carries only the host div), and that gap is a
  known shape, not a defect: a shadow-internal video is discovered by its
  media events through the composed path (videoFromEvent's premise â media
  events don't bubble but document capture listeners receive them composed,
  where the host retargets `target` away), so adoption is delayed only
  until first play/loadedmetadata, exactly the path the feed already rides;
  a hand-rolled root-walking seed is new machinery against a covered case
  (the lean-boot record's shape). Boundary witnesses confirmed: closest()
  stops at the ShadowRoot (`anchorAbove: false` with the anchor in light
  DOM above the host); `getRootNode()`/`root.host` are the primitives the
  composed arm rides.
- **(PIERCEb) dom.js's shadow compositions stay â no native replacement on
  the floor.** All four witnesses hold: `document.activeElement` retargets
  to the HOST on shadow-internal focus, `shadowRoot.activeElement` reads
  the real focus (why `deepestActiveElement` exists), `host.contains()` is
  blind across the boundary while `shadowRoot.contains` sees (why
  `isInsideShell` exists). These are the composition of the only
  primitives the floor ships.
- **(CLONEWARP) the clone/move family re-witnessed, no unexercised
  consumer.** structuredClone present (the D4 decline's re-price lives in
  the 160 small-run, not re-measured here). A clone of an upgraded custom
  element is upgraded AT CLONE TIME (`instanceof` true pre-insertion) and
  runs `connectedCallback` on insertion (conns 1â2); the shadow root does
  NOT travel with the clone (spec). No tree site clones a custom element
  (toast's cloneNode derives SVG markup; the pooled elements are never
  cloned with lifecycle), so the semantics are recorded, unexercised.
  `moveBefore` cross-parent re-witnessed on 160: performs the re-home
  WITHOUT throwing, flips the parent, and delivers the standard r1/a1
  record pair â the J/L3 + 160 record stands byte-true.
- **(QUADS) the box-quad family is GONE from Firefox 160.**
  `Element.getBoxQuads`, `document.getBoxQuads`,
  `CSSStyleDeclaration.getBoxQuads`, and `getTransformTo` are all
  undefined. The one genuinely unexplored native geometry read â which
  could have answered the S3 transform-split natively (gBCR re-measured
  carrying the ancestor scale(2): 100Ã50 â 200Ã100 while offsetWidth
  stays 100) â is absent from the engine; the S3 premises stand
  hand-derived.
- **(SURFACE) the shipped-without-consumer sweep, each declined on
  consumer absence so none re-opens silently:** scrollend (shipped on
  window + document; ReferenceBox's per-event scroll invalidation is
  mid-scroll origin truth â scrollend alone leaves anchors stale through
  the scroll, and the per-event invalidate already covers the
  end-of-scroll instant at zero layout cost); invoker commands (shipped:
  `command`/`commandForElement` IDL + `CommandEvent`; the shipped command
  vocabulary covers popover/dialog verbs only â no media commands exist
  for play/pause/seek, so the forge bar's `data-action` router keeps
  owning every verb it carries); ARIA IDL reflection (shipped, reflected +
  null-clear verified; the ~20 aria sites ride the generic attr-map helper
  at construction rate â property special-casing forks the one
  construction surface for zero behavior change, the attribute form
  stays); `Document.parseHTMLUnsafe`/`getHTML`/`setHTMLUnsafe` (shipped,
  parseHTMLUnsafe shape verified â static, returns a Document, parses SVG;
  the ui.js icon site parses build-static SVG markup in XML mode via the
  target-realm DOMParser behind a boot-rate WeakMap cache, so a switch
  changes the parse grammar XMLâHTML for zero measured gain â declined);
  `showPicker` (shipped; no input-picker consumer); `Intl.Segmenter`
  (shipped; the title sanitizer is code-point-regex by design, no grapheme
  consumer); `Array.fromAsync` (shipped; no async-iteration consumer);
  TreeWalker (long-shipped; `querySelectorAll` is already the native
  drain, the loop-body walk's recorded shape); rVFC + `cancelRvfc`
  (re-witnessed shipped, already consumed by the crank â witness only);
  `navigator.userActivation` (present â witness only).

Sweep disposition: record-only, no src change earned adoption â the
shadow-piercing direction is closed by engine absence (and the covered-case
decline for the seed-coverage gap it could only partially have served), the
clone/move family has no unexercised consumer, the geometry candidate is
absent from the engine, and every shipped-without-consumer operator is
declined on consumer absence. The Native-first bar's
implementation-IS-the-operator reading gains one more floor fact: on
Firefox 160 there is no selector vocabulary that crosses a shadow boundary
upward, so detection.js's composed arm is the only shape the floor permits.
Battery receipt: src untouched; the batch rides one green full-battery run
per the record-only rule.

**The forge-mode floor probe (Nov 14 2026, user direction "explore batch for
forge mode" pinned to the record-only floor-probe shape via the question
tool; post-`c629e5a`; one adoption landed with user direction).** The
fullscreen plane's engine premises re-derived on Firefox 160 — the fs gate,
the forge bar's mode swap, the document-realm hide rule, the ancestor
provisioning chain — plus the unexplored fullscreen vocabulary. Artifacts:
`check/.tmp/forge-mode-probe.mjs` (FM1âFM4 legs) and
`forge-mode-report.json`, uncommitted per sweep convention. Consumers
grounded BEFORE probing: dom.js FsGate `#truth()` (fullscreenElement read
per event), shell.js `enterFullscreen()` (container.requestFullscreen under
the gesture's activation; rejection rides the fullscreenerror watcher),
styles.css's `:fullscreen` hide rule + letterbox floor, page.js's
allowfullscreen provisioning. Real fullscreen rode REAL trusted input
(focusWindow + driver click / Escape) â the recorded harness lesson.

- **(FM1) enter/exit substrate.** Script-launched `requestFullscreen()` on a
  FOCUSED page with no user activation rejects
  `TypeError: "Fullscreen request denied"` (the repro shape the fs-scrub
  harness lesson recorded, now named). Trusted click enters real
  fullscreen; `fullscreenElement` is set AT event-delivery time (the
  FsGate premise holds); the event fires AT the element and bubbles to the
  document listener (target = the element, not document); the entry
  promise resolves first (~22ms) with the event ~0â6ms later; on exit the
  promise resolves first too and `fullscreenElement` is ALREADY null at
  the exit event (the gate's read-per-event law is measured-necessary â a
  captured element at the exit event would be a stale read).
- **(FM2) the styling plane.** `:fullscreen` matches only the fullscreened
  element (video/ancestors/body false; `matches()` honest); the shipped
  `[data-pf-shell]:fullscreen` position replica wins over the container's
  inline `position: relative` (the rule's own why-comment, re-proven);
  the hide-rule replica is live (chrome dies, the marked video chain
  survives, outside the subtree untouched â the marker must sit on a
  marked DESCENDANT, the first draft's miss, because `:has()` cannot see
  the fullscreen element's own attribute); `::backdrop` is
  computed-readable and styleable (default rgb(0,0,0), rule-set
  rgb(1,2,3)).
- **(FM3) the frame plane.** A granted cross-origin child enters
  fullscreen on a trusted click inside it, and the TOP document's
  `fullscreenElement` is the IFRAME element (matching `:fullscreen`) â the
  premise the kernel's diagnostics dump rides when it reads
  `document.fullscreenElement` in the top realm during a child
  fullscreen. Native Escape exits the whole chain. No-grant rejects the
  same `TypeError: Fullscreen request denied` class and delivers
  `fullscreenerror` in the CHILD document only (the top document saw no
  error event) â grounds both the provisioning chain's grant shape and
  the watcher's realm-local ownership. Harness finding worth holding:
  **Marionette's viewport-origin pointer actions dispatched from the top
  context DO NOT retarget into a cross-origin child** â the synthesized
  pointerdown landed on the TOP document at coordinates where
  `elementFromPoint` returned the iframe (measured twice), and the child
  received nothing; the WebDriver context switch (`switchTo().frame()` +
  a real element click in the child context, the same machinery
  `evalInFrame` rides) is the working route for trusted input into a
  cross-origin frame. A same-origin srcdoc iframe entered fullscreen with
  NO `allowfullscreen` at all â the permissions default allowlist is
  `'self'`, so the attribute is only load-bearing for cross-origin
  embeds; the legs were re-aimed at the dual-loopback origin.
- **(FM4) the vocabulary sweep.** Legacy booleans both false
  (`document.fullscreen`, `window.fullScreen`);
  `:fullscreen-ancestor` NOT shipped; `screen.orientation.lock` present,
  `navigator.keyboard.lock` absent (witness only â the orientation-lock
  companion retired by direction stands).

**Adoption: the letterbox floor's `background: #000` arm carries
`!important` (styles.css).** The arm had no `!important` while its four
position siblings do, so an SDK page styling its container by ID
(`#player { background: ... }` â a common shape) won on specificity
(attribute selector loses to ID) and left the fullscreen letterbox bands
the page's color instead of the floor: measured rgb(34,34,34) with the
replica, `!important` control restores rgb(0,0,0) (FM2). The flag is the
same page-specificity defense the position arms ride; legit flows
byte-unchanged. Battery receipt: 3 consecutive all-green full-battery
runs (132.3/131.8/131.7s) after one environment-correlated gestures flake
(0 shells at the bare-surface page, the recorded focus/timing class, not
recurred in any subsequent run).

The series'
record-only commits changed
AGENTS.md alone; every src-touching pass proved
itself on the full gate battery before its commit.*
