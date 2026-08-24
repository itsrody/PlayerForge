import { logger } from "../shared/logger.js";
import { KEYS, gmRegisterMenu, gmSetClipboard, loadJsonObject } from "../shared/storage.js";
import { delay } from "../shared/time.js";
import { GESTURE_EVENTS } from "../shell/inputs/actions.js";
import { SHELL_MARKER } from "../shell/chrome/inject.js";
import { EventBus } from "./bus.js";
import { ShellRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, findContainer, meetsMinSize, watchDocumentVideos } from "./sdk.js";
import { Shell } from "../shell/shell.js";

/** Grace period before a disconnected video's shell is destroyed (SPA source swaps detach briefly). */
const REMOVAL_GRACE_MS = 500;

/**
 * crypto.randomUUID() exists only in secure contexts; userscripts match
 * plain http pages too, so discovery needs a fallback id.
 */
function makeId() {
  return crypto.randomUUID?.() ?? `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, emits discovery events, and owns the bus/registry/lifecycle trio.
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (sdk.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */
export class Kernel {
  bus;
  #registry;
  #lifecycle;
  #initialized = false;
  #seenVideos = new Set();
  #removalObservers = new Set();
  #removalTimers = new Map();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
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
        logger.log("kernel", `Reconciled orphaned shell: ${shell.id}`);
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
    this.bus = new EventBus();
    this.#registry = new ShellRegistry(this.bus);
    this.#lifecycle = new LifecycleManager(this.bus, this.#registry);
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    logger.log("kernel", "Initializing kernel");
    this.#registerMenuCommand();
    const { signal } = this.#scope;
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    // Permanent rider on the shared discovery tap: every video the probe
    // would have seen, the kernel now adopts through the same wiring.
    this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
    logger.log("kernel", "Kernel ready - discovery tap active");
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
    const container = findContainer(video);
    if (!container) {
      logger.warn("kernel", "No container for video - skipping");
      return;
    }
    this.#seenVideos.add(video);
    logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
    this.bus.emit("pf:video-found", {
      video,
      container,
      sdk,
      sdkName: sdk.name,
      id: makeId()
    });
    this.#watchVideoRemoval(video, container);
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
            this.bus.emit("pf:video-removed", { video });
          } else {
            reanchorObservers();
          }
        }, REMOVAL_GRACE_MS));
        return;
      }
      if (video.parentElement !== anchors[0]) {
        reanchorObservers();
      }
    };

    reanchorObservers();
  }

  #createShell({ id, video, container, sdk, sdkName }) {
    return new Shell({
      id,
      video,
      container,
      sdk,
      sdkName,
      bus: this.bus
    });
  }

  #registerMenuCommand() {
    gmRegisterMenu("⚙️ PlayerForge Settings", () => {
      const shells = this.#registry.getAll();
      const host = shells.length ? shells.at(-1).shellHost : null;
      if (host) {
        host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
          detail: { method: "menu" }
        }));
      }
    }, { autoClose: true });
    gmRegisterMenu("\u{1F4CB} PlayerForge Copy Config", () => {
      const dump = {
        configs: loadJsonObject(KEYS.configs, null),
        resume: loadJsonObject(KEYS.resume, null)
      };
      gmSetClipboard(JSON.stringify(dump, null, 2), "application/json");
      logger.log("kernel", "Config and resume store copied to clipboard");
    }, { autoClose: true });
  }
}
