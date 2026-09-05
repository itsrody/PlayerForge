import { logger } from "../shared/logger.js";
import { getConfigValue } from "../shared/storage.js";
import { delay } from "../shared/time.js";
import { ShellSlot } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, meetsMinSize, watchDocumentVideos, watchMediaEvents } from "./sdk.js";
import { SHELL_MARKER, GESTURE_EVENTS, DEBUG_LOGS_KEY, FRAMEWORK_TUNING } from "./contract.js";
import { onNetEvents, mediaTimeline, isMediaElementEntry } from "./net-watch.js";

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
  /** Shell-destroyed listeners - the teardown twin of #createdListeners. */
  #destroyedListeners = new Set();
  #initialized = false;
  #seenVideos = new Set();
  #removalObservers = new Set();
  #removalTimers = new Map();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  #scope = new AbortController();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;
  /** Kernel subscriber to the net-watch feed; dropped at pagehide. */
  #stopNetWatch = null;

  #onPageShow = (event) => {
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    for (const shell of this.#registry.getAll()) {
      if (!shell.video.isConnected) {
        this.#seenVideos.delete(shell.video);
        shell.destroy();
        this.#notifyShellDestroyed(shell);
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
      this.#stopNetWatch?.();
      this.#stopNetWatch = null;
      const dying = this.#registry.getAll();
      this.#registry.destroyAll();
      for (const dyingShell of dying) {
        this.#notifyShellDestroyed(dyingShell);
      }
      this.#scope.abort();
    }
  };

  constructor() {
    this.#registry = new ShellSlot();
    this.#lifecycle = new LifecycleManager(
      this.#registry,
      (shell) => this.#notifyShellCreated(shell),
      (shell) => this.#notifyShellDestroyed(shell)
    );
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

  /** Register a shell-destroyed listener (teardown twin); returns an
   *  unsubscribe. Fired from every kernel destroy path: video removal,
   *  bfcache reconcile, and pagehide teardown. */
  onShellDestroyed(cb) {
    this.#destroyedListeners.add(cb);
    return () => this.#destroyedListeners.delete(cb);
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

  /** Fan out to every shell-destroyed listener. */
  #notifyShellDestroyed(shell) {
    for (const cb of this.#destroyedListeners) {
      try {
        cb(shell);
      } catch (err) {
        logger.error("kernel", "Shell-destroyed listener threw:", err);
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
      this.#setDebugRuntime(true);
      logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
    }
    const { signal } = this.#scope;
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    // Permanent rider on the shared discovery tap: every video the probe
    // would have seen, the kernel now adopts through the same wiring.
    this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
    // The framework owns the page's media network timeline through the unified
    // net-watch feed (§7.7): a filtered subscription keeps only media-shaped
    // resource sightings - the media element's own native GETs (network-process
    // loads this userscript's request seams can never see) plus routed ones -
    // and records them into the kernel-held collector until the page hides.
    // Event-driven by design - the browser calls the feed; nothing polls.
    this.#stopNetWatch = onNetEvents(
      (entries) => entries.forEach((entry) => mediaTimeline.add(entry)),
      { filter: isMediaElementEntry }
    );
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
    const observers = [];

    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    const watchDepth = Number.isInteger(hops) && hops > 0
      ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;

    const stopWatching = () => {
      for (const observer of observers) {
        observer.disconnect();
        this.#removalObservers.delete(observer);
      }
      this.#removalTimers.get(video)?.();
      this.#removalTimers.delete(video);
      this.#seenVideos.delete(video);
    };

    const reanchorObservers = () => {
      for (const observer of observers) {
        observer.disconnect();
        this.#removalObservers.delete(observer);
      }
      observers.length = 0;
      anchors.length = 0;
      let anchor = video.parentElement || container;
      for (let depth = 0; anchor && depth < watchDepth; depth++, anchor = anchor.parentElement) {
        const observer = new MutationObserver(checkAnchors);
        observer.observe(anchor, { childList: true });
        observers.push(observer);
        anchors.push(anchor);
        this.#removalObservers.add(observer);
      }
    };

    const anchors = [];

    const checkAnchors = () => {
      if (this.#removalTimers.has(video)) {
        return;
      }
      if (!video.isConnected) {
        this.#removalTimers.set(video, delay(() => {
          this.#removalTimers.delete(video);
          if (!video.isConnected) {
            stopWatching();
            this.#lifecycle.onVideoRemoved({ video });
          } else {
            reanchorObservers();
          }
        }, FRAMEWORK_TUNING.removalGraceMs));
        return;
      }
      if (video.parentElement !== anchors[0]) {
        reanchorObservers();
      }
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
  }
}
