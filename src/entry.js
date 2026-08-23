import { Kernel } from "./kernel/kernel.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./shared/guard.js";
import { getConfigValue, setConfigValue } from "./shared/storage.js";
import { registerBuiltins } from "./plugins/index.js";

export const VERSION = "0.7.0";

function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }
  if (window.__PF_KERNEL__) {
    console.warn("[PlayerForge] Kernel already initialized");
    return;
  }
  const kernel = new Kernel();
  window.__PF_KERNEL__ = kernel;
  kernel.init({
    gestures: true,
    hotkeys: true,
    resume: true,
    subtitles: true
  });

  if (getConfigValue("firstRun", true) !== false) {
    setConfigValue("firstRun", false);
    const coarsePointer = matchMedia("(pointer: coarse)").matches;
    kernel.bus.once("shell:created", (shell) => {
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
  }

  kernel.bus.on("shell:created", (shell) => {
    registerBuiltins(shell);
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
}

bootstrap();
