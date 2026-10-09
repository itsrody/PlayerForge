import { logger } from "../shared/diagnostics.js";
import { getConfigValue } from "../shared/storage.js";
import { setDebugRuntime } from "../shared/diagnostics.js";
import { postTask } from "../shared/scheduler.js";
import { Scope } from "../shared/scope.js";
import { findSdkForVideo, meetsMinSize, watchDocumentVideos, watchMediaEvents, forEachShadowVideos } from "./sdk.js";
import { GESTURE_EVENTS, DEBUG_LOGS_KEY, FRAMEWORK_TUNING } from "./contract.js";

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, drives discovery, and owns the registry/lifecycle pair.
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (sdk.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */
/** Skyline the removal watchdog never exceeds regardless of nesting. */
const MAX_REMOVAL_DEPTH = 8;
/** Extra ancestors (beyond the matched anchor) the removal watch observes. */
const REMOVAL_DEPTH_MARGIN = 1;

export class Kernel {
  #registry;
  #lifecycle;
  /** Shell-ready listeners (direct callbacks, no bus). */
  #createdListeners = new Set();
  #initialized = false;
  // Weak: an adopted video orphaned by an untracked removal path must not
  // pin the element (and its whole subtree) for the page's lifetime.
  #seenVideos = new WeakSet();
  /** Videos that already consumed their one post-failure retry. Weak, and read
   *  only on the failure path - a boot that throws deterministically must not
   *  be re-attempted on every mutation record, so the second failure is final. */
  #bootRetried = new WeakSet();
  /** Videos whose settle completed while they were detached: shell creation
   *  was skipped, but #seenVideos still claims them and the discovery tap has
   *  already downgraded, so no other path would ever offer them again. The
   *  removal watch's reconnect edge consumes this entry one-shot and
   *  re-adopts - without it a reattach inside the grace cancels the only
   *  pending re-check and the video stays claimed with no shell for the life
   *  of the document (live repro: settle-skip demo). Weak, and never
   *  iterated. */
  #settleSkipped = new WeakSet();
  /** Videos with an armed removal watch: one watcher per video. A settle-skip
   *  re-adoption re-enters #watchVideoRemoval while the original watcher is
   *  still live; a second observer pair would leave each stopWatching
   *  responsible for only its own observer, stranding anchors until pagehide.
   *  Weak - same rationale as #removalTimers. */
  #removalWatching = new WeakSet();
  /** Pending disconnect graces, keyed by the video that is going away. Weak,
   *  and only ever probed per-video (has/get/set/delete - never iterated):
   *  the entry is removed by the grace callback, but on pagehide the task is
   *  aborted, so that callback never runs. A strong Map would then pin a
   *  detached video and its whole subtree for the rest of the document's
   *  life, which is exactly what the Weak sets above refuse to do. */
  #removalTimers = new WeakMap();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  /** Kernel lifecycle scope: removal observers disconnect via onDispose,
   *  grace timers cancel via the signal. */
  #scope = new Scope();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

  #onPageShow = (event) => {
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    for (const shell of this.#registry.getAll()) {
      if (!shell.video.isConnected) {
        this.#seenVideos.delete(shell.video);
        shell.destroy();
        logger.log("kernel", `Reconciled orphaned shell: ${shell.sdk.name}`);
      }
    }
  };

  #onPageHide = (event) => {
    if (!event.persisted) {
      logger.log("kernel", "Page hiding, cleaning up");
      this.#stopDiscoveryTap?.();
      this.#stopDiscoveryTap = null;
      // Scope first: onDispose disconnects every removal observer, the
      // signal cancels pending removal-grace postTasks, and the page-level
      // pageshow/pagehide listeners drop. Lifecycle/registry teardown below
      // then runs with all watch machinery already dead.
      this.#scope.dispose();
      // Subscribers too. The kernel owns this set, so it owns its release:
      // callers register and drop the returned unsubscribe (nothing re-registers
      // a listener per page, so there is no double-fire to guard), and a
      // discarded page should not keep the closures alive. Deliberately inside
      // the !persisted branch - a bfcache hide restores the page, and the
      // reconcile path above still needs whoever registered to be listening.
      this.#createdListeners.clear();
      // Tear down in-flight settle waits so their observers + timers die
      // immediately instead of running the full quiet/cap window on a page
      // that is already leaving.
      this.#lifecycle.destroy();
      this.#registry.destroyAll();
    }
  };

  constructor() {
    this.#registry = new ShellRegistry();
    this.#lifecycle = new LifecycleManager(
      this.#registry,
      (shell) => this.#notifyShellCreated(shell),
      (video) => this.#onShellBootFailed(video),
      (video) => this.#settleSkipped.add(video)
    );
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
  }

  /**
   * The shell plugin registers its host provider here; the framework never
   * imports the shell, it only calls the provider it was handed. Provider
   * shape: `{ create({ video, container, sdk, onDestroy }) -> host }`.
   */
  registerShellProvider(provider) {
    this.#shellProvider = provider;
  }

  /**
   * Register a shell-ready listener directly; returns an unsubscribe.
   *
   * The kernel owns this set and releases it on a real pagehide, so a caller
   * that registers once per document (entry.js does) does not have to thread
   * the unsubscribe anywhere. The handle is still returned for callers that DO
   * register per-shell or conditionally.
   */
  onShellCreated(cb) {
    this.#createdListeners.add(cb);
    return () => this.#createdListeners.delete(cb);
  }

  /** Register the shell then fan out to every shell-ready listener. */
  #notifyShellCreated(shell) {
    this.#registry.register(shell);
    for (const cb of this.#createdListeners) {
      try {
        cb(shell);
      } catch (err) {
        logger.error("kernel", "Shell-created listener threw:", err);
      }
    }
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    logger.log("kernel", "Initializing kernel");
    // Debug logs activate from the persisted menu toggle or the #pf-debug
    // hash. The hash alone is a per-load override - it never writes the
    // setting, and an explicit menu "Off" wins over it.
    const storedDebug = getConfigValue(DEBUG_LOGS_KEY, false);
    const hashDebug = location.hash.includes("pf-debug");
    if (storedDebug || hashDebug) {
      setDebugRuntime(true);
      logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
    }
    const { signal } = this.#scope;
    document.addEventListener("pageshow", this.#onPageShow, { signal });
    window.addEventListener("pagehide", this.#onPageHide, { signal });
    // Permanent rider on the shared discovery tap: every video the probe
    // would have seen, the kernel now adopts through the same wiring.
    this.#stopDiscoveryTap = watchDocumentVideos((video) => this.#adoptVideo(video));
    // The probe boots us precisely so a video already in the parsed DOM gets
    // its shell without waiting for the next media event. Replay once: the
    // media-event tap (and the downgrade path) still catches script-lazy SDK
    // players that surface after boot. The shadow pass replays what qSA
    // cannot see - a shadow player in the parsed DOM was otherwise adopted
    // only via a media event (forEachShadowVideos has the live repro).
    for (const video of document.querySelectorAll("video")) {
      this.#adoptVideo(video);
    }
    forEachShadowVideos(document, (video) => this.#adoptVideo(video));
    logger.log("kernel", "Kernel ready - discovery tap active");
  }

  /**
   * After the first successful adoption, drop the full-document discovery tap
   * (the heavier childList+subtree observer) and fall back to the cheap
   * capture-mode media-event tap. On MPA pages there is no second player to
   * surface, so keeping the per-mutation scan alive for the whole page taxes
   * every DOM change for nothing; the media-event tap still catches a
   * script-lazy SDK player that fires loadeddata/play, so discovery never goes
   * fully quiet. Idempotent; pagehide still tears the remaining tap down.
   */
  #downgradeDiscoveryTap() {
    if (this.#discoveryDowngraded) {
      return;
    }
    this.#discoveryDowngraded = true;
    this.#stopDiscoveryTap?.();
    this.#stopDiscoveryTap = watchMediaEvents((video) => this.#adoptVideo(video));
  }

  /**
   * A shell's boot threw. If the boot failed, the shell already rolled its own
   * DOM back and the kernel released the claim, so the video is adoptable
   * again; if a shell came up fine, the seen-set and the registry slot refuse
   * it either way. Exactly one retry is allowed for the first case: the full-document
   * discovery tap feeds this path one record per mutation, so an unbounded
   * re-arm would spin on a deterministically-throwing boot. The second failure
   * is final and the video goes back into the seen-set.
   */
  #onShellBootFailed(video) {
    if (this.#bootRetried.has(video)) {
      this.#seenVideos.add(video);
      return;
    }
    this.#bootRetried.add(video);
    this.#seenVideos.delete(video);
  }

  /** Adopt the video, emit discovery and start removal watching. */
  #adoptVideo(video) {
    // Ownership is decided JS-side only: #seenVideos (claimed below, before
    // any yield), the registry slot, and the lifecycle's pending set. The
    // SHELL_MARKER attribute the shell writes is deliberately NOT read here:
    // it is observable state (the stylesheet's :fullscreen hook, the DOM's
    // boot signal), not identity — and attributes clone. A cloneNode(true) of
    // a managed video carries the marker onto a video no shell owns, and a
    // veto on it would refuse that clone for the life of the document.
    if (this.#seenVideos.has(video)) {
      return;
    }
    const sdk = findSdkForVideo(video);
    if (!sdk) {
      return;
    }
    if (!meetsMinSize(video)) {
      return;
    }
    const container = sdk.container;
    if (!container) {
      logger.warn("kernel", "No container for video - skipping");
      return;
    }
    this.#seenVideos.add(video);
    // Guarded like the logger contract promises: with chatter off (the
    // default), the dimensions/duration interpolation never runs - a disabled
    // log call must cost one boolean read, not a template build.
    if (logger.enabled) {
      logger.log("kernel", `${sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
    }
    this.#lifecycle.onVideoFound({
      video,
      container,
      sdk
    });
    this.#watchVideoRemoval(video, container, sdk.hops);
    this.#downgradeDiscoveryTap();
  }

  #watchVideoRemoval(video, container, hops) {
    // Re-adoption after a settle-skip (connected branch of checkAnchors) or a
    // container move (the movedOut branch) lands here with the original
    // watcher still armed; a second observer pair would never be torn down as
    // a pair. The closure keeps the FIRST adopt's container/hops: reanchor
    // only reads container as the parentless fallback and the depth as a cap,
    // both fine for the same video under a new parent.
    if (this.#removalWatching.has(video)) {
      return;
    }
    this.#removalWatching.add(video);
    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    const watchDepth = Number.isInteger(hops) && hops > 0
      ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;

    const anchors = [];
    /** The observed node ABOVE the watched range; null when the chain ends at
     * the document. Tracked (not just observed) so isChainFresh can detect a
     * subtree move that leaves anchors[] itself intact but shifts the upper
     * range off its old node - the shape the live swap probe hit. */
    let sentinel = null;

    /**
     * Removal-grace tick: a scheduler.postTask handle on the kernel scope. It
     * is pure deferral - nothing about it needs timer priority - and being
     * signal-bound means pagehide (or any kernel abort) cancels every pending
     * grace without the manual sweep loop racing the page.
     */
    const scheduleGraceTimer = (done) => {
      const handle = postTask(done, {
        priority: "user-visible",
        delay: FRAMEWORK_TUNING.removalGraceMs,
        signal: this.#scope.signal
      });
      return () => handle.abort();
    };

    /**
     * Is the observed chain still exactly the chain that was recorded? Walks
     * anchors[] then the hop beyond them against the sentinel: moving the
     * whole player subtree keeps video.parentElement - and even anchors[] -
     * intact while the upper range sits on a node that is no longer an
     * ancestor, so the new chain's removal never reaches checkAnchors
     * (measured live: host still inside the detached tree at +903ms; a
     * control mutation on an observed old root destroyed it at +708ms).
     * Bounded by anchors.length + 1 (<= MAX_REMOVAL_DEPTH + 1 parentElement
     * reads): 154ns at depth 2 (the plyr/JW shape) / 244ns worst-case per
     * batch on Gecko against a 48.9ns baseline - priced only to bound a
     * correctness walk, not sold as a win.
     */
    const isChainFresh = () => {
      let node = video.parentElement;
      for (let i = 0; i < anchors.length; i++) {
        if (node !== anchors[i]) {
          return false;
        }
        node = node.parentElement;
      }
      return node === sentinel;
    };

    // Arrow fn keeps the enclosing class-level `this` for timer/lifecycle access.
    const checkAnchors = () => {
      if (!video.isConnected) {
        // One single-shot grace per disconnect; while it is pending the timer
        // owns the re-check (further removal mutations are the same fact).
        if (this.#removalTimers.has(video)) {
          return;
        }
        this.#removalTimers.set(video, scheduleGraceTimer(() => {
          this.#removalTimers.delete(video);
          if (!video.isConnected) {
            stopWatching();
            this.#lifecycle.onVideoRemoved({ video });
          } else {
            reanchorObservers();
          }
        }));
        return;
      }
      // Connected again: any pending grace is stale - the event that brought
      // the video back (or moved it) replaces the time-based re-check, so the
      // stale timer is cancelled instead of firing later against outdated
      // state, and a fresh grace (if needed) is always measured from the
      // CURRENT disconnect. Between settled events nothing is pending.
      this.#removalTimers.get(video)?.();
      this.#removalTimers.delete(video);
      // The video leaving its parent means it moved OUT of the shell's
      // container (the host is injected INTO container - inject.js:88), so
      // the live HUD is stranded over the emptied slot while marker + seen
      // refuse the new location for the life of the document. Measured live:
      // video moved alone -> at +799ms the host was still in the old slot,
      // zero hosts in the new location, data-pf-shell still set even after
      // the old slot died. Re-adopt: destroy the stale shell (its destroy
      // unmarks and unregisters), release the claim, run adoption against
      // the CURRENT ancestry - which legitimately refuses an unrecognisable
      // new location (sdk null) and succeeds once the page wraps the video
      // in a player again. One shell rebuild per re-parent is the accepted
      // cost; resume re-adopts its saved entry by design.
      const movedOut = video.parentElement !== anchors[0];
      if (movedOut || !isChainFresh()) {
        reanchorObservers();
      }
      // A settle that completed while this video was detached skipped shell
      // creation but left #seenVideos claiming it - and this very reconnect
      // just cancelled the grace that would have released the claim. With the
      // discovery tap already downgraded, this edge is the only re-discovery
      // signal there is: release the claim and run adoption again (fresh
      // findSdk/size validation; a video that no longer qualifies stays
      // unclaimed and refusable). One-shot consume, so ordinary re-anchors
      // with a live shell - and boot-failed videos waiting on their media
      // event - never re-enter adoption. The movedOut branch re-adopts too,
      // so the flag is consumed on that path as well instead of staying
      // armed for a later, now redundant, offer.
      const skipEdge = this.#settleSkipped.delete(video);
      if (movedOut) {
        this.#lifecycle.onVideoRemoved({ video });
        this.#seenVideos.delete(video);
        this.#adoptVideo(video);
      } else if (skipEdge) {
        this.#seenVideos.delete(video);
        this.#adoptVideo(video);
      }
    };

    /** Single-target consolidation: `MutationObserver.observe()`
     *  supports multiple root targets natively (childList filtered in C++), so
     *  up to the active depth (cap: MAX_REMOVAL_DEPTH) per-video C++ wrappers
     *  collapse to one instance.
     *  The kernel scope disconnects it at pagehide - no per-video bookkeeping. */
    const observer = new MutationObserver(checkAnchors);
    this.#scope.onDispose(() => observer.disconnect());

    /**
     * The initial walk is tight (matched anchor + margin) so an untouched
     * player never watches the chatty upper document. Once a re-anchor has
     * run - a move, a reconnect-out-of-grace - the recorded locality is
     * known wrong and the next walk uses the MAX_REMOVAL_DEPTH cap: a tight
     * range after a move is demonstrably blind. The swap probe's drop record
     * fired only on the new body, two levels past the hops+1 range, so the
     * orphan survived (host in the detached tree at +905ms) even with a
     * correct chain compare. Same observer, still bounded by the cap; the
     * sentinel stays the documented boundary beyond it.
     */
    let anchorDepth = watchDepth;
    const reanchorObservers = () => {
      // MutationObserver has no per-target unobserve(): disconnect() is the
      // only way to drop the stale roots (the previous loop called a method
      // that does not exist and threw, leaving the anchors stranded on their
      // original parents). Records dropped by the disconnect cost nothing:
      // this callback never reads the queue - every decision below is
      // re-derived from live DOM state, which was just evaluated on this
      // very call - and the next mutation lands on the re-observed roots.
      observer.disconnect();
      anchors.length = 0;
      let anchor = video.parentElement || container;
      for (let depth = 0; anchor && depth < anchorDepth; depth++, anchor = anchor.parentElement) {
        observer.observe(anchor, { childList: true });
        anchors.push(anchor);
      }
      anchorDepth = MAX_REMOVAL_DEPTH;
      /**
       * Sentinel: the first ancestor ABOVE the watched range. MutationObserver
       * only reports mutations of the nodes it observes, so removing the
       * outermost watched anchor was a childList change on a node nobody
       * watched - no record, no checkAnchors, and the video stayed claimed
       * forever (shell, listeners, marker, #seenVideos entry). When the chain
       * ends at the document `anchor` is null and there is nothing to watch.
       * Kept out of `anchors` deliberately: that array is the watched RANGE,
       * and anchors[0] means "the video's parent" to checkAnchors.
       * Tracked in `sentinel` too: a subtree move can leave the whole range
       * intact while the node ABOVE it is no longer an ancestor, and only a
       * recorded sentinel can notice (isChainFresh).
       */
      if (anchor && !anchors.includes(anchor)) {
        observer.observe(anchor, { childList: true });
        sentinel = anchor;
      } else {
        sentinel = null;
      }
    };

    const stopWatching = () => {
      observer.disconnect();
      this.#removalWatching.delete(video);
      this.#removalTimers.get(video)?.();
      this.#removalTimers.delete(video);
      this.#seenVideos.delete(video);
    };

    reanchorObservers();
  }

  #createShell({ video, container, sdk }) {
    const provider = this.#shellProvider;
    if (!provider) {
      logger.error("kernel", "No shell provider registered");
      return null;
    }
    const shell = provider.create({
      video,
      container,
      sdk,
      onDestroy: () => this.#registry.unregister(shell)
    });
    return shell;
  }

  /**
   * Toggle the most recently created shell's panel from outside the input
   * stack (GM menu). Warns unconditionally when nothing can host a panel -
   * the user clicked something and must know why nothing happened.
   */
  togglePanel() {
    const shells = this.#registry.getAll();
    const host = shells.length ? shells.at(-1).shellHost : null;
    if (!host) {
      logger.warn("kernel", "Panel toggle requested but no player is active on this page");
      return;
    }
    host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
      detail: { method: "menu" }
    }));
  }
}

/* ── ShellRegistry ───────────────────────────────────────────────────────
 *
 * The live shells of one document, keyed by their <video>.
 *
 * This used to be a single slot that every new shell overwrote, which was only
 * correct while a document could hold one player. The kernel builds one shell
 * per qualifying <video> and platform/integration/gm-multisubscriber already
 * asserts two of them in one document, so the slot silently dropped every shell
 * but the last. That cost three things: a removed non-current player was never
 * destroyed, so its document-level hotkey listeners, its DOM observers and its
 * pf:resume subscription all stayed live (measured in Firefox 157: removing one
 * of two players produced ZERO gm:remove events, the subscription never left the
 * table); the bfcache reconcile pass only ever saw the newest shell, so orphaned
 * shells for any other video survived a restore; and getAll() was a
 * single-element array, which made togglePanel()'s "most recent" pick
 * meaningless.
 *
 * Insertion order is registration order, so the last entry is still the most
 * recently created shell - which is what togglePanel() means by it, and what it
 * means now that a page really can hold several.
 */
export class ShellRegistry {
  #shells = new Map();

  register(shell) {
    this.#shells.set(shell.video, shell);
    logger.log("registry", `Shell registered: ${shell.sdk.name}`);
  }

  unregister(shell) {
    // Deleted by identity, not by key alone. destroy() can legitimately be
    // reached twice - a removal grace and a pagehide both landing on the same
    // shell - and a bare delete would then evict whatever shell took the key in
    // between, losing a live player to a dead one's teardown.
    if (this.#shells.get(shell.video) === shell) {
      this.#shells.delete(shell.video);
    }
    logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
  }

  getByVideo(video) {
    return this.#shells.get(video) ?? null;
  }

  /** Every live shell, oldest registration first. */
  getAll() {
    return [...this.#shells.values()];
  }

  destroyAll() {
    // Emptied before any destroy() runs, so a shell torn down here cannot
    // unregister a sibling that happens to be destroyed later in this loop.
    const shells = [...this.#shells.values()];
    this.#shells.clear();
    for (const shell of shells) {
      shell.destroy();
      logger.log("registry", "Destroyed shell");
    }
  }
}

/* ── Settle-then-adopt lifecycle ─────────────────────────────────────────
 *
 * Resolve once the container's child list has been quiet for a run of
 * consecutive quiet time, or when the cap expires - whichever comes first.
 * SDKs build their player over several microtasks/frames after the
 * <video> appears; injecting mid-build invites wholesale innerHTML wipes.
 *
 * Settle detection is a MutationObserver trailing quiet-period timer rather
 * than an rAF quiet-frame counter, so the window is frame-rate independent
 * (an 144 Hz display settles 2.4x faster than 60 Hz, and a missed frame or
 * a throttled background tab still resolves on the quiet clock).
 *
 * Both timers are scheduler.postTask handles (background-tab throttling and
 * pagehide abort are native), re-armed per mutation. An optional AbortSignal
 * additionally resolves the wait immediately - so a video removed / page
 * hidden mid-window never leaves the observer + its two timers running for
 * the full cap. The watch covers the container subtree so nested SDK builds
 * re-arm the window within the same cap.
 */
function whenDomSettled(container, { quietMs = 50, capMs = 150, signal } = {}) {
  const { promise, resolve } = Promise.withResolvers();
  let settled = false;
  let settleHandle = null;
  let capHandle = null;

  const done = () => {
    if (settled) {
      return;
    }
    settled = true;
    observer.disconnect();
    settleHandle?.abort();
    capHandle?.abort();
    // Normal settle must release the abort listener too: with `{ once: true }`
    // it only self-removes on abort, so a quiet-page settle would otherwise
    // keep the kernel-scope signal subscribed for the whole page lifetime.
    if (onAbort) {
      signal?.removeEventListener("abort", onAbort);
    }
    resolve();
  };

  const observer = new MutationObserver(() => {
    // Any mutation re-arms the trailing quiet window from scratch.
    settleHandle?.abort();
    settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
  });

  settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
  capHandle = postTask(done, { priority: "user-visible", delay: capMs });

  observer.observe(container, { childList: true, subtree: true });

  const onAbort = () => done();
  signal?.addEventListener("abort", onAbort, { once: true });

  return promise;
}

/**
 * Bridges video discovery to shell creation: the kernel calls onVideoFound /
 * onVideoRemoved directly (single listener - no bus broadcast needed) and the
 * lifecycle invokes the shell factory once the SDK's DOM has settled. Creation
 * is deferred (quiescence-capped) so the parasite overlay never lands
 * mid-build, with post-wait guards against videos that vanished or were
 * adopted meanwhile. A ready shell is handed to the onShellCreated callback
 * (the kernel's coordinator). Page-unload cleanup is owned by the kernel.
 */
export class LifecycleManager {
  #registry;
  #onShellCreated;
  /** Told which video's shell failed to come up, so the kernel can re-arm. */
  #onShellFailed;
  /** Told which video's settle completed while it was detached. The kernel
   *  keeps that fact on its removal watch: the reconnect edge must re-enter
   *  adoption, because #seenVideos still claims the video and the discovery
   *  tap has already downgraded by then. */
  #onSettleSkipped;
  #shellFactory = null;
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();
  /** Abort scope for in-flight settle waits; disposed by destroy() (pagehide). */
  #scope = new Scope();

  /**
   * @param {object} registry shell slot
   * @param {(shell: object) => void} onShellCreated ready-shell fan-out
   * @param {(video: HTMLVideoElement) => void} [onShellFailed] a boot that
   *   threw after the shell rolled itself back. The shell has already undone
   *   its DOM by then, so the video is unmarked and adoptable again - the
   *   callback decides whether to re-arm it.
   * @param {(video: HTMLVideoElement) => void} [onSettleSkipped] the settle
   *   finished with the video (or container) detached. Nothing is created,
   *   but the kernel has already claimed the video - it needs to know so the
   *   removal watch can re-adopt on reconnect.
   */
  constructor(registry, onShellCreated, onShellFailed, onSettleSkipped) {
    this.#registry = registry;
    this.#onShellCreated = onShellCreated;
    this.#onShellFailed = onShellFailed;
    this.#onSettleSkipped = onSettleSkipped;
  }

  setShellFactory(factory) {
    this.#shellFactory = factory;
  }

  async onVideoFound({ video, container, sdk }) {
    logger.log("lifecycle", `video:found - ${sdk.name}`);
    if (this.#registry.getByVideo(video)) {
      logger.log("lifecycle", "Video already has a shell, skipping");
      return;
    }
    if (!this.#shellFactory) {
      logger.error("lifecycle", "No shell factory set!");
      return;
    }
    if (this.#pending.has(video)) {
      return;
    }
    this.#pending.add(video);
    await whenDomSettled(container, { signal: this.#scope.signal });
    this.#pending.delete(video);
    // container.contains(): the video can also be moved OUT of its container
    // mid-settle (a re-parent lands inside the quiet window) while both nodes
    // stay connected - booting there would strand the host in the abandoned
    // container. Same one-shot offer as the detached case: the movedOut edge
    // has already re-anchored the watch to the new chain, so the next nearby
    // mutation re-enters adoption against the CURRENT container.
    if (!video.isConnected || !container.isConnected || !container.contains(video)) {
      logger.log("lifecycle", `${sdk.name} video left its container before settle - skipping`);
      // The claim stands (#seenVideos) and the discovery tap is downgraded,
      // so this video is unreachable unless the removal watch's reconnect
      // edge re-offers it. Hand the kernel the fact it needs for that.
      this.#onSettleSkipped?.(video);
      return;
    }
    if (this.#registry.getByVideo(video)) {
      return;
    }
    try {
      const shell = this.#shellFactory({ video, container, sdk });
      await shell?.ready;
      this.#onShellCreated(shell);
      logger.log("lifecycle", `Shell created for ${sdk.name}`);
    } catch (err) {
      logger.error("lifecycle", `Failed to create shell for ${sdk.name}:`, err);
      // The shell rolls its own DOM back before rethrowing, so the video is
      // adoptable again. Re-arm it - without this the kernel's seen-set kept
      // the video claimed forever and one transient boot throw cost that
      // player PlayerForge for the rest of the document. Re-arming is safe
      // even when the throw came from #onShellCreated rather than the boot:
      // a shell that did come up is registered and claimed, so the seen-set
      // and the registry slot still refuse it a second shell.
      this.#onShellFailed?.(video);
    }
  }

  onVideoRemoved({ video }) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.sdk.name}`);
    }
  }

  /**
   * Tear down every in-flight settle wait: the observer + its two timers die
   * immediately instead of running their full quiet/cap window after pagehide.
   * Continuations resume and hit the still-connected guards, so nothing is
   * half-created on a dying page.
   */
  destroy() {
    this.#scope.dispose();
  }
}
