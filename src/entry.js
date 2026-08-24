import { Kernel } from "./kernel/kernel.js";
import { installContextBridge, installVideoProbe } from "./shared/context.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { KEYS, getConfigValue, setConfigValue } from "./shared/storage.js";

// The version lives in the banner and is read from the installed script at
// runtime via GM_info, so what the UI reports is always what VM actually
// runs - never a stale build-time constant.

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
    let welcomePending = getConfigValue(KEYS.firstRun, getConfigValue("firstRun", true) !== false);
    kernel.bus.addEventListener("pf:shell-created", (event) => {
      const shell = event.detail;
      logger.log("entry", `Shell ready: ${shell.id} (${shell.sdkName})`);
      if (!welcomePending) {
        return;
      }
      welcomePending = false;
      setConfigValue(KEYS.firstRun, false);
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
        version: GM_info.script.version
      }),
      writable: false,
      configurable: false
    });

    logger.log(
      "entry",
      `Kernel booted (${window.top === window ? "top" : "frame"}) - ` +
        `${GM_info.scriptHandler} ${GM_info.version}, script ${GM_info.script.version}`
    );
  };

  installContextBridge();
  installVideoProbe({
    minWidth: MIN_VIDEO_WIDTH,
    minHeight: MIN_VIDEO_HEIGHT,
    onCandidate: boot
  });
}

bootstrap();
