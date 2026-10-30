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
- Chromium **156+** platform floor, **Violentmonkey 2.50+ (MV3)** manager
- Features: pointer/keyboard gestures, hotkeys, progress resume, watch
  history, subtitles (.srt/.vtt with per-cue placement, per-entry sync
  offset, URL/file restore), color filters with presets, fullscreen
  pinch-to-fill fill/fit, in-player settings panel, toasts, extensible
  shell surface
- Not a general browser tool: ad-heavy hosts and player platforms are
  excluded in the header (YouTube, Vimeo, Netflix, streams, socials…), and
  `entry.js` keeps a runtime skip list above that.

**Repo shape (24 source modules, ~14k LOC):**

```
src/
  entry.js            install-time contract: which frames run the script
  kernel/  (4)        contract, detection, discovery, kernel orchestrator
  shared/  (5)        core, runtime, dom, page, store — the data planes
  shell/   (14)       shell, media, resume, filter, forge+actions,
                      subtitles(3), chrome(5 + styles.css)
check/                the one testing tool (see §7)
dist/                 generated, not the review target
esbuild.config.mjs    single build: IIFE userscript + css resource + worker chunk
```

**Shipping artifact** (`dist/playerforge.user.js`, ~152 KB one IIFE +
`dist/playerforge.css` via `@resource pfStyle`): match-all userscript with a
24-pattern exclusion list (`@exclude-match`, VM's strict match-pattern
surface — the old `@exclude` glob any-character semantics is why the bare
apex pairs existed; the released matcher's `*.` covers the apex), 8 grants
(`GM_setValue/getValue/registerMenuCommand/unregisterMenuCommand/
addValueChangeListener/removeValueChangeListener/getResourceText/
xmlhttpRequest`), `@connect *` + subtitlecat,
**`@run-at document-start`** (real under VM MV3's pre-matched registration),
deliberately **no `@noframes`**: every frame gets the script (§2).
`@downloadURL` pins the chromium-branch dist for VM's updater. Version is
derived from `package.json` by the build; never hand-edit the header version.

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
  fallback), so the resume entry always carries the **top document's**
  context. Zero timed retries: the bridge resolves event-driven — one send,
  then a `pf:ready` announce-down (install + relay echo to pending
  requesters, parent-hop-limited) re-issues requests and re-arms latched
  fullscreen provisions when an ancestor's handlers armed late; an
  ancestor's armed state is script-fact invisible to layout, so the
  announcement is the real reading (the deadline watchdog settles null for
  bridgeless embeds). When nothing answers, the frame falls back to its own
  context rather than losing resume.
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
  listener/timer/observer routed through it), `Fan` — the ONE plain-fan-out
  owner, a native `EventTarget` carrying one event per instance
  (`emit(payload)`/`subscribe(cb, { signal })`; the FsGate, FilterSession,
  ResumeStore, ConfigStore, SubtitleSyncState,
  SubtitleSession, and kernel shell-ready audiences all rode it — the
  kernel's per-listener try/catch retired with the conversion, native
  dispatch isolation is the real thing) — `DebugRuntime` (log chatter AND
  the LoAF diagnostic flip as one unit), logger facade.
- **dom.js** — the shared mutation feed (`onDomMutations`: ONE page-level
  MutationObserver every consumer rides — element pooling, the shell ledger,
  shadow traversal, the fullscreen gate, the iframe registry), `PoolElement`
  machinery, `ReferenceBox` — the ONE fill-box identity (inline →
  container, fs → the fullscreen element's own rect, which under
  `viewport-fit=cover` is the Android device screen incl. the safe area;
  pools per invalidation so the hot path stays layout-free; carries the
  full rect — `x/y` origin at the same reveal-on-invalidation instant, the
  consumer class that anchors against it rather than merely sizing needs
  the position — and broadcasts change ticks over the one Fan at exactly
  its four invalidate sites (container RO, fs re-target, orientation,
  and scroll — the origin-bearing arm: scroll repositions the viewport
  origin with no size signal, so the size-only cache the pool once was
  was silently wrong for anchor consumers; the audited subscriber census:
  every gesture consumer
  read-and-discards per flow, the subtitle renderer is the tick
  subscriber) — and
  `layoutViewport()`: the ONE real-world viewport read (the root element's
  laid-out box first, reported innerWidth/innerHeight as fallback; kernel
  presence, the fs window fallback, and the inline gesture-zone width all
  consume it).
- **page.js** — site identity (`getDomainKey`, `domainsMatch`, `domainScore`,
  `hashEntry`, title sanitizer), page context, the frame bridge (`pf:` prefix,
  `ContextPipe` class owning pipe/legacy/in-flight state, context responders,
  fullscreen provisioners), native navigation events.
- **store.js** — the storage data plane: `KEYS` = two roots (`pf:configs`,
  `pf:resume`), `gmSetValue`/`loadJsonObject`, and `watchStorageKey(key,
  handler)` — the cross-instance subscription that filters own-write echoes
  (`remote === false`) in exactly one place. The echo contract is VM-truth
  (read from its released GM-values source): own-instance writes flag false,
  every foreign instance — another tab OR another frame of this tab — hears
  `remote=true`, so a top-frame menu flip reaches sibling frames. Storage is
  **synchronous GM storage, deliberately not IndexedDB** (manager-space
  portability; a cross-tab live-reload needs echo events, not thread offload).

### kernel/ — policy layer
- **contract.js** — the shared vocabulary both layers import in isolation:
  gesture registry (`GESTURES`/`GESTURE_IDS` are formula-derived from `{id:
  label}` pairs), `GESTURE_EVENTS` (`pf:gesture-<id>`), `DEBUG_HASH_TAG =
  "pf-debug"`, tuning knobs. The frame bridge's message types derive from
  their own single prefix inside `page.js` (module-local by documented
  design); key bindings derive in `actions.js`. No machine-facing string is
  hand-spelled anywhere else.
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
  through the entry's kernel reference — works even kernel-less; menus
  are top-frame only, and `#armDebugWatch` rides the storage echo to
  propagate the debug flip into sibling frames mid-flight),
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
  the exp-smoothed velocity filter, and the bounded predicted-events wash),
  `SwipeStroke` (the translate-drag transform writes and their eased
  restore), `TapWindow` (the dbltap window: observation only, no seed and
  no replay — by the prevent-scope rule there is nothing held back to hand
  back), `KeyHoldSession`
  (the INPUT_ACTIONS session keys — today the hold-speed row's Space:
  hold-to-speed + bare-tap toggle, settle-on-next-press hygiene for a
  swallowed keyup). Gesture detail carries `dx` and the mirrored `dy` as
  engine geometry (the detail payload shape is source-table fixed); pinch
  and trackpad-pinch handshake stay engine-core; hold/scrub timers ride
  the shared scheduler.
- **inputs/actions.js** — the action layer: the unified `INPUT_ACTIONS`
  table (one row per user-facing function, each gathering every trigger
  under its `inputs` — pointer families and key codes, one-shot or
  hold-session; the hold-speed row defines 2x hold-to-speed ONCE, its
  pointer hold and Space hold both riding it) + `IntentGates`,
  and the per-story state machines `SkipStreak`, `ScrubSession` (the input/
  commit decoupling: moves accrue `#pendingDelta`, requestAnimationFrame —
  the compositor tick — commits one clamped seek per display refresh, the
  readout shows the authored target, `end()` flushes the backlog; a dead
  zone with a residue accumulator keeps slow strokes alive while holding
  jitter nets to zero), the hold bookkeeping (`#activeHolds` first-source-
  wins boost; any real pause mid-hold cancels through the release teardown —
  a paused video resuming must not carry a stale boost), and
  `ViewershipTransform` (the fill-mode cover scale composed as one
  `scale(s)` — pinch-to-fill's transform, released on pinch-in or fullscreen
  exit) — the one class allowed to write the video transform, exposed on
  the shell as `shell.view` — plus the haptic
  policy.
- **subtitles/** — `forgevtt.js` = the parse engine (the module the worker
  chunk bundles in, which is what guarantees the worker can never drift from
  the main-thread parser; ~.srt→WEBVTT normalizing), `vtt-worker.js` — a
  standalone esbuild chunk injected as `__VTT_WORKER_SOURCE__` blob, CSP-gated
  with in-band fallback (`WorkerTransport` owns spawn/sequence/watchdog as one
  class), `subtitles.js` — the main-thread surface: eager `SubtitleSession`
  (ForgeTrack renderer 8 concurrent cue slots, cue scheduling is OURS — no
  native TextTrack anywhere on the path: the file never enters the video's
  track list, so a host can never list/restyle/mode-flip our captions;
  per-frame `currentTime` sampling on the media clock with the compositor's
  rAF as the crank, a sorted-start walk with an amortized dead floor, the
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
- Stayed: grant guards in store.js (manager policy, not platform),
  `workerCapable()` (CSP/Worker presence is a runtime fact), and
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
  the worker spawn watchdog, and the hidden-tab flush cap with its
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
  `pictureInPictureEnabled` policy flag, wake-lock's secure-context gate,
  the GM grant read, `workerCapable()`, and null/parameter-shape guards
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

## 7. check/ — the testing tool

`check/run.mjs` is the repo's one testing interface. Gates run in order and
stop at the first failure:

1. **syntax** — parse-only V8 check of every src module (parallel children).
2. **flaws** — repo eslint + isolated module-import smoke per module.
3. **bundle** — real esbuild build (version derivation, worker chunk) +
   artifact shape validation (header fields, IIFE shape, css companion) and
   the manager-contract pins: the exclusion list only ever rides the strict
   `@exclude-match` surface, and `@downloadURL` stays present for the updater.
4. **browser** — real Helium Chromium 156 + real bundle in a GM realm:
   boot, gesture contract, media semantics, resume, menus, GM env, frame
   scenarios, subtitle picture anchoring, edge robustness. ~33–45s.

### Browser gate mechanics
- **Row statuses are binary: only an explicit `"pass"` passes.** A case file
  returning a boolean or shorthand status reads as fail (a real failure this
  once shipped as a false row the aggregator skipped past, and four
  all-green runs stood behind it).
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
  single-shell, a 6s attach-latency budget row, and the VM echo reach: a
  foreign settings write live-reloads the running frame's kernel and the
  event-time hotkeys gate sees it (blocked mid-flight, then re-armed).
- **Cases (10):** `boot` (install contract, positive/negative discovery),
  `discovery` (min size, no-anchor, tiny-video), `frames` (§ above),
  `gestures` (skip/mute/volume/panel/PiP/scrub with real driver input),
  `gm` (info mirror, own-echo exactly-once shape, remote-write cross-tab
  adoption surviving a seeked-flush save, the debug mirror: a foreign
  configs write flips the running kernel mid-flight (mirror line + real
  debug chatter), the reverse flip is proven silent, and a value-neutral
  rewrite never re-mirrors, xhr shape + `ontimeout` on a
  held route, pfStyle resource warmth, menu-handle census, harvest-seeded
  reboot), `media` (stream, gesture events, kernel re-anchoring onto a
  replacement video), `menus` (menu command → panel effect; the targeted
  reset row seeds a non-default color filter and proves the bare command
  restores it — no panel involved),
  `persist` (storage seeding, resume restore across reboot, the sync-grain
  row: one nudge gesture lands `subOffset` in the tracker's entry),
  `subtitles` (the picture-anchor case: a letterbox stage — square element
  in a taller stage — proves percent cue fields land on the displayed
  picture rect, not the layer box, with the panel drop as the real ingest
  path; a motion-lane row proving a visible slot's computed
  `transition-property` is exactly opacity/translate/display, the anchor
  lane absent; a resize row (video element + stage widening) proving the box
  ticks re-anchor the running slots without any cue change; and the own
  scheduler's boundary rows — one seek into a second cue's window lights
  the enter, the window passing drops the exit), `robust`
  (freeze-flush without user pause, checkpoint cadence on the native
  timeupdate media clock at 4x, 1000-echo
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
