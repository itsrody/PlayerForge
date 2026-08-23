import { Kernel } from "./kernel/kernel.js";
import { installContextBridge, installVideoProbe } from "./shared/context.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { getConfigValue, setConfigValue } from "./shared/storage.js";

export const VERSION = "0.7.0";

function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }

  const boot = () => {
    if (window.__PF_KERNEL__) {
      console.warn("[PlayerForge] Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    window.__PF_KERNEL__ = kernel;
    kernel.init();

    if (getConfigValue("firstRun", true) !== false) {
      setConfigValue("firstRun", false);
      const coarsePointer = matchMedia("(pointer: coarse)").matches;
      kernel.bus.addEventListener("shell:created", (event) => {
        const shell = event.detail;
        setTimeout(() => {
          if (shell && !shell.panel?.isOpen) {
            shell.toast({
              icon: "captions",
              text: coarsePointer
                ? "Swipe down to exit fullscreen"
                : "Press S for settings · Swipe down to exit fullscreen",
              duration: 5000
            });
          }
        }, 1200);
      }, { once: true });
    }

    kernel.bus.addEventListener("shell:created", (event) => {
      const shell = event.detail;
      logger.log("entry", `Shell ready: ${shell.id} (${shell.sdkName})`);
    });

    if (location.hash.includes("pf-debug")) {
      kernel.bus.debug = true;
      console.log("[PlayerForge] Debug mode enabled");
    }

    Object.defineProperty(window, "PlayerForge", {
      value: Object.freeze({
        kernel,
        version: VERSION
      }),
      writable: false,
      configurable: false
    });

    logger.log("entry", `Kernel booted (${window.top === window ? "top" : "frame"})`);
  };

  installContextBridge();
  installVideoProbe({
    minWidth: MIN_VIDEO_WIDTH,
    minHeight: MIN_VIDEO_HEIGHT,
    onCandidate: boot
  });
}

bootstrap();
