import { Kernel } from "./kernel/kernel.js";
import { registerShell } from "./shell/register.js";
import { installMenuCommands } from "./kernel/menus.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/context.js";
import { installVideoProbe } from "./kernel/probe.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { KEYS, getConfigValue, setConfigValue, deleteConfigField, whenManagerReady } from "./shared/storage.js";
import { importManagerConfig } from "./shared/power-config.js";
import { VERSION_MARKER } from "./kernel/contract.js";
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
  // without a supported player showed NO menu entries at all. Registration
  // calls GM_registerMenuCommand, which ScriptCat only installs after the
  // manager finishes loading under @early-start; gating on readiness is a
  // single microtask on every other manager, so the from-eval guarantee holds.
  if (window.top === window) {
    whenManagerReady().then(() => installMenuCommands());
  }
  const boot = () => {
    // Re-entry guard keyed on the DOM marker rather than a global. The marker
    // is the one surface both JS worlds can see, so it is authoritative for
    // "PF already booted here" - and, under @inject-into content, a page that
    // sets window.PlayerForge can no longer talk PF out of booting.
    if (document.documentElement?.hasAttribute(VERSION_MARKER)) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    registerShell(kernel);
    // Fold manager-side power-config edits into pf:configs before anything
    // reads those fields - the kernel reads debug.logs during init() and the
    // subtitle section reads its styling keys on shell creation.
    const adopted = importManagerConfig();
    if (adopted) {
      logger.log("entry", `Imported ${adopted} manager power-config field(s)`);
    }
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
      const hintDismiss = new AbortController();
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
        hintDismiss.abort();
      };
      document.addEventListener("pointerdown", cancelHint, { capture: true, once: true, signal: hintSignal });
      document.addEventListener("keydown", cancelHint, { capture: true, once: true, signal: hintSignal });
      document.addEventListener("wheel", cancelHint, { capture: true, passive: true, once: true, signal: hintSignal });
    });

    // GM_info is populated on every manager once loaded, but ScriptCat's
    // @early-start can surface a player before that; read it defensively so
    // the public debug surface degrades to a placeholder instead of throwing.
    const mgrInfo = typeof GM_info === "object" && GM_info !== null ? GM_info : {};
    const scriptVersion = mgrInfo.script?.version ?? "unknown";

    // Version surface: a DOM attribute, not a JS global. Under
    // @inject-into content a window property would live in the
    // content-script world, where a page can neither read it nor spoof it -
    // which is the point, but it also drops the read path pages had. The
    // attribute lives on the shared DOM, so
    // document.documentElement.dataset.pfVersion is the same value from a page
    // script, from an isolated script, and from the manager.
    // (data-pf-shell, the shell's own claim on its host, is its sibling.)
    document.documentElement?.setAttribute(VERSION_MARKER, scriptVersion);

    // #pf-debug in the hash re-exposes the kernel for console debugging
    // sessions; the rest of the time it stays private - handing the kernel to
    // page scripts would let them forge discovery events or poke shells. The
    // define is guarded because a name already taken in this world would
    // otherwise throw out of the try-less boot path and take the kernel with
    // it, which is a worse outcome than a missing debug handle.
    const debugMode = location.hash.includes("pf-debug");
    if (debugMode) {
      try {
        Object.defineProperty(window, "PlayerForge", {
          value: Object.freeze({ kernel, version: scriptVersion }),
          writable: false,
          configurable: false
        });
      } catch (error) {
        logger.warn("entry", "Debug handle unavailable (name already taken)", error);
      }
    }

    logger.log(
      "entry",
      `Kernel booted (${window.top === window ? "top" : "frame"}) - ` +
        `${mgrInfo.scriptHandler ?? "manager"} ${mgrInfo.version ?? "?"}, script ${scriptVersion}`
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
  const stopProbe = installVideoProbe({
    minWidth: MIN_VIDEO_WIDTH,
    minHeight: MIN_VIDEO_HEIGHT,
    onCandidate: boot
  });
  // The probe owns discovery until it boots the kernel (which detaches it). If
  // the document is torn down before any candidate appears, release its capture
  // listeners; a bfcache hide (persisted) keeps them so a player that appears
  // after restore is still caught - mirroring the kernel's pagehide handling.
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) {
      stopProbe();
    }
  });
}

bootstrap();