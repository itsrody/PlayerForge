import { Kernel } from "./kernel/kernel.js";
import { DEBUG_HASH_TAG } from "./kernel/contract.js";
import { Shell } from "./shell/shell.js";
import { installMenuCommands } from "./kernel/kernel.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/page.js";
import { installVideoProbe } from "./kernel/discovery.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/discovery.js";
import { logger } from "./shared/runtime.js";
import { getConfigValue, setConfigValue, deleteConfigField } from "./shared/store.js";
import { initFullscreenGate } from "./shared/dom.js";

// The version lives in the banner and is read from the installed script at
// runtime via GM_info, so what the UI reports is always what the manager
// actually runs - never a stale build-time constant.

/**
 * Any match skips the document entirely (ad/track/captcha frames host no
 * players). Hostname-anchored on purpose: an ad domain may appear only in a
 * path or query on a legitimate video page (`/doubleclick-interview/`,
 * `?ref=taboola.com`), and substring-matching the whole href would silently
 * skip a real player. Suffix match covers subdomains; captcha widget frames
 * live on their own domains (hcaptcha.com, recaptcha.net), so dropping the
 * path-style `recaptcha` probe costs only a harmless script eval in the
 * occasional captcha iframe that hosts no video.
 */
const AD_HOST_SUFFIXES = [
  "doubleclick.net",
  "googlesyndication.com",
  "googleadservices.com",
  "adnxs.com",
  "taboola.com",
  "outbrain.com",
  "hcaptcha.com",
  "googletagmanager.com",
  "recaptcha.net",
  "facebook.net"
];
/** Prefix families: adservice.google and its subdomains. */
const AD_HOST_PREFIXES = ["adservice.google."];

function isAdHost(hostname) {
  for (const suffix of AD_HOST_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) {
      return true;
    }
  }
  for (const prefix of AD_HOST_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function shouldSkipUrl() {
  try {
    const href = location.href;
    if (href === "about:blank" || href.startsWith("data:")) {
      return true;
    }
    if (isAdHost(new URL(href).hostname)) {
      return true;
    }
    if (window.top !== window && window.top?.location?.href) {
      if (isAdHost(new URL(window.top.location.href).hostname)) {
        return true;
      }
    }
  } catch {}
  return false;
}

function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }

  // Build the single fullscreen gate (src/shared/dom.js `fs`) off the
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
  // without a supported player showed NO menu entries at all. The kernel
  // (which the reset commands resolve their shell host through) boots after
  // this call, so the commands read it through a resolver hook at click time.
  const menuKernelRef = { current: null };
  if (window.top === window) {
    installMenuCommands(() => menuKernelRef.current);
  }
  const boot = () => {
    if (window.PlayerForge) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    menuKernelRef.current = kernel;
    // The shell plugin's "main", inlined from its former register.js home:
    // the kernel (framework) never imports the shell - it only calls the
    // provider registered here at boot. Holding the Shell import down in the
    // entry (and out of the kernel) is what keeps the shell a plug-in rather
    // than something the framework constructs directly.
    kernel.registerShellProvider({
      create({ home, onDestroy }) {
        return new Shell({ home, onDestroy });
      }
    });
    kernel.init();

    // One subscription serves both duties: readiness log always, first-run
    // welcome toast only until the flag flips. The flag lives under the single
    // "meta" subtree of the configs doc. Installs from before that move carry
    // it as a flat "pf:first-run" field (the previous name) or a bare
    // "firstRun" field (the oldest) - absorb either once, then sweep it.
    const seenBefore = getConfigValue(
      "meta.firstRun",
      getConfigValue("pf:first-run", getConfigValue("firstRun", undefined) !== false)
    );
    let welcomePending = seenBefore;
    deleteConfigField("pf:first-run");
    deleteConfigField("firstRun");
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
      setConfigValue("meta.firstRun", false);
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

    // Wrapping surface, not public surface: the sentinel lives inside the
    // manager's sandbox wrapper (Violentmonkey's makeGlobalWrapper routes
    // defineProperty onto the wrapper's private target), so a page - or
    // another script with its own wrapper - can neither read nor overlap
    // PlayerForge. The name still does the two honest jobs the wrapper
    // grants it: re-entry guard for this script's own boot path, and a
    // console-debug handle for the wrapper's context.
    const debugMode = location.hash.includes(DEBUG_HASH_TAG);
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