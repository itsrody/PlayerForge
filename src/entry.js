import { Kernel } from "./kernel/kernel.js";
import { DEBUG_HASH_TAG, NET_HINT, COMMAND_RELAY, DRM_LATCH } from "./kernel/contract.js";
import { installTabCommands, installFrameDiagnostics, dumpFrameState } from "./kernel/kernel.js";
import { installContextBridge, requestFullscreenProvision } from "./shared/page.js";
import { installVideoProbe } from "./kernel/discovery.js";
import { MIN_VIDEO_WIDTH, MIN_VIDEO_HEIGHT } from "./kernel/discovery.js";
import { logger, setDebugRuntime } from "./shared/runtime.js";
import { loadJsonObject, KEYS, getConfigValue, setConfigValue, warmStorage } from "./shared/store.js";
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

  // BrowserAction commands + the diagnostics responder exist from script
  // eval - not from the storage warm, and not from first video discovery.
  // The red row that surfaced this: the popup channel's trigger lands a few
  // IPC hops after its own script evals, INSIDE the warm await's gap under
  // the extension realm, so a receiver registered after the warm misses it
  // ("Could not establish connection" on nearly every page load). The
  // handlers already read the config map at message-delivery time, so a
  // command raced ahead of the warm answers from the empty map - the exact
  // stock-storage shapes these commands are specified to answer.
  // The receiver owns the commands from this call (a video-less page still
  // answers the popup), while the kernel - whose shell host the reset
  // commands resolve through - boots below, so the commands read it through
  // a resolver hook at command time. Top-frame only internally (the popup
  // acts on the active tab's top document, the same reach the top-frame-only
  // menu registration this surface replaces had).
  const menuKernelRef = { current: null };
  installTabCommands(() => menuKernelRef.current);
  // The diagnostics responder is EVERY frame's (the command is top-frame
  // only, the echo answer is realm-wide - each script instance reports its
  // own document, which is the whole point of the surface). Same kernel
  // resolver as the command receiver: the dump reads identity through the
  // entry's reference at dump time, not at install.
  installFrameDiagnostics(() => menuKernelRef.current);

  // The debug console handle installs at script eval, not at kernel boot:
  // the command channel's door must exist on every frame's document BEFORE
  // any video discovery (the red row that surfaced this: a video-less embed
  // host top - the popup's own receiver surface - never boots a kernel, so
  // its pfCommand arm was unreachable and the frame rows' top-frame channel
  // had no door). Kernel-bound arms resolve through the same menuKernelRef
  // hook the commands ride; the arms are debug-gated like their siblings and
  // every arm hands back a primitive per the compartment law.
  //
  // Compartment law (probed on the real floor): EVERY value an arm returns
  // is a string. An object created in the content-script compartment reads
  // Permission-denied from every other realm - the page, the driver's
  // executor, and a user's devtools console all hit the same wall (a probe
  // measured `typeof window.PlayerForge === "object"` with Permission
  // denied on the first property read) - so the object itself must be
  // cloned into the page's own realm via the content script's native waiver
  // (cloneInto with cloneFunctions: the arms become page-local functions
  // marshaling into the extension's compartment) and each arm must hand
  // back a primitive. JSON strings are the one shape every reader can
  // legally unwrap.
  const debugMode = location.hash.includes(DEBUG_HASH_TAG);
  // The debug hash arms the sentinel at script eval, not at kernel boot:
  // the debug surface (handle, pfVersion mirror, pfLog rail) is a property
  // of this document's load, and a video-less embed-host top never boots a
  // kernel - without this the top's own diag dump logged nothing (the
  // pfLog mirror latch never flipped), and the "top direct" leg of the
  // diagnostics echo answered silence. Never a disarm - a stored debug
  // setting (persisted toggle) still arms through kernel init; this only
  // moves the hash's per-load override earlier, before any boot-gated
  // lifecycle line could clobber or precede it.
  if (debugMode) {
    setDebugRuntime(true);
  }
  try {
    // The view-transition spy: the panel flips carry their direction as
    // types, and observing those types is impossible from OUTSIDE the
    // content-script realm (probed: a page-realm or harness-side
    // document.startViewTransition patch is invisible across the Xray -
    // the panel calls the content realm's own surface). In debug mode the
    // handle becomes the sanctioned marshal: a same-realm wrapper records
    // each flip's types and an arm hands them back as a JSON string.
    // Debug-gated like the rest of the surface; the wrapper is transparent
    // (the flip itself is not altered).
    const vtFlips = [];
    if (debugMode && typeof document.startViewTransition === "function") {
      const realVt = document.startViewTransition.bind(document);
      document.startViewTransition = (update, options) => {
        // The panel rides the options-object form (one argument carrying
        // both update and types); the two-arg native form is recorded the
        // same way a caller passing it would want.
        const types = Array.isArray(update?.types) ? update.types
          : Array.isArray(options?.types) ? options.types : [];
        vtFlips.push(types.join(","));
        return realVt(update, options);
      };
    }
    const target = window.wrappedJSObject ?? window;
    const handle = Object.freeze(debugMode
      ? {
          version: manifestVersion,
          diagnosticSnapshot: () => {
            const kernel = menuKernelRef.current;
            return JSON.stringify(kernel?.diagnosticSnapshot?.()
              ?? { error: "no kernel on this document yet" });
          },
          dumpFrameState: () => JSON.stringify(dumpFrameState(() => menuKernelRef.current)),
          storageDump: () => JSON.stringify({
            configs: loadJsonObject(KEYS.configs, null),
            resume: loadJsonObject(KEYS.resume, null)
          }),
          vtFlipsDump: (mode) => {
            const current = JSON.stringify(vtFlips);
            if (mode === "clear") {
              vtFlips.length = 0;
            }
            return current;
          },
          // The popup-machinery door: one command string in, the command
          // relayed to this package's own background (runtime.sendMessage)
          // where relay.js replays the browserAction popup's exact
          // tabs.sendMessage hop onto the active tab's top document. The
          // reply lands as a data-pf-cmd-<command> rail attribute on the
          // shared documentElement - strings cross the Xray, a live reply
          // object cannot - so the harness reads the settled outcome the
          // way it reads its own rails. Returns "accepted" immediately:
          // every arm hands back a primitive, and the command's real answer
          // is the rail write, not a cross-compartment promise.
          pfCommand: (command) => {
            const label = /^[a-z-]+$/.test(String(command))
              ? String(command) : "";
            // The rail is a plain attribute write, not a dataset write:
            // dataset["pfCmd-debug-query"] throws SyntaxError on set (a
            // hyphen-lowercase property name is an invalid DOMStringMap
            // key) - the silent no-reply shape the harness once saw.
            browser.runtime.sendMessage({ type: COMMAND_RELAY, command: label }).then(
              (reply) => {
                document.documentElement.setAttribute("data-pf-cmd-" + label,
                  JSON.stringify(reply ?? null));
              },
              (err) => {
                document.documentElement.setAttribute("data-pf-cmd-" + label,
                  JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
              }
            );
            return "accepted";
          }
        }
      : { version: manifestVersion });
    const exposed = typeof cloneInto === "function"
      ? cloneInto(handle, target, { cloneFunctions: true })
      : handle;
    Object.defineProperty(target, "PlayerForge", {
      value: exposed,
      writable: false,
      configurable: false
    });
  } catch (error) {
    logger.warn("entry", "PlayerForge console handle unavailable (page owns the name)", error);
  }

  // One wholesale storage read gates the boot. The storage plane is async
  // IPC under the hood and every config/resume read (the kernel init, the
  // first-run flag, resume warm) is served from its warmed value map.
  // Content-script -> parent-process IPC is a few milliseconds - immaterial
  // against document_start, where the DOM is not parsed yet anyway: the
  // video probe arms after warm and a first-frame video is still caught by
  // the mutation tap, which is when the document was being settled on the
  // userscript plane too.
  await warmStorage();

  // The shell stylesheet is warmed lazily at first shell construction
  // (shell.js #injectDom): the bundled sheet is adopted synchronously there -
  // no network fetch anywhere on this path (the userscript plane's @resource
  // upgrade relied on a remote CSS source; the extension ships its sheet in
  // the package), so first-video dimming never waits and non-video /
  // skipped pages never pay for an adopted-sheet injection.

  const boot = () => {
    // The re-entry identity is THIS instance's kernel reference, not the
    // window.PlayerForge name: the console handle installs at script eval
    // (the command door's contract), so its presence no longer means
    // "already booted" - every funnel into boot's caller set (probe
    // candidate, net hint, hint callback) still lands on one kernel.
    if (menuKernelRef.current) {
      logger.warn("entry", "Kernel already initialized");
      return;
    }
    const kernel = new Kernel();
    menuKernelRef.current = kernel;
    // The shell plugin's "main", inlined from its former register.js home:
    // the kernel (framework) never imports the shell - it only calls the
    // provider registered here at boot. The provider is ASYNC on purpose:
    // the shell is lazy-loaded (import of the package's shell.js module on
    // the FIRST confirmed adoption), so a non-player frame never evals the
    // shell - the module load rides the boot path's own #booting latch, and
    // a failed import behaves like any provider throw (kernel #abandonBoot
    // re-arms discovery). The failed promise clears the cache so a later
    // adoption retries the import instead of handing back the rejection.
    let shellModule = null;
    const loadShellModule = () => {
      if (!shellModule) {
        shellModule = import(browser.runtime.getURL("shell.js"));
        shellModule.catch(() => {
          shellModule = null;
        });
      }
      return shellModule;
    };
    kernel.registerShellProvider({
      async create({ home, onDestroy }) {
        const { Shell } = await loadShellModule();
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
  // The background's network hint receiver (contract's NET_HINT): media-
  // shaped traffic flowed through this frame, so the boot the probe's
  // candidate callback would eventually have waited for replays NOW - a
  // hint can land long before the <video> fires its first media event on a
  // slow network path. The hint never decides anything: boot() is the same
  // idempotent entry (its own re-entry guard + the kernel's scope law), and
  // a false hint (ad frames stream video/* too) is a free no-op. Undefined
  // is the explicit no-async-reply answer every sibling onMessage listener
  // (TabCommands) filters correctly; the listener is page-lifetime, the
  // same arrangement the probe's capture listeners ride.
  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== NET_HINT) {
      return undefined;
    }
    boot();
    return undefined;
  });
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

  armDrmLatch();
}

/**
 * The Reforge plane's DRM latch, content side - PASSIVE duty per the port's
 * premise (probe A): no verb wrap, a document-level listener for the
 * `encrypted` event (EME is spec-level, long on this floor). The event
 * bubbles out of the media element, so one capture listener per realm is
 * the whole surface. The realm's first latch sends one DRM_LATCH message
 * to the background (fire-and-forget: the reply is never consumed; a
 * rejection rides the log-then-continue class - the latch is one-way by
 * contract, so a failed send carries no retry surface). Per-realm dedup:
 * one send per realm at most - the listener is page-lifetime (survives
 * kernel boots and bfcache restores like the frame bridge does), and a
 * second `encrypted` after the first is the same already-demonstrated
 * fact. `encrypted` fires only inside an EME handshake, so a non-EME
 * page pays one listener and nothing else.
 */
function armDrmLatch() {
  "use strict";

  let latched = false;
  document.addEventListener("encrypted", () => {
    if (latched) {
      return;
    }
    latched = true;
    browser.runtime.sendMessage({ type: DRM_LATCH }).catch(() => {});
  }, { capture: true });
}

bootstrap();