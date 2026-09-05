/**
 * Kernel-owned proxy arm: installs the production proxy wire seams and
 * subscribes the element-level takeover plane to the kernel's shell lifecycle.
 *
 * The kernel never imports a shell; it arms the proxy by calling the provider
 * it is handed (hosting the top/frame role split and the GM_webRequest mount)
 * and then rides its own shell-created / shell-destroyed hooks to fire the
 * element seams and tear their temporary surfaces back down. This is the one
 * module that turns the shell facade (a created Shell) into proxy calls - the
 * proxy data plane itself stays headless (no shell import anywhere in
 * src/kernel/proxy).
 *
 * Deterministic: every seam (roles, GM_webRequest, fetch, xhr prototype, object
 * URL creation, provider, reportNativeWire) is a parameter; role + onShellReady
 * come from the kernel's registered provider/wiring so the whole arm runs
 * headless.
 */
import { installProxy, installProxyDebug } from "./bootstrap.js";
import { ProxyProvider } from "./provider.js";
import { routeProgressiveSource, disposeElementSource, routeManifestStreams, disposeManifestStream } from "./element-route.js";
import { getSetting } from "../settings.js";
import { logger } from "../../shared/logger.js";

/**
 * Install the proxy for one realm. Returns the seams entry.js/the kernel used
 * to reach the proxy: `{ router, flow, claims }` for the production arm, or
 * the debug installer's `{ summary, router, claims }`. Uses default installs
 * (globalThis.fetch / Global XHR prototype) unless overridden for headless
 * tests.
 *
 * @param {object}   env
 * @param {object}   env.kernel       the Kernel (for onShellCreated/onShellDestroyed).
 * @param {"top"|"frame"} [env.role="top"]
 * @param {Function} [env.gmWebRequest]
 * @param {Function} [env.fetch]
 * @param {object}   [env.xhrPrototype]
 * @param {object}   [env.provider]   ProxyProvider seam (defaults to a native-fetch one).
 * @param {Function} [env.reportNativeWire]
 * @param {boolean}  [env.debugOn=false]
 */
export function armProxy({ kernel, role = "top", gmWebRequest = null, fetch = null, xhrPrototype = null, provider = null, reportNativeWire = () => {}, debugOn = false } = {}) {
  if (!kernel || typeof kernel.onShellCreated !== "function") {
    logger.error("proxy", "arm", "a kernel with shell lifecycle hooks is required");
    return null;
  }

  const fallbackProvider = provider ?? new ProxyProvider({ native: { fetch: fetch ?? globalThis.fetch } });

  const installed = debugOn
    ? installProxyDebug({ debugOn: true, role, gmWebRequest, fetch, xhrPrototype, provider: fallbackProvider, reportNativeWire, getSetting })
    : installProxy({ role, gmWebRequest, fetch, xhrPrototype, provider: fallbackProvider, reportNativeWire, getSetting });

  if (!installed.router) {
    logger.warn("proxy", "arm", "no fetch seam - element seams stay inactive", installed.summary);
    return installed;
  }
  const { router, claims } = installed;

  // fire the element takeover seams on shell rendezvous, and tear their
  // temporary surfaces on shell destruction (the DOMManager-free teardown
  // twin of shell.dom.onCleanup).
  kernel.onShellCreated((shell) => {
    const routeSrc = () => {
      routeProgressiveSource({ video: shell.video, router, getSetting });
    };
    routeSrc();
    shell.ready
      .then(routeSrc)
      .catch((err) => logger.warn("kernel", "proxy element src route rejected", err?.message ?? err));
    routeManifestStreams({ video: shell.video, getSetting, claims, provider: fallbackProvider });
    shell.ready
      .then(() => routeManifestStreams({ video: shell.video, getSetting, claims, provider: fallbackProvider }))
      .catch((err) => logger.warn("kernel", "proxy manifest takeover rejected", err?.message ?? err));
  });
  kernel.onShellDestroyed((shell) => {
    disposeManifestStream(shell.video).catch((err) =>
      logger.warn("kernel", "proxy manifest stream dispose failed", err?.message ?? err)
    );
    disposeElementSource(shell.video);
  });

  logger.log("proxy", "arm", "proxy armed", installed.summary);
  return installed;
}