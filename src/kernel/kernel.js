import { logger } from "../shared/diagnostics.js";
import { getConfigValue } from "../shared/storage.js";
import { setDebugRuntime } from "../shared/diagnostics.js";
import { postTask } from "../shared/scheduler.js";
import { Scope } from "../shared/scope.js";
import { ShellRegistry } from "./registry.js";
import { LifecycleManager } from "./lifecycle.js";
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
