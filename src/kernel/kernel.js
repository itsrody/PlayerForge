import { logger } from "../shared/logger.js";
import { gmRegisterMenu } from "../shared/storage.js";
import { GESTURE_EVENTS } from "../shared/events.js";
import { EventBus } from "./bus.js";
import { ShellRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
import { findSdkForVideo, findContainer, MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./sdk.js";
import { Shell } from "../shell/shell.js";

export const SHELL_MARKER = "data-pf-shell";

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, emits discovery events, and owns the bus/registry/lifecycle trio.
 */
export class Kernel {
  bus;
  #registry;
  #lifecycle;
  #initialized = false;
  #seenVideos = new Set();
  #removalObservers = new Set();

  #onLoadStart = (event) => {
    if (event.target instanceof HTMLVideoElement) {
      this.#probeVideo(event.target);
    }
  };

  #onLoadedData = (event) => {
    if (event.target instanceof HTMLVideoElement) {
      this.#adoptVideo(event.target);
    }
  };

  constructor() {
    this.bus = new EventBus();
    this.#registry = new ShellRegistry(this.bus);
    this.#lifecycle = new LifecycleManager(this.bus, this.#registry);
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
  }

  init() {
    if (!this.#initialized) {
      this.#initialized = true;
      logger.log("kernel", "Initializing kernel");
      this.#registerMenuCommand();
      document.addEventListener("loadstart", this.#onLoadStart, true);
      document.addEventListener("loadeddata", this.#onLoadedData, true);
      logger.log("kernel", "Kernel ready — init + ready hooks active");
    }
  }

  /** Early hook: log candidate videos (no side effects). */
  #probeVideo(video) {
    if (this.#seenVideos.has(video) || video.hasAttribute(SHELL_MARKER)) {
      return;
    }
    const sdk = findSdkForVideo(video);
    if (!sdk || (!video.src && !video.currentSrc && !video.querySelector("source"))) {
      return;
    }
    const rect = video.getBoundingClientRect();
    if (!(rect.width < MIN_VIDEO_WIDTH) && !(rect.height < MIN_VIDEO_HEIGHT)) {
      logger.log("kernel", `Init hook: ${sdk.name} video detected`);
    }
  }

  /** Ready hook: adopt the video, emit discovery and start removal watching. */
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
    this.#seenVideos.add(video);
    const container = findContainer(video, sdk);
    if (!container) {
      logger.warn("kernel", "No container for video — skipping");
      this.#seenVideos.delete(video);
      return;
    }
    logger.log("kernel", `Ready hook: ${sdk.name} (${video.videoWidth}×${video.videoHeight}, ${Math.round(video.duration)}s)`);
    this.bus.emit("video:found", {
      video,
      container,
      sdk,
      sdkName: sdk.name,
      id: crypto.randomUUID()
    });
    this.#watchVideoRemoval(video, container);
  }

  #watchVideoRemoval(video, container) {
    const observers = [];
    let removed = false;

    const stopWatching = () => {
      for (const observer of observers) {
        observer.disconnect();
        this.#removalObservers.delete(observer);
      }
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
      if (!removed) {
        if (!video.isConnected) {
          removed = true;
          stopWatching();
          this.bus.emit("video:removed", { video });
          return;
        }
        if (video.parentElement !== anchors[0]) {
          reanchorObservers();
        }
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

  destroy() {
    logger.log("kernel", "Shutting down kernel");
    document.removeEventListener("loadstart", this.#onLoadStart, true);
    document.removeEventListener("loadeddata", this.#onLoadedData, true);
    for (const observer of this.#removalObservers) {
      observer.disconnect();
    }
    this.#removalObservers.clear();
    this.#registry.destroyAll();
    this.bus.clear();
    this.#initialized = false;
    this.#seenVideos.clear();
  }
}
