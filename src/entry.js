import { Kernel } from "./kernel/kernel.js";
import { registerShell } from "./shell/shell.js";
import { probeEngineHost } from "./shared/engine-host.js";
import { installMenuCommands } from "./kernel/menus.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/context.js";
import { installVideoProbe, shouldSkipUrl } from "./kernel/discovery.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/diagnostics.js";
import { KEYS, getConfigValue, setConfigValue, deleteConfigField } from "./shared/storage.js";
import { initFullscreenGate } from "./shared/shadow.js";
import { Scope } from "./shared/scope.js";

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

  // Probe the L0 environment facts explicitly: the snapshot defaults to its
  // import-time evaluation, but import order must never decide what the
  // facts are - entry owns the document, so entry owns the probe.
  probeEngineHost();

  // The shell stylesheet is warmed lazily at first shell construction
  // (shell.js #injectDom): the embedded sheet is adopted synchronously there,
  // and the @resource fetch is a background async upgrade - so first-video
  // dimming never waits on the network, and non-video / skipped pages never
  // pay for a pointless adopted-sheet injection or remote CSS fetch.

  // GM menu commands exist from script eval - not from first video
  // discovery. Registration used to live inside kernel.init(), so pages
  // without a supported player showed NO menu entries at all.
  if (window.top === window) {
    installMenuCommands();
  }
  const boot = () => {
    if (window.PlayerForge) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    registerShell(kernel);
    kernel.init();

    // One subscription serves both duties: readiness log always, first-run
    // welcome toast only until the flag flips. Installs from before the key
    // rename carry a bare "firstRun" field inside the configs doc - absorb
    // it once, then sweep the field (it never was a root GM key).
    const legacyFirstRun = getConfigValue("firstRun", undefined);
    let welcomePending = getConfigValue(KEYS.firstRun, legacyFirstRun !== false);
    if (legacyFirstRun !== undefined) {
      deleteConfigField("firstRun");
    }
    kernel.onShellCreated((shell) => {
      logger.log("entry", `Shell ready: ${shell.sdk.name}`);
      // Nested embeds can silently lose fullscreen (browsers require
      // allowfullscreen on every ancestor iframe). A shell in a
      // frame pushes a provisioning request up the chain so our SDK's own
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
      // One composed signal owns the hint's lifetime: the 1.2s cap and the
      // visitor's first interaction are its sources, so either one detaches
      // all three capture listeners - no clearTimeout plus manual
      // removeEventListener bookkeeping. Aborting the composed signal does
      // not cancel the cap's timer, so the flag is what keeps a dismissed
      // hint from toasting when the cap later elapses.
      const hintCap = AbortSignal.timeout(1200);
      const hintDismiss = new Scope();
      const hintSignal = AbortSignal.any([hintDismiss.signal, hintCap]);
      let hintCancelled = false;
      hintCap.addEventListener("abort", () => {
        if (hintCancelled) {
          return;
        }
        if (shell && shell.container?.isConnected && !shell.panel?.isOpen) {
          shell.toastHint(
            "captions",
            coarsePointer
              ? "Swipe down to exit fullscreen"
              : "Press S for settings · Swipe down to exit fullscreen"
          );
        }
      }, { once: true });
      const cancelHint = () => {
        hintCancelled = true;
        hintDismiss.dispose();
      };
      document.addEventListener("pointerdown", cancelHint, { capture: true, once: true, signal: hintSignal });
      document.addEventListener("keydown", cancelHint, { capture: true, once: true, signal: hintSignal });
      document.addEventListener("wheel", cancelHint, { capture: true, passive: true, once: true, signal: hintSignal });
    });

    // Minimal public surface: pages get the version string only. The kernel
    // (and through it the shell registry) stays private - handing it to page
    // scripts would let them forge discovery events or poke shells. #pf-debug
    // in the hash re-exposes it for console debugging sessions; debug log
    // state itself lives in the module-level logger (hash or menu setting).
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

  // The frame bridge is best-effort plumbing: if it ever fails to install
  // (e.g. its iframe-registry observer cannot bind to the document yet), the
  // video probe must still run - a nested frame whose bridge died would
  // otherwise lose capture entirely, since probe install is order-gated on
  // the bridge returning.
  try {
    installContextBridge();
  } catch (error) {
    logger.error("entry", "Frame bridge install failed", error);
  }
  installVideoProbe({
    minWidth: MIN_VIDEO_WIDTH,
    minHeight: MIN_VIDEO_HEIGHT,
    onCandidate: boot
  });
}

bootstrap();