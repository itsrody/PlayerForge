import { Kernel } from "./kernel/kernel.js";
import { registerShell } from "./shell/register.js";
import { installMenuCommands } from "./kernel/menus.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/context.js";
import { installVideoProbe } from "./kernel/probe.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/sdk.js";
import { logger } from "./shared/logger.js";
import { shouldSkipUrl } from "./kernel/guard.js";
import { KEYS, getConfigValue, setConfigValue, deleteConfigField } from "./shared/storage.js";
import { initFullscreenGate } from "./shared/shadow.js";
import { DEBUG_LOGS_KEY } from "./kernel/contract.js";
import { installProxyDebug } from "./shell/proxy/bootstrap.js";
import { routeProgressiveSource, disposeElementSource } from "./shell/proxy/element-route.js";
import { ProxyProvider } from "./shell/proxy/provider.js";
import { netSight } from "./kernel/net-watch.js";
import { getSetting } from "./shell/chrome/config.js";

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

  // Debug-only proxy bootstrap: observe + interpose the manifest surface with
  // the Gate disabled (byte-identical pass-through, no MSE takeover) so live
  // `[PlayerForge][proxy]` breadcrumbs are reachable without help. Same debug
  // signal the kernel uses at init - #pf-debug hash or the persisted toggle.
  // Split along the kernel's top/frame model: the top frame owns GM_webRequest
  // (tab-level rules, feature-detected) and every frame - top included -
  // interposes its own fetch/XHR where page players run.
  const proxyDebugOn =
    location.hash.includes("pf-debug") || getConfigValue(DEBUG_LOGS_KEY, false);
  if (proxyDebugOn) {
    // The kernel only enables the logger once a video boots; without this the
    // hash/setting-driven traces from document-start (early manifest captures,
    // GM_webRequest observations) would be dropped before logger.enable() runs.
    // Enabling here is idempotent with the kernel and the menu toggle.
    logger.enable();
  }
  const inTopFrame = window.top === window;
  const { router } = installProxyDebug({
    debugOn: proxyDebugOn,
    role: inTopFrame ? "top" : "frame",
    gmWebRequest: inTopFrame && typeof GM_webRequest === "function" ? GM_webRequest : null,
    fetch: globalThis.fetch,
    xhrPrototype: globalThis.XMLHttpRequest?.prototype,
    getSetting,
    provider: new ProxyProvider({
      gmFetch: typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : null,
      native: { fetch: globalThis.fetch }
    }),
    // The kernel arms the net-watch feed at init; the proxy schedules its own
    // native-wire fallback sightings on the same feed so the fallback is not a
    // blind spot. It lands on the kernel-held collector only through the
    // kernel's media-filtered subscription - mp4.js only ever sees this seam.
    reportNativeWire: (url, status) => {
      netSight({ name: url, via: "proxy", initiatorType: "proxy", responseStatus: status });
    }
  });

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
      // Element-level progressive MP4 routing: a player that assigns the media
      // URL straight to video.src (StreamTape-style) bypasses fetch/XHR, so the
      // proxy could never be its initiator. The seam routes the src through the
      // shared Mp4Router and swaps it to an object URL over the proxied bytes;
      // any refusal keeps the native wire. Re-checked after the shell finishes
      // booting (players that set src lazily) - routing is idempotent, a
      // blob: src or an in-flight/past route is skipped. The object URL is
      // revoked when the shell tears down.
      const routeSrc = () => {
        if (router) {
          routeProgressiveSource({ video: shell.video, router, getSetting });
        }
      };
      routeSrc();
      shell.ready
        .then(routeSrc)
        .catch((err) => logger.warn("entry", "Shell ready rejected", err?.message ?? err));
      shell.dom?.onCleanup?.(() => disposeElementSource(shell.video));
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
      setTimeout(() => {
        if (shell && !shell.panel?.isOpen) {
          shell.toastHint(
            "captions",
            coarsePointer
              ? "Swipe down to exit fullscreen"
              : "Press S for settings · Swipe down to exit fullscreen"
          );
        }
      }, 1200);
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

  installContextBridge();
  installVideoProbe({
    minWidth: MIN_VIDEO_WIDTH,
    minHeight: MIN_VIDEO_HEIGHT,
    onCandidate: boot
  });
}

bootstrap();
