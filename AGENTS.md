# AGENTS.md — PlayerForge, the complete guide

Read this before touching code. It describes what the product is, how every
module fits together, the conventions that decide "is this a good change", the
full refactoring path the tree has walked (the OOP development program), the
HUD design law that still binds any visual change, and the testing tool that
proves a change real. Sections 1–3 and 5–8 are load-bearing; section 4 is the
history that explains why those conventions exist.

---

## 1. What PlayerForge is

A Userscript-exclusive HTML5 video player enhancer for two fork browsers:

- **Helium** (macOS desktop), **Titanium** (Android)
- Chromium **156+** platform floor, **Tampermonkey 5.5+ (MV3)** manager
- Features: pointer/keyboard gestures, hotkeys, progress resume, watch
  history, subtitles (.srt/.vtt with per-cue placement, per-entry sync
  offset, URL/file restore), color filters with presets, per-domain
  zoom/pan crop, in-player settings panel, toasts, extensible shell surface
- Not a general browser tool: ad-heavy hosts and player platforms are
  excluded in the header (YouTube, Vimeo, Netflix, streams, socials…), and
  `entry.js` keeps a runtime skip list above that.

**Repo shape (25 source modules, ~14k LOC):**

```
src/
  entry.js            install-time contract: which frames run the script
  kernel/  (4)        contract, detection, discovery, kernel orchestrator
  shared/  (5)        core, runtime, dom, page, store — the data planes
  shell/   (15)       shell, media, resume, filter, forge+actions+zoom,
                      subtitles(3), chrome(5 + styles.css)
check/                the one testing tool (see §7)
dist/                 generated, not the review target
esbuild.config.mjs    single build: IIFE userscript + css resource + worker chunk
```

**Shipping artifact** (`dist/playerforge.user.js`, ~152 KB one IIFE +
`dist/playerforge.css` via `@resource pfStyle`): match-all userscript with a
40-host exclusion list, 8 grants (`GM_setValue/getValue/registerMenuCommand/
unregisterMenuCommand/addValueChangeListener/removeValueChangeListener/
getResourceText/xmlhttpRequest`), `@connect *` + subtitlecat, `@sandbox raw`,
**`@run-at document-start`**, deliberately
**no `@noframes`**: every frame gets the script (§2). Version is derived from
`package.json` by the build; never hand-edit the header version.

**Commands:** `npm run build` (or `--watch`), `npm run lint` (eslint src/),
`npm test` — the alias for `check/run.mjs`, the repo's one testing interface.
`npm run check:browser`, `check:flaws`, `check:syntax` run individual gates.
A clean run is ~33s.

---

## 2. Frame model (the most load-bearing fact)

The manager injects the script into **every frame** of every page — top and
iframes, same-origin and cross-origin:

- Each frame document runs the full bundle: its own kernel, its own bridge
  installation, its own GM realm. A kernel boots only when **its own
  document** holds a qualifying video, so exactly one document boots a shell
  per embedded player, neighbors stay inert, and a video-less host page never
  boots.
- Menu commands install **top-frame only**.
- `window.top !== window` frames push fullscreen provisioning up the chain on
  shell creation: every ancestor document grants `allowfullscreen` on its
  *direct child* iframe only (`installContextBridge` /
  `requestFullscreenProvision` in `page.js`).
- Page context (`domain/path/title`) is read from `window.top` directly when
  same-origin-capable; cross-origin frames go through the frame bridge
  (postMessage `pf:`-prefixed, MessageChannel ports with a legacy-broadcast
  fallback, `ContextPipe` retry backoff `[60,150,320,640]`), so the resume
  entry always carries the **top document's** context. When nothing answers
  (bridgeless embed), the frame falls back to its own context rather than
  losing resume.
- Navigation: `pagehide` tears the kernel down unless `event.persisted`
  (bfcache keeps it); `pageshow`/`resume` (freeze recovery) re-arm it.

## 3. Module map (A→Z)

### shared/ — five data-shaped planes, import-clean of each other
- **core.js** — clamping `P()`, tuning constants (`TUNING`, resume cadence,
  gesture timings, `RESUME_*` floors), formatters (`formatTime`,
  `fmtPercentOrOff`, …), error classification, `delay/debounce` moved out
  (they live in runtime's scheduler). Zero imports.
- **runtime.js** — the scheduling engine: a `postTask` façade over
  `scheduler.postTask` (single native arm; the jsdom emulation lives in the
  check harness, not here), `delay()`/`debounce()` handles (the one timer
  backend), `runSteps`/`runStepsAsync` (ordered declarative step lists for
  every boot/teardown sequence), `Scope` (one destroy-root per feature, every
  listener/timer/observer routed through it), `DebugRuntime` (log chatter AND
  the LoAF diagnostic flip as one unit), logger facade.
- **dom.js** — the shared mutation feed (`onDomMutations`: ONE page-level
  MutationObserver every consumer rides — element pooling, the shell ledger,
  shadow traversal, the fullscreen gate, the iframe registry), `PoolElement`
  machinery.
- **page.js** — site identity (`getDomainKey`, `domainsMatch`, `domainScore`,
  `hashEntry`, title sanitizer), page context, the frame bridge (`pf:` prefix,
  `ContextPipe` class owning pipe/legacy/in-flight state, context responders,
  fullscreen provisioners), native navigation events.
- **store.js** — the storage data plane: `KEYS` = two roots (`pf:configs`,
  `pf:resume`), `gmSetValue`/`loadJsonObject`, and `watchStorageKey(key,
  handler)` — the cross-tab subscription that filters own-write echoes
  (`remote === false`) in exactly one place. Storage is **synchronous GM
  storage, deliberately not IndexedDB** (manager-space portability; a
  cross-tab live-reload needs echo events, not thread offload).

### kernel/ — policy layer
- **contract.js** — the shared vocabulary both layers import in isolation:
  gesture registry (`GESTURES`/`GESTURE_IDS` are formula-derived from `{id:
  label}` pairs), `GESTURE_EVENTS` (`pf:gesture-<id>`), `BRIDGE_MSG_PREFIX`,
  `DEBUG_HASH_TAG = "pf-debug"`, media-key constants, tuning knobs. No
  machine-facing string is hand-spelled anywhere else.
- **detection.js** — the SDK identity engine, registry-driven, import-free.
  15 supported SDK records (JW Player, Video.js, Plyr, ArtPlayer, DPlayer,
  MediaElement.js, XGPlayer, Aliplayer, Fluid Player, Flowplayer, Clappr,
  Vidstack, Mux Player, Radiant, Laravel Video Embed), each a set of
  **SDK-namespaced anchor selectors** resolved through composed ancestry
  (`closest()`, shadow-boundary aware); the matched element with the fewest
  ancestor hops wins. There is deliberately **no generic fallback** — a bare
  `<video>` with no SDK anchor never boots.
- **discovery.js** — presence machinery: min-size thresholds (100×60),
  on-screen/layout deferral gates (`PresenceGate`, per-instance
  MutationObserver check), the media feed (`DiscoveryTap`: lazy escalation —
  cheap tap first, full listeners only for rendered candidates), idempotent
  boot sentinel, `RemovalWatch` (grace-per-disconnect observer, re-parent
  aware).
- **kernel.js** — the orchestrator: `whenDomSettled` boot sequencing, the
  `ShellSlot` (one shell per session; a displaced shell is **destroyed**,
  never orphaned), `MenuCommands` (debug toggle + the two one-shot reset
  commands, installed from script eval and resolving their shell host
  through the entry's kernel reference — works even kernel-less),
  pagehide teardown, freeze/pageshow recovery, per-boot
  manage-ability downgrades.

### shell/ — the feature layer
- **shell.js** — composes the boot step list (realm → settle → DOM layers →
  HUD wiring → media session → sections → markers), stamps managed markers,
  owns destroy and re-anchor paths.
- **media.js** — `MediaControls` (play/pause/seek/scrub-latch/volume/rate/
  boost/PiP/stop), `MediaSessionOwner` claim/lifecycle, `WakeLockSession`
  (screen wake-lock companion: acquire on play/visibility/boot, release on
  pause/ended/destroy, browser-owned via an abort signal).
- **resume.js** — the resume tracker: store warm → context resolve → entry
  match/create → restore → progress drive. Save cadence = 10s checkpoint
  span; flushes on `seeked`, on pause, on visibility loss, on freeze;
  `RESUME_MIN_POSITION` (5s) floor; bounds cutoff; the entry carries
  per-viewing extras (`subOffset`, `subsUrl`); cross-tab merges arrive
  through `watchStorageKey` and require the tracker's `#loaded` latch
  (`#adoptExternal`, which announces so grain consumers re-resolve).
- **filter.js** — `FilterSession` (eager state machine: values, apply,
  trailing persist, the menu reset gesture) + `VideoFilter` (the lazy panel
  section over it). The filter lives on the video from first play — a
  stored preset needs no panel open — and reset works with none.
- **inputs/zoom.js** — `ZoomState` (the per-domain zoom/pan state machine:
  wheel/steps, pan clamp, trailing persist, `resetForDomain` deletes the
  stored crop) + `buildZoomGroup` (the zoom/pan tools inlined as one group
  in the Settings tab over the same shell's state).
  Pure state: the transform write belongs solely to `ViewershipTransform`.
- **inputs/forge.js** — the pointer/keyboard gesture engine: the stream
  router (press eligibility, the interactive-target exemption — SDK
  controls keep their native press stream, pointer tracking, the session
  latch feeding the shared `fs` gate, click/dblclick suppression) over per-story recognizer
  machines: `ScrubStroke` (pointer move-stream scrub with coalesced samples,
  the exp-smoothed velocity filter, and the bounded predicted-events wash),
  `SwipeStroke` (the translate-drag transform writes and their eased
  restore), `TapReplay` (the dbltap window's click seed), `SpaceSession`
  (hold-to-speed + bare-tap toggle). Gesture detail carries `dx` and the
  mirrored `dy` the pan arm consumes; pinch and trackpad-pinch handshake
  stay engine-core; `HoldRepeater`-style timers ride the shared scheduler.
- **inputs/actions.js** — the action layer: the binding table + `IntentGates`,
  and the per-story state machines `SkipStreak`, `ScrubSession`, and
  `ViewershipTransform` (fill-mode cover scale, the zoom crop composed as
  `scale(s) translate(ox%,oy%)`, fullscreen-scoped wheel zoom,
  pan-instead-of-seek scrub latch) — the one class allowed to write the
  video transform, exposed on the shell as `shell.view` — plus the haptic
  policy.
- **subtitles/** — `forgevtt.js` = the parse engine (the module the worker
  chunk bundles in, which is what guarantees the worker can never drift from
  the main-thread parser; ~.srt→WEBVTT normalizing), `vtt-worker.js` — a
  standalone esbuild chunk injected as `__VTT_WORKER_SOURCE__` blob, CSP-gated
  with in-band fallback (`WorkerTransport` owns spawn/sequence/watchdog as one
  class), `subtitles.js` — the main-thread surface: eager `SubtitleSession`
  (ForgeTrack renderer 8 concurrent cue slots, drag-drop/URL ingest with
  per-entry restore, parsing memoized, cue-style vars applied at boot, the
  `SubtitleSyncState` grain singleton) + lazy `SubtitlesSection` (panel UI).
- **chrome/** — `config.js` (state: `SETTINGS_SCHEMA`, `getSetting`,
  `onSettingsChanged`, `SETTING_KEYS`, cross-tab live-reload cache),
  `panel.js` (the `Panel` builder + settings/history section renderers),
  `ui.js` (`el`/`button` construction, the SVG icon factory, `flashElement`
  WAAPI), `inject.js` (`ShellStyle` sheet lifecycle: adopt-once, monotonic
  `@resource` upgrade; viewport-fit-cover), `toast.js` (`ToastManager`,
  pooled custom element), **styles.css** (the HUD — §6).

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
`WorkerTransport`, `ShellStyle`, `HoldRepeater`, `MediaControls`,
`MediaSessionOwner`, `TransformEase`, `ForgeRegistry`/`GestureChannel`,
`ConfigStore`, `VideoProbe`, `DomSettleWatch`, `MenuCommands`, plus the
DomWatch/FsGate/Settings/SdkMatcher/panel-section family and — in the input
pass — `IntentGates` + `ShellActions`.
Rule applied everywhere: a class may own mutations; a consumer that just
calls a function must NOT be forced to spell `new` (plain-function wrappers
stay for those seams).

**Single-backend contract.** Production ships exactly one Chromium-native
implementation per platform capability; the jsdom check harness owns all
emulation (see `check/lib/node-realm.mjs`). The method: census every
dual-arm/dual-check probe in the tree; keep the arm whose semantics are real
(and pin it with a test), delete the harness-only arm, and make jsdom win by
having genuine matching semantics elsewhere. What stayed vs died:
- Stayed: ResizeObserver/IntersectionObserver gate factories (the harness
  deletes the globals to exercise the synchronous-rect and inert-gate
  fallbacks), element-level probes (`requestVideoFrameCallback`,
  `video.animate`, `requestPictureInPicture` — jsdom elements honestly lack
  them), grant guards in store.js (manager policy, not platform),
  `workerCapable()` (CSP/Worker presence is a runtime fact), the per-instance
  MutationObserver checks and down-ownership checks (deliberate, each pinned
  by a test), and `AbortSignal.any`'s manual-deadline arm — because a probe
  proved jsdom and Node brand-check opposite worlds on signals, so a merged
  signal can never exist across them.
- Died: the `postTask` façade's whole setTimeout arm, `yield_`'s
  scheduler→rAF→noop ladder, `onNavigate`'s popstate/hashchange backend that
  could never see a pushState-only change, `MessageChannel`/MutationObserver/
  `isInputPending`/`vibrate`/window-resize double-typeof checks, and all
  manual `Date.now()` deadline math behind watchdogs.

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

## 5. Conventions (the change bar)

1. **Comments explain WHY with reasoning** — the rejected alternatives and
   the measured/probed finding. No restating code, no TODOs, no status
   adjectives.
2. **One owner per behavior.** A duplicate is either absorbed or, if both
   are real users, promoted into the shared plane. There is one registry,
   one response gate, one close path, one timer backend, one mutation feed,
   one storage watch contract.
3. **Everything machine-facing is derived from a source table** (§3 lists
   them). Adding an SDK = one record + check rows. Adding a gesture = one
   table row; the schema, bindings, and events derive.
4. **Stateful ownership = private classes.** If state is mutated in more
   than one public flow, it belongs to one object with `#`-fields, not to
   module-level lets. Given a choice between a stateful factory (closure
   machine) and a class, choose the class; keep the factory as a plain
   enclosing function only when one thin wrapper name must not change.
5. **Signal-scoped teardown.** Every listener accepts `{ signal: scope }`;
   teardown paths call `scope.dispose()` and nothing else; the single
   abort-fire tears everything down. Never build removal-list pairs.
6. **Imports:** one per realm-form, combined; `shared` below package imports;
   module files import only downward across planes (kernel → contract,
   shell → shared/kernel-contract), never sideways into a sibling's consumer
   (the import graph is enforced by the flaws gate's isolated import
   smoke).
7. **No comments in check/ code beyond the why-docstrings it already
   carries; `installGMRealm` must stay a single self-contained function**
   (it ships as an executeScript payload — no closure references).
8. **ES target floor: Chromium 156.** `?.` chains, top-level field syntax,
   `data-transfer` file APIs, View Transitions, CloseWatcher — all in scope;
   nothing below the floor, no polyfill arms.
9. **Version is derived** (esbuild reads package.json). Header updates are
   interventions, not edits.

## 6. HUD design law (binds any visual change)

Still in force from the design process; `src/shell/chrome/styles.css` is the
only surface, scales/tokens `@property`-typed, gradients banned in the HUD:

- **R1 Glass budget: at most two `backdrop-filter` surfaces + one sanctioned
  blur band** — panel + toast, plus the R4 scroll-edge band's masked blur
  (user direction): the band fades in/out per R4, so it only costs while
  content actually passes under the pinned header. A fourth surface is a
  redesign decision with its own justification.
- **R3 One resting tint (`--pf-glass-tint`), unchanged by focus** — the
  material's two-state split (resting vs `--pf-glass-tint-focus`, 76%) was
  retired by user direction: the panel keeps the same tint whether or not it
  holds focus, and no control paints a highlight border merely for focus
  (keyboard `:focus-visible` outlines on controls stay). Which tint rests is a
  *user choice*, not a state branch: the `ui.glassTint` setting rides three
  measured presets on `--pf-tint-alpha` (Clear 44% / Medium 58% / Opaque 72%,
  the macOS 27 Golden Gate alignment; in-between levels are unoffered because
  unmeasured), and one tick in R1 applies.
- **R4 Every scrollable glass surface needs a scroll edge** — content
  scrolling beneath a pinned control is obscured; not a blanket scrim.
  Realized scroll-driven (the floor's scroll timelines register a
  `--pf-scroll-edge` share): the panel header is fully transparent at the
  top of the scroll and ramps its darker edge-ink band in only over passing
  content — a solid-to-faded gradient of the sheet's ink at a per-preset
  edge alpha (`--pf-edge-alpha`; GLASS_TINTS edge shares make the band over
  the body composite land exactly one notch, +14pt, darker than the body
  read) plus masked blur — so the resting header cannot go darker than the
  body until content actually passes under it.
- **R5 Nested radii are concentric and derived:** container radius R with
  inset padding P → inset elements use R − P (panel 16 → strip/close 8 →
  tab 5). Derived, not chosen, so container changes stay correct.
- **R6 The panel (sheet) has the largest radius in the HUD (16px).**
- **R7 Section headers are title case** (no uppercase transform).
- **R9 Every HUD change needs a measured contrast assertion**, not a
  screenshot. Geometry (resting radii, control positions) may not move as a
  side effect of appearance work.
- The current set is tint + blur + hairline border + rim shadows, **zero
  linear-gradients with one sanctioned exception**: the R4 scroll-edge band
  is a single solid-to-faded linear-gradient (user direction) — the only
  gradient permitted in the HUD — rim highlights present (`--pf-header-rim`,
  inset highlights), two blur layers (`--pf-blur-sm/lg` = `blur(16px)
  saturate(1.7)` / `blur(24px) saturate(1.8)`).

## 7. check/ — the testing tool

`check/run.mjs` is the repo's one testing interface. Gates run in order and
stop at the first failure:

1. **syntax** — parse-only V8 check of every src module (parallel children).
2. **flaws** — repo eslint + isolated module-import smoke per module.
3. **bundle** — real esbuild build (version derivation, worker chunk) +
   artifact shape validation (header fields, IIFE shape, css companion).
4. **browser** — real Helium Chromium 156 + real bundle in a GM realm:
   boot, gesture contract, media semantics, resume, menus, GM env, frame
   scenarios, edge robustness. ~28–36s.

### Browser gate mechanics
- Launch ladder: version-matched disk chromedriver → Selenium Manager, with
  a flood-spill ledger, a browser-aware `ensureChromeDriver()` probe, a
  selective `brew reinstall chromedriver` heal, and a real-session sentinel
  (`window.__checkReady === true` via `return`-ing script — expression-only
  bodies return `undefined`, the historical bug). Startup-tab hygiene closes
  Chrome's welcome tabs; `navigate()` verifies the landing (origin+path,
  one retry) because a `get()` that resolves before navigation can eat a
  whole case.
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
  single-shell, and a 6s attach-latency budget row.
- **Cases (9):** `boot` (install contract, positive/negative discovery),
  `discovery` (min size, no-anchor, tiny-video), `frames` (§ above),
  `gestures` (skip/mute/volume/panel/PiP/scrub with real driver input),
  `gm` (info mirror, own-echo exactly-once shape, remote-write cross-tab
  adoption surviving a seeked-flush save, xhr shape + `ontimeout` on a
  held route, pfStyle resource warmth, menu-handle census, harvest-seeded
  reboot), `media` (stream, gesture events, kernel re-anchoring onto a
  replacement video), `menus` (menu command → panel effect; the targeted
  reset row seeds a non-default color filter and proves the bare command
  restores it — no panel involved),
  `persist` (storage seeding, resume restore across reboot, the sync-grain
  row: one nudge gesture lands `subOffset` in the tracker's entry), `robust`
  (freeze-flush without user pause, rVFC frame crank on 156, 1000-echo
  < 400ms, 400 remote-adoption merges < 800ms).
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
- **Browser gate launch refused:** `driver probe` prints which disk driver
  is stale vs the embedded Chromium major; the ladder already prefers
  Selenium Manager — a repeated `handshake failed (no DevTools port)` after a
  browser update is the known mid-update shape; relaunch after the browser
  finishes updating.
- **A case's shell never attaches:** the boot ceremony dumps
  `{readyState, shell, video, pf, lastInjectError}` before throwing; the
  `.tmp/last-failure.png/json` capture adds `frame[0]`,
  `frame[0][0]` state via `snapshotFrameState`.

---

*AGENTS.md replaces DESIGN.md (the HUD guide it restates in §6). Committed
story: see `git log` — the pass era is `8c560e6..a044fe1`, the tool era
`b226fe8.."1dbf397"`, the input pass `3971636`/`1637549`, the stateful-class
turn `cff0ab0` + `c95db6a`, the layer unifications `4737f84`-`6a9411d`, the
redesign `3d0a772`-`c439fec`, and the tool hardening `b226fe8`..HEAD.*
