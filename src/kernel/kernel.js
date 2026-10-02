import { logger } from "../shared/logger.js";
import { getConfigValue } from "../shared/storage.js";
import { setDebugRuntime } from "../shared/perf-diag.js";
import { postTask } from "../shared/scheduler.js";
import { Scope } from "../shared/scope.js";
import { ShellSlot } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, meetsMinSize, createLayoutGate, createOnScreenGate, isOnScreen, watchDocumentVideos, watchMediaEvents } from "./sdk.js";
import { SHELL_MARKER, GESTURE_EVENTS, DEBUG_LOGS_KEY, FRAMEWORK_TUNING } from "./contract.js";

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, drives discovery, and owns the registry/lifecycle pair.
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (sdk.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */
/** Skyline the removal watchdog never exceeds regardless of nesting. */
const MAX_REMOVAL_DEPTH = 8;
/** Extra ancestors (beyond the matched anchor) the removal watch observes. */
const REMOVAL_DEPTH_MARGIN = 1;

export class Kernel {
  #registry;
  #lifecycle;
  /** Shell-ready listeners (direct callbacks, no bus). */
  #createdListeners = new Set();
  #initialized = false;
  // Weak: an adopted video orphaned by an untracked removal path must not
  // pin the element (and its whole subtree) for the page's lifetime.
  #seenVideos = new WeakSet();
  #removalTimers = new Map();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  /** Lazily built observer-driven layout-presence gate for videos that failed
   *  meetsMinSize (see #adoptVideo); stopped with the kernel scope. */
  #layoutGate = null;
  /** Lazily built on-screen gate for player-sized-but-off-screen videos (see
   *  #adoptVideo); stopped with the kernel scope. */
  #onScreenGate = null;
  /** Kernel lifecycle scope: removal observers disconnect via onDispose,
   *  grace timers cancel via the signal. */
  #scope = new Scope();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

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
    if (!event.persisted) {
      logger.log("kernel", "Page hiding, cleaning up");
      this.#stopDiscoveryTap?.();
      this.#stopDiscoveryTap = null;
      // Scope first: onDispose disconnects every removal observer, the
      // signal cancels pending removal-grace postTasks, and the page-level
      // pageshow/pagehide listeners drop. Lifecycle/registry teardown below
      // then runs with all watch machinery already dead.
      this.#scope.dispose();
      // Tear down in-flight settle waits so their observers + timers die
      // immediately instead of running the full quiet/cap window on a page
      // that is already leaving.
      this.#lifecycle.destroy();
      this.#registry.destroyAll();
    }
  };

  constructor() {
    this.#registry = new ShellSlot(() => this.#onRegistryEmpty());
    this.#lifecycle = new LifecycleManager(this.#registry, (shell) => this.#notifyShellCreated(shell));
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
  }

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
    this.#createdListeners.add(cb);
    return () => this.#createdListeners.delete(cb);
  }

  /** Register the shell then fan out to every shell-ready listener. */
  #notifyShellCreated(shell) {
    this.#registry.register(shell);
    for (const cb of this.#createdListeners) {
      try {
        cb(shell);
      } catch (err) {
        logger.error("kernel", "Shell-created listener threw:", err);
      }
    }
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    logger.log("kernel", "Initializing kernel");
    // Debug logs activate from the persisted menu toggle or the #pf-debug
    // hash. The hash alone is a per-load override - it never writes the
    // setting, and an explicit menu "Off" wins over it.
    const storedDebug = getConfigValue(DEBUG_LOGS_KEY, false);
    const hashDebug = location.hash.includes("pf-debug");
    if (storedDebug || hashDebug) {
      setDebugRuntime(true);
      logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
    }
    const { signal } = this.#scope;
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    document.addEventListener("resume", this.#onResume, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    this.#armDiscoveryTap();
    logger.log("kernel", "Kernel ready - discovery tap active");
  }

  /**
   * (Re)establish the full-document discovery tap and replay the videos already
   * in the parsed DOM. The probe boots us precisely so a video already present
   * gets its shell without waiting for the next media event; the media-event
   * tap still catches script-lazy SDK players that surface after boot. Called
   * at init and again whenever the last shell leaves (see #onRegistryEmpty).
   */
  #armDiscoveryTap() {
    this.#stopDiscoveryTap?.();
    this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
    this.#discoveryDowngraded = false;
    // Mutations only report future changes: a rebuild (SPA route swap) can
    // leave a new player sitting in the tree with no pending record for us.
    for (const video of document.querySelectorAll("video")) {
      this.#adoptVideo(video);
    }
  }

  /**
   * The last shell left the live page. A router swap can destroy the shell and
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
    this.#stopDiscoveryTap?.();
    this.#stopDiscoveryTap = watchMediaEvents((video) => this.#adoptVideo(video));
  }

  /**
   * The kernel's single observer-driven layout-presence gate: built on first
   * need and torn down with the kernel scope. Returns null once the scope is
   * disposed, so a late adoption after pagehide has nothing to wait for.
   */
  #ensureLayoutGate() {
    if (!this.#layoutGate && !this.#scope.disposed) {
      this.#layoutGate = createLayoutGate();
      this.#scope.onDispose(() => {
        this.#layoutGate?.stop();
        this.#layoutGate = null;
      });
    }
    return this.#layoutGate;
  }

  /**
   * Companion gate for player-sized videos that are not yet on screen: built on
   * first need, torn down with the kernel scope. Returns null once disposed.
   */
  #ensureOnScreenGate() {
    if (!this.#onScreenGate && !this.#scope.disposed) {
      this.#onScreenGate = createOnScreenGate();
      this.#scope.onDispose(() => {
        this.#onScreenGate?.stop();
        this.#onScreenGate = null;
      });
    }
    return this.#onScreenGate;
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
      this.#ensureLayoutGate()?.watch(video, () => this.#adoptVideo(video));
      return;
    }
    // Player-sized but off-screen (a carousel slide, a below-the-fold embed):
    // defer the shell until the lookahead intersection, so a page of embeds
    // does not boot a full shell for a video the user cannot see. isOnScreen
    // reports true when the viewport is unknown, so this can only delay.
    if (!isOnScreen(video)) {
      this.#ensureOnScreenGate()?.watch(video, () => this.#adoptVideo(video));
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
    this.#lifecycle.onVideoFound({
      video,
      container,
      sdk
    });
    this.#watchVideoRemoval(video, container, sdk.hops);
    this.#downgradeDiscoveryTap();
  }

  #watchVideoRemoval(video, container, hops) {
    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    const watchDepth = Number.isInteger(hops) && hops > 0
      ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;

    const anchors = [];

    /**
     * Removal-grace tick: a scheduler.postTask handle on the kernel scope. It
     * is pure deferral - nothing about it needs timer priority - and being
     * signal-bound means pagehide (or any kernel abort) cancels every pending
     * grace without the manual sweep loop racing the page.
     */
    const scheduleGraceTimer = (done) => {
      const handle = postTask(done, {
        priority: "user-visible",
        delay: FRAMEWORK_TUNING.removalGraceMs,
        signal: this.#scope.signal
      });
      return () => handle.abort();
    };

    // Arrow fn keeps the enclosing class-level `this` for timer/lifecycle access.
    const checkAnchors = () => {
      if (!video.isConnected) {
        // One single-shot grace per disconnect; while it is pending the timer
        // owns the re-check (further removal mutations are the same fact).
        if (this.#removalTimers.has(video)) {
          return;
        }
        this.#removalTimers.set(video, scheduleGraceTimer(() => {
          this.#removalTimers.delete(video);
          if (!video.isConnected) {
            stopWatching();
            this.#lifecycle.onVideoRemoved({ video });
          } else {
            reanchorObservers();
          }
        }));
        return;
      }
      // Connected again: any pending grace is stale - the event that brought
      // the video back (or moved it) replaces the time-based re-check, so the
      // stale timer is cancelled instead of firing later against outdated
      // state, and a fresh grace (if needed) is always measured from the
      // CURRENT disconnect. Between settled events nothing is pending.
      this.#removalTimers.get(video)?.();
      this.#removalTimers.delete(video);
      if (video.parentElement !== anchors[0]) {
        reanchorObservers();
      }
    };

    /** Chromium-native single-target consolidation: `MutationObserver.observe()`
     *  supports multiple root targets natively (childList filtered in C++), so
     *  up to `watchDepth` per-video C++ wrappers collapse to one instance.
     *  The kernel scope disconnects it at pagehide - no per-video bookkeeping. */
    const observer = new MutationObserver(checkAnchors);
    this.#scope.onDispose(() => observer.disconnect());

    const reanchorObservers = () => {
      // MutationObserver has no per-target unobserve(): disconnect() is the
      // only way to drop the stale roots (the previous loop called a method
      // that does not exist and threw, leaving the anchors stranded on their
      // original parents). Records dropped by the disconnect cost nothing:
      // this callback never reads the queue - every decision below is
      // re-derived from live DOM state, which was just evaluated on this
      // very call - and the next mutation lands on the re-observed roots.
      observer.disconnect();
      anchors.length = 0;
      let anchor = video.parentElement || container;
      for (let depth = 0; anchor && depth < watchDepth; depth++, anchor = anchor.parentElement) {
        observer.observe(anchor, { childList: true });
        anchors.push(anchor);
      }
    };

    const stopWatching = () => {
      observer.disconnect();
      this.#removalTimers.get(video)?.();
      this.#removalTimers.delete(video);
      this.#seenVideos.delete(video);
    };

    reanchorObservers();
  }

  #createShell({ video, container, sdk }) {
    const provider = this.#shellProvider;
    if (!provider) {
      logger.error("kernel", "No shell provider registered");
      return null;
    }
    const shell = provider.create({
      video,
      container,
      sdk,
      onDestroy: () => this.#registry.unregister(shell)
    });
    return shell;
  }

  /**
   * Toggle the most recently created shell's panel from outside the input
   * stack (GM menu). Warns unconditionally when nothing can host a panel -
   * the user clicked something and must know why nothing happened.
   */
  togglePanel() {
    const shells = this.#registry.getAll();
    const host = shells.length ? shells.at(-1).shellHost : null;
    if (!host) {
      logger.warn("kernel", "Panel toggle requested but no player is active on this page");
      return;
    }
    host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
      detail: { method: "menu" }
    }));
  }
}
