import { logger, watchFrameQuality } from "../shared/diagnostics.js";
import { deepestActiveElement, isInsideShell, eventHitsControl, isShadowRoot, rootNodeOf, fs } from "../shared/shadow.js";
import { EngineBroker, InputForge } from "./inputs/forge.js";
import { attachInputActions, releaseShellActions } from "./inputs/actions.js";
import { ResumeTracker } from "./resume.js";
import { SubtitlesSection } from "./subtitles/section.js";
import { VideoFilter } from "./filter.js";
import { SettingsPanel } from "./chrome/panel.js";
import { addSettingsSection } from "./chrome/config.js";
import { TUNING } from "../shared/tuning.js";
import { addHistorySection } from "./chrome/history.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost } from "./chrome/inject.js";
import { surveyVideos } from "../kernel/sdk.js";
import { replayFullscreenProvision } from "../shared/context.js";
import { DOMManager } from "../shared/dom-manager.js";
import { KEYS, gmGetValue, gmSetValue } from "../shared/storage.js";
import { Scope } from "../shared/scope.js";
import { createActivity } from "../shared/activity.js";
import { StatusManager, Playback, Presence } from "../shared/status-manager.js";
import { HudReconciler, RenderGate } from "../shared/render.js";
import { writeReferenceBox } from "../shared/geometry.js";
import { yield_ } from "../shared/scheduler.js";

/**
 * Mark a boot error as timing noise rather than a defect: the kernel spends
 * these from a separate transient budget instead of the one retry that
 * abandons deterministically-throwing boots. Only the mount proof throws
 * these - a video that moved or reflowed mid-boot, never a broken shell -
 * and re-adoption re-runs the full boot including the proof.
 */
function transientBootError(message) {
  return Object.assign(new Error(message), { transient: true });
}

/**
 * Per-video facade: wraps the media element with a stable API, injects the
 * HUD, hosts the input layer, playback tracking, subtitles, and settings
 * panel, tracks fullscreen state, and wires MediaSession.
 */
export class Shell {
  id;
  video;
  container;
  sdk;

  #shellDom = null;
  #inputs = null;
  #resume = null;
  #subtitles = null;
  #filter = null;
  #panel;
  #toasts = null;
  /** Pooled box reused by the referenceBox getter; values are rewritten on every read. */
  #refBox = { width: 0, height: 0 };
  /** Pre-prep boxes, read first in #injectDom: the mount proof compares
   *  against them after the yields, so prep that moves the SDK aborts. */
  #preMountBox = null;
  #onDestroy;
  /** DOM lifecycle manager: listeners, observers, elements, rollbacks. */
  #dom = new DOMManager();
  /** Lifecycle scope: disposal flag + signal passed to InputForge,
   *  MediaSession, settings, fullscreen watchers, etc. */
  #scope = new Scope();
  /** Command plane: all playback control routes through these primitives. */
  #media;
  /** OS media-key facet, null without MediaSession support. */
  #mediaSession = null;
  /** L2 status: what this player is, observed from its media element. Beside
   *  the activity below rather than replacing it - the activity still decides
   *  when the media clock is attached, status only records what happened. */
  #status = null;
  /** The keyboard broker this shell's engine arbitrates through: the
   *  plugin's per-document broker, or a fresh owned one for
   *  direct constructions (which empties itself on teardown). */
  #broker = null;
  /** Shadow-adopt re-offer entry back into kernel adoption, or null when
   *  the shell was built without one (unit harnesses). */
  #reoffer = null;
  /** L4 render gate. Commits it issues outlive the event that caused them, so
   *  N edges in one tick are one write and the priority is declared by
   *  the work rather than inherited from whichever handler ran first. Today it
   *  drives the media-state custom properties (see #forwardMediaEvents),
   *  whose writes are diffed by L5's reconciler inside the commit rather than
   *  behind a second gate. It is null until boot has reached that point. */
  #gate = null;

  constructor({ video, container, sdk, onDestroy, broker = null, reoffer = null }) {
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.#broker = broker ?? new EngineBroker();
    this.#reoffer = reoffer;
    this.#onDestroy = onDestroy;
    this.#media = createMediaControls({ video });
    // A boot that throws AFTER #injectDom has marked the video would otherwise
    // strand a half-live shell: the caller only logs, the video keeps its
    // SHELL_MARKER, and the kernel's claim release never runs, so the video
    // stays refused for the life of the document. Roll the half-built shell
    // back here, where the instance is still reachable, then re-throw so the
    // caller still sees the failure and can allow a retry. destroy() is
    // null-safe across every sub-component and idempotent via the scope.
    this.ready = this.#boot().catch((err) => {
      logger.error("shell", `Shell "${this.sdk.name}" boot failed - rolling back`, err);
      this.destroy();
      throw err;
    });
  }

  /** Resolves when the shell DOM and HUD are live. Styles load is awaited. */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
    }

    // Yield between DOM injection and component construction so the browser
    // can process pending layout/paint work before the panel builds its tree.
    await yield_();

    // The settle guard ran before the build, and the prep above plus the
    // yields since span the exact window SDKs re-parent in: verify the video
    // is still ours to mount before constructing anything on it. Deliberately
    // connectivity only, not boxes - position:relative-without-offsets and
    // isolation:isolate are layout-identical by construction, so prep cannot
    // move boxes, but a mid-boot move strands the host in the abandoned
    // container. A throw here rides the constructor's rollback and the
    // kernel's one-retry re-arm, exactly like any other boot failure.
    this.#verifyPlacement();

    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer, this.#dom, this.#scope.signal);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost, this.#broker);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);
    if (this.sdk.source === "generic") {
      this.#noticeGenericDetection();
    }

    // Lazy section builder: panel sections (subtitles, filter, history,
    // settings) are constructed on first open to keep boot fast. Construction
    // yields to the event loop between sections so the first-open burst never
    // wedges input handling.
    this.#panel.setSectionBuilder(async () => {
      this.#subtitles = new SubtitlesSection(this);
      await yield_();
      this.#filter = new VideoFilter(this, this.#panel);
      await yield_();
      addHistorySection(this.#panel, this);
      await yield_();
      addSettingsSection(this.#panel, this.#scope.signal);
    });

    this.#setupFocusManagement();
    this.#forwardMediaEvents();
    // Needs #status, so it has to follow #forwardMediaEvents.
    this.#watchOcclusion();
    this.#scope.onDispose(watchFrameQuality(this.video, this.#scope.signal));
    this.#mediaSession = claimMediaSession({
      controls: this.#media,
      video: this.video,
      signal: this.#scope.signal
    });
    this.#watchFullscreen();
    this.#watchShadowAdoptions();
    logger.log("shell", `Shell "${this.sdk.name}" constructed`);
  }

  /** Read-only state views; all writes route through `shell.media`. */
  get volume() {
    return this.video.volume;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get duration() {
    return Number(this.video.duration) || NaN;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  get muted() {
    return this.video.muted;
  }

  get paused() {
    return this.video.paused;
  }

  /**
   * Sole fullscreen condition, read straight off the shared `fs` gate
   * (shadow.js) - built on the native fullscreen event by initFullscreenGate().
   * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
   * fullscreen; `fs` is the single boolean that gates fs features codebase-wide.
   */
  get fullscreen() {
    return fs;
  }

  /**
   * Unified contextual reference box, per the PlayerForge geometry rule
   * (`src/shared/geometry.js` — the screen in fullscreen, the container
   * inline). Read directly at call time - no cache, no invalidation watchers;
   * consumers read once per gesture (scrub start, pinch-out).
   * Returns { width, height }.
   */
  get referenceBox() {
    return writeReferenceBox(this.container, this.#refBox);
  }

  get shellDom() {
    return this.#shellDom;
  }

  get shellHost() {
    return this.#shellDom?.host;
  }

  get panel() {
    return this.#panel;
  }

  get resume() {
    return this.#resume;
  }

  /** The DOMManager — for sub-components that need lifecycle-tracked artifacts. */
  get dom() {
    return this.#dom;
  }

  /** Keep focus on the shell host when pointer interactions happen inside it. */

  /** Keep focus on the shell host when pointer interactions happen inside it. */
  #setupFocusManagement() {
    const host = this.shellHost;
    if (!host) {
      return;
    }
    // preventScroll: adopting a below-fold player must not yank the viewport
    // to it - the integration focus test used to depend on exactly that
    // scroll, so it scrolls its target into view explicitly instead.
    host.focus({ preventScroll: true });
    this.#dom.listen(this.container, "pointerdown", (event) => {
      if (this.#scope.disposed) {
        return;
      }
      // Common case: focus already lives on the host - no traversal needed.
      if (document.activeElement === host) {
        return;
      }
      // A press on an SDK control keeps its focus: the control (a play
      // button, a slider) is the keyboard context now, not the host.
      if (eventHitsControl(event)) {
        return;
      }
      if (!isInsideShell(host, event.composedPath()[0])) {
        queueMicrotask(() => this.#restoreFocusIfNeeded(host));
      }
    }, { capture: true, passive: true });
  }

  /** Re-focus the host after a pointerdown unless focus already moved inside. */
  #restoreFocusIfNeeded(host) {
    if (!this.#scope.disposed && deepestActiveElement(host) !== host) {
      // preventScroll: the host is parked focus, not a navigation target -
      // a bare focus() scrolls an off-screen player into view on every
      // outside click, yanking the page out from under the reader.
      host.focus({ preventScroll: true });
    }
  }

  toast(payload) {
    this.#toasts?.show(payload);
  }

  /** Completion feedback (800ms). */
  toastFlash(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.flashMs, group });
  }

  /** Status message (2500ms). */
  toastInfo(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.infoMs, group });
  }

  /** Onboarding hint (5000ms). */
  toastHint(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.hintMs, group });
  }

  /** Action toast with buttons (4000ms). */
  toastAction(icon, text, group, actions) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.actionMs, group, actions });
  }

  hideToast(group) {
    this.#toasts?.hide(group);
  }

  /** The command plane, for interaction layers that issue media commands. */
  get media() {
    return this.#media;
  }

  async #injectDom() {
    // Snapshot first: the mount proof in #verifyPlacement compares against
    // these, so they must predate every write below (reads-then-writes is
    // the allowed order - the flush they force is the baseline the prep is
    // measured against, on the adoption path only).
    this.#snapshotBoxes();
    // warmStyles() is synchronous - the embedded sheet is adopted immediately,
    // so shell construction never blocks on the @resource fetch. A warm
    // background upgrade later propagates through the same shared sheet.
    warmStyles();
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    // Register host for auto-removal on destroy and mark managed attributes.
    this.#dom.onCleanup(() => this.#shellDom?.host.remove());
    this.#dom.markAttribute(this.#shellDom.host, SHELL_MARKER, "");
    // Mark the video/container in the same synchronous block as the injection.
    // The marker is the DOM's observable claim - the stylesheet's :fullscreen
    // hook and the queryable boot signal - so leaving the video unmarked for
    // the rest of boot, which spans several yields while the panel builds, is
    // a real window: the HUD is already live and queryable, but the video
    // claims to be unmanaged. Double adoption in that window is refused by
    // the kernel's seen-set, claimed synchronously in #adoptVideo before the
    // first yield; the marker itself is never a decision input.
    this.#markManaged();
    // Restore container position if we changed it from static.
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#dom.markStyle(this.container, "position", "relative");
    }
    // Contain the overlay's paint order. The host carries z-index INT32_MAX
    // to outrank every sibling stack the SDK paints inside the player — but
    // position:relative alone creates no stacking context, so without this
    // the host escapes into the nearest ancestor context (often the page
    // root) and paints above site chrome that merely overlaps the player
    // rect. isolation:isolate is paint-order-only: unlike contain:layout it
    // cannot change what the SDK measures, and it rolls back on destroy.
    this.#dom.markStyle(this.container, "isolation", "isolate");
    // Parasite watchdog: re-attach host if evicted by SDK. The reconnect
    // subscription is manager-owned, so the watchdog's arm/disarm cycle stops
    // at shell destroy without a paired cleanup handle here. The liveness
    // predicate yields teardown to destruction: an eviction racing removal
    // grace lets the destroy land instead of fighting it back.
    watchShellHost(this.container, this.#shellDom.host, this.#dom, () => !this.#scope.disposed);
  }

  #forwardMediaEvents() {
    const video = this.video;
    const host = this.#shellDom?.host;
    // L2 status first: everything below subscribes to it. The activity after
    // still answers "should the media clock be attached"; this answers "what
    // is the player", as one queryable value, from the element's own events
    // only. It writes nothing back: status is observed, never optimistic, so
    // a rejected play() cannot leave us rendering a pause icon for a video
    // that never started. Fullscreen comes from shadow.js's single gate
    // through StatusManager's own subscription, not a second listener.
    this.#status = new StatusManager({
      target: video,
      doc: document,
      signal: this.#scope.signal
    });
    // Discrete transitions arrive as status commits: one subscription drives
    // MediaSession sync and the HUD commit below, replacing the per-event
    // boundary listeners (play/pause/ended/seeked/durationchange/...). The
    // reconciler diffs the props and sync() dedups the session, so commits
    // that move nothing cost nothing - and transitions that move together
    // land together, which per-event listeners could never promise. Dies
    // with the status in dispose(), so no unsubscribe handle is kept.
    this.#status.subscribe(() => {
      this.#mediaSession?.sync();
      this.#gate?.request("user-visible");
    });
    // The position exception: a seek that moves no axis (buffer already
    // NONE, playback already PAUSED) emits no commit, but the OS surface
    // still needs the settled position now, not at the next clock tick.
    this.#dom.listen(video, "seeked", () => this.#mediaSession?.sync(), { passive: true });
    // `timeupdate` is the only continuous one: it is the ~4 Hz media clock, and
    // it only ticks while the playhead advances. That makes playback the
    // activity it belongs to, so it is attached for the playing window and
    // detached when the window closes - the clock listener does not exist while
    // paused, and the exit flush hands the OS surface the final position.
    createActivity({
      target: video,
      events: ["play", "playing", "pause", "ended", "emptied"],
      isActive: () => !video.paused && !video.ended,
      signal: this.#scope.signal,
      onEnter: (work) => {
        video.addEventListener("timeupdate", () => this.#mediaSession?.sync(), { signal: work.signal, passive: true });
      },
      onExit: () => this.#mediaSession?.sync()
    });
    // Expose media state as CSS custom properties on the host so the shadow
    // DOM can style based on playing/paused/muted without crossing the realm
    // boundary. The :playing/:paused/:muted pseudo-classes (which Firefox
    // does not ship, and which cannot reach into shadow roots anywhere)
    // are not relied on; custom properties bridge the gap.
    if (host) {
      // One bindings table for both properties (§3.2: derived from one table,
      // not hand-maintained twice). The reconciler owns the "has this value
      // already been written" half — `#applied` starts null, so the inline
      // seed below writes both — and the gate owns *when* the commit runs.
      //
      // The commit reads `video` at commit time rather than at event time, so
      // `play` + `pause` inside one tick coalesces to the state that actually
      // survived the tick - which is the whole point of the gate. The seed runs
      // inline: construction is not a state transition, and the first frame
      // must not paint with the properties undefined.
      //
      // volumechange fires continuously while volume/panner is dragged, and a
      // setProperty on a hot style recolors the host subtree for nothing when
      // neither flag changed - the diff is what keeps that a no-op.
      const hud = new HudReconciler({
        bindings: {
          paused: (value) => host.style.setProperty("--pf-media-paused", value),
          muted: (value) => host.style.setProperty("--pf-media-muted", value)
        }
      });
      const commit = () => hud.apply({
        paused: video.paused ? "1" : "0",
        muted: video.muted ? "1" : "0"
      });
      commit();
      this.#gate = new RenderGate({ commit, signal: this.#scope.signal });
      // A HUD commit after a media edge is `user-visible` (§4 priority
      // table): it needs to land before the next frame, not before the input
      // that follows it, and it must never be starved behind a background
      // write. Nothing reads these properties synchronously, so deferring to
      // the next task is behaviourally invisible. Requested from the status
      // subscription above, not from per-event listeners: one commit request
      // per batched commit, however many edges produced it.
    }
  }

  /**
   * L5's occlusion rule: a paused player the user cannot see, with no focus
   * inside the HUD, drops out of layout entirely so it contributes zero style,
   * layout and paint cost (§4 L5, rule 4). One class on the host and one
   * document-realm CSS rule - a class swap rather than an inline style, so
   * Gecko batches the invalidation across the subtree instead of recolouring
   * it per property.
   *
   * Two of the rule's four conjuncts are not observed here at all, each for a
   * different reason:
   *
   *   - "not hovered" is *implied* by "occluded". `isIntersecting === false`
   *     means no part of the target is inside the viewport, and the pointer is
   *     always inside the viewport, so an occluded player cannot be hovered.
   *     Two listeners that could only ever agree with the geometric answer
   *     would be bookkeeping, not a guard.
   *   - "not focus-within" is read at resolve time, from wherever focus has
   *     landed *inside* the HUD - not from `host.contains(activeElement)`.
   *     The shell parks focus on the host itself as a keyboard sink and puts
   *     it back there after every outside click (`#setupFocusManagement`), so
   *     the anchor is focused at boot and at rest; counting that parked sink
   *     as interaction would make the conjunct unsatisfiable and the rule
   *     dead on arrival. `deepestActiveElement` pierces the shadow root that
   *     `document.activeElement` retargets to, and `isInsideShell` keeps a
   *     page-level focus from being mistaken for ours, so what blocks the
   *     detach is focus on a control of ours - exactly the case where
   *     `display: none` would drop it mid-interaction. Focus events only
   *     *trigger* a re-resolve; they never carry the value. They are attached
   *     in both places because the layer is always an ancestor of a focused
   *     descendant while the host is not - and a duplicate trigger costs
   *     nothing, because the reconciler diffs.
   *     `focusout` fires before the element loses focus, so the resolve cannot
   *     run in the handler - it runs on the gate's task, after focus has
   *     settled for that turn.
   *     Hiding the anchor does drop its focus to the page, which is why that
   *     case is allowed to detach at all: the key gate already accepts
   *     `document.body` as a target, so shortcuts survive the round trip.
   *
   * "idle" is the playhead not advancing: PAUSED, ENDED, READY or IDLE.
   * LOADING is excluded so a `play()` in flight never detaches the HUD it is
   * about to paint. Read from status rather than from `video.paused` so the
   * rule answers the same question §4 asks - "when status is ...".
   *
   * Routed through L4 as of phase 7. Both sources were already deferred
   * (IntersectionObserver is posted as a task, focus arrives in its own turn),
   * so deferring the write costs nothing observable - and the gain is in the
   * *read*: a focus move used to resolve twice, once per edge, each walking
   * focus again, and any status axis change landing in the same tick resolved
   * a third time. All of them are one commit reading where focus actually
   * ended up. The seed still runs inline: construction is not a transition.
   */
  #watchOcclusion() {
    const host = this.#shellDom?.host;
    const hudLayer = this.#shellDom?.hudLayer;
    const status = this.#status;
    if (!host || !hudLayer || !status) {
      return;
    }
    const hud = new HudReconciler({
      bindings: {
        detached: (value) => host.classList.toggle("pf-detached", value)
      }
    });
    const resolve = () => {
      if (this.#scope.disposed) {
        return;
      }
      const { playback, presence } = status;
      const idle = playback !== Playback.PLAYING && playback !== Playback.LOADING;
      const occluded = presence === Presence.OCCLUDED || presence === Presence.BACKGROUND;
      const focusTarget = deepestActiveElement(host);
      const focusWithin = focusTarget !== host && isInsideShell(host, focusTarget);
      hud.apply({ detached: idle && occluded && !focusWithin });
    };
    const gate = new RenderGate({ commit: resolve, signal: this.#scope.signal });
    const onFocus = () => gate.request("user-visible");
    const listen = (node) => {
      node.addEventListener("focusin", onFocus, { signal: this.#scope.signal, passive: true });
      node.addEventListener("focusout", onFocus, { signal: this.#scope.signal, passive: true });
    };
    listen(hudLayer);
    listen(host);
    status.subscribe(() => gate.request("user-visible"), this.#scope.signal);
    resolve();
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - the UA requires it on every
    // frame edge). Surface a hint and re-provision the chain
    // (idempotent) so a retry succeeds if the attributes were just granted,
    // e.g. an SDK iframe created after our boot-time provisioning.
    this.#dom.listen(document, "fullscreenerror", () => {
      if (this.#scope.disposed || fs) {
        return;
      }
      this.toastInfo("fs-block", "Fullscreen blocked by embed", "fs-block");
      if (window.top !== window) {
        // The replay entry point, not the boot-time one: the latch entry.js
        // spent at shell-ready is already set by now, so a request through it
        // would be dropped and the retry would fail the same way.
        replayFullscreenProvision();
      }
    });
  }

  exitFullscreen() {
    if (fs) {
      document.exitFullscreen()?.catch(() => {});
    }
  }

  #markManaged() {
    this.#dom.markAttribute(this.video, SHELL_MARKER, "");
    this.#dom.markAttribute(this.container, SHELL_MARKER, "");
  }

  /**
   * Late shadow adoptions: videos appended into this shell's shadow root
   * after boot produce no document-level mutation record, so the shared
   * feed structurally cannot see them. Watch only this root (never general
   * shadow surveillance - unbounded observers on custom-element-heavy pages
   * were rejected deliberately) and re-offer newcomers to the kernel, which
   * dedups by claim. Light-DOM shells skip this entirely: the document feed
   * already covers them. Lifetime rides the shell's manager.
   */
  #watchShadowAdoptions() {
    const reoffer = this.#reoffer;
    if (typeof reoffer !== "function") {
      return;
    }
    // Documents are already covered by the shared feed; detached fragments
    // cannot host a mounted shell, so only shadow roots arm the watch.
    // rootNodeOf answers null for hostile objects instead of throwing.
    const root = rootNodeOf(this.container);
    if (!isShadowRoot(root)) {
      return;
    }
    const mine = this.video;
    const observer = new MutationObserver(() => {
      for (const { video } of surveyVideos(root)) {
        if (video !== mine) {
          reoffer(video);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    this.#dom.trackObserver(observer, "shadow-adopt");
  }

  /** Post-prep placement check: the mount point must still hold the video. */
  #verifyPlacement() {
    if (!this.video.isConnected || !this.container.isConnected ||
        !this.container.contains(this.video)) {
      throw transientBootError(`Shell "${this.sdk.name}": placement lost mid-boot`);
    }
    // Mount proof: prep (relative-without-offsets, isolate, the host
    // itself) is layout-identical by construction, so boxes that moved
    // under it mean the SDK reflowed mid-boot and the placement was
    // resolved against stale geometry. Abort like any boot failure -
    // rollback plus the kernel's one-retry re-arm. 2px tolerance for
    // subpixel rounding across the style recalc the prep triggers.
    const before = this.#preMountBox;
    if (before) {
      const shifted = (a, b) => Math.abs(a - b) > 2;
      const video = this.video.getBoundingClientRect();
      const container = this.container.getBoundingClientRect();
      if (shifted(video.width, before.vw) || shifted(video.height, before.vh) ||
          shifted(video.x, before.vx) || shifted(video.y, before.vy) ||
          shifted(container.width, before.cw) || shifted(container.height, before.ch) ||
           shifted(container.x, before.cx) || shifted(container.y, before.cy)) {
        throw transientBootError(`Shell "${this.sdk.name}": placement shifted under prep`);
      }
    }
  }

  /** Read both boxes flat: retained numbers, never live rects. */
  #snapshotBoxes() {
    try {
      const video = this.video.getBoundingClientRect();
      const container = this.container.getBoundingClientRect();
      this.#preMountBox = {
        vw: video.width, vh: video.height, vx: video.x, vy: video.y,
        cw: container.width, ch: container.height, cx: container.x, cy: container.y
      };
    } catch {
      this.#preMountBox = null;
    }
  }

  /**
   * First-run notice for the default-on fallback: the one adoption the user
   * never asked for by name gets one hint pointing at its toggle, then a
   * stored flag so it never nags again. Registry and learned adoptions stay
   * silent - only the measured guess announces itself.
   */
  #noticeGenericDetection() {
    try {
      if (gmGetValue(KEYS.genericNotice, false)) {
        return;
      }
      gmSetValue(KEYS.genericNotice, true);
    } catch {
      return;
    }
    this.toastHint("detect", "Unknown player detected - toggle in PlayerForge settings");
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    logger.log("shell", `Destroying shell "${this.sdk.name}"`);
    // Scope first: flips disposed (re-entrancy guard), aborts the shared
    // signal (MediaSession/settings/fullscreen listeners die natively).
    this.#scope.dispose();
    // Undo host-page style writes the aborted signal cannot: fill mode owns
    // inline transform/object-fit on an element PF does not own, so a shell
    // destroyed mid-fill would otherwise leave the embed's video scaled and
    // letterboxed for good. Must run before #inputs.destroy(), which cancels the
    // in-flight ease that would otherwise re-apply the scale.
    releaseShellActions(this);
    // Destroy sub-components (each manages its own internal state).
    this.#resume?.destroy();
    this.#resume = null;
    this.#subtitles?.destroy();
    this.#subtitles = null;
    this.#filter?.destroy();
    this.#filter = null;
    this.#inputs?.destroy();
    this.#inputs = null;
    this.#panel?.destroy();
    this.#panel = null;
    this.#toasts?.destroy();
    this.#toasts = null;
    // Status has no DOM to tear down, but it holds listeners with or without
    // the signal and a subscriber list that should not outlive the shell.
    this.#status?.dispose();
    this.#status = null;
    // The scope signal already took the gate down at the top of destroy();
    // disposing again is idempotent and makes it explicit that no commit can
    // land after this point, before the DOM goes away.
    this.#gate?.dispose();
    this.#gate = null;
    // DOM lifecycle: remove elements, disconnect observers, remove
    // listeners, restore attributes/styles — all in one call.
    this.#dom.destroy();
    this.#shellDom = null;
    this.#onDestroy?.(this);
  }
}

/**
 * The shell plugin's "main": the one place the shell reaches the framework and
 * hands it a host provider. The kernel (framework) never imports the shell - it
 * only calls the provider registered here. Keeping the `Shell` import in the
 * plugin (and out of the kernel) is what makes the shell a plug-in rather than
 * something the framework constructs directly.
 */
export function registerShell(kernel) {
  // The document's keyboard broker, owned here: one per bootstrap, threaded
  // provider -> Shell -> InputForge, so arbitration state is never global.
  const broker = new EngineBroker();
  kernel.registerShellProvider({
    create({ video, container, sdk, onDestroy, reoffer }) {
      return new Shell({ video, container, sdk, onDestroy, broker, reoffer });
    }
  });
}
