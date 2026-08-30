import { Kernel } from "./kernel/kernel.js";
import { installMenuCommands } from "./kernel/menus.js";
import { installContextBridge, installVideoProbe, requestFullscreenProvision } from "./shared/context.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { KEYS, getConfigValue, setConfigValue, deleteConfigField } from "./shared/storage.js";
import { TUNING } from "./shell/chrome/config.js";
import { initFullscreenGate } from "./shared/shadow.js";

// The version lives in the banner and is read from the installed script at
// runtime via GM_info, so what the UI reports is always what the manager
// actually runs - never a stale build-time constant.

function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }

  // Build the single fullscreen gate (src/shared/shadow.js `fs`) off the
  // native fullscreenchange event. Runs before any shell exists so fs-gated
  // paths have a live boolean the moment they first query it.
  initFullscreenGate();

  // The shell stylesheet is warmed lazily at first shell construction
  // (shell.js #injectDom): the embedded sheet is adopted synchronously there,
  // and the @resource fetch is a background async upgrade - so first-video
  // dimming never waits on the network, and non-video / skipped pages never
  // pay for a pointless adopted-sheet injection or remote CSS fetch.

  // GM menu commands exist from script eval - not from first video
  // discovery. Registration used to live inside kernel.init(), so pages
  // without a supported player showed NO menu entries at all.
  let activeKernel = null;
  if (window.top === window) {
    installMenuCommands({ getKernel: () => activeKernel });
  }

  const boot = () => {
    if (window.PlayerForge) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    kernel.init();
    activeKernel = kernel;

    // One subscription serves both duties: readiness log always, first-run
    // welcome toast only until the flag flips. Installs from before the key
    // rename carry a bare "firstRun" field inside the configs doc - absorb
    // it once, then sweep the field (it never was a root GM key).
    const legacyFirstRun = getConfigValue("firstRun", undefined);
    let welcomePending = getConfigValue(KEYS.firstRun, legacyFirstRun !== false);
    if (legacyFirstRun !== undefined) {
      deleteConfigField("firstRun");
    }
    kernel.bus.addEventListener("pf:shell-created", (event) => {
      const shell = event.detail;
      logger.log("entry", `Shell ready: ${shell.id} (${shell.sdkName})`);
      // Nested embeds can silently lose fullscreen (Firefox requires
      // allowfullscreen on every ancestor iframe, bug 1608358). A shell in a
      // frame pushes a provisioning request up the chain so our SDk's own
      // fullscreen button - and PF's fs-gated gestures - can engage.
      if (window.top !== window) {
        requestFullscreenProvision();
      }
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
            duration: TUNING.toast.hintMs
          });
        }
      }, 1200);
    });

    // Minimal public surface: pages get the version string only. The kernel
    // (and through it the bus and shell registry) stays private - handing it
    // to page scripts would let them forge discovery events or poke shells.
    // #pf-debug in the hash re-exposes it for console debugging sessions;
    // log/bus debug state itself lives in the kernel (hash or menu setting).
    const debugMode = location.hash.includes("pf-debug");
    Object.defineProperty(window, "PlayerForge", {
      value: Object.freeze(debugMode
        ? { kernel, version: GM_info.script.version }
        : { version: GM_info.script.version }),
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
