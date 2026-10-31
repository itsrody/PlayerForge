import { logger, setDebugRuntime, postTask, Scope, runSteps, Fan } from "../shared/runtime.js";
import { KEYS, watchStorageKey, invalidateConfigCache, getConfigValue, setConfigValue, gmRegisterMenu, gmUnregisterMenu } from "../shared/store.js";
import { SHELL_MARKER, GESTURE_EVENTS, DEBUG_LOGS_KEY, DEBUG_HASH_TAG, FRAMEWORK_TUNING } from "./contract.js";
import { findSdkForVideo } from "./detection.js";
import { forEachVideoInDocument, meetsMinSize, createLayoutGate, createOnScreenGate, isOnScreen, createDiscoveryTap } from "./discovery.js";

/**
 * One settle wait: resolves once the container's child list has been quiet for
 * a run of consecutive quiet time, or when the cap expires - whichever comes
 * first. Owns its observer and both timer handles as private fields.
 */
class DomSettleWait {
  #settled = false;
  #settleHandle = null;
  #capHandle = null;
  #promise;

  constructor(container, { quietMs = 50, capMs = 150, signal = null } = {}) {
    const { promise, resolve } = Promise.withResolvers();
    this.#promise = promise;
    const observer = new MutationObserver(() => {
      // Any mutation re-arms the trailing quiet window from scratch.
      this.#settleHandle?.abort();
      this.#settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    });

    // One release controller makes the abort-listener teardown native: every
    // settle path (quiet window, cap, owner abort) fires `done`, and `done`
    // heads `release.abort()` so the owner-scope listener detaches itself.
    // Manual `signal?.removeEventListener("abort", done)` would be the pair
    // §5.5 bans - and the quiet-page settle must not leave the kernel-scope
    // signal subscribed page-long, which is exactly what the release buys.
    const release = new AbortController();
    const done = () => {
      if (this.#settled) {
        return;
      }
      this.#settled = true;
      observer.disconnect();
      this.#settleHandle?.abort();
      this.#capHandle?.abort();
      release.abort();
      resolve();
    };

    this.#settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    this.#capHandle = postTask(done, { priority: "user-visible", delay: capMs });

    observer.observe(container, { childList: true });

    signal?.addEventListener("abort", done, { once: true, signal: release.signal });
  }

  get promise() {
    return this.#promise;
  }
}

/**
 * Resolve once the container's child list has been quiet for a run of
 * consecutive quiet time, or when the cap expires - whichever comes first.
 * SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 *
 * Settle detection is a MutationObserver trailing quiet-period timer rather
 * than an rAF quiet-frame counter, so the window is frame-rate independent
 * (an 144 Hz display settles 2.4x faster than 60 Hz, and a missed frame or
 * a throttled background tab still resolves on the quiet clock).
 *
 * Both timers are scheduler.postTask handles (background-tab throttling and
 * pagehide abort are native), re-armed per mutation. An optional AbortSignal
 * additionally resolves the wait immediately - so a video removed / page
 * hidden mid-window never leaves the observer + its two timers running for
 * the full cap.
 */
function whenDomSettled(container, options) {
  return new DomSettleWait(container, options).promise;
}

/**
 * Holds the single live shell. PlayerForge is one-shell-per-session by design.
 *
 * `onEmpty` (optional) fires when the last shell leaves through unregister -
 * the DOM-status edge the kernel uses to re-arm discovery. It is not wired to
 * destroyAll(): that is a page-teardown sweep, not a live page losing a player.
 *
 * Formerly registry.js; kept as a class (not collapsed into Kernel privates)
 * because its displacement/onEmpty contract is pinned by dedicated unit tests.
 */
class ShellSlot {
  #current = null;
  #onEmpty;

  constructor(onEmpty) {
    this.#onEmpty = onEmpty;
  }

  /**
   * Install the session's shell. PlayerForge is one-shell-per-session, so a
   * shell already live is destroyed here rather than silently dropped:
   * otherwise adopting a second player orphans the first (still in the DOM and
   * removal-watched, but unreachable from the registry and so never torn down).
   * The slot is filled before destroying the displaced shell so its own
   * onDestroy -> unregister() sees a different current and neither nulls the
   * slot nor reports an empty registry.
   */
  register(shell) {
    const previous = this.#current;
    this.#current = shell;
    if (previous && previous !== shell) {
      previous.destroy();
    }
    logger.log("registry", `Shell registered: ${shell.sdk.name}`);
  }

  unregister(shell) {
    if (this.#current === shell) {
      this.#current = null;
      this.#onEmpty?.();
    }
    logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
  }

  getByVideo(video) {
    return this.#current?.video === video ? this.#current : null;
  }

  getAll() {
    return this.#current ? [this.#current] : [];
  }

  destroyAll() {
    const shell = this.#current;
    this.#current = null;
    if (shell) {
      shell.destroy();
      logger.log("registry", "Destroyed shell");
    }
  }
}

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, drives discovery, and owns the shell slot plus the discovery-to-shell
 * settle pipeline (former lifecycle.js, absorbed as privates).
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (discovery.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */

/** Skyline the removal watchdog never exceeds regardless of nesting. */
const MAX_REMOVAL_DEPTH = 8;
/** Extra ancestors (beyond the matched anchor) the removal watch observes. */
const REMOVAL_DEPTH_MARGIN = 1;

/**
 * One video's removal watchdog, extracted from a per-closure Kernel private.
 *
 * Previously the watch lived in Kernel#watchVideoRemoval as a closure machine
 * whose state - the observed anchors, the MutationObserver, the pending grace
 * - was split between a kernel-level `Map` (video -> grace-cancel) and the
 * closure's own surround variables, kept in step by hand at every path. Here
 * that state hangs on one instance: `#anchors` (what is being observed),
 * `#observer` (one instance watching up to `watchDepth` roots natively) and
 * `#graceCancel` (the pending single-shot grace).
 *
 * Lifecycle: connected mutations re-check anchor currency (a re-parent
 * re-observes); a disconnect schedules exactly ONE grace timer (further
 * mutations are the same fact while it is pending); a grace fire that still
 * finds the video detached ends the watch and removes the shell, while one
 * that finds it reconnected re-anchors. stop() is the single teardown for
 * both ends - a really-removed video and a page that is leaving - and both
 * release the seen-video pin via the owner's onStop callback.
 *
 * The re-parent branch is also the one identity seam the tree carries: the
 * kernel's onReparent callback re-resolves detection there (universal
 * container identity), and when the resolved container differs from the
 * shell's boot identity it destroys that shell and re-adopts through the
 * boot path - meaning this watch may be stopped from inside its own
 * callback. A stopped watch therefore refuses to re-observe (#reanchor
 * no-ops), so the callback's trailing re-seat can never resurrect roots
 * the stop just dropped.
 */
class RemovalWatch {
  #video;
  #container;
  #watchDepth;
  #signal;
  #onRemoved;
  #onReparent;
  #onStop;
  #anchors = [];
  #observer = new MutationObserver(() => this.#checkAnchors());
  #graceCancel = null;
  #stopped = false;

  constructor({ video, container, hops, signal, onRemoved, onReparent, onStop }) {
    this.#video = video;
    this.#container = container;
    this.#onRemoved = onRemoved;
    this.#onReparent = onReparent;
    this.#onStop = onStop;
    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    this.#watchDepth = Number.isInteger(hops) && hops > 0
      ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;
    this.#signal = signal;
    this.#reanchor();
  }

  /** Spec-level multi-target consolidation: `MutationObserver.observe()`
   *  accepts multiple root targets on every engine (the subtree filter runs
   *  natively), so up to `watchDepth` per-video wrappers collapse to one
   *  instance. The kernel scope disconnects it at pagehide - no per-video
   *  bookkeeping. */
  #reanchor() {
    // The re-wrap may have stopped this watch from inside the very callback
    // that called here (the kernel's destroy-readopt seam) - a stopped
    // watch refuses to observe, so no roots resurrect past their stop.
    if (this.#stopped) {
      return;
    }
    // MutationObserver has no per-target unobserve(): disconnect() is the
    // only way to drop the stale roots (the previous loop called a method
    // that does not exist and threw, leaving the anchors stranded on their
    // original parents). Records dropped by the disconnect cost nothing:
    // this callback never reads the queue - every decision below is
    // re-derived from live DOM state, which was just evaluated on this
    // very call - and the next mutation lands on the re-observed roots.
    this.#observer.disconnect();
    this.#anchors.length = 0;
    let anchor = this.#video.parentElement || this.#container;
    for (let depth = 0; anchor && depth < this.#watchDepth; depth++, anchor = anchor.parentElement) {
      this.#observer.observe(anchor, { childList: true });
      this.#anchors.push(anchor);
    }
  }

  /**
   * Removal-grace tick: a scheduler.postTask handle on the kernel scope. It
   * is pure deferral - nothing about it needs timer priority - and being
   * signal-bound means pagehide (or any kernel abort) cancels every pending
   * grace without the manual sweep loop racing the page.
   */
  #scheduleGrace(done) {
    const handle = postTask(done, {
      priority: "user-visible",
      delay: FRAMEWORK_TUNING.removalGraceMs,
      signal: this.#signal
    });
    return () => handle.abort();
  }

  /**
   * Record-shape freedom: every decision re-derives from live DOM state and
   * never reads the queued records, so a host's state-preserving move
   * (`Element.moveBefore`, live on the 159 floor in both its Element and
   * Document forms) lands as the same removed/added records a remove+insert
   * produces - the queued "removal" reads a video that is still connected,
   * the pending grace is cancelled, and the parent-equality check below
   * re-anchors onto the new chain. No per-shape code exists to get wrong.
   */
  #checkAnchors() {
    const video = this.#video;
    if (!video.isConnected) {
      // One single-shot grace per disconnect; while it is pending the timer
      // owns the re-check (further removal mutations are the same fact).
      if (this.#graceCancel) {
        return;
      }
      this.#graceCancel = this.#scheduleGrace(() => {
        this.#graceCancel = null;
        if (!video.isConnected) {
          this.stop();
          this.#onRemoved();
        } else {
          this.#reanchor();
        }
      });
      return;
    }
    // Connected again: any pending grace is stale - the event that brought
    // the video back (or moved it) replaces the time-based re-check, so the
    // stale timer is cancelled instead of firing later against outdated
    // state, and a fresh grace (if needed) is always measured from the
    // CURRENT disconnect. Between settled events nothing is pending.
    this.#graceCancel?.();
    this.#graceCancel = null;
    if (video.parentElement !== this.#anchors[0]) {
      // Currency crossing: the parent changed under a connected video. The
      // kernel seam may resolve a NEW SDK container here and tear this
      // watch down (with its shell) - the trailing re-observe below no-ops
      // through the stopped guard when it does.
      this.#onReparent?.();
      this.#reanchor();
    }
  }

  stop() {
    // The onStop callback (seen-pin release) must fire exactly once, and
    // the kernel-scope dispose calls stop() again at pagehide on a watch
    // the re-wrap seam already stopped.
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#observer.disconnect();
    this.#graceCancel?.();
    this.#graceCancel = null;
    this.#onStop?.();
    this.#onStop = null;
  }
}

export class Kernel {
  /** The one live shell (one-shell-per-session; see ShellSlot). */
  #registry = new ShellSlot(() => this.#onRegistryEmpty());
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();
  /** Abort source for in-flight settle waits; aborted at pagehide. */
  #settleScope = new AbortController();
  /** Shell-ready fan-out audience (one event per registration). */
  #audience = new Fan("shell");
  #initialized = false;
  // Weak: an adopted video orphaned by an untracked removal path must not
  // pin the element (and its whole subtree) for the page's lifetime.
  #seenVideos = new WeakSet();
  /** The live discovery tap (createDiscoveryTap); dropped at pagehide. */
  #discoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  /** Lazily built observer-driven presence gates ("layout"/"onScreen" ->
   *  createLayoutGate/createOnScreenGate engines), stopped with the kernel
   *  scope (see #ensureGate). */
  #gates = new Map();
  /** Kernel lifecycle scope: removal observers disconnect via onDispose,
   *  grace timers cancel via the signal. */
  #scope = new Scope();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

  /** The debug-watch latch: the stored debug value this frame booted with, so
   *  value-neutral foreign configs writes (a remote tab editing a filter,
   *  say) never clobber the boot-time #pf-debug hash override. */
  #debugWatchLast = null;

  #onPageShow = (event) => {
    // bfcache restores report persisted; a discarded page comes back with
    // persisted false but wasDiscarded true. Both hand back a document whose
    // shells may reference detached videos, so both reconcile.
    if (!event.persisted && !document.wasDiscarded) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    this.#reconcileOrphans();
  };

  /**
   * Page Lifecycle freeze -> resume fires no pageshow, yet the player tree may
   * have been mutated while frozen (or a shell orphaned by a swap), so run the
   * same orphan sweep on the native resume event.
   */
  #onResume = () => {
    if (this.#scope.disposed) {
      return;
    }
    logger.log("kernel", "Page resumed - reconciling");
    this.#reconcileOrphans();
  };

  #reconcileOrphans() {
    for (const shell of this.#registry.getAll()) {
      if (!shell.video.isConnected) {
        this.#seenVideos.delete(shell.video);
        shell.destroy();
        logger.log("kernel", `Reconciled orphaned shell: ${shell.sdk.name}`);
      }
    }
  }

  #onPageHide = (event) => {
    if (event.persisted) {
      return;
    }
    logger.log("kernel", "Page hiding, cleaning up");
    runSteps([
      () => {
        this.#discoveryTap?.stop();
        this.#discoveryTap = null;
      },
      // Scope first: onDispose disconnects every removal observer, the
      // signal cancels pending removal-grace postTasks, and the page-level
      // pageshow/pagehide listeners drop. Shell teardown below then runs
      // with all watch machinery already dead.
      () => this.#scope.dispose(),
      // Abort in-flight settle waits so their observers + timers die
      // immediately instead of running the full quiet/cap window on a page
      // that is already leaving.
      () => this.#settleScope.abort(),
      () => this.#registry.destroyAll()
    ]);
  };

  /**
   * The shell plugin registers its host provider here; the framework never
   * imports the shell, it only calls the provider it was handed. Provider
   * shape: `{ create({ video, container, sdk, onDestroy }) -> host }`.
   */
  registerShellProvider(provider) {
    this.#shellProvider = provider;
  }

  /** Register a shell-ready listener directly; returns an unsubscribe. */
  onShellCreated(cb) {
    return this.#audience.subscribe(cb);
  }

  /** Register the shell then fan out to every shell-ready listener.
   *  No per-listener try/catch: native dispatch isolates listener
   *  exceptions (reported to the global, never halting the rest of the
   *  dispatch) - the per-case audit rows already watch that path. */
  #notifyShellCreated(shell) {
    this.#registry.register(shell);
    this.#audience.emit(shell);
  }

  /**
   * Bridges video discovery to shell creation (former lifecycle.js): a settle
   * wait defers creation until the SDK's DOM has quiesced (or the cap expires),
   * with post-wait guards against videos that vanished or were adopted
   * meanwhile. A ready shell is handed to #notifyShellCreated. Page-unload
   * cleanup aborts in-flight waits via #settleScope.
   */
  async #onVideoFound({ video, container, sdk }) {
    logger.log("lifecycle", `video:found - ${sdk.name}`);
    if (this.#registry.getByVideo(video)) {
      logger.log("lifecycle", "Video already has a shell, skipping");
      return;
    }
    if (!this.#shellProvider) {
      logger.error("lifecycle", "No shell factory set!");
      return;
    }
    if (this.#pending.has(video)) {
      return;
    }
    this.#pending.add(video);
    await whenDomSettled(container, { signal: this.#settleScope.signal });
    this.#pending.delete(video);
    if (!video.isConnected || !container.isConnected) {
      logger.log("lifecycle", `${sdk.name} video left the document before settle - skipping`);
      return;
    }
    if (this.#registry.getByVideo(video)) {
      return;
    }
    let shell = null;
    try {
      shell = this.#createShell({ video, container, sdk });
      await shell?.ready;
      this.#notifyShellCreated(shell);
      logger.log("lifecycle", `Shell created for ${sdk.name}`);
    } catch (err) {
      logger.error("lifecycle", `Failed to create shell for ${sdk.name}:`, err);
      // A shell that throws mid-boot (or rejects ready) may already have
      // injected DOM, timers, and listeners. destroy() is scope-guarded and
      // idempotent, so it reaps the partial state without double-freeing a
      // shell that never got registered.
      await shell?.destroy?.();
    }
  }

  #onVideoRemoved(video) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.sdk.name}`);
    }
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    logger.log("kernel", "Initializing kernel");
    const { signal } = this.#scope;
    runSteps([
      // Debug logs activate from the persisted menu toggle or the debug
      // hash tag (contract) - a per-load override that never writes the
      // setting, and an explicit menu "Off" wins over it. The watch below
      // mirrors later foreign-instance flips.
      () => {
        const storedDebug = getConfigValue(DEBUG_LOGS_KEY, false);
        const hashDebug = location.hash.includes(DEBUG_HASH_TAG);
        this.#debugWatchLast = storedDebug;
        if (storedDebug || hashDebug) {
          setDebugRuntime(true);
          logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
        }
      },
      () => this.#armDebugWatch(),
      () => document.addEventListener("pageshow", this.#onPageShow, { signal }),
      () => document.addEventListener("resume", this.#onResume, { signal }),
      () => window.addEventListener("pagehide", this.#onPageHide, { signal }),
      () => this.#armDiscoveryTap()
    ]);
    logger.log("kernel", "Kernel ready - discovery tap active");
  }

  /**
   * Mirror foreign-instance flips of the debug setting mid-flight. The
   * manager's echo contract decides the reach (Violentmonkey's
   * GM-values source): a local write notifies the writer's own hooks with
   * remote=false, while every FOREIGN instance - another tab OR another
   * frame of this tab - re-delivers through the UpdatedValues broadcast
   * with remote=true. watchStorageKey filters the own echo, so this handler
   * sees exactly the outside write: the top-frame menu toggle reaching the
   * video embed, the remote tab's settings panel, a sibling tab's command.
   * Frames boot silent - a flip must reach them after boot, or the frame
   * stays debug-deaf ("no logs at all" degenerates into a diagnosis trap).
   * The handler owns its read freshness (invalidate then read - the configs
   * cache's invalidation ordering with other handlers is none of this
   * one's business) and the pre-write latch from init() keeps value-neutral
   * writes from clobbering the boot-time hash override.
   */
  #armDebugWatch() {
    watchStorageKey(KEYS.configs, () => {
      invalidateConfigCache();
      const next = getConfigValue(DEBUG_LOGS_KEY, false);
      if (next === this.#debugWatchLast) {
        return;
      }
      this.#debugWatchLast = next;
      setDebugRuntime(next === true);
      logger.log("kernel", `Debug logs mirrored ${next ? "on" : "off"} from a foreign write`);
    });
  }

  /**
   * (Re)establish the full-document discovery tap and replay the videos already
   * in the parsed DOM. The probe boots us precisely so a video already present
   * gets its shell without waiting for the next media event; the media-event
   * tap still catches script-lazy SDK players that surface after boot. Called
   * at init and again whenever the last shell leaves (see #onRegistryEmpty).
   */
  #armDiscoveryTap() {
    this.#discoveryTap?.stop();
    this.#discoveryTap = createDiscoveryTap((video) => this.#adoptVideo(video));
    this.#discoveryDowngraded = false;
    // Mutations only report future changes: a host rebuild can
    // leave a new player sitting in the tree with no pending record for us.
    forEachVideoInDocument((video) => this.#adoptVideo(video));
  }

  /**
   * The last shell left the live page. A host teardown rebuild can destroy the shell and
   * insert a fresh player that never fires a media event, and the first
   * adoption had downgraded us to the media-event tap - so re-arm the full
   * document tap to hunt again. Skipped during pagehide (scope already
   * disposed) and when nothing was ever downgraded (no shell has existed).
   */
  #onRegistryEmpty() {
    if (this.#scope.disposed || !this.#discoveryDowngraded) {
      return;
    }
    logger.log("kernel", "Last shell gone - re-arming full discovery tap");
    this.#armDiscoveryTap();
  }

  /**
   * After the first successful adoption, drop the full-document discovery tap
   * (the heavier childList+subtree observer) and fall back to the cheap
   * capture-mode media-event tap. On MPA pages there is no second player to
   * surface, so keeping the per-mutation scan alive for the whole page taxes
   * every DOM change for nothing; the media-event tap still catches a
   * script-lazy SDK player that fires loadedmetadata/loadeddata/play, so
   * discovery never goes fully quiet, and #onRegistryEmpty re-arms the full tap
   * if that shell later leaves. Idempotent; pagehide tears the tap down.
   */
  #downgradeDiscoveryTap() {
    if (this.#discoveryDowngraded) {
      return;
    }
    this.#discoveryDowngraded = true;
    this.#discoveryTap?.stop();
    this.#discoveryTap = createDiscoveryTap((video) => this.#adoptVideo(video), { mutations: false });
  }

  /**
   * The kernel's observer-driven presence gates (layout, on-screen): each built
   * on first need from its engine factory and torn down with the kernel scope.
   * Returns the live gate, or null once the scope is disposed, so a late
   * adoption after pagehide has nothing to wait for.
   */
  #ensureGate(kind, create) {
    let gate = this.#gates.get(kind);
    if (!gate && !this.#scope.disposed) {
      gate = create();
      this.#gates.set(kind, gate);
      this.#scope.onDispose(() => {
        gate.stop();
        this.#gates.delete(kind);
      });
    }
    return gate ?? null;
  }

  /** Adopt the video, emit discovery and start removal watching. */
  #adoptVideo(video) {
    if (this.#seenVideos.has(video) || video.hasAttribute(SHELL_MARKER)) {
      return;
    }
    const sdk = findSdkForVideo(video);
    if (!sdk) {
      return;
    }
    if (!meetsMinSize(video)) {
      // Not player-sized yet: a one-shot rect here would strand the video
      // forever unless an unrelated media event re-ran adoption. The layout
      // gate re-enters this method the moment the delivered box qualifies
      // (RO callbacks run off the mutation batch, with layout already fresh,
      // and the size is read from the observation rather than a fresh reflow).
      this.#ensureGate("layout", createLayoutGate)?.watch(video, () => this.#adoptVideo(video));
      return;
    }
    // Player-sized but off-screen (a carousel slide, a below-the-fold embed):
    // defer the shell until the lookahead intersection, so a page of embeds
    // does not boot a full shell for a video the user cannot see. isOnScreen
    // reports true when the viewport is unknown, so this can only delay.
    if (!isOnScreen(video)) {
      this.#ensureGate("onScreen", createOnScreenGate)?.watch(video, () => this.#adoptVideo(video));
      return;
    }
    const container = sdk.container;
    if (!container) {
      logger.warn("kernel", "No container for video - skipping");
      return;
    }
    this.#seenVideos.add(video);
    // Guarded like the logger contract promises: with chatter off (the
    // default), the dimensions/duration interpolation never runs - a disabled
    // log call must cost one boolean read, not a template build.
    if (logger.enabled) {
      logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
    }
    this.#onVideoFound({ video, container, sdk });
    this.#watchVideoRemoval(video, container, sdk.hops);
    this.#downgradeDiscoveryTap();
  }

  /** Hand per-video removal watching to its one stateful owner. */
  #watchVideoRemoval(video, container, hops) {
    let watch = null;
    watch = new RemovalWatch({
      video,
      container,
      hops,
      signal: this.#scope.signal,
      onRemoved: () => this.#onVideoRemoved(video),
      onReparent: () => this.#onRewrap(watch, video),
      onStop: () => this.#seenVideos.delete(video)
    });
    // Chromium-native single-target consolidation and the timer are both
    // handled inside the watch; the kernel scope is its pagehide backstop.
    this.#scope.onDispose(() => watch.stop());
  }

  /**
   * Universal container identity, the re-parent seam: the watch's
   * parent-equality check surfaced a live re-home, so identity re-resolves
   * through the same detection the adoption ran (the parent-stamped
   * descriptor cache invalidates exactly on this parent change). One
   * decision rule, from the ShellSlot doctrine: container identity is a
   * shell-lifetime fact and a displaced shell is destroyed, never
   * re-seated - so a DIFFERENT resolved container stops this watch, tears
   * the boot-identity shell down (destroy rolls back every managed marker,
   * so nothing blocks the rebuild), and re-adopts through the existing
   * boot path at the new home. The equality shape - the pinned moveBefore
   * re-home onto a bare stage - resolves the same container and falls out
   * the comparison untouched. An unresolvable video (the full SDK context
   * left the composed ancestry) stands on the boot identity: the
   * adoption contract says no SDK anchor means no shell, but there is no
   * matching mid-flight teardown contract, and the move may reverse.
   */
  #onRewrap(watch, video) {
    const shell = this.#registry.getByVideo(video);
    if (!shell) {
      return;
    }
    const sdk = findSdkForVideo(video);
    const container = sdk?.container ?? null;
    if (!container || container === shell.container) {
      return;
    }
    logger.log("lifecycle", `${sdk.name} re-wrapped: container identity changed - destroy-readopt`);
    watch.stop();
    shell.destroy();
    this.#adoptVideo(video);
  }

  #createShell({ video, container, sdk }) {
    // The provider is guaranteed present - #onVideoFound checks and reports
    // before reaching here, and this is a private method with one caller.
    const shell = this.#shellProvider.create({
      video,
      container,
      sdk,
      onDestroy: () => this.#registry.unregister(shell)
    });
    return shell;
  }

  /**
   * The shell host one-shot menu commands act on: the most recently created
   * shell (the same precedence the panel toggle follows - the user works with
   * the newest player they opened). Null when no shell is live here.
   */
  menuShellHost() {
    const shells = this.#registry.getAll();
    return shells.length ? shells.at(-1).shellHost : null;
  }

  /**
   * The debug toggle (MenuCommands, same kernel reference as menuShellHost)
   * reports its flip so the watch latch tracks the fresh stored value - a
   * later foreign echo of this doc must read value-neutral and never
   * re-mirror our own flip.
   */
  noteDebugFlip(value) {
    this.#debugWatchLast = value === true;
  }

  /**
   * Toggle the active shell's panel from outside the input stack (GM menu).
   * Warns unconditionally when nothing can host a panel - the user clicked
   * something and must know why nothing happened.
   */
  togglePanel() {
    const host = this.menuShellHost();
    if (!host) {
      logger.warn("kernel", "Panel toggle requested but no player is active on this page");
      return;
    }
    host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
      detail: { method: "menu" }
    }));
  }
}

/** GM menu wiring, owned at the kernel layer instead of inside the Kernel so
 *  the commands exist from script eval - not just after a video is
 *  discovered. The debug toggle works fully without a kernel: it persists the
 *  setting and flips the shared debug runtime (the console log flag). The
 *  one-shot reset commands need a live shell, resolved lazily through the
 *  entry's kernel reference at click time (the kernel boots after eval).
 *  One instance owns the handles; the debug toggle re-registers with its
 *  previously returned handle so the manager updates the item in place. */
class MenuCommands {
  #debugId = null;
  #filterId = null;
  #syncId = null;
  /** () -> kernel: the entry keeps the kernel reference for commands to
   *  resolve their target shell host at click time. */
  #resolveKernel = null;

  constructor(resolveKernel = null) {
    this.#resolveKernel = resolveKernel ?? null;
  }

  #hostFor(label) {
    const kernel = this.#resolveKernel?.();
    const host = kernel?.menuShellHost?.() ?? null;
    if (!host) {
      logger.warn("kernel", `${label} requested but no player is active on this page`);
    }
    return host;
  }

  #resetEvent(eventKey, label) {
    const host = this.#hostFor(label);
    if (host) {
      host.dispatchEvent(new CustomEvent(GESTURE_EVENTS[eventKey], {
        detail: { method: "menu" }
      }));
    }
  }

  #refreshDebug() {
    const enabled = getConfigValue(DEBUG_LOGS_KEY, false);
    // Passing the previously returned handle as options.id (VM 2.15.9+) makes
    // the manager update the live item in place - the caption flip no longer
    // pays the unregister/re-register churn. autoClose stays unset: true is
    // the manager default. Registered top-frame only so an embed-heavy page
    // runs one command set, not one per video frame (VM's popup does list
    // commands registered from frames - we simply register none there); the
    // same same-tab storage bus that re-arms fullscreen provisioning carries
    // each frame's copy of the flip (see #armDebugWatch).
    this.#debugId = gmRegisterMenu(
      `\u{1F41B} Debug Logs:${enabled ? "On" : "Off"}`,
      () => {
        const next = !getConfigValue(DEBUG_LOGS_KEY, false);
        setConfigValue(DEBUG_LOGS_KEY, next);
        this.#resolveKernel?.()?.noteDebugFlip?.(next);
        setDebugRuntime(next);
        this.#refreshDebug();
      },
      { id: this.#debugId, title: "Toggle PF debug logging" }
    );
  }

  install() {
    this.#refreshDebug();
    this.#filterId = gmRegisterMenu(
      "\u{1FAA8} Reset Color Filter",
      () => this.#resetEvent("filterReset", "Color filter reset"),
      { title: "Restore the default color filter" }
    );
    this.#syncId = gmRegisterMenu(
      "\u{1F4AC} Reset Subtitle Sync",
      () => this.#resetEvent("syncReset", "Subtitle sync reset"),
      { title: "Restore the default subtitle sync offset" }
    );
    return () => {
      for (const id of [this.#debugId, this.#filterId, this.#syncId]) {
        if (id != null) {
          gmUnregisterMenu(id);
        }
      }
      this.#debugId = this.#filterId = this.#syncId = null;
    };
  }
}

export function installMenuCommands(resolveKernel = null) {
  return new MenuCommands(resolveKernel).install();
}
