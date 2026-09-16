import { logger } from "../shared/logger.js";
import { getConfigValue } from "../shared/storage.js";
import { delay } from "../shared/time.js";
import { setPerfDiag } from "../shared/perf-diag.js";
import { ShellSlot } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, meetsMinSize, watchDocumentVideos, watchMediaEvents } from "./sdk.js";
import { SHELL_MARKER, GESTURE_EVENTS, DEBUG_LOGS_KEY, FRAMEWORK_TUNING } from "./contract.js";
import { Multiplexer } from "../shared/multiplexer.js";

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
/** Whether scheduler.postTask() is available for priority-aware timers. */
const CAN_POST_TASK = typeof globalThis.scheduler?.postTask === "function";

export class Kernel {
  #registry;
  #lifecycle;
  /** Shell-ready listeners — Multiplexer provides subscribe/dispatch/error isolation. */
  #createdMux = new Multiplexer();
  #initialized = false;
  // Weak: an adopted video orphaned by an untracked removal path must not
  // pin the element (and its whole subtree) for the page's lifetime.
  #seenVideos = new WeakSet();
  #removalObservers = new Set();
  #removalTimers = new Map();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  #scope = new AbortController();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

  #onPageShow = (event) => {
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    for (const shell of this.#registry.getAll()) {
      if (!shell.video.isConnected) {
        this.#seenVideos.delete(shell.video);
        shell.destroy();
        logger.log("kernel", `Reconciled orphaned shell: ${shell.sdk.name}`);
      }
    }
  };

  #onPageHide = (event) => {
    if (!event.persisted) {
      logger.log("kernel", "Page hiding, cleaning up");
      this.#stopDiscoveryTap?.();
      this.#stopDiscoveryTap = null;
      for (const observer of this.#removalObservers) {
        observer.disconnect();
      }
      this.#removalObservers.clear();
      for (const cancel of this.#removalTimers.values()) {
        cancel();
      }
      this.#removalTimers.clear();
      // Tear down in-flight settle waits so the lifecycle's observer and
      // timers die immediately instead of running their full quiet/cap window.
      this.#lifecycle.destroy();
      this.#registry.destroyAll();
      this.#scope.abort();
    }
  };

  constructor() {
    this.#registry = new ShellSlot();
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
    return this.#createdMux.subscribe(cb);
  }

  /** Register the shell then fan out to every shell-ready listener. */
  #notifyShellCreated(shell) {
    this.#registry.register(shell);
    this.#createdMux.dispatch(shell);
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
      this.#setDebugRuntime(true);
      logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
    }
    const { signal } = this.#scope;
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    // Permanent rider on the shared discovery tap: every video the probe
    // would have seen, the kernel now adopts through the same wiring.
    this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
    // The probe boots us precisely so a video already in the parsed DOM gets
    // its shell without waiting for the next media event. Replay once: the
    // media-event tap (and the downgrade path) still catches script-lazy SDK
    // players that surface after boot.
    for (const video of document.querySelectorAll("video")) {
      this.#adoptVideo(video);
    }
    logger.log("kernel", "Kernel ready - discovery tap active");
  }

  /**
   * After the first successful adoption, drop the full-document discovery tap
   * (the heavier childList+subtree observer) and fall back to the cheap
   * capture-mode media-event tap. On MPA pages there is no second player to
   * surface, so keeping the per-mutation scan alive for the whole page taxes
   * every DOM change for nothing; the media-event tap still catches a
   * script-lazy SDK player that fires loadeddata/play, so discovery never goes
   * fully quiet. Idempotent; pagehide still tears the remaining tap down.
   */
  #downgradeDiscoveryTap() {
    if (this.#discoveryDowngraded) {
      return;
    }
    this.#discoveryDowngraded = true;
    this.#stopDiscoveryTap?.();
    this.#stopDiscoveryTap = watchMediaEvents((video) => this.#adoptVideo(video));
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
      return;
    }
    const container = sdk.container;
    if (!container) {
      logger.warn("kernel", "No container for video - skipping");
      return;
    }
    this.#seenVideos.add(video);
    logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
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

    /** Schedule the removal grace timer. Uses scheduler.postTask() (Firefox
     *  142+ / Chrome 129+) with 'user-visible' priority when available: the
     *  browser's task scheduler natively integrates this delay, yielding
     *  better prioritization than setTimeout for a UI-critical grace window.
     *  The signal option (Firefox 157+) auto-cancels on kernel pagehide.
     *  Falls back to the delay() helper for environments without scheduler. */
    const scheduleGraceTimer = (callback) => {
      if (CAN_POST_TASK) {
        const handle = globalThis.scheduler.postTask(callback, {
          priority: "user-visible",
          delay: FRAMEWORK_TUNING.removalGraceMs,
          signal: this.#scope.signal
        });
        return () => handle.abort?.();
      }
      return delay(callback, FRAMEWORK_TUNING.removalGraceMs);
    };

    // Arrow fn keeps the enclosing class-level `this` for timer/lifecycle access.
    const checkAnchors = () => {
      if (this.#removalTimers.has(video)) {
        return;
      }
      if (!video.isConnected) {
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
      if (video.parentElement !== anchors[0]) {
        reanchorObservers();
      }
    };

    /** Native multi-target consolidation: `MutationObserver.observe()` supports
     *  multiple root targets natively (childList filtered in native code), so
     *  up to `watchDepth` per-video wrappers collapse to one instance. */
    const observer = new MutationObserver(checkAnchors);
    this.#removalObservers.add(observer);

    const reanchorObservers = () => {
      // Unobserve stale anchors without a full disconnect (pending records
      // from targets that still matter are preserved).
      for (const target of anchors) {
        observer.unobserve(target);
      }
      anchors.length = 0;
      let anchor = video.parentElement || container;
      for (let depth = 0; anchor && depth < watchDepth; depth++, anchor = anchor.parentElement) {
        observer.observe(anchor, { childList: true });
        anchors.push(anchor);
      }
    };

    const stopWatching = () => {
      observer.disconnect();
      this.#removalObservers.delete(observer);
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

  #setDebugRuntime(on) {
    if (on) {
      logger.enable();
    } else {
      logger.disable();
    }
    setPerfDiag(on);
  }
}
