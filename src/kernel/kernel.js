import { logger } from "../shared/logger.js";
import { getConfigValue } from "../shared/storage.js";
import { delay } from "../shared/time.js";
import { GESTURE_EVENTS } from "../shell/inputs/actions.js";
import { SHELL_MARKER } from "../shell/chrome/inject.js";
import { ShellRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, meetsMinSize, watchDocumentVideos, watchMediaEvents } from "./sdk.js";
import { Shell } from "../shell/shell.js";
import { TUNING, DEBUG_LOGS_KEY } from "../shell/chrome/config.js";

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, drives discovery, and owns the registry/lifecycle pair.
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (sdk.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */
export class Kernel {
  #registry;
  #lifecycle;
  /** Shell-ready listeners (direct callbacks, no bus). */
  #createdListeners = new Set();
  #initialized = false;
  #seenVideos = new Set();
  #removalObservers = new Set();
  #removalTimers = new Map();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  #scope = new AbortController();

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
      this.#registry.destroyAll();
      this.#scope.abort();
    }
  };

  constructor() {
    this.#registry = new ShellRegistry();
    this.#lifecycle = new LifecycleManager(this.#registry, (shell) => this.#notifyShellCreated(shell));
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
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
      cb(shell);
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
    this.#watchVideoRemoval(video, container);
    this.#downgradeDiscoveryTap();
  }

  #watchVideoRemoval(video, container) {
    const observers = [];

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
      for (let depth = 0; anchor && depth < 5; depth++, anchor = anchor.parentElement) {
        const observer = new MutationObserver(checkAnchors);
        observer.observe(anchor, { childList: true });
        observers.push(observer);
        anchors.push(anchor);
        this.#removalObservers.add(observer);
      }
    };

    let anchors = [];

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
        }, TUNING.kernel.removalGraceMs));
        return;
      }
      if (video.parentElement !== anchors[0]) {
        reanchorObservers();
      }
    };

    reanchorObservers();
  }

  #createShell({ video, container, sdk }) {
    let shell;
    shell = new Shell({
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
