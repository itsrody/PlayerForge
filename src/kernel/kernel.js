import { logger } from "../shared/logger.js";
import { gmRegisterMenu } from "../shared/storage.js";
import { GESTURE_EVENTS } from "../shared/events.js";
import { EventBus } from "./bus.js";
import { ShellRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, findContainer, videoFromEvent, MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./sdk.js";
import { Shell } from "../shell/shell.js";

export const SHELL_MARKER = "data-pf-shell";

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
 * Under @run-at document-start nothing pre-exists us: an insertion observer
 * catches SDK-created players the moment their <video> enters the DOM, and
 * capture-phase media events cover readiness transitions on existing ones.
 */
export class Kernel {
  bus;
  #registry;
  #lifecycle;
  #initialized = false;
  #seenVideos = new Set();
  #removalObservers = new Set();
  #removalTimers = new Map();
  #insertionObserver = null;
  #scope = new AbortController();

  #onMediaEvent = (event) => {
    const video = videoFromEvent(event);
    if (video) {
      this.#adoptVideo(video);
    }
  };

  #onPageShow = (event) => {
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache — reconciling");
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
      this.#insertionObserver?.disconnect();
      this.#insertionObserver = null;
      for (const observer of this.#removalObservers) {
        observer.disconnect();
      }
      this.#removalObservers.clear();
      for (const timer of this.#removalTimers.values()) {
        clearTimeout(timer);
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
    document.addEventListener("loadeddata", this.#onMediaEvent, { capture: true, signal });
    document.addEventListener("play", this.#onMediaEvent, { capture: true, signal });
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    this.#insertionObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.localName === "video") {
            this.#adoptVideo(node);
          } else if (node.querySelectorAll) {
            for (const video of node.querySelectorAll("video")) {
              this.#adoptVideo(video);
            }
          }
        }
      }
    });
    this.#insertionObserver.observe(document.documentElement, { childList: true, subtree: true });
    logger.log("kernel", "Kernel ready — media events + insertion watch active");
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
    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_VIDEO_WIDTH || rect.height < MIN_VIDEO_HEIGHT) {
      return;
    }
    const container = findContainer(video, sdk);
    if (!container) {
      logger.warn("kernel", "No container for video — skipping");
      return;
    }
    this.#seenVideos.add(video);
    logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}×${video.videoHeight}, ${Math.round(video.duration)}s)`);
    this.bus.emit("video:found", {
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
      clearTimeout(this.#removalTimers.get(video));
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
        const timer = setTimeout(() => {
          this.#removalTimers.delete(video);
          if (!video.isConnected) {
            stopWatching();
            this.bus.emit("video:removed", { video });
          } else {
            reanchorObservers();
          }
        }, REMOVAL_GRACE_MS);
        this.#removalTimers.set(video, timer);
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
      const host = shells.length ? shells[shells.length - 1].shellHost : null;
      if (host) {
        host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
          detail: { method: "menu" }
        }));
      }
    }, { autoClose: true });
  }
}
