import { Kernel } from "./kernel/kernel.js";
import { DEBUG_HASH_TAG } from "./kernel/contract.js";
import { Shell } from "./shell/shell.js";
import { installTabCommands, installFrameDiagnostics, dumpFrameState } from "./kernel/kernel.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/page.js";
import { installVideoProbe } from "./kernel/discovery.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/discovery.js";
import { logger } from "./shared/runtime.js";
import { getConfigValue, setConfigValue, warmStorage } from "./shared/store.js";
import { initFullscreenGate } from "./shared/dom.js";

// The version lives in the manifest and is read from the installed extension
// at runtime via browser.runtime.getManifest(), so what the UI reports is
// always what the browser actually runs - never a stale build-time constant.

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

/**
 * The compiled alternation twin: the suffix family as one end-anchored
 * alternation, the prefix family as one lead alternation — both derived
 * from the two source tables below and built once at module init, so the
 * scan rides the C++ RegExp engine instead of a 10-iteration JS walk
 * (24.5ns/host vs the loop's 90.5 on the delegation probe; at boot rate
 * the absolute saving is noise, the shape gain is the one-op site). The
 * end anchor is the loop's own equality/endsWith semantics: a
 * trailing-suffix trap like `doubleclick.net.evil.com` must not match,
 * and the probe draft's un-anchored form would have accepted it. Dots are
 * escaped because a suffix's literal dots must not become wildcards;
 * hostnames from `new URL().hostname` are spec-lowercase, so no flag.
 */
const AD_HOST_RE = new RegExp(
  "(?:^|\\.)(" +
    AD_HOST_SUFFIXES.map((suffix) => suffix.replace(/\./g, "\\.")).join("|") +
  ")$|^(?:" +
    AD_HOST_PREFIXES.map((prefix) => prefix.replace(/\./g, "\\.")).join("|") +
  ")"
);

function isAdHost(hostname) {
  return AD_HOST_RE.test(hostname);
}

// Read once at module eval: the manifest is immutable for the document's
// lifetime, so a getter adds nothing - the version reports what this
// loaded build actually is even if the package updates underneath.
const manifestVersion = browser.runtime.getManifest().version;

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
  // The belt IS the contract: a malformed href or a cross-origin
  // top-location read is an unreadable URL, and unreadable means not our
  // skip decision - the probe stays open rather than refusing a player
  // whose address we could not name.
  return false;
}

async function bootstrap() {
  "use strict";

  if (shouldSkipUrl()) {
    return;
  }

  // Build the single fullscreen gate (src/shared/dom.js `fs`) off the
  // native fullscreenchange event. Runs before any shell exists so fs-gated
  // paths have a live boolean the moment they first query it.
  initFullscreenGate();

  // One wholesale storage read gates the boot. The storage plane is async
  // IPC under the hood and every config/resume read (the command receiver's
  // debug query, kernel init, the first-run flag, resume warm) is served
  // from its warmed value map. Content-script -> parent-process IPC is a
  // few milliseconds - immaterial against document_start, where the DOM is
  // not parsed yet anyway: the video probe arms after warm and a first-
  // frame video is still caught by the mutation tap, which is when the
  // document was being settled on the userscript plane too.
  await warmStorage();

  // The shell stylesheet is warmed lazily at first shell construction
  // (shell.js #injectDom): the bundled sheet is adopted synchronously there -
  // no network fetch anywhere on this path (the userscript plane's @resource
  // upgrade relied on a remote CSS source; the extension ships its sheet in
  // the package), so first-video dimming never waits and non-video /
  // skipped pages never pay for an adopted-sheet injection.

  // BrowserAction commands exist from script eval - not from first video
  // discovery. The receiver owns the commands from this call (a video-less
  // page still answers the popup), while the kernel - whose shell host the
  // reset commands resolve through - boots below, so the commands read it
  // through a resolver hook at command time. Top-frame only internally
  // (the popup acts on the active tab's top document, the same reach the
  // top-frame-only menu registration this surface replaces had).
  const menuKernelRef = { current: null };
  installTabCommands(() => menuKernelRef.current);
  // The diagnostics responder is EVERY frame's (the command is top-frame
  // only, the echo answer is realm-wide - each script instance reports its
  // own document, which is the whole point of the surface). Same kernel
  // resolver as the command receiver: the dump reads identity through the
  // entry's reference at dump time, not at install.
  installFrameDiagnostics(() => menuKernelRef.current);

  const boot = () => {
    if (window.wrappedJSObject?.PlayerForge || window.PlayerForge) {
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
    // "meta" subtree of the configs doc. The "pf:first-run"/"firstRun" names
    // the userscript plane absorbed once are retired here: extension storage
    // is a fresh namespace (per-extension, not the manager's), so no install
    // of this build can carry the legacy fields there is nothing to sweep.
    let welcomePending = getConfigValue("meta.firstRun", true);
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

    // Wrapping surface, not public surface. The userscript plane froze this
    // as a non-configurable property inside the manager's sandbox (a page
    // could neither read nor overlap it); content scripts share the page's
    // window through an Xray, so custom properties must cross the waiver
    // (wrappedJSObject) to be visible to the page at all - a page CAN
    // legally own the name first. The re-entry guard (the truthiness above,
    // read through the same waiver) and the diagnostic console handle
    // survive as the honest jobs; a pre-existing definition degrades the
    // install to the belt (console only) instead of crashing the boot.
    const debugMode = location.hash.includes(DEBUG_HASH_TAG);
    try {
      const target = window.wrappedJSObject ?? window;
      Object.defineProperty(target, "PlayerForge", {
        value: Object.freeze(debugMode
          ? { kernel, dumpFrameState, version: manifestVersion }
          : { version: manifestVersion }),
        writable: false,
        configurable: false
      });
    } catch (error) {
      logger.warn("entry", "PlayerForge console handle unavailable (page owns the name)", error);
    }
    // Driver-debug observability: a plain string on the document, readable
    // from both realms (the live kernel object cannot cross an Xray, so the
    // version mirror is what the harness pins; debug mode only, the same
    // gate the sentinel's rich shape sits behind).
    if (debugMode) {
      document.documentElement.dataset.pfVersion = manifestVersion;
    }

    logger.log(
      "entry",
      `Kernel booted (${window.top === window ? "top" : "frame"}) - PlayerForge ${manifestVersion}`
    );
  };

  // The frame bridge is best-effort plumbing: if it ever fails to install
  // (e.g. its iframe-registry observer cannot bind to the document yet), the
  // video probe must still run - a nested frame whose bridge died would
  // otherwise lose capture entirely, since probe install is order-gated on
  // the bridge returning.
  try {
    // The returned teardown is deliberately never consumed, the way the
    // kernel shell-ready handle is not: the bridge is page-lifetime plumbing
    // that must stay armed across kernel boots (and across bfcache restores,
    // where the kernel tears down but the frame is still alive), and a real
    // unload disposes the realm with it. Wiring it into a pagehide would
    // close the pipes on the persisted path this bridge is required to keep.
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