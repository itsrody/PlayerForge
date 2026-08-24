import { Kernel } from "./kernel/kernel.js";
import { installContextBridge, installVideoProbe } from "./shared/context.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { getConfigValue, setConfigValue } from "./shared/storage.js";

// VERSION is injected by esbuild `define` from the single constant in
// esbuild.config.mjs, so the userscript banner can never drift.

function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }

  const boot = () => {
    if (window.PlayerForge) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    kernel.init();

    // One subscription serves both duties: readiness log always, first-run
    // welcome toast only until the flag flips.
    let welcomePending = getConfigValue("pf:first-run", getConfigValue("firstRun", true) !== false);
    kernel.bus.addEventListener("pf:shell-created", (event) => {
      const shell = event.detail;
      logger.log("entry", `Shell ready: ${shell.id} (${shell.sdkName})`);
      if (!welcomePending) {
        return;
      }
      welcomePending = false;
      setConfigValue("pf:first-run", false);
      const coarsePointer = matchMedia("(pointer: coarse)").matches;
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
    });

    if (location.hash.includes("pf-debug")) {
      kernel.bus.debug = true;
      logger.log("entry", "Debug mode enabled");
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
