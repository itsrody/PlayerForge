# AGENTS.md — PlayerForge, the complete guide

Read this before touching code. It describes what the product is, how every
module fits together, the conventions that decide "is this a good change", the
full refactoring path the tree has walked (the OOP development program), the
HUD design law that still binds any visual change, and the testing tool that
proves a change real. Sections 1–3 and 5–8 are load-bearing; section 4 is the
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
  excluded in the header (YouTube, Vimeo, Netflix, streams, socials…), and
  `entry.js` keeps a runtime skip list above that.

**Repo shape (23 source modules, ~15k LOC):**

```
src/
  entry.js            install-time contract: which frames run the script
  kernel/  (4)        contract, detection, discovery, kernel orchestrator
  shared/  (5)        core, runtime, dom, page, store — the data planes
  shell/   (14)       shell, media, resume, filter, forge+actions,
                      subtitles(2), chrome(5 + styles.css)
check/                the one testing tool (see §7)
dist/                 generated, not the review target
esbuild.config.mjs    single build: IIFE userscript + css resource
```

**Shipping artifact** (`dist/playerforge.user.js`, ~165 KB one IIFE +
`dist/playerforge.css` via `@resource pfStyle`): match-all userscript with a
24-pattern exclusion list (`@exclude-match`, VM's strict match-pattern
surface — the old `@exclude` glob any-character semantics is why the bare
apex pairs existed; the released matcher's `*.` covers the apex), 8 grants
(`GM_setValue/getValue/registerMenuCommand/unregisterMenuCommand/
addValueChangeListener/removeValueChangeListener/getResourceText/
xmlhttpRequest`), `@connect *` + subtitlecat,
**`@run-at document-start`** (real under VM's MV2 registration),
deliberately **no `@noframes`**: every frame gets the script (§2).
`@downloadURL` pins the branch dist for VM's updater. Version is
derived from `package.json` by the build; never hand-edit the header version.
The bundled sheet rides the hand minifier (`minifyCss` in esbuild.config.mjs),
whose whitespace stripping carries two grammar-critical preservation rules
(build-pipeline A→Z sweep, probed on the floor): the run before `(`/`:` is
kept when an identifier-ish character precedes it — dropping it merges two
tokens into one, `) and (` into the function token `and(...)`, which Firefox
silently rewrites to `@media not all` (a media row that never applies; the
coarse-pointer bottom-sheet rows shipped inert for releases under this bug),
and the run after `)` is kept when a letter or `+`/`-` follows — calc's `+`/`-`
infix demands whitespace on both sides of the operator even after a paren
(`)+ var(` dies at substitution time: the probe read the computed fallback
where the spaced form computes). Stripping elsewhere still collapses to one
space; calc arithmetic and descendant selectors survive as single spaces. The
shipped damage this fixed: the bottom-sheet row's `bottom` and `max-height`
calcs and the landscape coarse compact-panel row were all inert. The bundle
gate pins both glue signatures as a static artifact row.
The header↔runtime cross-check (sweep): the 8 `@grant`s map 1:1 onto real
call sites — setValue/getValue/addValueChangeListener/removeValueChangeListener
(store.js's storage plane), registerMenuCommand/unregisterMenuCommand
(kernel.js's MenuCommands), getResourceText (inject.js's `pfStyle` warm),
xmlhttpRequest (store.js's `gmRequestText`, the CORS-bypass subtitle ingest);
`GM_info` needs no grant (entry's version mirror) and `GM_setClipboard` is
deliberately absent — the store.js docstring's dead-permission-surface record
and the banner agree. There is exactly one network egress family in the tree:
the subtitle `loadFromUrl` path, user-supplied URLs from arbitrary hosts,
which is what `@connect *` is FOR; there is no plain `fetch` or
XMLHttpRequest anywhere in src (all cross-origin text rides the manager, whose
Firefox-MV2 wrapper honors `timeout`/`ontimeout` and gates nothing). The
explicit `@connect subtitlecat` line predates the umbrella (`004bd6e`, a
per-domain pre-approval) and has no dedicated caller left — inert
documentation under the matcher, kept as a header surface (header edits are
interventions; sweep #5 re-verified the apex-coverage matcher semantics this
rests on). **The network floor is census-pinned (sweep #6)**: the census
stage derives the src-side counts (one `GM_xmlhttpRequest` relay site, one
`gmRequestText` consumer = the `loadFromUrl` voucher, zero plain
`fetch`/XHR/WebSocket/EventSource/`sendBeacon`/`importScripts`, zero
`.src =`/`srcset`/`createObjectURL` and script/iframe/img/track/link element
creation — closing the DOM-shaped channels the API can never grant — plus the
one `file.text()` drop-ingest read), and the bundle stage pins the header
half (exactly 2 `@connect` lines with the `*` umbrella among them; exactly 1
`@resource` — pfStyle is the one manager-fetched asset).

**Sweep #7 record (manager floor, premise-level, all verified against
Violentmonkey master at the v2.50.0-era HEAD — the same release the floor
names).** Five runtime premises the tree encodes as literal manager behavior,
each now source-cited: (1) the **echo contract** — `src/injected/web/
gm-values.js`: own writes call `notifyChange` with `remote = false`; the
background's `UpdatedValues` broadcast (`src/background/utils/values.js`) is
sent to every opener frame of every tab (sibling frames of the writing tab
included) and re-fires hooks through `changedRemotely(..., remote = true)` —
and self-receipt is deduped structurally: the writer's own `bridge.storages`
was updated at write time, so its broadcast re-read finds `oldRaw === raw` and
never re-fires (the "own-write echo arrives exactly once" shape the `gm` case
proves empirically in both directions); per-callback try/catch isolation is
the released behavior. (2) **the xhr relay gates nothing** — `src/background/
utils/requests.js` consumes no `@connect` vocabulary anywhere in the
background/injected request pair (`vetUrl` is URL-shape validation, not
host consent; the only "connect" in the pair is a forbidden-header regex), and
`timeout` is clamped and honored with `timeout` in `EVENTS_TO_NOTIFY` so
`ontimeout` propagates — the premise behind the store.js docstring and the
`gm` case's ontimeout row. (3) **the frame model's manager premise** —
`src/manifest.yml` the Firefox MV2 build ships `matches: <all_urls>`,
`run_at: document_start`, `all_frames: true`, byte-confirming "every frame,
top and cross-origin iframes, runs the full bundle". (4) **the `GM_info`
mirror** — `src/injected/web/gm-api-wrapper.js` sets `scriptHandler =
VIOLENTMONKEY` and `version = VM_VER`; the `gm` case's handler assertion and
entry.js's version mirror are manager-truth reads, not constants. (5) **the
matching surface** — sweep #5's `tester.js` record covers this floor's
matcher (`*.` apex coverage, strict `@exclude-match`). These premises are
what make Tampermonkey/Greasemonkey ports non-trivial: each is a
released-source behavior the runtime treats as given, and re-auditing them
against a different manager means re-proving each file's semantics from
that manager's released source (see the sweep's remote-verification
artifacts under `check/.tmp/`, left uncommitted per convention).

The two exclusion vocabularies are complementary, not
redundant: the 24 `@exclude-match` patterns ban the player *platforms* the
match-all lets sitewide, while `entry.js`'s runtime skip
(`AD_HOST_SUFFIXES`/`AD_HOST_PREFIXES` + the about:blank/data: gate) does the
hostname-anchored work the header cannot — rejecting ad/captcha *frames* of
sites the header allows, whose hostnames may appear only in a path or query
of a legitimate video page.

**Sweep #5 record (exclusion-vs-registry non-overlap, audit-clean).** The two
ban surfaces were cross-checked against the 15-record `SDK_REGISTRY` per
banned platform, both directions exhaustively: (A) no host is spelled on both
surfaces — `facebook.com`/`fb.watch` (header, platform) vs `facebook.net`
(runtime skip, the SDK-loader embed family) are complementary families, not a
dual spelling; the skip's 10 suffix families + `adservice.google.` prefix
touch no header pattern and vice versa. (B) no record is unreachable behind a
ban — every banned platform runs a proprietary player (studio DRMs, feed
players, the bilibili in-house player that is not the third-party DPlayer SDK
it shares history with; v.redd.it serves bare video files, correctly unbooted
under the no-generic-fallback law), and record identity rides names + CSS
anchor vocabulary, which cannot host-match — no record scopes a banned host.
The sweep also re-verified the matcher ground truth the banner comment rests
on against Violentmonkey's released source (`src/background/utils/tester.js`):
`hostMatcher()` maps `*.` to `RE_STR_ANY = (?:|[^:/]*?\.)`, whose empty
alternative covers the apex domain, so `*://*.youtube.com/*` bans
youtube.com itself; `RE_GLOB_HOST_SUFFIX` rejects trailing-`*` TLD hosts in
favor of the `.tld` vocabulary — none of the 24 patterns is at risk. No gate
row added: the bundle stage already pins the strict `@exclude-match` surface
(and fails on any `@exclude` glob returning), and the audit surfaced no
further machine-enforceable invariant — the check's artifact is this record
(`check/.tmp/overlap-audit.mjs`, left uncommitted per sweep convention).

**Commands:** `npm run build` (or `--watch`), `npm run lint` (eslint src/),
`npm test` — the alias for `check/run.mjs`, the repo's one testing interface.
`npm run check:browser`, `check:flaws` (the syntax+flaws pair),
`check:census` — the individual quick gates.
A clean run is ~60s.

---

## 2. Frame model (the most load-bearing fact)

The manager injects the script into **every frame** of every page — top and
iframes, same-origin and cross-origin:

- Each frame document runs the full bundle: its own kernel, its own bridge
  installation, its own GM realm. A kernel boots only when **its own
  document** holds a qualifying video, and it adopts exactly **one main
  video per document** — the product's scope law: the first qualifying
  candidate wins (detection + presence gates order = the pick), later
  qualifying candidates are refused while a shell is live or mid-boot, and
  the registry-empty edge re-arms discovery so the next candidate adopts
  when the main leaves. Enforcement is **per document only** — cross-frame
  coordination machinery does not exist, so a Top video plus a
  separate-iframe video still yields two shells. Exactly one document boots
  a shell per embedded player, neighbors stay inert, and a video-less host
  page never boots.
- Menu commands install **top-frame only**.
- `window.top !== window` frames push fullscreen provisioning up the chain on
  shell creation: every ancestor document grants `allowfullscreen` on its
  *direct child* iframe only (`installContextBridge` /
  `requestFullscreenProvision` in `page.js`).
- Page context (`domain/path/title`) is read from `window.top` directly when
  same-origin-capable; cross-origin frames go through the frame bridge
  (postMessage `pf:`-prefixed, MessageChannel ports; a nonce-broadcast belt
  survives only for a genuinely refused port transfer, with no chain memo —
  the refuse-to-remember arm retired with its jsdom premise), so the resume
  entry always carries the **top document's** context. Zero timed retries:
  the bridge resolves event-driven — one send,
  then a `pf:ready` announce-down (install + relay echo to pending
  requesters, parent-hop-limited) re-issues requests and re-arms latched
  fullscreen provisions when an ancestor's handlers armed late; an
  ancestor's armed state is script-fact invisible to layout, so the
  announcement is the real reading (the deadline watchdog settles null for
  bridgeless embeds). The bridge's returned teardown is deliberately never
  consumed at its entry install — the same page-lifetime arrangement as the
  kernel shell-ready handle: the bridge must stay armed across kernel boots
  and bfcache restores, and a real unload disposes the realm with it. When
  nothing answers, the frame falls back to its own
  context rather than losing resume.
- Navigation: `pagehide` tears the kernel down unless `event.persisted`
  (bfcache keeps it); `pageshow` re-arms it — restoration re-adoption rides
  the orphan reconcile (`#reconcileOrphan`: a detached shell video is
  destroyed and the registry-empty edge re-arms the full discovery tap) —
  and the non-persisted hide tears the probe's capture listeners down with
  the realm (entry.js). The bfcache/freeze-recovery plane sweep (A→Z) probed
  the Page Lifecycle vocabulary on the floor: **Firefox 159 exposes
  `freeze`/`resume` in no realm and has no `document.wasDiscarded`** —
  Chromium-only surfaces — so every arm keyed to them retired: the kernel's
  `resume` reconciliation listener (its work was one duplicate of the
  pageshow reconcile), resume.js's `freeze` flush, forge.js's `freeze`
  session interrupt (blur + `visibilitychange` hidden cover the swallow
  classes on Firefox; the freeze interrupt could never add a third onset),
  and `#onPageShow`'s `wasDiscarded` guard clause (a Chromium discard-restore
  is a reload — a fresh realm boots a fresh kernel — so the clause bought no
  reconciliation even hypothetically). Recovery on the floor is exactly:
  `visibilitychange` hidden + `pagehide` flushes (the pagehide belt is live
  on the persisted leg only — a real pagehide dispatches the kernel's own
  pagehide listener first, whose scope dispose aborts the tracker belt
  mid-dispatch, and that leg's final save rides the shell destroy inside
  the kernel's destroyAll), persisted-hide state preserved, `pageshow`
  reconcile + registry-empty re-arm.

## 3. Module map (A→Z)

### shared/ — five data-shaped planes, import-clean of each other
- **core.js** — clamping `P()`, tuning constants (`TUNING`, resume cadence,
  gesture timings, `RESUME_*` floors), formatters (`formatTime`,
  `fmtPercentOrOff`, …), error classification, `delay/debounce` moved out
  (they live in runtime's scheduler). Zero imports.
- **runtime.js** — the scheduling engine: a `postTask` façade over
  `scheduler.postTask` (single native arm, no emulation anywhere — the real
  engine is the check's proof surface; the retirement audit is re-probed live:
  no upstream sunset movement, priority tiers honored natively on 159, the
  two-controller shape load-bearing because an abort landing inside the task
  body rejects the completed task's promise, and the `yield_()` guard still
  recovers what raw `scheduler.yield()` rejects in an own-aborted task —
  pinned by the `scheduler` check case), `delay()`/`debounce()` handles (the
  one timer backend), `runSteps`/`runStepsAsync` (ordered declarative step
  lists for every boot/teardown sequence), `Scope` (one destroy-root per
  feature, every listener/timer/observer routed through it; the cleanup
  verb is `defer(fn)` — the platform's DisposableStack vocabulary on this
  floor, with the queue deliberately NOT the platform's: a disposed stack
  refuses late registration where the contract runs it immediately, and the
  platform rethrows disposer errors where the treaty isolates and logs every
  throw; the `#disposed` flag died into `signal.aborted` — the abort flip
  completes synchronously before any listener runs, so a re-entrant dispose
  no-ops from the flip onward), `Fan` — the ONE plain-fan-out
  owner, a native `EventTarget` carrying one event per instance
  (`emit(payload)`/`subscribe(cb, { signal })`; the FsGate, FilterSession,
  ResumeStore, ConfigStore, SubtitleSyncState,
  SubtitleSession, and kernel shell-ready audiences all rode it — the
  kernel's per-listener try/catch retired with the conversion, native
  dispatch isolation is the real thing). Audited census: ten instances —
  kernel shell-ready (entry's page-lifetime only; its returned handle is
  never consumed), FsGate, ReferenceBox change-ticks (exactly ONE
  subscriber: the subtitle renderer; every gesture consumer
  reads-and-discards via `get()` — the emit heat is scroll-frequency but
  one-tap-deep), FilterSession, the three SubtitleState grains +
  SubtitleSession's presentation state, ConfigStore's `settings` bus (the
  echo-storm hot path: 1000 foreign writes ride the robust row inside
  400ms) and ResumeStore's entry set.
  **Subscriber census (the audience axis, recorded alongside the instance
  axis)**: fs-gate 4 (ReferenceBox's fs-flip re-seed, the pinch wheel's
  fill-release, `ViewershipTransform`'s reset, the panel's close-on-fs);
  sync grain 2 (session offset apply + panel stepper echo); placement
  grain 2 (the grain's forward into the session + the panel position
  echo); settings bus 2 (the action layer's hotkey recompute + the
  panel's cross-tab sync); resume store 2 (the sync grain's re-resolve
  via the tracker + the subtitle restore); kernel shell-ready 1
  (multi-boot across destroy-readopt and registry-empty recovery);
  reference-box ticks 1; FilterSession 1 (the VideoFilter section);
  style grain 1 (the panel echo — the five values boot-apply directly at
  bind, no subscription); session presentation state 1 (the section's
  hint refresh; the renderer's crank re-reads state, it does not
  subscribe). Five relays, five true fans. The relays stay on purpose
  (the few-fans review batch): a direct callback drops native dispatch
  isolation (a throwing subscriber strands the notify chain) and
  hand-rolls signal teardown the §5.5 census retired — and three of the
  five exist because of import direction (`shared` cannot import
  `shell`; `dispose` has no reverse surface on this floor). The one true
  reducer audited and declined: merging the four subtitle-module Fans
  into one grain-tagged bus (10→7) — robustness identical, but the
  saving is a few EventTarget allocations per frame, the same noise
  scale the pooled-dispatch measurement declined (~1µs/emit), while the
  per-grain event identity that makes the one-owner-per-grain record
  audit-checkable would live in payload tags instead. The one deliberate
  non-fan: DomWatch
  cannot ride it — EventTarget exposes no listener census, which the feed
  needs three ways (liveness-gated observer teardown, tombstone
  compaction, logged throw containment). The subscribe handle is a
  Disposable (`[Symbol.dispose]` on the old callable — FF 134, floor-real;
  `using` verified live on the 159 page realm; one shape on every subscribe
  path — the already-aborted no-op returns the same Disposable over a
  release spent at once, the bare-closure fast path this once kept was a
  second shape whose protocol was aliasing luck); pooling the dispatched
  CustomEvent was measured (~680 ns/emit vs ~1690 fresh) and declined: an
  in-dispatch event re-dispatched synchronously throws InvalidStateError,
  and the settings bus is exactly the re-entrant shape, while ~1µs/emit is
  noise against the delivery-dominated budgets. Observable/
  `EventTarget.when()` stays un-adoptable — Mozilla's negative standards
  position (bug 1871732) keeps it off this floor, so Fan remains the
  fan-out definition the platform doesn't ship — `DebugRuntime` (the
  one debug flag, private to the instance; the LoAF arm retired — probed
  unreachable: Firefox 159 exposes the entry type in no realm, page or
  worker), logger facade.
  **Sweep #13 record (core + runtime A→Z, audit-clean; the sweep map
  closes).** core.js and runtime.js read front-to-back — the last pair
  without a series record. **core.js**: the zero-import leaf claim holds,
  and the pass's one mechanical audit ran reference-counted: every
  `TUNING` leaf key, every timing constant, and every formatter carries at
  least one live consumer — the dead-constant class this file's own history
  records (13 exports retired once, which was where "single source of
  truth" went honest) has not regrown. `isBenignMediaPolicyError` is
  exactly the two-name classification the media record names. One
  ownership note verified deliberate: `FRAMEWORK_TUNING` (contract.js) is
  the kernel's single constant — `removalGraceMs`, consumed once at
  kernel.js's removal-grace delay — disjoint from the behavior `TUNING` by
  domain and by owned key, so no duplicate-tuning-table drift exists.
  **runtime.js**: the facade choreography verified at statement level —
  the fire path aborts ONLY the release controller (the two-controller
  shape's measured reason: aborting the task signal inside the body would
  reject the completed task's promise); `end()` aborts both on the
  handle/owner paths; and every rejection lands behind
  `task.catch(() => {})`. Newly pinned: that swallow IS the timer-callback
  boundary semantics — a throw inside a `delay`/`debounce` callback lands
  silent, never on the page error surface (the deliberate inverse of Fan's
  native-dispatch reporting sentence; both real debounce consumers'
  writes — filter's `#writePersist`, subtitles' `#write` — carry their own
  log-then-continue classes, so nothing depends on a callback throw
  surfacing). `debounce`'s `.flush()`/`.cancel()` hold their
  sinks-with-owners shape — exactly one real consumer each (filter destroy
  flush; subtitles destroy cancel), matching the trailing-write-before-
  teardown premise spelled in the export. Scope's abort-flip idempotency
  and the late-`defer`-runs-now path verified against `#runDisposer` (the
  census's one catch-log-never-rethrow isolation site); Fan's handle
  carries `[Symbol.dispose]` unconditionally — the same Disposable over a
  spent release on the aborted fast path, exactly the one-shape contract
  the §4 record pins. `DebugRuntime` is the one console-flag owner; the
  `setRuntime` alias survives as the consumed path (`setDebugRuntime` →
  `setRuntime` → `setLogs`), not a dead surface.
- **dom.js** — the shared mutation feed (`onDomMutations`: ONE page-level
  MutationObserver; its four real subscribers are discovery's media tap +
  detached-target prune, the page.js pipe diff, and inject.js's reconnect
  watchdog — the module's other exports ride the same plane, not the feed),
  `DomPool`
  (element recycling; the three reusable DOM pools are the toast pill, the
  panel's history cards, and the subtitle cue slots — the first two are
  DomPool consumers, the cue slots are pool-by-construction: a
  MAX_SLOTS-bound fixed pre-allocation that never acquires/releases, so a
  grow-on-demand recycle fits nothing there), `ReferenceBox` — the ONE
  fill-box identity and ONE read in
  both modes: the same SDK container discovery resolved (detection's
  composed-ancestry `host`/anchor walk), a single `getBoundingClientRect()`
  filling dims AND origin — the read the discovery presence gates use on
  the same element. The fullscreen convergence is structural: the fs gate
  only arms in the video's own document now, and there the fullscreened
  tree IS the SDK's container tree — the SDK's fullscreen expands the
  container edge-to-edge, so its rect becomes the gesture space on its own
  and the class needs no fs branch at all (the letterboxed-frame /
  document-kind shapes the former viewport arm served are dark under the
  API-only gate by construction); the fs `layoutViewport()` arm, the
  `(0,0)` origin rule it carried, and the inline clientWidth/Height
  "untransformed layout numbers" dual-source all retired with the
  direction (a site-scaled container now reports the scaled box the real
  gestures land in);
  pools per invalidation so the hot path stays layout-free; carries the
  full rect — `x/y` origin at the same reveal-on-invalidation instant, the
  consumer class that anchors against it rather than merely sizing needs
  the position — and broadcasts change ticks over the one Fan at exactly
  its four invalidate sites (container RO, fs flip, orientation,
  and scroll — the origin-bearing arm: scroll repositions the viewport
  origin with no size signal, so the size-only cache the pool once was
  was silently wrong for anchor consumers; the audited subscriber census:
  every gesture consumer
  read-and-discards per flow, the subtitle renderer is the tick
  subscriber) — and
  `layoutViewport()`: the ONE real-world viewport read (the root element's
  laid-out box first, reported innerWidth/innerHeight as fallback; kernel
  presence and the inline gesture-zone width consume it). Real-reading candidates audited against the floor and
  declined: `devicePixelContentBoxSize` (delivers live on the floor, probed
  via the boxes option — device-pixel units no CSS-px consumer can
  couple), IO (intersection-clipped, episodic),
  anchor positioning (a positioning surface; its styles.css verdict), vv
  (the §4 witness-absence verdict; the sheet's mirror, not this class).
  Headless so far: reports a real synthetic screen (1366×768 probed — the
  old screen-width-0 note died). The `fs` gate (FsGate) keeps ONLY the
  native fullscreen API's own surfaces, by user direction: truth is
  `document.fullscreenElement` (per document — the video's own top/frame
  document) read per update from `fullscreenchange` and the lifecycle
  pageshow re-seed, and both fullscreen media queries retired with the
  probe record from this batch's run: the old `(fullscreen)` query never
  evaluates on Firefox under ANY kind (probed element/document/frame/exit,
  headed + headless; the "Chromium evaluates both" note was Chromium-side
  on a Firefox-only floor), and `(display-mode: fullscreen)` — probed
  Firefox's universal fullscreen witness (both kinds, a fullscreened frame
  and its parent, false on exit, the letterboxed frame under a fullscreened
  window too, where the frame viewport stays the gesture space) — is a
  display-mode surface, not the API, so it left with the rest; window
  fullscreen (F11) presents no fullscreenElement and fires no
  fullscreenchange, so the gate goes dark there by construction (the same
  reading real Firefox shipped before the probe run; the gate's own
  breadcrumb names the blind kind).
- **page.js** — site identity (`getDomainKey`, `domainsMatch`, `domainScore`,
  `hashEntry`, title sanitizer), page context, the frame bridge (`pf:` prefix,
  `ContextPipe` class owning pipe state, context responders,
  fullscreen provisioners). The Navigation-API `onNavigate` surface (plus
  resume's whole route-follow chain it armed) is retired: same-document
  navigation is outside the product's topology — the swap machinery's one
  unique value was the route-change + in-place-swap conjunction, an in-place
  src swap without a route change never had a watcher even then, and a
  route change with document unload is the kernel's pagehide + fresh boot.
  Reintroducing it needs new scope direction: a same-document URL change is
  now a blind spot, accepted.
- **store.js** — the storage data plane: `KEYS` = three roots (`pf:configs`,
  `pf:resume`, and the transient `pf:diag` — NOT a state; each write is a
  one-shot "dump now" gesture consumed by its own echo, `randomUUID` values
  mean no read ever re-acts and a stale residue is inert, so it owes no
  cleanup deadline),
  `gmSetValue`/`loadJsonObject`, and `watchStorageKey(key,
  handler)` — the cross-instance subscription that filters own-write echoes
  (`remote === false`) in exactly one place. The echo contract is VM-truth
  (read from its released GM-values source): own-instance writes flag false,
  every foreign instance — another tab OR another frame of this tab — hears
  `remote=true`, so a top-frame menu flip reaches sibling frames. Storage is
  **synchronous GM storage, deliberately not IndexedDB** (manager-space
  portability; a cross-tab live-reload needs echo events, not thread offload).

  **Sweep #10 record (store.js proper A→Z, audit-clean).** The module read
  front-to-back with every seam reconciled against the wider records, no src
  gap: the **grant guards are the deliberate survivor class** — the §4
  single-backend census retired double-typeof *platform-capability* checks but
  kept "grant guards (manager policy, not platform)", and every GM wrapper
  here (`gmRegisterMenu`/`gmUnregisterMenu`/`gmAddValueChangeListener`/
  `gmRemoveValueChangeListener`/`gmGetResourceText`, plus `gmRequestText`'s
  route) is exactly that shape: `typeof GM_*` guards the grant surface, not a
  platform capability — a missing grant degrades to a null handle / null
  resource, never a throw. `watchStorageKey` owns the echo contract the tree
  rides: the `args[3] === false` own-write filter in exactly one place, the
  lenient default (a 4th-arg-omitting implementation behaves as foreign writes
  — the contract only ever widens deliverability, never silently drops), the
  `{ stop() }` handle idempotent across double-stop and failed-install
  (callback-first order: an install throw still returns a usable stop), and
  its premises are the sweep-#7 source-cited manager truths (per-tab+frame
  broadcast, `remote=false` only on the writer's own delivery). `ConfigStore`
  carries the census's storage claims exactly: the parse-once `#cache`
  (`loadJsonObject(configs, { version: 1 })` boot default) served from the
  module cache with `invalidate()` as the cross-tab refresh arm; the
  copy-on-write descent (whole-doc `structuredClone` was the dominant CPU cost
  of one stepper-step write) with the for-in-with-own-guard attr-walk repeating
  ui.js's measured ~78→~20 ns/op finding; the `isSafeKeySegment` guard is
  applied along BOTH the read path (get — "a hostile stored doc must not turn
  a read path into prototype traversal either") and the write/delete paths
  (`__proto__`/`constructor`/`prototype` rejected as segments), with
  `Array.isArray` gates in the `setFields`/`deleteField` walkers refusing
  arrays as intermediate nodes (the strict-CSP census's dead `structuredClone`
  vocabulary is gone — the walkers ARE the shape guarantee). The two-dot
  divergence is deliberate and stays unshared: `setFields` warns-and-drops the
  whole batch on an unsafe segment ("a write must stay visible"), while
  `deleteField`'s walker silently no-ops — the documented "four behaviors
  under one mode flag" refusal where a shared walker with a mode flag would
  tie two error verbs to one table. `#persist` is the log-then-continue class
  (log, return `false`, keep the cache as-was — a failed write leaves memory
  ahead of disk, and the next cross-tab echo re-serves the foreign doc).
  `loadJsonObject` itself is the plain truthiness-object read — missing/corrupt
  yields the fallback; no array-read gate exists at load level because the
  tree's writers project through field whitelists (the resume entry
  projection; the configs doc's setFields shape guards) and the walkers make
  an array-valued segment inert rather than polluting.

  **Sweep #12 record (shared geometry/context planes A→Z, audit-clean).**
  dom.js and page.js read front-to-back — the last two shared planes without
  a series pass — and both seam rings reconciled against the wider records,
  no src gap. **dom.js**: the census claims re-derived live exactly as
  recorded — one mutation feed with its four real subscribers (discovery's
  media tap + detached-target prune, the iframe registry's added-node diff,
  inject.js's detach watch), ten Fans, eleven Scope roots with the
  DOMManager as the shared-side root. Newly pinned: the feed's two
  proven-bug stories are measured engineering record, worth holding — the
  pooled batch double-buffer swaps then re-arms the incoming buffer EMPTY
  (without it, every flush from the third onward re-delivered stale records
  witnessed as `[1,1,2,2,3]`; each a redundant DOM walk over already-handled
  mutations), and the `PUSH_APPLY_LIMIT` index walk exists because
  `apply()` spread on a mass-DOM-teardown batch hits the engine's
  applied-args RangeError (measured: V8 at ~124k) that would escape the
  observer callback before `#queued` is set — the whole batch silently
  dropped (the fast path stays apply, the walk is the safe arm); the 4:1
  tombstone compaction rides slot-IDENTITY unsubscribe (the returned
  `off()` closes over its slot object, so reindexing can never orphan a
  handle — the positional-tombstone zombie the comment records); the
  hidden-tab belt parks dispatch on a background-priority postTask capped
  500ms and resumes on visibilitychange (the zero-timer census's
  coalescer class, armed only while the feed awaits). FsGate: the
  persisted-pagehide force-false writes the `fs` binding DIRECTLY, not
  through `#set` — silent by design: no emit to subscribers on a page going
  away, the restore's `#update()` then no-ops (fs already false), and the
  erased on-claim was a stale future anyway (the browser exits fullscreen
  on navigation; the belt exists because a persisted restore would never
  fire fullscreenchange to correct it). ReferenceBox's four invalidate arms
  verified (container RO, fs flip, orientation, capture-phase scroll), its
  audience is exactly the four fullscreen subscribers the census names
  (ReferenceBox, the forge pinch fill-release, `ViewershipTransform`'s
  reset, the panel close-on-fs), and the two traversal helpers + the ONE
  layout-viewport read hold their consumer lists (forge's control-focus
  gate and zone width, the panel's focus-return, shell's shadow-host
  check, discovery's presence gate). **page.js**: the census holds — zero
  timers; both of the module's deadline classes are activity-paired, not
  polled (TopFrameResponder evicts idle pipes inside `#touchPipe` on
  request activity — a truly idle pipe closes only on messageerror or a
  later request; FrameRelay's nonce TTL sweep runs per incoming
  request/ready echo). Newly pinned: `isOwnFrame`'s nested-frame walk caps
  at depth 4 and only while layers stay same-origin-readable — a
  cross-origin `contentDocument` catch ends the subtree (the strict vouch
  posture unchanged, merely visibility-bounded); the single-bridge-handler
  ordering is load-bearing (iframeRegistry.arm runs first inside the
  dispatch so the synchronously-seeded cache lands before the next
  handler's vouch, re-establishing the old listener-registration-order
  guarantee the three-listener shape got for free); and the
  fullscreenerror remediation seam is closed on both sides — the gate's
  own docstring names shell.js as the HUD-layer owner, and shell's
  `#watchFullscreen` re-arms + re-hops via `retryFullscreenProvision`
  exactly on the failure path the provision latch re-opens for.

### kernel/ — policy layer
- **contract.js** — the shared vocabulary both layers import in isolation:
  gesture registry (`GESTURES`/`GESTURE_IDS` are formula-derived from `{id:
  label}` pairs), `GESTURE_EVENTS` (`pf:gesture-<id>`), `DEBUG_HASH_TAG =
  "pf-debug"`, tuning knobs, and `AdoptionHome` — the frozen adoption
  identity the kernel→shell watcher protocol carries (one record per
  adoption through the provider, the `RemovalWatch` anchors, and the
  destroy-readopt compare; every seam previously re-spelled the
  `{video, container, sdk}` shape by hand). The frame bridge's message types derive from
  their own single prefix inside `page.js` (module-local by documented
  design); key bindings derive in `actions.js`. No machine-facing string is
  hand-spelled anywhere else.
- **detection.js** — the SDK identity engine, registry-driven, importing only
  its contract.
  15 supported SDK records (JW Player, Video.js, Plyr, ArtPlayer, DPlayer,
  MediaElement.js, XGPlayer, Aliplayer, Fluid Player, Flowplayer, Clappr,
  Vidstack, Mux Player, Radiant, Laravel Video Embed), each a set of
  **SDK-namespaced anchor selectors** resolved through composed ancestry
  (shadow-boundary aware); the matched element with the fewest
  ancestor hops wins, the answer per hop coming from ONE native
  selector-list probe (`ANCHOR_PROBE` — every registry anchor joined into one
  list, one C++ `matches()` call per hop answering "any anchor match?",
  replacing the per-anchor JS loop between `matches()` calls; the
  hop-ascending scan IS the fewest-hops law, and record/anchor identity at
  the winning hop comes from one ordered tie loop — registry order, then
  anchor order — the same tie law the old best-tracking applied;
  measured ~5µs → ~2µs per miss-walk in §7's hotpath row). An anchor must
  carry no top-level comma (the join constraint; currently none does). There is deliberately **no generic fallback** — a bare
  `<video>` with no SDK anchor never boots. Record provenance is
  source-verified, not assumed: Clappr's compound lead anchor
  `.container[data-container]` (the vendor-set `{ class: "container",
  "data-container": "" }` Container element, one hop closer than the Core's
  `data-player` fallback arm — verified in clappr/clappr main) resolves the
  shell home to the tight video box. The kernel A→Z audit re-proved the
  ring against current vendor releases: XGPlayer's `xgplayer` root class
  (v3 source + docs, the `xg-` elements are plain non-canonical elements),
  MediaElement's dual namespace (`mejs__` default + the legacy `mejs-`
  stylesheet route, verified through 7.1.0), Flowplayer's `.flowplayer`
  setup container (the OSS release's own minimal-setup markup), and
  ArtPlayer's `art-video-player` (256 occurrences across the current 5.x
  dist) all hold; the audit found one record GAP — Radiant's single
  custom-element anchor covered only its secondary WC install route, so it
  gained `.rmp-container` (the primary script route's appended wrapper,
  verified in the served rmp 10.7.9 `wc.rmp.min.css` class set), and the
  media element's own `.rmp-video` is deliberately not an anchor — a 0-hop
  match would resolve the video element as the shell home, a box the shell
  cannot host its DOM in. One deliberate exception stands, closed: Laravel
  Video Embed's anchors are Inertia's `data-page` vocabulary, not
  the package's own (every Laravel embed package renders iframes), so the
  record matches any Inertia app with a bare video — it was added for a
  real-target site with a named fullscreen fix. The record-and-weigh-later
  path rode the problem-site diagnostics pass that served the
  reverted fs-ui plan; with that pass closed (not master work — it died with
  its branch), retire-vs-narrow has no standing re-open: the exception is
  deliberate, and re-opening it needs a new named site with real markup
  facts. The registry is
  exported as `SDK_REGISTRY` so the check's registry-coverage case proves
  every record against a real anchor-satisfying stub per record.
- **discovery.js** — presence machinery: min-size thresholds (100×60),
  on-screen/layout deferral gates (`PresenceGate`, per-instance
  MutationObserver check), the media feed (`DiscoveryTap`: lazy escalation —
  cheap tap first, full listeners only for rendered candidates), idempotent
  boot sentinel, `RemovalWatch` (grace-per-disconnect observer, re-parent
  aware, and `moveBefore`-aware by derivation: state-preserving moves land
  as the same remove+add record shape, both primitive forms live on the 159
  floor, and the watch's decisions re-derive from live DOM state — no
  per-shape code exists).
- **kernel.js** — the orchestrator: `whenDomSettled` boot sequencing
  (`runSteps`), the one-main-video scope guard on adoption — the pick policy
  "first-qualifying wins": a candidate meeting SDK identity is refused while
  a shell is live or mid-boot (`#registry.occupied || #booting != null`), never
  pinning a presence gate on a refused video, and recovery is the
  registry-empty edge re-arming the full discovery tap — identity flows as
  ONE frozen `AdoptionHome` (`resolveAdoptionHome` resolves at adoption and
  at the re-wrap seam; the provider, `RemovalWatch`, and the
  container-equality compare all read the same record) — the `ShellSlot`
  (one shell per session; a displaced shell is **destroyed**, never
  orphaned; the adoption guard makes the displaced-destroy a backstop),
  `MenuCommands` (debug toggle + the two one-shot reset
  commands + the frame-state diagnostics dump, installed from script eval
  and resolving their shell host through the entry's kernel reference —
  works even kernel-less; menus
  are top-frame only, and `#armDebugWatch` rides the storage echo to
  propagate the debug flip into sibling frames mid-flight),
  `installFrameDiagnostics` + `dumpFrameState` — the one-tap field triage:
  the dump command writes `pf:diag`, the top realm answers by direct call
  (its own write is echo-filtered), and every script realm
  — another tab or another frame — answers through the echo with one
  `logger.warn` state line (warn rides the NOT-debug-gated belt on purpose;
  the dump must land on a stock install — that gate is the surface's
  premise: it exists because the fs-ui field loop burned ten console probes
  answering "which document holds the player's state"). Page-lifetime
  install like the frame bridge; per-realm record carries realm/domain,
  videos with per-video SDK identity + min-size + on-screen, the live
  shell's SDK name, the mid-boot latch, fullscreenElement, and the debug
  flag),
  pagehide teardown, pageshow recovery (the orphan reconcile; the freeze/
  resume arm retired — its reconcile duplicated the pageshow one and Firefox
  exposes no Page Lifecycle events), per-boot
  manage-ability downgrades, and the universal-container-identity seam on
  `RemovalWatch`'s re-parent branch: container identity is a shell-lifetime
  fact resolved by detection alone — a live re-home re-runs
  `findSdkForVideo` (the parent-stamped cache invalidates on exactly this
  parent change), and a DIFFERENT container destroys the boot-identity
  shell and re-adopts through the boot path (destroy-readopt; the
  equality shape and the unresolvable shape stand untouched). The boot
  hands itself its `RemovalWatch` and carries an explicit shell-less-exit
  release (`#abandonBoot`): a settle that resolves disconnected, and a
  mid-boot `shell.create` throw / `ready` reject, never touch the
  registry-empty edge (nothing registered), so without this the pre-boot
  pin refuses every later event for that video and the downgrade strands —
  the release stops the watch (onStop = pin release, exactly-once) and
  re-arms the full tap when the registry is empty; skipped under pagehide
  (the scope defers already stopped it).

### shell/ — the feature layer
- **shell.js** — composes the boot step list (realm → settle → DOM layers →
  HUD wiring → media session → sections → markers), stamps managed markers,
  owns destroy and re-anchor paths. The shell stores the frozen
  `AdoptionHome` the provider hands it and exposes `video`/`container`/`sdk`
  as read-only aliases of the same record (identity is a shell-lifetime
  fact). The panel-section destroy loop rides ONE uniform bare `catch` (the
  release-tail class): a section destroy that throws must not strand the
  inputs/panel/toast/DOM teardown steps behind it — they are the shell's
  only unregister on that path, so the broken member dies contained and the
  tail gets everything below it done (a future member without an honest
  destroy surfaces as leftover DOM in the rows, not as a leak). Destroy
  releases an active fill right after the scope flip (`#view.exitFill(false)`): the
  reachable mid-fill destroy is the destroy-readopt seam, and a video left
  riding its inline fill transform + claimed object-fit would carry them
  into the re-adoption — the fresh shell's ViewershipTransform boots
  `#fillActive=false`/`#priorObjectFit=""` and never sees the hostage.

  **Sweep #8 record (shell lifecycle A→Z, audit-clean).** The module read
  front-to-back with every seam reconciled against the wider records:
  the boot contract is two-phase (`#injectDom` → one `yield_` → the eager
  component set + lazy `PANEL_SECTIONS` builder → the watcher `runSteps`
  with the managed-marker stamp as its tail), and `#injectDom`'s four
  deferrals (host removal, `SHELL_MARKER` on the host, the static→relative
  position fix, the parasite watchdog) all ride the shell's `DOMManager`.
  The teardown ownership matrix is the record's real deliverable — five
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
  census's second shell-side `new Scope(` — a separate machine disposed
  by its own `destroy()` verb at the destroy tail, after the `#scope`
  flip, with no cross-cascade between the two roots (the never-disposed
  `#dom`-without-`#scope` shape cannot happen: `shell.destroy` is the
  only caller and runs both). The re-entrant destroy guard rides
  `#scope.disposed` returning early; mid-boot destroys are legal (every
  post-`#injectDom` field guards `?.`, the sections array is empty by
  construction). Idle-state facts recorded for the next reader:
  `#home` stays intentionally (identity is a shell-lifetime fact),
  `#view` is not nulled because `exitFill(false)` restores every byte
  it can mutate (transform + claimed object-fit) and it holds no
  listeners of its own (they die with the forge signal). One subtlety
  kept deliberately rather than "fixed": a section destroy that throws
  mid-loop abandons its later siblings before the array clears — the
  documented belt premise, not a bug to repair.
- **media.js** — the media plane A→Z's single-writer population: every
  HTMLMediaElement property write in the tree (7) lives in this file — three
  clamped `currentTime` writes (stop/seekTo/latched-scrub), clamped volume,
  muted flip, and two playbackRate writes whose release (`endBoost`) is
  deliberately UNGATED so a mid-hold source swap cannot strand a boosted
  rate; the reads outside are shell aliases and resume/cue consumers, and
  the one second play call is forge's bare-tap — native parity: its silence
  logs real rejections to debug instead of rethrowing (media.play's
  throw-through serves gesture/panel callers that own a failure surface; a
  gesture surface with nothing to degrade into does not). Readiness is two
  gates: `#isReady()` (readyState ≥ HAVE_METADATA) for everything
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
  fingerprint compare — that page's userscript tax (2 getter reads + 1
  template per mutation batch), the tree's one per-host-mutation cost
  surface, with the candidates (title-node-only observer, part-compare
  without the concat) parked unless a site surfaces real cost. `URL.parse`
  as the null-guarded poster parse and `fastSeek` under the seekto
  handler's `fastSeek` detail are the floor-era surfaces; PiP keeps the
  `pictureInPictureEnabled` runtime policy read (enterprise/embed can
  disable) while the method-presence checks that died floor-dead (70) stay
  dead. — `MediaControls` (play/pause/seek/scrub-latch/volume/rate/
  boost/PiP/stop), `MediaSessionOwner` claim/lifecycle — the bridge carries a
  plain disposal boolean, not a Scope root: every listener it owns rides the
  claim's caller signal and the had-scope held no signal consumers and no
  disposers (the roots census's one retirement, 12→11). The wake-lock and
  fullscreen orientation-lock companions retired by user direction:
  Firefox already keeps its screen awake during media playback and handles
  fullscreen orientation on its own (the ReferenceBox orientation-change
  listener in dom.js stays - it is the fill-rect's geometry feed, not the
  lock).
- **resume.js** — the resume tracker: store warm → context resolve → entry
  match/create → restore → progress drive. One adoption per tracker
  lifetime — a same-document route change is out of scope (see the page.js
  bullet), so there is no route-follow/`#adopting` machinery. Save cadence
  = 10s checkpoint span; flushes on `seeked`, on pause, on visibility loss,
  on pagehide (persisted leg; the freeze leg retired — Firefox exposes no
  freeze, and pagehide is the belt's one suspension surface);
  `RESUME_MIN_POSITION` (5s) floor; bounds cutoff; the entry
  carries per-viewing extras (`subOffset`, `subsUrl`); cross-tab merges
  arrive through `watchStorageKey` and require the tracker's `#loaded`
  latch (`#adoptExternal`, which announces so grain consumers re-resolve).
  The merge adopts REMOVALS too — a foreign doc omitting a known entry is a
  deletion made elsewhere, adopted under doc-side LWW (entry revision older
  than the foreign doc's stamp) so a background tab's next checkpoint
  cannot resurrect a panel-deleted entry; the "Start over" toast action
  writes its reset through the store (an explicit boundary outranks the
  drift epsilon, like the completion state does). The never-written
  `pending` entry field (entrance-only across the whole repo history) is
  retired with its load-time sweep — the one wall-clock read that went with
  it is the Date.now census 10→9. The resume-plane A→Z sweep read the
  module end to end and verified the whole seam ring against the shared
  planes — no src gap: the store's persistence shape (fixed-whitelist
  entry projection blocks field injection and prototype traversal since
  `__proto__`/`constructor` are outside RESUME_ENTRY_FIELDS; foreign and
  future writers adopted with a restamp, malformed entries dropped with a
  count-warn, the echo attestation never minted on a load), the merge's
  exact invalidation contract (in-place LWW updates touch only `updatedAt`,
  so `#byId`/`#byPath` stay exact and only the sorted snapshot drops; the
  doc-side removal adoption keeps the entry when it is exactly-recent -
  under `<=`, deliberate), the strict four-field echo fast path
  (docUpdated + version + count + maxEntry stamp; any foreign writer bumps
  one), the checkpoint mathematics (span = clamp(duration·0.01, 10, 60)s,
  completion 0.95 outranks the 3s epsilon on the terminal state, the
  store's no-op guards churn-skip repeats), the id-trust rule (an
  `hashEntry` id matches only when `domainsMatch` agrees, so legacy
  domain-less ids and true collisions fall through to the fuzz-scored
  path-bucket match), and the two classified subtleties the sweep cleared
  rather than fixed: destroy's `currentTime ?? NaN` fallback is
  unreachable (`#shell` is never nulled) and even a fired NaN write would
  be Number.isFinite-guarded at every consumer, and the `#persist`
  embedded foreign-merge window (an echo-miss race) rewrites the disk
  with the converged set immediately after, without a structural notify —
  the remote-write path proper announces, so History staleness is bounded
  to a same-instant race whose writer is the writer tab itself.
- **filter.js** — `FilterSession` (eager state machine: values, apply,
  trailing persist, the menu reset gesture) + `VideoFilter` (the lazy panel
  section over it). The filter lives on the video from first play — a
  stored preset needs no panel open — and reset works with none.
- **inputs/forge.js** — the pointer/keyboard gesture engine: the stream
  router (passive press/move streams under the prevent-scope rule — a plain
  tap's whole native sequence passes unclaimed, no press-time cancel
  anywhere; the SDK-control exemption lattice — the tag/role shape list
  plus the affordance-cursor clause (pointer/grab on a small box outside
  the gesture-surface family) — sorts SDK surfaces out of gesture ownership
  so their streams stay theirs; the touchmove belt, the wheel pinch
  listener, and the post-gesture activation suppressors are the only
  cancel-default listeners), pointer tracking, the session
  latch feeding the shared `fs` gate, and click/dblclick suppression, over
  per-story recognizer
  machines: `ScrubStroke` (pointer move-stream scrub with coalesced samples,
  the exp-smoothed velocity filter, and the bounded predicted-events wash;
  the move stream is pointermove+coalesced alone — `pointerrawupdate` is
  live on the floor but fires 1:1 with pointermove over real driver
  strokes (probed) and is non-cancelable, so a second stream buys no
  samples and the committed seek stays rAF-bound),
  `SwipeStroke` (the translate-drag transform writes and their eased
  restore), `TapWindow` (the dbltap window: observation only, no seed and
  no replay — by the prevent-scope rule there is nothing held back to hand
  back), `PressHold` — the ONE press-hold qualifier (timer + latch + pooled
  hold/release dispatch) both trigger shapes ride — and `KeyHoldSession`
  (the INPUT_ACTIONS session keys — today the hold-speed row's Space:
  hold-to-speed + bare-tap toggle, settle-on-next-press hygiene for a
  swallowed keyup; the KeyHoldSession copy it replaced was the keyboard
  spelling of a story the engine's pointer press owned inline, with the
  same null-check timer-clear body spelled twice — the channel-shape facts
  are constructor options (`method`; `zone` as a string for keys or a `()
  =>` live reader for the pointer shape) and the per-press facts are
  `arm()` parameters (`gate`, and the pointer's `onArm` claim effect, so
  the claim is a parameter, not a second class)). Gesture detail carries
  `dx` and the mirrored `dy` as
  engine geometry (the detail payload shape is source-table fixed); pinch
  and trackpad-pinch handshake stay engine-core; hold/scrub timers ride
  the shared scheduler. Keyboard arbitration filters its candidates by
  engine liveness (`#isActive`: `readyState > 0 && !ended` — an ended
  engine must not steal keys from a live one), deliberate for the
  multi-engine case, but answers **vacancy outright**: when no engine
  holds a playable video (`candidates === 0` — every live video ended or
  not yet loaded), playback arbitration is vacuous and the method returns
  true, so the page-level chrome keys (panel/history/settings) still work
  after the credits roll — exactly when the keyboard has nothing else to
  do; one shell per realm-document (the scope law) makes vacancy
  single-engine, so no cross-engine routing question survives. The
  gestures case proves the shape: seek to duration marks `ended` on the
  paused fixture video, the real driver KeyS still opens the panel, and
  the row restores (seek-back + panel close) before the hold-speed rows.
- **inputs/actions.js** — the action layer: the unified `INPUT_ACTIONS`
  table (one row per user-facing function, each gathering every trigger
  under its `inputs` — pointer families and key codes, one-shot or
  hold-session; the hold-speed row defines 2x hold-to-speed ONCE, its
  pointer hold and Space hold both riding it) + `IntentGates`,
  and the per-story state machines `SkipStreak`, `ScrubSession` (the input/
  commit decoupling: moves accrue `#pendingDelta`, requestAnimationFrame —
  the compositor tick — commits one clamped seek per display refresh (the
  pump's clock probed against rVFC and declined: 30 pipelined paused-seek
  writes over 500ms landed as ONE `seeked` + ONE presentation callback while
  rAF held 60 commit ticks over the same window, rVFC idles outright on a
  paused video with no presented frames, and its playing cadence is content
  fps — 50 fires vs rAF's 241 across a 2s play window on a 120Hz display —
  so a presented-frame pump either quantizes to the decoder's display rate
  or strands at pause, while the UA coalesces burst seeks with zero dropped
  frames, making the rAF pump the efficient shape already), the
  readout shows the authored target, `end()` flushes the backlog; a dead
  zone with a residue accumulator keeps slow strokes alive while holding
  jitter nets to zero) — and the pump's idle arm measured and declined
  (a still hand keeps a 120Hz early-return tick whose self-time rounds to
  0 at the probe's resolution — the noise scale the pooled-dispatch verdict
  declined at higher frequency — so a dynamic disarm buys nothing), while
  the native guarantees the floor hands the pump for free are recorded
  (the rAF argument IS the frame clock — equal to document.timeline.currentTime
  to the digit, so a callback never buys a second clock read; cadence is
  pinned to the display's vsync with 8.34ms median interval and no drift;
  a hidden tab pauses rAF outright and resumes within 11ms of re-show), the hold bookkeeping (`#activeHolds` first-source-
  wins boost; any real pause mid-hold cancels through the release teardown —
  a paused video resuming must not carry a stale boost), and
  `ViewershipTransform` (the fill-mode cover scale composed as one
  `scale(s)` — pinch-to-fill's transform, released on pinch-in or fullscreen
  exit) — the one class allowed to write the video transform, exposed on
  the shell as `shell.view`.

  **Sweep #11 record (inputs plane A→Z, audit-clean).** Both modules read
  front-to-back — the pair's first dedicated series pass — and the seam
  ring reconciled against the wider records, no src gap:
  the pooled-detail rewrite discipline holds at every dispatch site
  (advance/hold/release/scrub-end/pinch/swipe/dbltap/key each rewrite every
  field its payload owns, the no-stale-carry contract stands intact), the
  pool boundary is exactly the allocation record's (events per engine via
  the per-instance `GestureChannel` — the in-flight-re-dispatch hazard is
  event-scoped; details module-level singles whose consumers never
  retain), and the two release-tail bare catches the error census named
  ARE the pointer-lift races (`#pointerOp`'s NotFoundError lift race, the
  lost-capture `hasPointerCapture` read — the farewell subtlety that a
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
  direction — the down direction exits fullscreen through ShellActions,
  and the UP direction toggles the panel (the section's `#wireEvents`
  consumes `GESTURE_EVENTS.swipe` detail.direction "up"); the engine's
  fs-gated swipe intent makes both fullscreen-only, as the README's
  gesture table now states. The IntentGates snapshot plan stays
  verified-as-recorded (bus re-sample + per-query fs revalidate; keys
  live-read per keystroke); the stacked TransformEase docblocks
  re-classified as prologue + class doc (both live, left).
- **subtitles/** — `forgevtt.js` = the parse engine (~.srt→WEBVTT normalizing)
  whose async variant IS the ingest arm — a 50ms block budget hands the
  thread back through scheduler.yield, so even a multi-megabyte track drains
  without stalling playback or paint (the dedicated-Worker offloader retired
  with the subtitles A→Z batch: its 512KiB floor gate fired virtually never
  — real .srt/.vtt files are tens of KB and offsets/memo reparse nothing —
  its one real-floor row could not produce a spawn in the shipped bundle,
  and the in-band fallback rendered byte-identical cues; the native `<track>`
  parse stays ledger-rejected on ingest ownership, so the cooperative arm
  is the whole decision space), `subtitles.js` — the main-thread surface:
  eager `SubtitleSession`
  (ForgeTrack renderer 8 concurrent cue slots, cue scheduling is OURS — no
  native TextTrack anywhere on the path: the file never enters the video's
  track list, so a host can never list/restyle/mode-flip our captions;
  the presented-frame rVFC crank (re-adopted by the clocks direction —
  samples the callback's `mediaTime`, the painted frame's own timeline
  position, so the active set is answered by what the eye sees; a paused
  seek carries its own `seeked` rider, and the cross-source gap rides the
  presentation-lag epsilon), a sorted-start walk with an amortized dead
  floor, the
  W3C relation `start <= t < end`; slot entry/exit rides the hidden flip in
  the HUD sheet itself — `@starting-style` +
  `display allow-discrete` over `&[hidden]`, transitioning ONLY the motion
  lane (opacity/translate — centering lives in `translate` so `transform`
  stays free), never the anchor lane, so posture corrections land instantly;
  picture-anchored cue
  placement — percent cue fields resolve against the displayed video
  picture derived from the ReferenceBox rect + the element's own
  box/intrinsic/object-fit re-derived per render, slots laid in the
  env-inset layer space; unreadable geometry and zero-area clips fall back
  to the old layer-relative resolution — re-anchoring rides the ReferenceBox
  change tick, video-relative marks ride the renderer's own signal-scoped
  RO + the media `resize` event; drag-drop/URL ingest with
  per-entry restore, parsing memoized, the `SubtitleSyncState`,
  `SubtitleStyleState` (all five values boot-apply at bind; the former
  partial font/stroke boot left a stored custom size/color/shadow unapplied
  until the section built), and `SubtitlePlacementState` grain singletons —
  one owner per grain, no mirror fields between session and section) + lazy
  `SubtitlesSection` (panel UI).
- **chrome/** — `config.js` (state: `SETTINGS_SCHEMA`, `getSetting`,
  `onSettingsChanged`, `SETTING_KEYS`, cross-tab live-reload cache;
  `SETTING_KEYS` is the ONE key-vocabulary table — the four machine-read
  root handles plus the `subtitles` group the subtitle state machines ride
  through raw-config handles, and the key-census sweep proved the handle
  discipline: every `getSetting`/`setSetting` site passes a table handle
  (`SETTING_KEYS.*`, `definition.key` from the schema,
  `GESTURES.*.setting`/`SETTING_KEYS.hotkeys` in INPUT_ACTIONS) — zero
  raw strings. The other dotted families of the configs doc each keep
  exactly one spell site derived from their own source table (the real
  source-table-law claim; this rewords the formerly over-broad "no second
  table spells a dotted key"): `settings.<row>`
  via the schema + `SETTINGS_PREFIX` in config.js, `gestures.<id>`
  formula-derived contract-side (`gestures.${id}` like the event names),
  `filter.<channel>` via the filter defs + `CONFIG_PREFIX` in filter.js;
  the only hand-spelled literals are entry's `meta.firstRun` plus the
  two legacy names (`pf:first-run`, `firstRun`) its boot absorbs and
  sweeps once — all three spelled in exactly that migration line),
  `panel.js` (the `Panel` builder + settings/history section renderers;
  `startViewTransition` runs `{ types: [PANEL_VT_TYPES.open|close], update }`
  — the flips carry their direction as a view-transition type and the sheet's
  `:active-view-transition-type()` rules key directional motion on them:
  open arrives from below on the bounce curve, close sinks back on the plain
  ease-out, endpoint pose identical, ink untouched (the redesign-verdict
  ledger's earlier
  "types with no CSS reader" record closed its adoption on reader-absence;
  Firefox 159 ships both faces and the reader landed with the redesign
  decision — the un-typed `::view-transition-old/new(pf-panel)` pair stays
  as the fallback for any future untyped flip). The UA schedules
  each flip's update callback on its own clock, so both flips are
  null-guarded against the destroy-between-scheduling-and-callback window
  (a shell destroyed mid-flight nulls the DOM refs before the UA runs the
  update; an unguarded throw there rejects `updateCallbackDone`/`finished`
  unhandled — the media case proves the race with a 120ms-delayed spy and
  a +30ms destroy-readopt); the open-restore
  and containment focus fallback share one `#focusFallback()`;
  the product sections return their instances into the shell's
  section-handle table — the `PANEL_SECTIONS` entries are the build *and*
  teardown source of truth, so attempt-rollback and shell destroy call
  `section.destroy?.()` on real handles, and the history subscription rides
  the shell scope's signal into the resume store's Fan),
  `ui.js` (`el`/`button` construction, the SVG icon factory, `flashElement`
  WAAPI), `inject.js` (`ShellStyle` sheet lifecycle: adopt-once, monotonic
  `@resource` upgrade; viewport-fit-cover), `toast.js` (`ToastManager`,
  pooled custom element), `panel.js`
  (the `ui.panelScale` write rides `#applyCompactSetting()` as the panel
  root's inline `style.zoom`, per-open like compact), **styles.css** (the
  HUD — §6; the section labels carry the `text-box-trim` cap rule).

  **Sweep #9 record (chrome/ A→Z, audit-clean).** The three small modules
  read front-to-back with no src gap:
  `ui.js` — the construction helpers are the measured-allocation shapes
  the allocation sweep pinned (`el`'s for-in + hasOwn over the attr map,
  the ~78→~20 ns/op finding; `button`'s one-mutated attrs object with
  forwarded rest keys, so the `data-action` contract never silently
  drops); the icon plane is the two-table vocabulary (`ICONS` +
  `ALIASES`, `canonicalName` hasOwn-gated) feeding the document-keyed
  WeakMap template cache with cloneNode derivation — the string path
  (toast markup) and the element path (panel buttons) hit the same
  cache; `DOMParser`-not-innerHTML is the strict-CSP/Trusted-Types belt
  (the census's 7th bare catch includes this file's) with
  `importNode` keeping the parsed node in the requesting realm;
  `flashElement` is the WAAPI restart grammar (cancel finished
  background animations + scan running ones for `backgroundColor`, the
  null-effect half kept spec-nullable; `!el` the only guard; FLASH
  constants from core, no re-spelled durations).
  `toast.js` — singleton `DomPool(initial: 1)`; `acquire` is consumed at
  construction and never released (the held-side contract the pool's
  destroy comment names); pointer-events follow the stylesheet's
  hidden/interactive state so no inline writes go stale across reuse;
  the repeated-show skip is the 4-field render fingerprint (irrelevant
  churn is the ~100ms scrub-hint tick); auto-hide rides the scheduler's
  `delay` (feature-timer class) with the WCAG 2.2.1 hover/focus hold
  carried uniformly on (this is behavior, not an a11y branch — the
  pause machinery runs on every realm); destroy cancels the pending
  delay and latches `#paused` before `#pool.destroy()` (available-side
  only — the held pill rides the hud-removal defer in shell.js); the
  four pointer/focus listeners are element-owned and die with the layer
  at natural GC.
  `inject.js` — `ShellStyle` is the one-object sheet story (adopt-once,
  the strictly-monotonic `@resource` upgrade with its parity guard and
  last-good-keep on a bad `replaceSync` — the log-then-continue class
  the error-path census pins; `settled()` never rejects); the container
  pockets ride a real `<style>` element because `@container` size rules
  do not evaluate inside `adoptedStyleSheets` in either harness engine
  (gate-probed), restating the sheet's old tie order as source order
  (density → landscape adjustment → compact reader LAST);
  `watchShellHost` is fully event-driven as documented — container
  childList MO + the detach leg armed only while the container is out
  of the document, riding the shared mutation feed (one of the four
  DomWatch feed subscribers §2 records), no timers, no surrender;
  `ensureViewportFitCover` is idempotent, and *forcing* cover over an
  embed's own fit keyword is the point, not an overreach.
  One classified surface (kept, not fixed): `pf-toast` is never
  registered in any `customElements` registry — it is a valid
  unregistered tagname styled by tag selector — and it is created in
  the PAGE document (`hudLayer.ownerDocument`), so a page that
  pre-registered the `pf-toast` name could upgrade it. The reach is
  toast behavior only, by a page that already owns every other byte of
  the document; the shadow-host isolation story does not require
  creating the element in a different realm, so no new registry or
  realm-juggling was added for the theoretical shape.

## 4. The OOP development path (A→Z chronicle)

The tree was rebuilt by a sequence of review-and-unification passes. Each pass
had one rule: prove the current shape wrong first, then move code, then prove
behavior unchanged by gates. This is the reason for every convention in §5.

**HUD design era.** The redesign started from an Apple Liquid-Glass
applicability audit, landed the still-current rules (§6), then retired the
accessibility honors it discovered: the HUD now renders and animates uniformly
(no cpu-tier detection, no reduced-transparency/motion/contrast branches — the
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
- Layer unifications: shared 20→5 planes, kernel 5→4, chrome 8→5,
  subtitles 5→3, each keeping exactly the build-boundary files separate.

**Closure-machines → classes (the OOP turn).** Every stateful factory whose
state was split between module-level `let`s and closure variables became one
class owning its story, with public factory names kept stable so consumer
churn was import-paths only:
`ContextPipe`, `DebugRuntime`, `FullscreenProvisioner`,
`PresenceGate`, `DiscoveryTap`, `RemovalWatch`, `ShellSlot` (state kept as a
class because its displacement/`onEmpty` contract is unit-pinned),
`ShellStyle`, `HoldRepeater`, `MediaControls`,
`MediaSessionOwner`, `TransformEase`, `ForgeRegistry`/`GestureChannel`,
`ConfigStore`, `VideoProbe`, `DomSettleWatch`, `MenuCommands`, plus the
DomWatch/FsGate/Settings/SdkMatcher/panel-section family and — in the input
pass — `IntentGates` + `ShellActions`.
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
  zero poll-style timers — `setTimeout`/`setInterval` never appears in src;
  the cadence that was once a wall clock (resume checkpoints every 10s)
  rides the native `timeupdate` broadcast + `currentTime` (the element's own
  media clock, ~4Hz while advancing, idle while paused/stalled; the rVFC
  presented-frame crank retired with user direction), and the bridge's
  retry ladder died into the `pf:ready`
  announcement (event-driven, last commits). Every timer that remains is
  one of three deliberate classes: a **coalescer** — the `DomSettleWait`
  trailing quiet period re-armed per mutation (no native "settled" event
  exists), removal-grace one-shot deferrals, and the three persist
  debounces that batch trailing writes under stepper drags; a **deadline**
  over witness absence — bridge watchdogs (bridgeless embed settles null),
  and the hidden-tab flush cap with its
  `visibilitychange` resume; or a **feature timer** whose semantics the
  product defines as temporal — hold-to-speed, press qualifying, toast
  auto-hide, the first-run hint cap. All ride the shared scheduler
  (`postTask`/`delay`/`debounce`, abort-scoped). A future timer needs to
  name one of these three classes, not merely be a `delay`.
- Died: the `postTask` façade's whole setTimeout arm, `yield_`'s
  scheduler→rAF→noop ladder, `onNavigate`'s popstate/hashchange backend that
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
  — "jsdom elements honestly lack them / some host surfaces" died with the
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
`check/` tool (§7), whose browser gate replaced the entire behavioral test
surface with real-Chromium proofs; the glass measurement harness rides the
same retirement (its target state is recorded in §6 instead). The frames
round added per-frame injection (§7), and chromedriver robustness hardened
launch (§8).

**Redesign-verdict ledger (final; closed).** The redesign-class questions the
tool era left open are closed on evidence, in-repo. The canon that decided
them (user direction, batch 19): a platform surface earns adoption only when
it is BOTH native-backed AND universal across every topology the frame model
serves (top-frame big page, same-origin, cross-origin embed) — native but
context-scoped retires, the same test that killed the emulation arms in the
single-backend contract. Reopening any of these needs new user direction AND
new code-level evidence:
- **`<dialog>` panel migration — rejected on modal scope, not stack doctrine.**
  `showModal()`'s `::backdrop` is unconditionally document-modal: while the
  panel is open the entire frame document goes inert. That happens to match the
  iframe topology (embed document ≡ player region), but is fatal for the
  top-frame/same-origin big-page topology — the panel must stay
  *player-region* modal, where an outside press on the host page acts on the
  site AND closes the panel (the shell-local shield's whole point); a
  top-layer backdrop absorbs the press and hands the page to the dialog. No
  API scopes `::backdrop` to a region. The earlier recorded ground (toast
  3<4 repaint arithmetic) was incidental — the z tokens put panel(4) >
  toast(3), so a top-layer panel *matches* the doctrine instead of fighting
  it; the verdict stands on the weaker reason alone. Non-modal `show()` buys
  nothing (no top layer, no close-request wiring). The dismissal machinery is
  already native-honest: `CloseWatcher` is the close-request API on the floor,
  per-open arming costs a never-opened panel zero document budget, and the
  `pfEscArmed` revert-then-close lattice maps onto `cancel`.
- **Native `<track>` VTT parser migration — rejected on ingest ownership.**
  Subtitle ingest is `GM_xmlhttpRequest` (CORS bypass, `@connect *`); a native
  `<track src>` fetch rides only the media element's own fetch path and can
  bypass neither CORS nor the GM grant. The fallback (fetch text → blob-track)
  is async and media-lifecycle-timed, which strands boot-restore behind a
  fetch/parse round-trip and forces the sync-offset stepper off its
  zero-await `parseSubtitles(text, offset)` reparse path — that sync path IS
  the product; parsing costs were never the complaint the main-thread parser
  fixes.
- **Toast popover migration — rejected on top-layer push.** `popover` surfaces
  render in the top layer, so a toast could then paint above the open panel,
  inverting the documented z doctrine (`panel(4) > toast(3)`) the panel owns;
  staying in the HUD layer keeps the order the tokens express.
- **`visualViewport` retirement in favor of real-world reads — rejected on
  witness absence.** The vv mirror serves the portrait bottom sheet's two
  needs — staying above the on-screen keyboard and inside the collapsed-URL-bar
  visible area — and both are *out-of-layout occlusions*: no DOM element or
  laid-out box carries them, so the real-world reads the geometry plane
  unified (root client box, element rects, ReferenceBox) cannot witness them;
  vv IS the real reading for that datum. The only non-vv arm — merging
  `interactive-widget=resizes-content` into the host page's viewport meta
  (keyboard resizes the layout viewport, Chrome 108+) — redefaults the entire
  host page's keyboard layout and covers the keyboard alone (not the overlay
  toolbar, not pinch zoom). The mirror stays, hardened: coarse-pointer boot
  gate (the sheet block is the vars' only consumer and exists behind
  `(pointer: coarse)` — a desktop arms nothing) and a pinch-scale guard
  (readers emit the CSS-default neutrals `"100vh"`/`"0px"` while
  `vv.scale !== 1`, real values at scale 1).

**The allocation drift re-audit (Nov 2026, record-only; the sweep-series
close).** The pools-and-shared-scratch record from the allocations sweep
(`2369e3f`) re-derives over the tree as shipping now, driven by a fresh
comment-stripped ripgrep inventory (`check/.tmp/alloc-slim.mjs`,
uncommitted per sweep convention — ~310 slim hits over the seven true
allocator vocabularies: spread, map/split/slice array-builds,
map/set/controller constructors, event constructors, clone/JSON/site-walk
APIs, rest params; every hit carries line context for the axis
classification). The census-proven drift fact comes first: between the
allocation sweep and this audit exactly ONE commit touched src (`4f2ea18`,
the Page Lifecycle retirement) and it is pure subtraction — three listener
arms deleted, comment prose swapped, no new statement that can allocate.
So the hot axes were re-verified, not re-measured: forge's pooled per-name
gesture event + detail (module scratch, the per-engine scope still the
safety contract), media's `setPositionState` scratch, dom's pooled
mutation buffer + DomPool + ReferenceBox's one-read pooled box, and
toast's pooled pill all hold byte-true; the declined poolings (fresh
CustomEvent per emit for the re-entrancy rule, the per-render picture
derive, the sync-offset cue-list rebuild) stay declined and their hotpaths
tripwires — the only honest re-measuring surface — sit green in the gate
battery. The inventory's claims not already in the sweep record, audited:
(a) every `logger.log` site sits at boot/refuse/gesture-start boundaries —
zero on a per-event or per-render path — so the disabled-logger cost is
one rest-array per human gesture (the disabled-path doc's promise held
beyond its own wording; `log`'s rest param allocates before the gate, but
nothing hot ever calls it); (b) every `getBoundingClientRect`/
`getComputedStyle` read on the tree is claimed by an explicit rule —
ReferenceBox's one-read-per-invalidation, forge's press-arm/session-start,
the subtitles render (the measured shape), discovery's boot gate,
shell's inject-time style read; no unclaimed hot read; (c) page.js's
iframe-registry diff is already added-node-scoped (`#diff` walks only the
added element's subtree — the full-document reseed is retired prose), so
the per-mutation-batch host tax is one `nodeType` check per added node and
zero on text/attribute batches; (d) the remaining hits are boot/
module-init derived tables (config's schema maps, filter defaults,
media's sync-event set, panel's section maps) or per-subscription release
controllers — the human-rate tail the sweeps already classify. No
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
rate axis: **(1) DOM-query families are fully native-delivered** — the
three matcher `matches()` sites (the probe, the tie loop, the host-override
walk), forge's press-arm `closest(SDK_CONTROLS_SELECTOR)` (module-static
selector string; the affordance-cursor clause's one `getComputedStyle` read
is the claimed press-arm shape), page.js's iframe-registry `#diff` riding
native `node.querySelectorAll("iframe")` per added subtree, flashElement's
element-scoped `el.getAnimations()`, and the panel/toast builders' scoped
`querySelector` meshes — no per-anchor JS loop survives anywhere.
**(2) The cleared-family backend is native wholesale** — `replaceChildren()`
is the pooled-clear backend at every pooled render site (panel title/meta,
toast icon/actions), leaving no `removeChild` loop or `textContent=""`
reparse in src. **(3) The relational operators already ride the sheet** —
the compact band's `:not(:has(...))` style query is the live `:has()`
adoption (inject.js), `:is()` rides the matcher probe, and `Map.groupBy`
is the derived-table backend at both real sites (the `POINTER_INTENTS`
family map at module scope, resume's `#buildByPath` on the merge path) —
the constructor's C++ hashing replaced the hand loops the derived-table
law used to spell. **(4) The survivors audited and DECLINED**, each recorded
so none re-opens silently: entry.js's skip-probe `new URL` parses (boot-rate
— the try is the cross-origin `top.location` read belt, not a parse guard;
`URL.parse` would index null into the identical TypeError arm with zero
call-site saving), `hashEntry`'s djb2 `charCodeAt` loop (checkpoint-rate,
~30 short strings, and no native in-realm hash exists — `crypto.subtle.digest`
is async and sized for the wrong job), `shouldSkipUrl`/`URL.canParse`
(the two-call form duplicates a parse `URL.parse` already does in one),
the forgevtt timecode `charCodeAt` fast paths (measured engine-tight at
11ms/1.1MB — the census's own tripwire row), a `Float64Array` numeric sort
for the 19k-cue ordering (no native key-sort API exists; the comparator
closure is log-n and the whole parse is budgeted), and the subtitle
placement/re-anchor rects (getBoundingClientRect reads all claimed per the
drift audit's reading rule, and `anchor()`/`position-anchor` cannot express
object-fit picture math anyway — the earlier anchor-positioning verdict
stands with no JS-positioned consumer). The sheet side already saturates
the CSS-native operator ledger (`contain` variants, `overscroll-behavior:
contain` ×2, the scroll-timeline R4 band, `@property` tokens, the
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
  below). **(0) The floor probe pinned the ledger** — Firefox 159 ships the
  full modern operator surface: `Promise.withResolvers`/`Promise.try`, the
  whole Set-integration family (`union`/`intersection`/`difference`/
  `symmetricDifference`/`isXSubsetOf` + `isDisjointFrom`), the whole Iterator
  helpers family, the Array copy verbs (`toSorted`/`toReversed`/`toSpliced`/
  `with`) + `findLast`, `RegExp.escape`, `URL.parse`/`canParse`,
  `Object.groupBy`/`hasOwn`, well-formed-string verbs, `structuredClone`,
  `using`. Every one audited for a matching tree shape: all
  **declined on consumer-absence** — runtime.js's one `new Promise(`
  consumes its resolver inside the constructor (not a deferred shape; no
  stored-resolver site exists), the tree's nine `new Set(` sites are
  module tables or work-carrying walks (the one algebra candidate,
  resume's `foreignIds` removal predicate, is bounded by `updatedAt`
  comparisons, not pure membership — `Set.difference` cannot express the
  predicate), every iteration is for-of (already the single native op;
  helpers would ADD wrapper allocation), the three `.sort(` sites are
  deliberate in-place (resume's 0.1Hz snapshot, cue ordering under the
  parse budget — a copy verb is strictly more allocation), and no untrusted
  string is ever built into a regex (the two `new RegExp(` sites assemble
  from the module-constant `SUBTITLE_EXTS`; `RegExp.escape` has no input,
  no twin exists). The `hasOwnProperty`-class census also came back empty —
  every ownership probe already rides `Object.hasOwn`/`hasOwn`-gated shapes
  from the allocation sweep. **(1) All prior saturation families re-derived
  clean over the reverted tree** (the only src commit since the audit is
  the readout revert — pure subtraction, no new statement that can carry a
  loop). **(2) The ingest engine's manual scanner is the one place a
  full C++-regexp rewrite could claim, and the A/B proved the recorded
  verdict holds live**: the `CUE_LINE_RE`-removal docstring's history
  (a capture-heavy regex state machine once ran over every line of every
  block) re-applied on today's floor with one-exec twins built from the
  corpus both engines agree byte-behavior on (0 mismatches across 38k
  timecodes + 19k timing lines): the timing-line twin is ~3x faster at the
  narrow unit (1ms vs 3ms / 19k lines) but that unit is ~2ms of the
  11ms/1.1MB whole-parse tripwire, at ingest rate — once per explicit
  subtitle load, under the file's own 50ms block budget — so the shave is
  noise-scale on the recorded rate axes, and the twin's hybrid-gate shape
  (an `indexOf` pre-guard to keep the regex off the 57k non-candidate
  lines, or the twin's 8 capture-slice allocs ×19k per load) is strictly
  more code and allocation than the landed scanner; declined, measured.
  The timecode unit is parity (2ms vs 2ms / 38k tokens) and the
  blank-line pre-scan twin is fused into the line walk with no separate
  pass to claim (manual ≈ regex/`.test` per line, all sub-ms at 76k
  lines). **(3) The two not-yet-shipped CSS operator words re-probed
  unchanged** on 159.0.1: `corner-shape` and `interpolate-size`
  (and `text-wrap-style: pretty`) still false — the redesign-floor
  probe's NOT-SHIPPED set holds. No src change earned adoption; the
  artifact is this record plus the three census/probe scripts.

**The belt-and-suspenders loop-body walk (Nov 2026, user-directed;
post-`d9e229f`, record-only, audit-clean).** A per-module re-read at the
narrowest grain the earlier audits can be wrong at: every loop body in
every JS module spot-read against the module's own sweep/saturation/
drift record, asking not "is there a faster shape" (the saturation and
C++-ops scans answered that exhaustively) but "does the shipped body
still match the shape its record claims" — a trust-but-verify pass over
the records themselves. All 22 JS modules read whole or spent at their
bodies (styles.css carries no loops); every flagged site reconciled;
**no adoptable site and no record drift found** — the verdict is
byte-true confirmation, recorded because an unverified record is a
premise, not a fact. The walker's bar held throughout: a body earns
adoption only on a measured win or an unclaimed behavior, for-of is
already the single native op, and pool/dirty-check shapes are recorded
allocation contracts, not candidates. The confirmation roll, per module
against its record:

- `subtitles/subtitles.js` (1584) — pooled dirty-checked slot render,
  amortized dead floor, ParseMemo FNV-1a keyed hash: the drift audit's
  record classes, byte-true. `forgevtt.js` (447) — the C++-ops A/B
  record confirmed live-shaped: charCode timecode walk (measured
  parity), single-capture timing scanner (the regex twin declined on
  the live A/B), blank-line pre-scan fused into the one-pass line
  walk, shape-stable `DEFAULT_CUE_SETTINGS` frozen default, in-place
  `sortCues` (copy-verb decline), the 50ms budget with the `(i & 127)`
  yield throttle; the sync fast path / async ingest split stands.
- `inputs/forge.js` (1778, effectively whole) — pooled detail walk,
  ScrubStroke's coalesced samples without a materialized array, scalar
  exp-velocity filter, indexed wheel-panel scan, `#shouldHandleKeys`
  vacancy arbitration, `#ownedKeyCodes` repeat shield: all engine-tight
  or recorded contract.
- `chrome/panel.js` (1449) — Stepper drag `while` payback (bounded,
  scalar), `#rollbackTo` spread confined to failure rate, History's
  pooled positional index reconcile + `replaceChildren()` clears, the
  indexed `querySelectorAll` walk kept spread-free as its comment
  records.
- `page.js` (1275) — `DomainKeyCache` quarter-bounded eviction, bounded
  Levenshtein over reusable `Int32` scratch (no native exists),
  `hashEntry` djb2 (the declined no-seed shape), `stripNonAscii` 8
  single-native regex passes + one-slot memo, bridge resolves already
  on `Promise.withResolvers()`, depth-4 capped `isOwnFrame`,
  added-node-scoped `#diff`.
- `inputs/actions.js` (1068) — ScrubSession's sqrt fast path (measured
  ~1.6×, gated on the exact exponent), pooled toast payload refilled
  in place, dirty-checked toast string cache, the rAF commit pump,
  IntentGates' early-break recompute at settings-bus rate, the
  `Map.groupBy` derived tables.
- `resume.js` (868) — `toSorted` adopted where the record claims it;
  `foreignIds` walk (the `Set.difference` decline — the removal
  predicate bounds on `updatedAt`, not membership); deliberate
  in-place `#enforceBounds` sort; allocation-free `#diskEchoMatches`/
  `#stampDiskEcho`; the groupBy path bucket.
- `kernel/kernel.js` (1013) — `RemovalWatch`'s bounded parent-chain
  walk (≤8 hops + margin, multi-root native observe), live-DOM
  re-derivation (`#checkAnchors`, zero queued-record reads),
  `DomSettleWait` on `Promise.withResolvers()`.
- `dom.js` (860) — the pooled double-buffer with the re-armed-empty
  swap (the `[1,1,2,2,3]` proof), `PUSH_APPLY_LIMIT` index walk (the
  ~124k RangeError story), slot-identity tombstone compaction,
  `ReferenceBox.get`'s ONE read into the pooled box.
- `discovery.js` (578) — `forEachVideoInMutations`' indexed NodeList
  drain (the generator allocation decline recorded in-file),
  PresenceGate's WeakMap + lazy prune, `entryBoxSize` delivering
  observation (no forced reflow), `isOnScreen`'s claimed rect read,
  the probe gates all floor-guaranteed single-native arms.
- `detection.js` (270) — `#fillComposedChain`'s indexed flat walk into
  the reusable scratch (length truncated against detachment),
  hop-ascending one-native-`matches()`-per-hop probe + the ordered tie
  loop: the measured ~2µs/walk / ~70ns/hit budget shapes, byte-true.
- `entry.js` (242) — the ad-host suffix/prefix scans: boot rate, one
  realm eval. `contract.js` (136) — module-init derived tables only.
- `core.js` (205) — zero loop statements exist in the file;
  `formatTime` is the recorded integer-arithmetic + concat shape.
- `filter.js` (323) — `presetMatches`' ~11ns/op literal-field shape,
  the closure-free index scan, native joins; per-key table loops at
  human/interaction rate over the 9-key schema.
- `shell.js` (607) — `cssVarSyncer`'s for-of over a ≤2-spec array with
  the Map-diff invalidation-only guard (the measured shape); the
  `MEDIA_SESSION_SYNC_EVENTS` loop arms nine listeners once per shell;
  the section destroy loop under the release-tail belt;
  `PANEL_SECTIONS` construction at first-open rate.
- `media.js` (498) — the `CLEAR_ACTIONS` teardown loop, the pooled
  `#positionState` scratch on the ~4Hz clock (the recorded alloc row),
  scalar clamp/quantum/dedup math, `URL.parse` adopted as the one-call
  null-guard.
- `runtime.js` (534) — loops only at boot/teardown rate
  (`runSteps`/`runStepsAsync`, `Scope.dispose`'s reverse walk); the
  per-task `AbortController` pair is the recorded measured
  two-controller contract, not a pooling candidate; `debounce`'s
  bookkeeping scalar.
- `store.js` (337) — byte-true to sweep #10: the for-in +
  `Object.hasOwn` walk (the measured ~78→~20 ns/op finding), the
  copy-on-write descents with the deliberate two-dot divergence,
  `split(".")` at interaction rate, `gmRequestText` on
  `Promise.withResolvers()`.
- `inject.js` (380) — one `[...adoptedStyleSheets, sheet]` copy at
  boot; `watchShellHost`'s nested walk riding the scoped childList
  observer at eviction rate; the viewport-fit regex passes at boot
  rate.
- `ui.js` (259) — `el`/`button`'s measured for-in + one-mutated-attrs
  shapes verbatim; the document-keyed WeakMap icon-template cache
  with `cloneNode` derivation; `flashElement`'s `getAnimations` scan
  at per-human-flash rate with its scan rule in the comment.
- `toast.js` (217) — the action-button build loop at per-show rate,
  the 4-field render-fingerprint skip, `replaceChildren()` pooled
  clears, scalar timer bookkeeping; `config.js` (219) — schema walks
  at constructor + echo rate (the budgeted 1000-echo storm path),
  derived tables at init.

The walk's one structural observation worth holding (no action): the
operator floor is saturated enough that every remaining loop on the
tree is either (a) the recorded allocation contract itself, (b)
rate-bounded below measurement, or (c) the semantics the feature
means — and none of the three classes can be rewritten native without
deleting the behavior. The allocator/operator record series is
re-verified all the way down; no artifact script was produced (the
reads were full-file reads, and the committed census scripts remain
the machine-checkable distillation).

**The C++ substrate audit (Nov 2026, user-directed "deeper than operators";
post-`23c0cb2`, record-only, one drift surfaced).** The operator audits
proved every JS-facing call is ONE native op; this probe descends a layer
and re-measures the load-bearing *engine-behavior premises* — what Gecko's
C++ actually does UNDER the ops — on real Firefox 159.0.1 headless.
Artifacts: `check/.tmp/substrate-floor-probe.mjs` (7-axis PLAN runner,
per-axis try/catch with an in-body watchdog that always fires `done`;
`node ... [axis ...]` filters) and its `check/.tmp/substrate-report.json`,
plus `check/.tmp/substrate-isolate.mjs` (the harness-semantics single-taps),
all uncommitted per sweep convention. Harness premises worth holding for
any future floor probe: an `executeAsyncScript` body that never settles its
`done` strands as a ScriptTimeout (a missing `done` call or a never-ending
await — both ship as a bare timeout, not an error), so bodies ride the
watchdog `done` belt; an abort scheduled before a postTask task starts
prevents the task from ever running (the yield-inheritance re-probe aborts
AFTER the park, not synchronously after scheduling); MutationObserver
callbacks deliver at microtask checkpoints, so any count read needs a
settle before it; and page-realm `performance.now` on this build quantizes
coarsely, so sub-µs per-op rides many-iteration division and premise rows
must run at a subtree scale (A was re-run at 4200 nodes) where any flush
dominates quanta rather than contesting them. Verdicts, one per axis:

- **(A) style substrate — the engine SKIPS same-value writes; custom-
  property inheritance is the expensive axis.** On a 4200-node descendant
  tree: clean rect read 250ns; same-value `setProperty`+read 375ns (the
  write API call itself, no flush — same-value class-add 187ns and
  attr-set 187ns read the same); a CHANGED custom property costs
  ~379µs/pair (≈90ns/node — the invalidation walks every inheriting
  descendant even with no consumer of the var), while a changed
  class/attribute on the host costs ~333ns/pair (element-local
  invalidation). Premise reconciliation: the shell's `cssVarSyncer`
  docstring claims a same-value setProperty "invalidates (recolors) the
  host subtree even when the value matches" — **contradicted on this
  floor** (same-value ≈ clean read). The guard itself stays exactly
  right-shaped: the Map-diff write-on-flip is what keeps the 379µs
  value-change flush entirely off the per-event path, and a `state.get`
  compare is free against the write's ~125ns — but the docstring's flush
  rationale is written as an engine fact the probe now measures false
  (docstring correction landed with user direction, post-record: the
  comment now states the measured skip + the inherited-tree flush axis,
  riding 3x green battery runs).
- **(B) selector substrate — `matches()` scales linearly in list length;
  NO hit-position discount.** list1 100ns → list15 900 → list60 2900 →
  list120 5600 (~47ns per selector entry); a hit costs ~3000ns regardless
  of position (hitFirst 3000 ≈ hitLast 3000 ≈ a full 60-miss scan) —
  Gecko charges the whole list, no ordering shortcut. ANCHOR_PROBE's
  folded-list premise holds proportionally, and the tie loop's
  registry-order law was never engine-assisted — this confirms nothing
  was lost by assuming it isn't.
- **(C) layout substrate — the flush amortizes.** Clean read 250ns;
  write+rect-read 1600ns/pair; write+2 reads 1133ns/3 ops (the second
  read ~free — layout happens once); write+`checkVisibility` 700ns/pair
  (flushes too, but cheaper than a rect read — no box construction).
  ReferenceBox's one-read-per-invalidation law confirmed at substrate
  depth: reads after the first within one invalidation window cost
  ~nothing, so the layout-free hot path is real, and a second read in
  the same window buys nothing extra.
- **(D) dispatch substrate — delivery-dominated, no boundary tax.**
  EventTarget: 0 listeners 133ns/emit; 10 → ~1233 (~110ns/listener);
  100 → ~11400 (~114ns/listener) — dispatch cost is pure delivery,
  linear in audience. Node dispatch (`bubbles`+`composed`): 250ns at 0
  listeners, ~195ns/listener at 10. Dispatching ON a shadow host with an
  empty outer audience: 250ns — no shadow-boundary crossing tax when no
  outer listeners exist. Fan's recorded premises (delivery-dominated,
  the zero-subscriber warm read, the audience snapshot) hold.
- **(E) mutation substrate — per-turn coalescing is absolute; the C++
  filter never wakes on unrelated churn.** One document-level observer +
  one 5000-append turn = ONE callback invocation carrying all 5000
  records; four rAF-separated turns = four invocations of 1000 each
  (turn granularity, the shared-feed batch-per-turn premise).
  **Filter locality: an `attributeFilter`'d subtree observer over 402,000
  unrelated writes woke 0 times (121ms of churn), while 200 related
  writes produced one ~1ms delivery sweep** — filtering is engine-side,
  so container-scoped attribute observers are invisible to unrelated
  host churn; the shared-feed premise holds.
- **(F) scheduler substrate — honest deadlines, absolute priority, the
  yield divergence exactly as recorded.** `postTask` delay:100ms over 30
  sequential samples: median drift 0ms, max 2ms. A 400-task mixed burst:
  all 200 user-visible tasks landed before the first background
  (`firstBgIndex` 200/400) — priority honored absolutely at burst scale,
  not probabilistically. Yield inheritance: yield called inside an
  own-aborted task **rejects AbortError** (the runtime.js `yield_()`
  guard recovers exactly this), and a yield parked while pending
  **resolves** when an external abort fires after the park — the
  two-controller shape's reason (an abort landing in/after the parked
  yield does not reject the aligned completion) confirmed in both
  directions.
- **(G) sheets substrate — replaceSync propagation wins per root.** 100
  shadow roots adopting one sheet: `replaceSync` ≈ 2µs/root;
  per-root re-adopt of a fresh sheet ≈ 3µs/root. The inject.js
  warmStyles parity guard's premise (re-parsing + re-adopting buys
  nothing) holds with the measured margin — the adopt-once,
  replace-on-upgrade shape is also the cheaper path.

Sweep disposition: no src change earned adoption — every re-measured
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
premises — the claims written into detection.js, discovery.js,
kernel.js, and entry.js. Artifacts: `check/.tmp/kernel-substrate-probe.mjs`
(a 7-axis PLAN runner — H entry skip surface, I ANCHOR_PROBE at
substrate depth, J removal record shapes, K observation gates, L1/L2/L3
sequencing-timer + moveBefore semantics — each axis filterable on the
CLI), isolates `kernel-substrate-isolate{,2..6}.mjs` (the bisection
trail), and `kernel-substrate-report.json` (the consolidated,
all-axes-green run), all uncommitted per sweep convention. Harness
lessons worth holding for any future floor probe: a replica must ride
SIGNAL-abort (native `TaskResult.abort()` from inside a running task
throws `TypeError` on self-abort, and an abort on an unrelated PENDING
task does not cancel it — two bisection isolates pinned each; a replica
built on direct handle-aborts hangs by construction, the same
first-fire-wins lockout shape in miniature); a subtree re-home
observation needs `{ childList: true, subtree: true }` (a stage-level
childList-only watch sees nothing on grandchildren — the cross-parent
arm's first pass recorded empty on exactly this miss); and the page's
timers fire exactly on a steady page (a sanity isolate landed a
delay-50 `postTask` at 50.0ms — the hard-hang shape earlier in the
batch was the replica's own backend mischoice, not throttle/cache).

- **(H) entry skip substrate — boot-rate trivial, audit-clean.** A
  `data:`-iframe cross-origin realm throws `SecurityError` on
  `top.location.href` at ~1000ns/throw-catch; warm `new URL` parse
  800ns; `hostname` getter 50ns; the suffix/prefix scan misses at
  ~150ns (the common miss walks most of the 10-suffix list) and hits at
  ~0 (the first suffix's `endsWith` short-circuits the ad-host case);
  the whole skip-probe pass lands 0–500ns. `shouldSkipUrl`'s shape and
  cost premises hold at substrate depth.
- **(I) detection ANCHOR_PROBE substrate — the compiled-selector cache
  IS the module-constant string.** The REAL 27-arm registry list, warm
  `matches()` at 375ns median per call, hit or miss, zero
  hit-position discount (re-confirming substrate B's whole-list charge
  at this list's length); a FRESH unique selector string per call costs
  3333ns (~9x) — Gecko's compiled-selector cache is the warming, so the
  single-constant probe string is a measured caching decision, not
  style. The full 16-hop miss walk lands at 8500ns (~530ns/hop including
  the chain build). The descriptor-cache steady state (the ~70ns/hit
  repeated-resolve budget) is a distinct plane and stays pinned by its
  own hotpath row.
- **(K) observation substrate — PresenceGate's gates are all
  frame-scale, audit-clean.** MO delivery for an append lands within
  0–2ms across runs; RO initial 1–7ms / grow 1–8ms; IO initial 1–7ms
  all run-to-run bands inside one-frame territory. Delivered-box reads
  over one captured RO batch: `borderBoxSize` read ≈ rect read (≈5ns/
  entry at 200 entries) — the layout flush amortizes across the batch
  (substrate C's law at observer scale), so `entryBoxSize`'s served
  form and a rect re-read cost the same inside one invalidation window
  and the one-read law stands on the hot-path frequency argument it
  always carried, not a per-window flush gap. The
  `contentvisibilityautostatechange` event fires exactly once on
  reveal, target = the `cv:auto` element, non-bubbling — capture-at-document is the only delivery
  route, confirming discovery.js's reveal-listener wiring as the
  measured necessity, not a convention.
- **(J/L3) removal substrate — record-shape identity confirmed in all
  four shapes; one engine finding.** Every state-preserving move
  delivers the IDENTICAL one-batch pair (removed:1 then added:1, targets
  naming the two parent DIVs): `moveBefore` reorder, cross-parent
  `appendChild` re-home, and remove+reinsert-in-one-task alike —
  RemovalWatch's "lands as the same removed/added records" docstring
  premise confirmed at the batch level. Hot reads: `isConnected`
  30–80ns, `parentElement` 30–60ns median. **The engine finding:
  Firefox 159's `Element.moveBefore` performs a CROSS-PARENT
  state-preserving re-home without throwing** — `p1.moveBefore(el,
  null)` with el parented in p2 FLIPS the parent (probed twice,
  isolated + in-axis; the element stays connected) — while
  `document.moveBefore` (a parented child) and a detached-parent call
  both throw `HierarchyRequestError`, and the cross-parent move STILL
  delivers the standard removed/added pair. This is more permissive
  than the same-parent-only reading the era's prose assumed. No src
  premise binds a throw there — the watch re-derives from live DOM
  state and carries no per-shape code, so the extra freedom costs
  nothing and needs nothing; recorded so a future reader does not
  "harden" a TypeError arm into existence at the cross-parent shape.
- **(L) sequencing-timer substrate — DomSettleWait's realized edges
  land where the tuning claims, audit-clean; the facade's cancellation
  channel gains its substrate citation.** On a replica of the kernel's
  quiet/cap shape: a quiet page settles at 50–53ms (≈ quietMs 50); a
  churning container (1 append/10ms) settles exactly at the cap
  (150–152ms), the deadline winning over the churn as designed; a
  burst-then-quiet container settles 49–50ms after the LAST mutation,
  the trailing window re-armed per mutation. `AbortSignal.timeout(1200)`
  (the entry hint cap's deadline class) fires with median 0ms drift,
  max 1ms over 10 samples; `AbortSignal.any` costs ~2.6–7.3µs/creation
  and propagates an abort synchronously (0ms). The measured caveat is
  the harness finding above: the CANCEL channel on this floor is
  signal-abort — a task's own `signal`, which is exactly the facade's
  release-controller shape — because a native `Task` handle cannot
  cancel (pending-abort is a no-op) and cannot even be touched from
  inside its own task (self-abort throws TypeError). DomSettleWait and
  every other postTask consumer on the tree ride the facade, so nothing
  is exposed to the unusable channel.

Sweep disposition: no src change earned adoption — every re-measured
premise is the shape the tree already rides, the one engine finding
(cross-parent `moveBefore`) widens a spec-reading rather than moving any
src claim, and the two docstring premises named in the axes (RemovalWatch
record identity, the capture-only reveal route) were re-proven, not
corrected. Artifact scripts under `check/.tmp/`, uncommitted per sweep
convention.

**The shell-plane substrate audit (Nov 2026, user-directed "deeper than
operators", scoped to `src/shell/` — media, resume, subtitles, chrome,
inputs — plus the chrome sheet's engine premises; post-`ea5a8f1`,
record-only, with three premise-wording corrections and one src-relevant
finding flagged for user direction).** The kernel-plane batch descended on
the boot plane's engine premises; this one does the same for the feature
layer's. Artifacts: `check/.tmp/shell-substrate-probe.mjs` (a 7-axis PLAN
runner — S1 media clock, S2 cue motion lane, S3 picture geometry, S4
pointer/click substrate + S6 Esc lattice driven by REAL geckodriver input
in node mode, S5 WAAPI flash grammar, S7 R4 scroll-edge timeline — every
evaluated body self-contained, watchdog-belted) and
`shell-substrate-report.json` (the consolidated all-axes-green run; the
trailing `done` line stripped at write time), all uncommitted per sweep
convention. Verdicts, one per axis:

- **(S1) media-clock substrate — the resume drive's clock reads exactly as
  recorded; the clamp guards are engine-required.** Flight `timeupdate`
  fired 4.0Hz (16 ticks / 3.97s, median inter-tick 280ms — the ~250ms
  doc constant is the same neighborhood, no correction), PAUSED read
  ZERO ticks over a quiet second (the first version of the axis measured
  3+ ticks — it had not paused the video before its quiet window; the
  pause ordering is part of the harness lesson), and the tick stream
  carries seek-injected ticks (the seek targets 5/9/9.5 appear verbatim:
  the clock broadcasts on seeks too — harmless for the tracker, whose
  checkpoint math is span-clamped, but worth knowing before anyone reads
  tick counts as a cadence witness). `fastSeek(9.5)` landed 9.5 in 44ms.
  `setPositionState` throws TypeError on `position > duration` AND on a
  negative duration, while negativeRate/zeroDuration/missingPosition are
  all ok — media.js's quantize/clamp (`currentTime < duration` cap) is
  measured-necessary, not defensive.
- **(S2) cue motion-lane substrate — the ENTER fade is real; the EXIT
  fade is not, and the exit prose needs its correction.** The replica
  matched the shipped rows byte-for-byte (`transition: opacity, translate,
  display … allow-discrete`, `@starting-style`, mirrored `&[hidden]`
  targets). Enter: the curve tweens from the starting-style pose
  (opacity 0→0.09→…→0.9 over ~15 frames with the 3px settle-in), reaching
  rest inside the authored 0.2s; a mid-exit un-hide re-fades cleanly from
  0. Exit: the display:none flip creates NO transition — the synchronous
  in-flush probe (the flip's own forced recalc, the exact instant a
  transition would be created) returns an EMPTY `getAnimations()`, display
  none, opacity 0 from that first frame, identical for the attribute
  flip and a class flip, while a control that flips opacity/visibility
  WITHOUT touching display creates two running transitions at that same
  flush (translate progress 8ms, opacity mid-flight 0.037). So on 159
  Gecko builds enter transitions through `@starting-style` and the
  allow-discrete lane, but never an exit transition across a display:none
  flip — the sheet's "holds to a real fade" claim for cue exit is
  measure-false, and shipped cue exit is an instant removal, not a 200ms
  fade (invisible at cue cadence; no check row pins it; acceptance is
  live). Correction candidate: the styles.css exit prose.
- **(S3) picture substrate — the transform-split reading confirms; the
  "any ancestor transform" universality does not.** GBCR carries the
  element's OWN transform scale (1000×562.5 under scale(1.25) vs the
  untransformed offsetWidth 800×450) — the rect-vs-offsetWidth
  transform-split premise confirmed. Ancestor `translate(50px,50px)`:
  the layer-relative delta equals the local write exactly (the shipped
  formula lands 487.5 on screen — deltas cancel). Ancestor `scale(2,
  origin 0 0)`: a viewport-derived delta written as a local px
  OVERSHOOTS — a video top 450 local px lands on screen 1000 vs the
  intended 775 (delta error = (s−1)×viewportDelta). `#derivePicture`'s
  "deltas stay truthful under any ancestor transform" docstring is
  measure-false for scale (true for translate). The mismatch class is
  bounded on this tree — the reference and the layer live inside the SDK
  container's own compose surface, which no known SDK puts under an
  ancestor transform — but the universal wording needs its correction
  (prose-only, correction candidate). The fill-claim premise confirmed:
  the 1.25×-scaled stream clipped to the container yields exactly the
  800×450 box, i.e. the stage clip is a no-op when fill/contain is
  aspect-aligned with the container.
- **(S4) pointer substrate (real geckodriver Actions input) — the
  prevent-scope rule gains its click-survival pin; the lift-race belt is
  unexercised by every tried shape.** Real driver taps: pointerdown/move/
  up all `cancelable: true`; a plain tap keeps its whole sequence AND the
  UA click; a pointerdown preventDefault suppresses the compat mousedown
  (absent from the event census) but still delivers exactly 1 click —
  forge's time-based `#suppressClickUntil` suppression is
  measured-necessary: pointerdown cancellation does not own the click.
  Lift race: release-in-up, double-release-in-up, and a DEFERRED release
  (setTimeout-0) after the implicit release ALL landed `ok-noThrow` with
  `hasPointerCapture` false — no NotFoundError shape was reachable from
  any race tried on this floor/driver; the two recorded lift-race catch
  belts stay as defensive release-tail machinery (teardown must complete,
  the census's classification), now with the record that their named
  shape did not fire under either probe arm.
- **(S5) WAAPI flash substrate — flashElement's finished-cancel leg is a
  belt with zero measured debt, and the restart pass is trivial.** A
  finished fill:`none` animation is AUTO-REMOVED from `getAnimations()`
  (count 0 after finish) on 159 — nothing accumulates for the scan to
  reap; `cancel()` on finished and running entries surfaced zero
  unhandled rejections and zero page errors across full cycles; the
  restart pass (scan + cancel + animate) measures ~13–43µs on the page's
  coarse clock with the animation count pinned steady at 1 through an
  instrumented 30-pass growth probe (no accumulation).
- **(S6) dismissal substrate (real trusted Esc through the driver) — the
  lattice's ordering premise holds, but the keyup wording and one
  sentence about cancellation are both due.** Three readings: (1) the
  CloseWatcher's cancel+close deliver INSIDE the keydown — plain Esc:
  keydown → `cw-cancel` → `cw-close` all at the same ms, keyup 1ms
  later. panel.js's "the watcher fires on the Escape KEYUP" engine
  sentence is measure-false; what the lattice actually needs — close
  lands AFTER the page's keydown listeners ran, so a field's
  `pfEscArmed` is already set when close re-enters — is measured TRUE,
  and the design's own close-handler armed re-check
  (`active.dataset.pfEscArmed`) is exactly the guard that defers the
  watched close on the armed press; only the keyup wording needs
  correcting (correction candidate). (2) A page's capture keydown with
  stopPropagation cannot shadow the close request — both keydown
  listeners ran, then `cw-cancel`/`cw-close` delivered anyway (the UA
  close-request stage rides outside the DOM dispatch tree). (3)
  **Cancellation is asymmetric on the keyboard path: the Esc-path cancel
  arrives `cancelable: true`, but preventDefault on it does NOT suppress
  close** (close fired, same ms), while a prevented `cancel` on the
  programmatic `requestClose()` path DOES suppress close (close absent).
  On 159 the keyboard-path close is not gated on cancel prevention. No
  impact on this tree — the panel never relies on cancelled cancels
  (its guards are armed-state re-checks inside the keydown and close
  handlers) — recorded so a future consumer of cancel-prevention against
  real Esc is not burned by this floor.
- **(S7) scroll-edge substrate — the batch's src-relevant finding: the
  shipped R4 band's ramp is arithmetically dead.** The replica carried
  the shipped rows byte-for-byte (`@property --pf-scroll-edge: <percentage>`
  / inherits false / initial 0%; keyframes animating it; `opacity:
  calc(var(--pf-scroll-edge) / 1%)` over `scroll(nearest)` at `0px
  24px`). Measured: the animated var interpolates PERFECTLY on this
  floor (8.33333% at 2px → 16.6667% at 4px → 50% at 12px → 100% at 24px,
  clock progress 0.4999… at the 12px sample) — the interpolator is not
  the problem; the SHIPPED DIVISOR is. `calc(8.33% / 1%)` = 833 (the
  idiom multiplies the 0–100% share by 100) and opacity clamps to [0,1],
  so the band's computed opacity is exactly 0 at rest (0%/1% = 0) and 1
  at ANY other timeline position: the 24px ramp never paints; the band
  turns fully on with the first pixel of scroll. Both control routes
  that carry the intended mapping ramp byte-identically — direct scalar
  opacity keyframes AND the same var route with `/100%` (0.083 → 0.167 →
  0.5 → 1.0 against scrollTop/24). Two replica-artifact classes closed
  on the way: an UNregistered custom property animates discretely by
  spec (midpoint flip between 12–14px — the first run's "hard flip"
  verdict was the missing `@property`, corrected with a registration
  control), and `%/% division evaluates fine (0%/1% = 0) — the failure
  mode is the size, not invalidity (a div-by-invalid reading would have
  pointed the fix the wrong way). Impact: visually benign in normal use
  (passing content and scrolled state coincide; the 24px gradient tail
  itself still fades), but the R4 engagement story ("ramped by the
  scroll timeline") is not what ships. The one-line fix is `/ 1%` →
  `/ 100%`, pending user direction (record-only batch).

Sweep disposition: record-only at write time — no adoption earned; every
re-measured premise held except four flagged items, ALL LANDED with user
direction in the same batch: the styles.css cue-exit prose rewritten to
the measured instant-removal fact (S2), the `#derivePicture` and
`ReferenceBox` wording split into its report/write halves with the
translate-true / scale-overshoot boundary and the probe numbers (S3), the
panel's Escape ordering sentence corrected to the measured keydown
post-dispatch delivery (S6), and the R4 divisor one-line fix `/ 1%` →
`/ 100%` (S7) — the src pass rode 3x green full-battery runs
(79.8/79.5/79.5s). Harness lessons worth holding for any future
shell-floor probe: a
media-clock quiet window must PAUSE first (the axis's own first version
counted flight ticks into its paused bucket); exit-transition questions
need synchronous in-flush `getAnimations()` probes at the flip's own
forced recalc — per-frame sampling alone cannot separate "no transition
created" from "not yet ticked" (S2); a CSS anime replica must carry its
`@property` registrations or it answers a different question (S7's first
verdict was a replica artifact); real-driver pointer taps ride
`raw.actions({ async: true })` with viewport-origin moves (an
element-origin move in the `bridge` chain delivered nothing in this
harness) — and S6's real-Esc legs ride `sendKeys` over the same action
chain. Artifact scripts under `check/.tmp/`, uncommitted per sweep
convention.

**The redesign-class decisions (Nov 2026; user direction opened the ledger).**
The saturation audit closed with "everything further is a redesign
decision of its own" — this batch is that decision, taken with receipts.
**The floor probe** (`check/.tmp/redesign-floor-probe.mjs`, uncommitted)
ran the real Firefox 159.0.1 through the redesign-class operator set:
SHIPPED — view-transition `types` + `:active-view-transition-type()`
(the `types` slice is a live `ViewTransitionTypeSet`, not an array — the
first probe's `Array.isArray` test misread it), `scrollbar-color`/
`scrollbar-width`/`scrollbar-gutter`, `text-wrap-style: balance`,
`text-box-trim`/`text-box-edge`, `field-sizing`, `scroll-snap-type`,
`zoom`, `color-mix()` + relative color, and the full CSS anchor-
positioning module (`anchor-name`/`position-anchor`/`position-area`/
`position-try-fallbacks`/`position-visibility`/`anchor-center`); NOT
SHIPPED — `corner-shape` (the squircle HUD radii stay unclaimable),
`interpolate-size`/`calc-size()`, `text-wrap-style: pretty`. The `popover`
reflection probe corrected: the attribute ships (the first check compared
the wrong default value). **Adopted: directional panel motion** — the
one closure on the ledger the floor now unblocked, the frame model's own
vocabulary completing itself rather than a new feature: the panel flips
carry `PANEL_VT_TYPES` (open `pf-panel-open`, close `pf-panel-close`) and
the sheet's `:active-view-transition-type()` rules key route-specific
motion on them — open arrives from below on `--pf-ease-bounce`, close
sinks back on `--pf-ease-out`; endpoint pose identical in both
directions, zero ink movement (R1/R4/R6 untouched, no gradient, no
backdrop-filter — the panel motion is a motion-lane change only), and
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
+ `scrollbar-color` in the sheet — that ledger entry was a miss against
the shipped rows, caught on the dist-CSS review.)

**Adopted: Balance + snap (the second redesign batch, same receipts).**
  A shipped-sibling re-verification over the dist caught one more ledger
  miss first: `content-visibility: auto` already rides `.pf-history-card`
  (`contain-intrinsic-size: auto 56px`) — it never was an open item. And
  `field-sizing` is DECLINED on a consumer-absence axis: every HUD text
  input is flex-filled (`width: 100%`/`flex: 1`), so no unconstrained
  auto-sizing input exists for `field-sizing: content` to change.
  **`text-wrap-style: balance`** adopted on the two multi-line prose
  surfaces that exist — the cue slot (`.pf-cue`, after `text-align:
  center`) and the panel hint (`.pf-panel-hint` base arm; the
  load-row's nested nowrap arm is unaffected by construction) — balance
  reflows internal line breaks only, so line count/height and the
  anchored slot geometry stay identical (the subtitles case's pixel-top
  rows are the geometry guard and stayed whole: top=557.5px etc.;
  computed `text-wrap-style: balance` pinned on the visible slot in a
  new row). **`scroll-snap-type: y proximity` + `scroll-snap-align:
  start`** adopted on the History list/cards — a rest near a card edge
  settles it to the top edge, motion away is untouched (proximity, not
  mandatory: the list still scrolls freely); asserted as a computed pin
  (list snap-type + card snap-align) riding the open-panel pool stages
  in persist.mjs, with the floor fact recorded: Firefox 159 computes
  `y proximity` as `y` (the default strictness elides in the computed
  form; `y mandatory` would show whole) — the row accepts both
  serializations and documents this.

**Adopted: trims + zoom; the anchored readout shipped and was reverted
  the same day by user direction (the third redesign batch, closing the
  ledger).** Two of the three remaining items ride the sheet; the third
  rode the probe record the furthest before real use returned the
  verdict:
  - **Pointer-anchored scrub readout — shipped, then REVERTED by user
    direction.** The gesture-scrub pill rode CSS anchor positioning at a
    zero-size `.pf-gesture-point` element (a fixed sibling inserted
    BEFORE the pooled pill — anchor validity is tree order): the
    producers wrote ONLY the point's inset at the ~100ms beat cadence,
    and the pose class carried
    `position-anchor`/`position-area: top center`/
    `position-try-fallbacks: flip-block, flip-inline` — above the point,
    flipped inside the viewport at both edges, ink untouched. Two engine
    defects had to be dodged and diagnosed, both gate-probed with
    receipts — the durable survey artifacts of the batch (kept because
    they bind any future anchor-positioning retry; the per-poke exhaust
    and the fs geometry census live under `check/.tmp/
    anchor-warm-probe.mjs` and `fs-box-census.mjs`, uncommitted per
    sweep convention): (a) the anchor lattice does not resolve inside
    `adoptedStyleSheets` under a scoped sheet's `@scope` (scoped+adopted
    falls back to the static position; the verbatim rule set in a real
    `<style>` anchors live, unscoped doc-level and scoped shadow-level
    both proved) — the pose rules therefore rode a real-`<style>` pocket
    (`ANCHOR_POCKET_CSS`) joined into the same carrier as the container
    pockets; (b) **Gecko re-derives an element's anchor plan only at
    frame construction** — a pose claimed on an element already in the
    tree resolves as static fallback forever, and the per-poke exhaust
    proved every restyle arm stale (sheet re-cascade, pocket re-adopt,
    class retoggle, inline anchor-name/position-anchor rewrites, hud
    paint writes, anchor-element reinsertion): only reinserting the
    QUERY element (the pill) re-plans it. The repair was a one-arm
    structural rewarm at the pose-claim transition — the pose class add
    re-appended the pill to its parent (an already-parented appendChild
    is a pure move: same parent, same last-child slot, listeners live).
    Also probed and recorded: anchor geometry reads from the
    untransformed layout box (the point must move via left/top — a
    transform-moved point parks the readout at the origin) and per-move
    cost is ~13µs. The revert landed on the user's one-line report
    ("the scrub broke the toast?! it follows the pointer" — a real-fs
    repro, `fs-scrub-repro.mjs`, entered REAL fullscreen headless
    through a trusted WebDriver `sendKeys("f")`: script-launched
    `requestFullscreen` is denied for missing user activation, not for
    headless — the trusted keydown grants it, a harness fact worth
    holding for any future real-fs row) whose full diagnosis proved
    the report was the design verdict itself, not a defect: detail x/y
    == client coords == the written inset, the hud layer sits at the
    viewport origin in real fullscreen (the box census; the "−40/+15
    drift" the first repro chased was geckodriver move-interpolation
    comparing a mid-drag beat against the final move target), the seek
    commits, the pose clears — mechanics sound end to end, and the
    product question was the one the user answered: the readout made
    the resting toast follow the pointer, and the resting pose stays.
    All readout surfaces retired wholesale — toast.js/inject.js/
    forge.js/actions.js/styles.css byte-true from the pre-batch commit,
    gestures.mjs's readout row removed; trim + zoom stay.
  - **`text-box-trim: trim-both` + `text-box-edge: cap alphabetic`** on the
    section labels (`.pf-panel-label`) — the label's content box
    tightens to the cap height, computed serializations pinned verbatim,
    with the height assertion on a zoom-immune ratio band
    (`h/fs` in a range covering the zoom variants) so the row holds
    under the zoom write below.
  - **`zoom` panel scale** as the new `ui.panelScale` setting (0.9, 1,
    1.15, 1.3, default 1, percent format), applied per-open as inline
    `style.zoom` on the panel root next to compact. NOT a compact-reader
    replacement (declined on semantics: compact is non-uniform —
    thumb-sized coarse targets and the bottom-sheet swap — while zoom is
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
C++-operators-first, loop-body walk) closed the space from the JS side —
every surviving loop was an allocation contract, rate-bounded, or product
semantics. This wave re-entered from the engine side on the one lens
those walks never priced: **the JS-callback re-entry tax inside native
array verbs** — the assumed standing reason callback-shaped verbs
(`findLastIndex`/`some`/`filter`) can never claim a manual walk even
though the OUTER loop of a verb is engine code. Artifacts:
`check/.tmp/native-wave2-probe.mjs` (G1/G0 sanity + three axes) and
`native-wave2-report.json`, both uncommitted per sweep convention.

- **Harness findings worth holding.** (a) The page-realm
  `performance.now()` quantizes to EXACTLY **1ms** on this floor (G0:
  every distinct step 1.000ms; a 20M-element burst reads 12ms on both
  `performance.now()` and `Date.now()` — G1's clock cross-check). Any
  measurement must size raw totals to ≥ ~20ms and derive per-element by
  division, and every row carries its raw total plus a `quantized` flag
  (min round < 20×grain) so an under-grain reading cannot masquerade as a
  number. (b) The corpus must force honest work on BOTH arms — the first
  draft ended its corpus on a predicate match, which let the
  reverse-scanning `findLastIndex` answer after ONE element and read
  0ms/scan while the manual walk paid the full N; the fix is structural
  and recorded in the probe: an all-miss corpus (both arms walk all N)
  with parity sanity rows (same answer from both arms) before any cost
  comparison, plus a one-match corpus as its own honest row.
- **(T1) the callback tax is ZERO on 159 — the old standing reason is
  dead; shape, not per-element cost, defends the manual walks.** On an
  all-miss 2M-element Float64Array (predicate never matches, so the verb
  and both manual walks pay the full N): manual constant-folded walk
  **0.46 ns/element** (23ms raw), the same walk calling the SAME
  predicate through a JS closure **0.46** (+0.00), and the C++ verb
  `findLastIndex` scanning the whole array with that JS predicate per
  element **0.45** (−0.01, 72ms raw). SpiderMonkey inlines a simple
  numeric predicate to parity with the hand loop — the callback re-entry
  costs nothing beyond the scan. What stays for the manual walks: the
  tree's scans answer at amortized windows (16-entry gesture/HUD
  scale: manual window 0.59 ns/elem ≈ 9.4ns/window vs the verb paying the
  forced full 16 at 0.92 ≈ 14.7ns/window), the loop body carries state
  the verb's contract cannot (the sorted-start walk's moving dead floor),
  and most tree scans ride strings/DOM/cue structures where no array-verb
  shape exists. Engine finding recorded: `findLastIndex` scans BACKWARD
  and stops at the match — forced match at N/2 lands 0.42 ns/elem while
  walking half — the verb's native direction IS an amortized floor, the
  shape the tree's manual dead-floor rides already; nothing to adopt,
  a premise to know.
- **(T2) scanner primacy re-derived with the shipped unit verbatim — the
  regex return-path decline stands, now with a floor reading.** The
  shipped `timecodeToSeconds` + `parseTimingLine` replicated verbatim
  over a 38k-line corpus (19k timing lines + 19k junk): **13.2 ns/line**
  (30ms raw), 0 semantic mismatches. The capture-array + `Number()`
  regex twin — the shape the scanner was written to replace — measured
  **27.2 ns/line** (62ms raw): 2.1× SLOWER today; the JIT did not shrink
  the twin's per-line allocation tax (two capture arrays, three regex
  entries, eight `Number` coercions per timing line). The unit is a
  0.25ms share of the ~11ms/1.1MB whole-parse budget at ingest rate —
  the same axis the original A/B declined on. The manual scanner is
  re-recorded correct, not re-opened.
- **(T3) flash-scan native identity — cancel-by-scan has no native
  replacement, now measured above grain.** A runtime WAAPI
  `Element.animate()` animation carries `animationName` = `undefined`
  (`kindOf Animation`); a foreign looped CSS animation carries a readable
  `@keyframes` name (`"wf-foreign"`, `kindOf CSSAnimation`). No native
  filter can select only flashElement's flash — name-selecting would
  INVERT the scan (drop the foreign background-animating animation the
  scan must reap too). The shipped `getAnimations()` +
  `getKeyframes().some(backgroundColor)` scan measured **3.8µs/pass** on
  the loaded element (ours + a foreign loop running; bare
  `getAnimations()` alone 1.4µs) at per-human-flash rate, zero unhandled
  rejections across 150k passes.

Sweep disposition: no src change earned adoption. The wave-2 probe
re-measured the one premise the saturation audits never priced and the
floor answers it at zero on 159 — but every callback-shaped verb row
still loses to the manual shapes on the axes that matter (windows pay
delta, the walks carry floors the verbs cannot, and the per-element
predicates ride string/DOM data no array verb accepts). The scanner
primacy and the flash scan's cancel-by-scan identity re-recorded with
floor numbers. Artifact scripts under `check/.tmp/`, uncommitted per
sweep convention.

## 5. Conventions (the change bar)

1. **Comments explain WHY with reasoning** — the rejected alternatives and
   the measured/probed finding. No restating code, no TODOs, no status
   adjectives.
2. **One owner per behavior.** A duplicate is either absorbed or, if both
   are real users, promoted into the shared plane. There is one registry,
   one response gate, one close path, one timer backend, one mutation feed,
   one storage watch contract.
3. **Everything machine-facing is derived from a source table** (§3 lists
   them). Adding an SDK = one record + check rows (the registry-coverage case
   demands a stub builder for every record, so the fixture promise is
   machine-enforced). Adding a gesture = one
   table row; the schema, bindings, and events derive.
4. **Stateful ownership = private classes.** If state is mutated in more
   than one public flow, it belongs to one object with `#`-fields, not to
   module-level lets. Given a choice between a stateful factory (closure
   machine) and a class, choose the class; keep the factory as a plain
   enclosing function only when one thin wrapper name must not change.
5. **Signal-scoped teardown.** Every listener accepts `{ signal: scope }`;
   teardown paths call `scope.dispose()` and nothing else; the single
   abort-fire tears everything down. Never build removal-list pairs. The
   deliberate-machines census holds this byte-true: every hand-rolled
   release/teardown machine now rides native abort compositions (an internal
   release controller per machine — `postTask`'s owner bridge (task signal +
   release), `DomSettleWait`, `DomWatch` (its subscribe release and its defer
   machine), the pinch wheel, Fan's own subscribe handle, the page.js pipe
   family (per-request settle signals, per-pipe entries, the bridge install
   mount), the panel's per-open dismissal scope, the layout-gate reveal and
   media-tap scopes, the entry hint's composite source, and the per-scope
   roots —
   its `{ once: true }`+`{ signal: release.signal }` composition detaches the
   owner listener natively on whichever path ends first), and the census of
   `removeEventListener` across src comes back empty: zero live manual
   removals remain, Fan's handle included — its handle now tears down by
   abort like every other machine's. The steady-state listener & observer
   census (sweep): 124 static registration sites, 28 at document/window
   level, zero manual removals — and every unscoped-looking site verified
   either `{ signal }` on a continuation line, an options-var binding,
   the panel's per-open dismissal scope, or a deliberate page-lifetime
   plane — three exist, all load-bearing: the bridge's ONE window `message`
   listener (`installContextBridge`; its returned teardown is consumed
   nowhere, the same page-lifetime arrangement as the kernel's shell-ready
   handle — sibling routes are isolated inside the single handler, and the
   two other page.js `message` listeners ride per-request settle signals),
   the FsGate singleton's three listeners (document `fullscreenchange` +
   the pagehide/pageshow pair on the document's *view* — those lifecycle
   events fire at the Window and never traverse the tree — with the `#doc`
   latch making a double script eval re-seed without stacking), and
   DomWatch's one page-level MutationObserver (the shared mutation feed IS
   the page plane). Everything else is scope-settled or element-owned —
   listeners on nodes the feature DOM discards ride natural GC teardown; a
   signal there would be ceremony, not scope. Per-state live table:
   pre-boot = bridge 1 + DomWatch MO + 1 visibilitychange + discovery's 3
   document media taps + the kernel's pageshow/pagehide pair (the resume
   arm retired - freeze/resume unreachable on the Firefox floor) +
   the entry hint trio (armed only in the first-run hint window) + the 4
   `watchStorageKey` consumers (the GM echo channel, not DOM events);
   live shell = resume's 6-event drive cluster + its IO + media's
   loadedmetadata listener + 2 witness MOs + subtitles' rVFC crank (an
   arm, not a listener) with its video RO/IO + 4 video events + 2 host
   gesture relays + ReferenceBox's RO/orientation/scroll + forge's
   machine-owned streams + the shell's document-level wires; panel open
   adds exactly the dismissal trio + the CloseWatcher close listener on a
   per-open scope; scrubbing adds zero listeners (the rAF commit chain is
   one callback swap, not a socket).
6. **Imports:** one per realm-form, combined; `shared` below package imports;
   module files import only downward across planes (kernel → contract,
   shell → shared/kernel-contract), never sideways into a sibling's consumer
   (the import graph is enforced by the flaws gate's isolated import
   smoke).
7. **No comments in check/ code beyond the why-docstrings it already
   carries; `installGMRealm` must stay a single self-contained function**
   (it ships as an executeScript payload — no closure references).
8. **ES target floor: Firefox 159.** `?.` chains, top-level field syntax,
   `data-transfer` file APIs, View Transitions, CloseWatcher — all in scope;
   nothing below the floor, no polyfill arms.
9. **Version is derived** (esbuild reads package.json). Header updates are
   interventions, not edits.

## 6. HUD design law (binds any visual change)

Still in force from the design process — rewritten ink-style by user direction
(the glass era's audit, budget, and contrast machinery are history below);
`src/shell/chrome/styles.css` is the only surface, scales/tokens
`@property`-typed, gradients banned in the HUD:

- **R1 Ink budget: zero `backdrop-filter` surfaces, anywhere.** Every sheet —
  panel, toast, and every in-panel control — paints opaque ink or a flat
  surfacing on top of it; the compositor never blurs video under HUD geometry
  (the glass era paid a per-frame `blur(16/24px) saturate(1.7/1.8)` on its two
  sheets plus a masked band; that cost is why ink won the resource audit). A
  `backdrop-filter` returning is a redesign decision with its own justification.
- **R3 One resting ink (`--pf-sheet: #0e0e10`), unchanged by focus** — opaque,
  content-independent; text legibility is a fixed material property (white on
  the ink ≈ 18.9:1, the 64% secondary ≈ 9.9:1 — both past WCAG AAA at 7:1 over
  any video). The `ui.glassTint` setting (Clear/Medium/Opaque alphas on
  `--pf-tint-alpha`, GLASS_TINTS) is *retired*: translucency was the only thing
  it could parameterize, and the glass era's two-state focus split was already
  retired before it. Stale stored `ui.glassTint` keys stay harmlessly unread
  (the schema coerce ignores unknown keys).
- **R4 Every scrollable sheet keeps its scroll edge** — the pinned panel
  header rides the one sanctioned gradient: solid ink at the rail fading down
  a 24px tail, engaged by the scroll timeline at `--pf-scroll-edge` only while
  content actually passes under it (0% at rest — the band paints nothing).
  No blur, no mask: with the sheet opaque the gradient alone carries the fade,
  and the weaker-era "one notch darker" derivation died with the transparency
  it arbitrated.
- **R5 Nested radii are concentric and derived:** container radius R with
  inset padding P → inset elements use R − P (panel 16 → strip/close 8 →
  tab 5). Derived, not chosen, so container changes stay correct.
- **R6 The panel (sheet) has the largest radius in the HUD (16px).**
- **R7 Section headers are title case** (no uppercase transform).
- **R9 Every HUD change needs a measured contrast assertion**, not a
  screenshot. The opaque ink makes the assertion content-independent (spectral
  ratios above); geometry (resting radii, control positions) may not move as a
  side effect of appearance work.
- The current set is **opaque ink + hairline border, nothing else**
  (separation from video is the `--pf-sheet-border` hairline alone — the rim
  era and the soft drop shadow died by direction, the shadow's glass-era
  48px ancestry with them), **zero linear-gradients with one sanctioned
  exception**: the R4 scroll-edge band is the single solid-to-faded
  linear-gradient — the only gradient permitted in the HUD. **No inset white
  highlights anywhere** — the rim era (`--pf-header-rim`, `--pf-sheet-inner`'s
  rim insets) retired by direction. Zero blur layers, zero shadow layers.

The HUD token sweep (census) re-derived the token plane from both sheets
(styles.css + inject.js's compact band), comment-stripped: **zero orphaned
tokens** — every declared `--pf-*` has a reader, with one census-relevant
shape: `--pf-compact` is read through a **container style query**
(`@container pf-compact-bus style(--pf-compact: 1)`) rather than `var()`,
so a var()-only counter would misreport it dead. Six tokens read without a
sheet declaration, all legitimate: the five `@property`-registered ones
(`--pf-cue-top/left/x`, `--pf-media-paused` — registration provides the
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
lg 16 → md 12 → sm 8 → xs 5).

## 7. check/ — the testing tool

`check/run.mjs` is the repo's one testing interface. Gates run in order and
stop at the first failure:

1. **syntax** — parse-only V8 check of every src module (parallel children).
2. **flaws** — repo eslint + isolated module-import smoke per module.
3. **census** — the executable census: the recorded AGENTS.md counts
   (ten Fans, eleven Scope roots, the zero-timer pipeline, zero manual
   teardowns, the empty-catch belt, the wall-clock reads, the network
   egress floor) re-derived statically as literal occurrence counts over **comment-stripped** source —
   prose that names a pattern (`runtime.js` mentions `catch {}` in a
   docstring, `kernel.js` names `removeEventListener` in a comment) must not
   count, so a naive grep would misreport the record. Each row carries its
   why-docstring: a red row is answered by updating the gate's expect **and**
   the AGENTS.md census in the same commit, with the change's why — never by
   bumping the number alone. The error-path A→Z sweep classified every
   throw/catch under comment-stripped src (6 throws, 34 catches) into
   eight named classes, each with its why: **throw-through** (media's
   play/PiP rethrow non-benign after the AbortError/NotAllowedError
   filter — callers own a failure surface), **release-tail bare
   catches** (panel-section destroy loop, MediaSession destroy belt,
   forge's two pointer-lift races — teardown must complete, not report),
   the **Scope isolation site** (`#runDisposer`: catch-log-never-rethrow,
   the only machine given that verb), **witness-absence fallbacks**
   (shouldSkipUrl's belt-owns-the-contract, discovery's rect
   try/returns, page.js's cross-origin contentDocument subtree-end),
   **port-lifecycle races** (the bridge's five postMessage/port sites —
   re-establish the pipe, not an error path), **log-then-continue
   persistence** (resume/store persist, inject's monotonic resource
   upgrade, panel's build rollback+toast, subtitles' three-stage #fail
   toasts, entry's bridge-install isolation with the probe still
   running), **feature-degrade** (CloseWatcher null with the keydown
   path still dismissing, DOMParser belt, session-metadata skip until
   the next key change), and **fan-out isolation** (dom-watch's
   per-subscriber belt; the bridge dispatch's `reportError` rehome —
   the platform's own out-of-band report verb keeps deliberate error
   sentences on the page error surface the audit ledger reads, while
   sibling routes inside the dispatch stay isolated). Tool-facing
   metric this feeds: the browser cases fail on any page error, so a
   rethrow or reportError sentence must always be deliberate by
   construction — the classes are the map behind that ceremony.
4. **bundle** — real esbuild build (version derivation) +
   artifact shape validation (header fields, IIFE shape, css companion) and
   the manager-contract pins: the exclusion list only ever rides the strict
   `@exclude-match` surface, `@downloadURL` stays present for the updater,
   exactly the 2 `@connect` lines ship with the `*` umbrella among them (the
   census's network block's header half — a dropped umbrella kills every
   user-supplied subtitle URL against CORS with no error a user could act
   on), exactly 1 `@resource` ships (pfStyle; a second resource is new
   manager-lifecycle egress), and the HUD class-vocabulary agreement scan — every `pf-*` class the
   source JS spells must have a reader on styles.css or the inject-side
   sheet (a class no CSS consumes is a dead vocabulary token, the same
   audit shape as the grant-coverage check; `pf-debug` is the
   `DEBUG_HASH_TAG` vocabulary, never a class, and trailing-hyphen tokens
   are template id prefixes); plus the sheet-fidelity row — the shipped
   sheet must contain no grammar-token glue (`)and(`/`) or`-family after a
   `)`, `)[+-]` for the calc infix), the signature of a minifier regression
   that shipped the two compound coarse-pointer media rows inert — the
   mobile coarse bottom-sheet block and the landscape coarse compact-panel
   block never applied, and the two calc infix glues inside the bottom-sheet
   block died double-covered, dead rows owning the glued declarations.
5. **browser** — real browser + real bundle in a GM realm: **real native
   Firefox 159** headless, driven by geckodriver (this branch's floor, not a
   fork shim). Proves: boot, gesture contract, media semantics, resume,
   menus, GM env, frame scenarios, subtitle picture anchoring, edge
   robustness. ~60s.

### Browser gate mechanics
- **Row statuses are binary: only an explicit `"pass"` passes.** A case file
  returning a boolean or shorthand status reads as fail (a real failure this
  once shipped as a false row the aggregator skipped past, and four
  all-green runs stood behind it).
- Launch ladder: disk geckodriver → Selenium Manager (geckodriver majors are
  cross-version, so there is no version-matching gate to fail), with a
  browser-aware `ensureFirefoxDriver()` probe, a selective
  `brew reinstall geckodriver` heal when the disk is empty, and a
  real-session sentinel (`window.__checkReady === true` via `return`-ing
  script — expression-only bodies return `undefined`, the historical bug).
  Window rect via the native `setRect` command (no `--window-size` exists on
  Firefox); startup-tab hygiene closes any session-restore extras;
  `navigate()` verifies the landing (origin+path, one retry) because a
  `get()` that resolves before navigation can eat a whole case.
- **Ceremony per case:** `navigate(page?boot=<ts>)` (query-bust, same-URL
  reload would eat the bundle) → GM realm → bundle (everything after
  `==/UserScript==` in the dist IIFE) → `wakeVideos` (dispatch `loadeddata`
  so the probe sees present videos) → `.pf-shell` up to 9s.
- **GM realm** (`check/lib/gm-realm.mjs`): a faithful per-`@grant` surface —
  exactly the shipped grants, no more; a synchronous `__pfBacking` store;
  `__gmTest` audit surface (`remoteWrite`, `usage()`, `aliveMenuIds`); timeout
  + cold-cache wiring; forensics hooks (`__pfErrors`, `__pfConsole`, capped
  `__pfConsoleLog` capturing console chatter incl. `Shell registered: <sdk>`);
  `installGMRealm` is one self-contained function by design (§5.7).
- **Fixture server** (`driver.mjs`): dual-loopback listener — the same
  handler and port on `127.0.0.1` **and** `::1`, so `http://localhost:P` is
  a genuinely cross-origin route versus `http://127.0.0.1:P` with zero second
  server. Range-request support (206) is load-bearing for seeks (a
  non-rangeable stream silently discards `currentTime`). The video fixture
  (12s, `-movflags +faststart`, h264+aacs) is built once with the machine's
  ffmpeg.
- **Frame scenarios** (`cases/frames.mjs`): `injectGMRealmFrame`,
  `evalInFrame(path, fn)`, `waitForFrame` (poll re-enters the frame chain —
  a swapped document resets the script target anyway), `snapshotFrameState`
  forensics. Fixtures: `embedHostPage` (deliberately **no**
  `allowfullscreen` — the kernel must add it), SDK anchor stub pages
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
  foreign `pf:diag` write through the audit surface — cross-realm delivery
  itself stays manager-truth (every harness realm is an echo island;
  the same premise the settings live-reload row rides).
- **Cases (14):** `boot` (install contract, positive/negative discovery),
  `discovery` (min size, no-anchor, tiny-video),
  `fan` (the fan-out owner unit, imported into the page realm: positional
  fan, callable handle, native signal teardown, aborted-signal no-op,
  Symbol.dispose presence+use, `using` release (a live and a dead handle),
  mid-dispatch batch join, 10k-emit budget, and the dispatch-isolation
  witness: a throwing subscriber strands neither followers nor `emit`, its
  throw reports to the page error surface by design, and the deliberate
  error sentences itself out of the uncaught-error ledger),
  `sdk` (the registry-coverage gate, imported into the page realm through the
  served working-tree module: every registry record resolves against a real
  anchor-satisfying stub — name, container element, and one hop — the bare
  video keeps its null answer, the Clappr compound beats the Core on fewest
  hops, and a record without a stub builder fails its row),
  `frames` (§ above),
  `gestures` (skip/mute/volume/panel/PiP/scrub with real driver input),
  `hotpaths` (the hot-path budgets: the per-frame/echo loops the tree rides,
  benchmarked in the REAL engine as regression tripwires — fan dispatch at
  100k emissions (10-subscriber echo-audience shape and the zero-subscriber
  warm read; the fresh-CustomEvent ~2.9µs/emit re-measured and the pooling
  decline re-recorded), the ingest engine's full 1.1MB / ~19k-cue parse and
  its offset reparse (double-digit ms), 250k HUD formatter calls, and the
  zero-alloc allocation probes — the fresh-vs-pooled measurement pairs that
  answer every zero-alloc rewrite candidate: the per-render picture-derive
  box (fresh object at rVFC cadence vs one-retained-picture + one-scratch
  ping-pong; PARITY at 1M renders, ~5ms harness-precision floor both) and
  the sync-offset cue-list rebuild (#applyBase's fresh Array + object per
  cue per stepper commit vs list+object reuse with a module comparator;
  PARITY at the pathological 19k-cue scale x 15 commits) — both poolings
  DECLINED as noise, the same verdict the fresh-CustomEvent pooling
  decline recorded, and every budget a multi-x multiplier over the
  measured baseline, so the tripwire catches shape regressions (an
  accidental allocation loop, a megamorphic rewrite) and never CI jitter;
  nothing earned an adoption — the loops are already engine-tight and the
  measured verdicts are the batch's record). **The adoption identity
  plane rides the same gate** (the kernel's uBO-grade path pinned as
  budgets): 1000 first-resolve composed walks over the REAL served
  registry resolve whole at the measured ~2µs/walk (the probe shape — the
  registry anchors joined into ONE selector list, one native
  `matches()` call per hop answering "any anchor match?" in the C++
  selector engine, then one ordered registry/anchor tie loop at the
  winning hop — was ~5µs/walk under the per-anchor `matches()` loop
  bounded by best-hops; a walker regression shows at ~10x), and 100k
  repeat resolves ride the descriptor cache's steady state at the measured
  ~70ns/hit (unchanged by the probe — one WeakMap read + one parentNode
  compare + the record alloc — the ~30x hit/miss ratio IS the cache's
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
  held route, pfStyle resource warmth, menu-handle census (four live
  commands: debug toggle, the frame-state dump, the two resets), the
  diagnostics dump row (one menu tap prints the realm's own state line
  through the warn plane — identity, live registry, per-video attribution
  parsed whole), harvest-seeded
  reboot), `media` (stream, gesture events, kernel re-anchoring onto a
  replacement video, the containment re-wrap (a second SDK container — the
  destroy-readopt seam, one shell ends in the new home), the one-main
  refusal row (a second Plyr wrapper with a second video appended while the
  main is live → still exactly one shell, the second video unstamped — a
  refusal is an absence, so the row samples to a stable no-adoption), the
  refusal-recovery row (the refusal leaves the candidate unpinned — no
  seen-pin, no gate — so once the live shell's owner is really removed and
  the registry-empty edge fires, the re-armed full tap's seed walk adopts
  the surviving candidate, whichever video the doc-order pick left
  unshelled; the strand shape, a refusal surviving its refusal with no
  recovery path, is the row's fail), and the
  state-preserving move: a `moveBefore` reorder
  in place and a cross-parent re-home of the running shell, both
  floor-real), `menus` (menu command → panel effect; the targeted
  reset row seeds a non-default color filter and proves the bare command
  restores it — no panel involved, and the directional-motion row: the
  panel flips spy-deliver their view-transition types (open=
  `pf-panel-open`, close=`pf-panel-close`), the HUD sheet carries a
  `:active-view-transition-type()` reader for both words, and the R9 ink
  pin rides the row (the panel's computed surface/border identical
  before-open vs after-close — motion-lane-only, asserted at full depth);
  the trim row: a seeded section label's computed
  `text-box-trim: trim-both` / `text-box-edge: cap alphabetic` serializations
  plus a zoom-immune height ratio band (`h/fs` bounds hold across the zoom
  variants); the zoom row: the panel measured open vs `ui.panelScale: 1.15`
  seeded — computed `zoom` reflects the inline write, rects scale by the
  factor while computed radii/font-size stay unzoomed authored px (the R5
  identity), and resting ink unchanged — with a panel-open wait and a
  close-panel restore before the typed row keeps later rows undisturbed),
  `persist` (storage seeding, resume restore across reboot, the sync-grain
  row: one nudge gesture lands `subOffset` in the tracker's entry, the
  Start-over row proving the explicit boundary writes past the drift
  epsilon, and the foreign-omission row proving a removal adoption with no
  write-back resurrection, plus the scroll-snap pin riding the open-panel
  pool stages: the History list's computed snap-type (`y` — Firefox 159
  elides the default proximity strictness in the computed form) and a
  card's `snap-align: start`),
  `subtitles` (the picture-anchor case: a letterbox stage — square element
  in a taller stage — proves percent cue fields land on the displayed
  picture rect, not the layer box, with the panel drop as the real ingest
  path; a motion-lane row proving a visible slot's computed
  `transition-property` is exactly opacity/translate/display, the anchor
  lane absent; a resize row (video element + stage widening) proving the box
  ticks re-anchor the running slots without any cue change; the own
  scheduler's boundary rows — one seek into a second cue's window lights
  the enter, the window passing drops the exit — plus the V-stepper
  placement row (typing "90" into the panel stepper's live-commit field
  re-anchors the running slot the same frame) and the scale row, a
  >512KiB drop through the real panel path proving the cooperative
  parse (the arm the retired Worker offloader left as sole backend)
  drains and lands its overloaded cue, and the balance pin: the visible
  cue's computed `text-wrap-style` is exactly `balance` (vocabulary
  presence — the pixel-top rows are the geometry guard balance must not
  move), `robust`
  (hidden-flush without user pause - a real second tab sets the document
  hidden and the native visibilitychange flush must land the position; the
  freeze surface the row once dispatched synthetically is Chromium vocabulary
 Firefox 159 has no realm for, probed - , checkpoint cadence on the native
  timeupdate media clock at 4x, 1000-echo
  < 400ms, 400 remote-adoption merges < 800ms),
  `scheduler` (the postTask façade unit, imported into the page realm:
  firing order and delay honors, dead-handle/release/rejection-swallow
  choreography, the two-controller shape surviving an abort inside the
  task body, and `yield_()` recovering what raw `scheduler.yield()`
  rejects).
- **One `sleep` helper** (check/lib/driver.mjs): every node-side wait
  between driver commands and case steps buys the one promise shape; the
  three local twins it absorbed (a `settle` in two case files plus ~40
  inline one-liners) went with it. In-page probe sleeps stay self-contained
  on purpose — the evaluated bodies serialize into the page realm and can
  never close over a check-module import.
- **Per-case audit rows** follow every case file: uncaught page errors
  become fails, `console.error` becomes informational rows, a GM-usage
  census row; failing cases get a screenshot + page-state dump into
  `check/.tmp/`.

### The working cycle (this is the workflow law)
1. Implement: all gates run; **≥2–3 consecutive all-green runs** before any
   summary or commit.
2. Rows are honest: a red row reveals a real gap — only then touch kernel
   source, never to make a row green.
3. Summarize results and **wait for an explicit "commit and push"** — never
   commit proactively; never amend a failed commit, create a new one.
4. Development environment facts ride with the tool: Helium auto-updates
   mid-flight (155→156 happened); do **not** adopt Chromium's IndexedDB→
   SQLite backend backing for userscript storage; Chromium failed-module
   retry policies are irrelevant (single-file bundle).

## 8. Quick diagnostics

- **Gate fails at syntax/flaws:** run the concatenation of the isolated
  import child output; if a module brings a consumer it doesn't use, that's
  the import-graph smoke catching it.
- **Gate fails at census:** a recorded count moved — the red row names it and
  prints the why it guarded. The fix is a reasoning commit: update the gate's
  `expect` in `check/stages/census.mjs` and the AGENTS.md census together,
  with the change's why in the message. Bumping the number alone is what the
  gate exists to make visible, never the fix.
- **Browser gate launch refused:** `driver probe` prints the disk geckodriver
  and the Firefox binary version; geckodriver is cross-version so there is no
  stale-major shape — a repeated `handshake failed (no marionette port)`
  after a browser update is the known mid-update shape; relaunch after the
  browser finishes updating.
- **A case's shell never attaches:** the boot ceremony dumps
  `{readyState, shell, video, pf, lastInjectError}` before throwing; the
  `.tmp/last-failure.png/json` capture adds `frame[0]`,
  `frame[0][0]` state via `snapshotFrameState`.

---

*AGENTS.md replaces DESIGN.md (the HUD guide it restates in §6). Committed
story: see `git log` — the pass era is `8c560e6..a044fe1`, the tool era
`b226fe8.."1dbf397"`, the input pass `3971636`/`1637549`, the stateful-class
turn `cff0ab0` + `c95db6a`, the layer unifications `4737f84`-`6a9411d`, the
redesign `3d0a772`-`c439fec`, and the tool hardening `b226fe8`..`98b17fa`; and
then the review-sweep series — twenty-one A→Z/census
passes, each recorded in place above: kernel layer (`7ffd3eb`), rVFC/rAF
floor probes (`3177185`), fs-ui branch closure (`dfaceee`), allocations
end-to-end (`2369e3f`), media plane (`90c8a62`), listener/observer census
(`28a408a`), error-path census + header↔runtime cross-check (`49e1f80`),
settings key occupancy (`d7d82b0`), HUD token sweep (`b61ec2c`), resume
plane (`980d6d1`), build pipeline — the minifier fix (`ecc36a8`),
bfcache/freeze-recovery plane (`4f2ea18`), exclusion-vs-registry
non-overlap (`f8149cf`), network egress census (`1b95cc2`), manager floor
at premise level (`b52821c`), shell lifecycle (`b89b8bd`), chrome modules
(`b92c7a0`), and store.js proper (`a68f076`), closing with the allocation
drift re-audit (Nov 2026, record-only — see §4's drift block), the inputs
plane (`2d67422`), the shared geometry/context planes — dom.js + page.js
(`4893b78`), and core + runtime — closing the sweep
map with every src module family carrying a dedicated record — plus the
adoption identity plane (`0f06dbd`, the measured hotpath budgets) and the
two post-close record-only audits: the allocation drift re-audit and the
native-operator saturation audit (post-`75437f2`, the probe batch), then
the substrate series (C++ `20b07da`, kernel-plane `ea5a8f1`, shell-plane
`5479871`) and the native-replacement wave-2 probe (post-`5479871`,
record-only). The
series'
record-only commits changed
AGENTS.md alone; every src-touching pass proved
itself on the full gate battery before its commit.*
