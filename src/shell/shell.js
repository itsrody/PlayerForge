import { logger, Scope, yield_, runSteps, runStepsAsync } from "../shared/runtime.js";
import { deepestActiveElement, isInsideShell, fs, subscribeFullscreen, DOMManager, ReferenceBox } from "../shared/dom.js";
import { InputForge } from "./inputs/forge.js";
import { attachInputActions, ViewershipTransform } from "./inputs/actions.js";
import { ZoomState } from "./inputs/zoom.js";
import { ResumeTracker } from "./resume.js";
import { SubtitleSession, SubtitlesSection, subtitleSync } from "./subtitles/subtitles.js";
import { VideoFilter, FilterSession } from "./filter.js";
import { SettingsPanel, addSettingsSection, addHistorySection } from "./chrome/panel.js";
import { getSetting, SETTING_KEYS } from "./chrome/config.js";
import { TUNING } from "../shared/core.js";
import { ToastManager } from "./chrome/toast.js";
import { claimMediaSession, createMediaControls, WakeLockSession, MEDIA_SESSION_SYNC_EVENTS } from "./media.js";
import { SHELL_MARKER, warmStyles, injectShell, watchShellHost, ensureViewportFitCover } from "./chrome/inject.js";
import { requestFullscreenProvision } from "../shared/page.js";

/**
 * Surfaces that legitimately own the native context menu inside the shell:
 * form fields (paste/copy/spellcheck) and contenteditable regions. Tested
 * against the deep (shadow-composed) event target, so panel inputs inside
 * the shadow root resolve via their own ancestor chain.
 */
const EDITABLE_SELECTOR =
  "input, textarea, [contenteditable]:not([contenteditable='false'])";

/**
 * Equal-write custom-property sync onto the shell host, the one guard both
 * CSS-var mirrors run through. A setProperty on a hot style invalidates
 * (recolors) the host subtree even when the value matches, so event storms -
 * volumechange under a volume drag, visualViewport resize/scroll while the
 * URL bar collapses per frame - would pay that cost per event to no-op the
 * paint unless each prop writes only on an actual flip (measured in the
 * media-vars row this guard replaces).
 */
function cssVarSyncer(host, specs) {
  const state = new Map();
  return () => {
    for (const [prop, read] of specs) {
      const next = read();
      if (state.get(prop) !== next) {
        state.set(prop, next);
        host.style.setProperty(prop, next);
      }
    }
  };
}

/** Human labels for MediaError.code; an unknown code falls back at the call. */
const MEDIA_ERROR_LABELS = {
  1: "Playback was aborted",
  2: "Network error while loading video",
  3: "Video could not be decoded",
  4: "Video format is not supported"
};

/**
 * Panel sections, in the order they appear, built lazily on the panel's first
 * open (never at boot). Each entry runs with a `{ shell, panel, signal }`
 * context and returns a section that owns a destroy() - or nothing when the
 * panel itself owns the teardown (history, settings register into the panel
 * tree, whose destroy() already takes them down). The boot loop yields to the
 * event loop BETWEEN entries so the first-open construction burst never wedges
 * input handling. Order here is the single source of truth for both build and
 * teardown.
 */
const PANEL_SECTIONS = [
  ({ shell }) => new SubtitlesSection(shell),
  ({ shell, panel }) => new VideoFilter(shell, panel),
  ({ shell, panel }) => {
    addHistorySection(panel, shell);
  },
  ({ shell, panel, signal }) => {
    addSettingsSection(panel, shell.zoom, signal);
  }
];

/**
 * Per-video facade: wraps the media element with a stable API, injects the
 * HUD, hosts the input layer, playback tracking, subtitles, and settings
 * panel, tracks fullscreen state, and wires MediaSession.
 */
export class Shell {
  id;
  video;
  container;
  sdk;

  #shellDom = null;
  #inputs = null;
  #resume = null;
  /** Eager subtitle session: track ownership + ingest live before the panel. */
  #subtitles = null;
  /** Eager filter session: stored filter applies at play, menu resets work. */
  #filters = null;
  /** Fullscreen crop state: gesture/panel state + per-domain persistence. */
  #zoom = new ZoomState();
  /** Fullscreen fill + zoom-crop transform machine (per-shell, owns every
   *  video.style.transform write), exposed as shell.view. */
  #view = new ViewershipTransform(this);
  /** Lazy panel sections built on first open; torn down with the shell. */
  #panelSections = [];
  #panel;
  #toasts = null;
  /** Pooled reference-box owner: the one fill-box identity (see shared/dom.js
   *  ReferenceBox) - built in the constructor once the container is known. */
  #refBox = null;
  #onDestroy;
  /** DOM lifecycle manager: listeners, observers, elements, rollbacks. */
  #dom = new DOMManager();
  /** Lifecycle scope: disposal flag + signal passed to InputForge,
   *  MediaSession, settings, fullscreen watchers, etc. */
  #scope = new Scope();
  /** Command plane: all playback control routes through these primitives. */
  #media;
  /** OS media-key facet, null without MediaSession support. */
  #mediaSession = null;
  /** Screen wake-lock companion; owns its acquire/release lifecycle. */
  #wakeLock = null;

  constructor({ video, container, sdk, onDestroy }) {
    this.video = video;
    this.container = container;
    this.sdk = sdk;
    this.#refBox = new ReferenceBox(container, this.#scope.signal);
    this.#onDestroy = onDestroy;
    this.#media = createMediaControls({ video });
    this.ready = this.#boot();
  }

  /**
   * Resolves when the shell DOM and HUD are live. Styles are NOT awaited:
   * warmStyles() applies the embedded sheet synchronously and upgrades it in
   * place when the @resource fetch lands, so boot resolves on DOM rather than
   * on a network round trip.
   */
  async #boot() {
    await this.#injectDom();
    if (!this.#shellDom) {
      throw new Error(`Shell "${this.sdk.name}": failed to inject shell DOM`);
    }

    // Yield between DOM injection and component construction so the browser
    // can process pending layout/paint work before the panel builds its tree.
    await yield_();

    this.#panel = new SettingsPanel(this);
    this.#toasts = new ToastManager(this.#shellDom.hudLayer);
    this.#inputs = new InputForge(this.video, this.container, this.shellHost,
      () => this.referenceBox);
    attachInputActions(this, this.shellHost, this.#inputs.signal);
    this.#resume = new ResumeTracker(this);
    this.#subtitles = new SubtitleSession(this);
    this.#filters = new FilterSession(this);

    // Lazy section builder: panel sections are constructed on first open to
    // keep boot fast. The table is the single source of truth for the section
    // order; the step loop yields between entries so the first-open burst
    // never wedges input handling. A failed attempt must undo both sides of
    // the seam from your own artifact ownership: this catch destroys the
    // section instances this attempt pushed and re-raises, so the panel's
    // rollback removes the tab rows + section DOM before it hands the
    // builder back - a retry then starts from the pre-attempt state instead
    // of stacking duplicate tabs.
    this.#panel.setSectionBuilder(() => {
      const context = { shell: this, panel: this.#panel, signal: this.#scope.signal };
      const attemptStart = this.#panelSections.length;
      return runStepsAsync(
        PANEL_SECTIONS.map((build) => () => {
          const section = build(context);
          if (section) {
            this.#panelSections.push(section);
          }
        }),
        { yieldBetween: true }
      ).catch((err) => {
        for (const section of this.#panelSections.splice(attemptStart)) {
          section.destroy?.();
        }
        throw err;
      });
    });

    runSteps([
      // Sync-state and zoom bindings before any watcher: the nudge/reset
      // gestures and the per-domain crop must be live from frame one, panel
      // sections included. The tracker announces each adoption once; the
      // zoom re-binds to the entry's domain and the sync state re-resolves
      // its grain through their own subscriptions.
      () => {
        subtitleSync.bindShell(this, this.#scope.signal);
        const bindZoomDomain = () => {
          const key = this.#resume?.domainKey;
          if (key) {
            this.#zoom.bindDomain(key);
          }
        };
        bindZoomDomain();
        this.#resume.onChange(bindZoomDomain);
      },
      () => this.#setupFocusManagement(),
      () => this.#suppressContextMenu(),
      () => this.#forwardMediaEvents(),
      () => this.#watchMediaErrors(),
      () => {
        this.#mediaSession = claimMediaSession({
          controls: this.#media,
          video: this.video,
          signal: this.#scope.signal
        });
      },
      () => this.#watchFullscreen(),
      () => {
        this.#wakeLock = new WakeLockSession(this.video);
      },
      () => this.#watchOrientation(),
      () => this.#watchVisualViewport(),
      // The runSteps tail: once every watcher is armed, the videos are
      // officially ours - stamp video and container as managed.
      () => {
        this.#dom.markAttribute(this.video, SHELL_MARKER, "");
        this.#dom.markAttribute(this.container, SHELL_MARKER, "");
      }
    ]);
    logger.log("shell", `Shell "${this.sdk.name}" constructed`);
  }

  /** Read-only state views; all writes route through `shell.media`. */
  get volume() {
    return this.video.volume;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  get duration() {
    return Number(this.video.duration) || NaN;
  }

  get playbackRate() {
    return this.video.playbackRate;
  }

  get muted() {
    return this.video.muted;
  }

  get paused() {
    return this.video.paused;
  }

  /**
   * Sole fullscreen condition, read straight off the shared `fs` gate
   * (shared/dom.js) - built on the native fullscreen event by initFullscreenGate().
   * The shell lives inside the SDK's frame, so an SDK fullscreen IS a document
   * fullscreen; `fs` is the single boolean that gates fs features codebase-wide.
   */
  get fullscreen() {
    return fs;
  }

  /**
   * The unified contextual fill box, owned by shared/dom.js ReferenceBox:
   * inline mode reads the shell's own container (the SDK container),
   * fullscreen reads the fs element's own rect - the device screen including
   * the Android safe area where viewport-fit=cover merged on the active
   * frame - and document fullscreen (no element) falls back to the window
   * box inside the class. Returns { width, height }.
   */
  get referenceBox() {
    return this.#refBox.get();
  }

  get shellDom() {
    return this.#shellDom;
  }

  get shellHost() {
    return this.#shellDom?.host;
  }

  get panel() {
    return this.#panel;
  }

  get resume() {
    return this.#resume;
  }

  get subtitles() {
    return this.#subtitles;
  }

  /** Color-filter state, shared by the panel section and the menu reset. */
  get filters() {
    return this.#filters;
  }

  /** Zoom & pan state, shared by the action layer and the panel section. */
  get zoom() {
    return this.#zoom;
  }

  /** The viewership transform machine (fill + zoom crop composition). */
  get view() {
    return this.#view;
  }

  /** The DOMManager — for sub-components that need lifecycle-tracked artifacts. */
  get dom() {
    return this.#dom;
  }

  #suppressContextMenu() {
    this.#dom.listen(this.container, "contextmenu", (event) => {
      // Editable surfaces (panel inputs, select popups, contenteditable)
      // keep the native context menu - paste/copy/spellcheck is part of
      // native-feel field editing. Everything else stays suppressed so the
      // page's menu never covers the shell.
      const deep = event.composedPath?.()[0];
      if (deep?.closest?.(EDITABLE_SELECTOR)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true });
  }

  /** Keep focus on the shell host when pointer interactions happen inside it. */
  #setupFocusManagement() {
    const host = this.shellHost;
    if (!host) {
      return;
    }
    host.focus();
    this.#dom.listen(this.container, "pointerdown", (event) => {
      // No disposed re-check: this closure only fires through #dom.listen's
      // own abort signal, and runSteps destroys synchronously - no event can
      // interleave between the scope flip and the dom abort that removes it.
      // Common case: focus already lives on the host - no traversal needed.
      if (document.activeElement === host) {
        return;
      }
      if (!isInsideShell(host, event.composedPath()[0])) {
        queueMicrotask(() => this.#restoreFocusIfNeeded(host));
      }
    }, { capture: true, passive: true });
  }

  /** Re-focus the host after a pointerdown unless focus already moved inside. */
  #restoreFocusIfNeeded(host) {
    if (!this.#scope.disposed && deepestActiveElement(host) !== host) {
      host.focus();
    }
  }

  toast(payload) {
    this.#toasts?.show(payload);
  }

  /** Completion feedback (800ms). */
  toastFlash(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.flashMs, group });
  }

  /** Status message (2500ms). */
  toastInfo(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.infoMs, group });
  }

  /** Onboarding hint (5000ms). */
  toastHint(icon, text, group) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.hintMs, group });
  }

  /** Action toast with buttons (4000ms). */
  toastAction(icon, text, group, actions) {
    this.#toasts?.show({ icon, text, duration: TUNING.toast.actionMs, group, actions });
  }

  hideToast(group) {
    this.#toasts?.hide(group);
  }

  /** The command plane, for interaction layers that issue media commands. */
  get media() {
    return this.#media;
  }

  async #injectDom() {
    // warmStyles() is synchronous - the embedded sheet is adopted immediately,
    // so shell construction never blocks on the @resource fetch. A warm
    // background upgrade later propagates through the same shared sheet.
    warmStyles();
    // Document-level (idempotent): make the SDK's own viewport report
    // viewport-fit=cover so the fullscreen frame can draw behind the Android
    // cutout edge-to-edge (see inject.js). Gated by fullscreen.edgeToEdge:
    // when disabled we leave the iframe at the default (Chrome letterboxes to
    // the safe area itself) and fill simply covers the letterboxed frame.
    if (getSetting(SETTING_KEYS.edgeToEdge) !== false) {
      ensureViewportFitCover();
    }
    this.#shellDom = injectShell(this.container);
    if (!this.#shellDom) {
      logger.error("shell", "Failed to inject shell DOM");
      return;
    }
    // Register host for auto-removal on destroy and mark managed attributes.
    this.#dom.onCleanup(() => this.#shellDom?.host.remove());
    this.#dom.markAttribute(this.#shellDom.host, SHELL_MARKER, "");
    // Restore container position if we changed it from static.
    const style = getComputedStyle(this.container);
    if (style.position === "static") {
      this.#dom.markStyle(this.container, "position", "relative");
    }
    // Parasite watchdog: re-attach host if evicted by SDK.
    const dropWatch = watchShellHost(this.container, this.#shellDom.host);
    this.#dom.onCleanup(dropWatch);
  }

  #forwardMediaEvents() {
    const video = this.video;
    const host = this.#shellDom?.host;
    // Expose media state as CSS custom properties on the host so the shadow
    // DOM can style based on playing/paused/muted without crossing the realm
    // boundary. The :playing/:paused/:muted pseudo-classes are in-floor on
    // 156 (verified via selector probes) but match only in the video's realm;
    // from inside our shadow root they cannot select the page's video, so
    // custom properties bridge the gap.
    let cssSync = null;
    if (host) {
      cssSync = cssVarSyncer(host, [
        ["--pf-media-paused", () => (video.paused ? "1" : "0")],
        ["--pf-media-muted", () => (video.muted ? "1" : "0")]
      ]);
    }
    // One registration set for both concerns: play/pause/volumechange are in
    // MEDIA_SESSION_SYNC_EVENTS, so separate css-sync listeners would double-
    // dispatch those three hottest state events into two closures each.
    const handler = () => {
      this.#mediaSession?.sync();
      cssSync?.();
    };
    for (const name of MEDIA_SESSION_SYNC_EVENTS) {
      this.#dom.listen(video, name, handler, { passive: true });
    }
    cssSync?.();
  }

  /**
   * Surface a terminal media failure. The `error` event on <video> means the
   * current resource cannot play (network/decode/format), a status the native
   * UI may or may not show; a toast makes the reason visible inside the shell.
   * `video.error` is read at event time (it can be cleared on a source reset)
   * and an unknown code still reports a generic failure.
   */
  #watchMediaErrors() {
    // Listener-entry guards stay out: the registration rides #dom.listen's
    // abort signal, and synchronous destroy cannot interleave an event
    // between the scope flip and that abort.
    this.#dom.listen(this.video, "error", () => {
      const code = this.video.error?.code;
      this.toastInfo("alert", MEDIA_ERROR_LABELS[code] ?? "Video playback error", "media-error");
    });
  }

  /** Surface a hint + re-provision when a fullscreen entry is rejected. */
  #watchFullscreen() {
    // An attempt to enter fullscreen was rejected (typically because an
    // ancestor embed lacks allowfullscreen - Chromium requires it on every
    // frame edge). Surface a hint, and re-issue the provisioning request so an
    // embed that was granted the attributes late can still answer.
    //
    // NOTE: this is a no-op whenever a shell was created in a nested frame, and
    // that is the only case it guards. requestFullscreenProvision is latched
    // one-shot (shared/page.js), and entry.js already calls it from onShellCreated,
    // so by the time a fullscreenerror can arrive the latch is long set. The
    // call is kept as defence in depth - if the latch is ever relaxed, or a
    // boot-time provision is skipped, this still tries - but it does not
    // currently enable the retry the code above describes.
    this.#dom.listen(document, "fullscreenerror", () => {
      // The disposed arm is gone with the other listener-entry guards
      // (abort-scoped registration, synchronous destroy); `fs` stays - it
      // is the semantic verdict (nothing to report while already fullscreen).
      if (fs) {
        return;
      }
      this.toastInfo("fs-block", "Fullscreen blocked by embed", "fs-block");
      if (window.top !== window) {
        requestFullscreenProvision();
      }
    });
  }

  /** Lock to landscape on fullscreen entry (Android); unlock on exit. */
  #watchOrientation() {
    // No disposed re-check at entry: the subscription takes this.#scope's
    // signal, so the gate drops the callback at the same abort that kills
    // everything else; entry-only checks here would duplicate that fire.
    const unsub = subscribeFullscreen(async (active) => {
      try {
        // Lock only a portrait display: an already-landscape device gets a
        // pointless lock churn (and a failed framing on tablets that reject
        // the request). type is absent on older impls - keep the legacy lock.
        const type = screen.orientation?.type;
        if (active && screen.orientation?.lock && (!type || type.includes("portrait"))) {
          await screen.orientation.lock("landscape");
        } else if (!active && screen.orientation?.unlock) {
          screen.orientation.unlock();
        }
      } catch {}
    }, this.#scope.signal);
    this.#dom.onCleanup(unsub);
  }

  exitFullscreen() {
    if (fs) {
      document.exitFullscreen()?.catch(() => {});
    }
  }

  /**
   * Mirror the visual viewport onto the shell host as CSS custom properties.
   * The mobile on-screen keyboard and collapsing URL bar shrink/offset the
   * visual viewport without changing the layout viewport, so the panel's
   * portrait bottom sheet reads these to stay above the keyboard and inside
   * the actually-visible area. vv is the real reading for this datum - the
   * keyboard is an out-of-layout occlusion no DOM element or laid-out box
   * carries - so the boundary questions stay native and only two guards
   * apply:
   *  - Coarse-pointer boot gate: the compact-sheet block is the vars' only
   *    consumer and it exists behind (pointer: coarse) - a desktop never
   *    presents the keyboard over the touch sheet, so the listeners and the
   *    writes they would arm buy nothing there. Stale after a pointer-class
   *    flip is harmless: the consumer block also disarms and stops reading.
   *  - Pinch scale: while scale deviates from 1, vv dims read in zoomed CSS
   *    px and the inset formula's layout-viewport baseline (innerHeight) is
   *    false - the readers defer to the sheet's own CSS fallbacks (the
   *    100vh/0px the spec spells) until the pinch settles.
   */
  #watchVisualViewport() {
    const vv = window.visualViewport;
    const host = this.shellHost;
    if (!vv || !host || !window.matchMedia("(pointer: coarse)").matches) {
      return;
    }
    const sync = cssVarSyncer(host, [
      ["--pf-vv-height", () => (vv.scale === 1 ? `${vv.height}px` : "100vh")],
      ["--pf-vv-inset-bottom", () => (vv.scale === 1
        ? `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`
        : "0px")]
    ]);
    this.#dom.listen(vv, "resize", sync, { passive: true });
    this.#dom.listen(vv, "scroll", sync, { passive: true });
    sync();
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    logger.log("shell", `Destroying shell "${this.sdk.name}"`);
    runSteps([
      // Scope first: flips disposed (re-entrancy guard), aborts the shared
      // signal (MediaSession/settings/fullscreen listeners die natively).
      () => this.#scope.dispose(),
      // Destroy sub-components (each manages its own internal state). Lazy
      // panel sections tear down in build order.
      () => {
        this.#resume?.destroy();
        this.#resume = null;
      },
      () => {
        this.#subtitles?.destroy();
        this.#subtitles = null;
      },
      () => {
        this.#filters?.destroy();
        this.#filters = null;
      },
      // Land the zoom's trailing per-domain persist before everything else
      // dies - the last gesture-landed crop must not be the one that never
      // got written.
      () => this.#zoom.flush(),
      () => {
        for (const section of this.#panelSections) {
          section.destroy();
        }
        this.#panelSections = [];
      },
      () => {
        this.#wakeLock?.destroy();
        this.#wakeLock = null;
      },
      () => {
        this.#inputs?.destroy();
        this.#inputs = null;
      },
      () => {
        this.#panel?.destroy();
        this.#panel = null;
      },
      () => {
        this.#toasts?.destroy();
        this.#toasts = null;
      },
      // DOM lifecycle: remove elements, disconnect observers, remove
      // listeners, restore attributes/styles - all in one call.
      () => {
        this.#dom.destroy();
        this.#shellDom = null;
      },
      () => this.#onDestroy?.(this)
    ]);
  }
}
