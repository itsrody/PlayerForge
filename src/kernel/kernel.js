import { logger } from "../shared/diagnostics.js";
import { getConfigValue, loadJsonObject, gmSetValue, KEYS } from "../shared/storage.js";
import { setDebugRuntime } from "../shared/diagnostics.js";
import { postTask } from "../shared/scheduler.js";
import { Scope } from "../shared/scope.js";
import { DOMManager, trackScopedObserver } from "../shared/dom-manager.js";
import { resolvePlayer, fingerprintFor, meetsMinSize, watchDocumentVideos, watchMediaEvents, forEachShadowVideos } from "./sdk.js";
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
/** Learned prints remembered per hostname; oldest-learned evicted past it. */
const PRINTS_PER_HOST = 10;

/** Identity of a print for deduping: tag, depth, id and class set. */
function printKey(print) {
  if (!print || typeof print !== "object") {
    return "";
  }
  const cls = Array.isArray(print.cls) ? print.cls : [];
  return `${print.tag ?? ""}\n${print.depth ?? -1}\n${print.id ?? ""}\n${cls.join("\n")}`;
}

export class Kernel {
  #registry;
  #lifecycle;
  /** Shell-ready listeners (direct callbacks, no bus). */
  #createdListeners = new Set();
  #initialized = false;
  /**
   * Per-video session state, keyed by the element. One WeakMap entry per
   * adopted video carries the claim, the boot-retry flag, the settle-skip
   * flag, and the removal watch (observer, anchors, grace) - five Weak
   * collections before, one lookup now. Weak throughout: an adopted video
   * orphaned by an untracked removal path must not pin the element (and its
   * whole subtree) for the page's lifetime, and the entry dies with the key.
   * Never iterated; every path addresses its own video.
   */
  #sessions = new WeakMap();
  /** Unsubscribe for the shared discovery tap; dropped at pagehide. */
  #stopDiscoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  /** Kernel lifecycle scope: scoped-observer releases and removal grace
   *  timers cancel via the signal. */
  #scope = new Scope();
  /** Document-level DOM ownership: the page listeners live here instead of
   *  as bare addEventListener calls, so the census has one registry and
   *  destroy() covers them without a paired sweep. */
  #dom = new DOMManager();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

  #onPageShow = (event) => {
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    for (const shell of this.#registry.getAll()) {
      if (!shell.video.isConnected) {
        this.#sessions.get(shell.video)?.releaseClaim();
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
      // Scope first: the signal cancels pending removal-grace postTasks.
      // Then the DOM manager: the pageshow/pagehide listeners above were
      // registered under ITS signal (listen() owns the signal unconditionally),
      // so only its destroy drops them - the kernel scope never held them.
      this.#scope.dispose();
      this.#dom.destroy();
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
      (video) => this.#sessions.get(video)?.armSettleSkip()
    );
    this.#lifecycle.setShellFactory((discovery) => this.#createShell(discovery));
  }

  /** The live session for a video, minted on first adoption. */
  #sessionFor(video) {
    let session = this.#sessions.get(video);
    if (!session) {
      session = new VideoSession(video, {
        scope: this.#scope,
        adopt: (v) => this.#adoptVideo(v),
        removeShell: (v) => this.#lifecycle.onVideoRemoved({ video: v })
      });
      this.#sessions.set(video, session);
    }
    return session;
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
    // Learn from generic adoptions only: registry matches are static
    // knowledge, and learned matches are already learned. Recording what a
    // successful slow-path adoption looked like is what makes the next visit
    // fast.
    if (shell.sdk?.source === "generic") {
      this.#learnFromShell(shell);
    }
    for (const cb of this.#createdListeners) {
      try {
        cb(shell);
      } catch (err) {
        logger.error("kernel", "Shell-created listener threw:", err);
      }
    }
  }

  /** Whether the unknown-player fallback (generic + learned) may run. On
   *  unless the user opts out - the registry answers first either way. */
  #genericEnabled() {
    return getConfigValue("detection.genericPlayers", true) === true;
  }

  /**
   * The learned prints document, read once on first need rather than at
   * init: registry-only pages never pay the GM read. Shape-guarded on the
   * way in - a corrupt or foreign doc degrades to "nothing learned".
   */
  #printsDoc = null;
  #printsLoaded = false;

  #loadPrints() {
    if (!this.#printsLoaded) {
      this.#printsLoaded = true;
      const raw = loadJsonObject(KEYS.prints, null);
      this.#printsDoc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
    }
    return this.#printsDoc;
  }

  /** Prints remembered for this hostname, or []. */
  #printsForHost() {
    const doc = this.#loadPrints();
    if (!doc) {
      return [];
    }
    let hostname;
    try {
      hostname = location.hostname;
    } catch {
      return [];
    }
    const list = doc[hostname];
    return Array.isArray(list) ? list : [];
  }

  /**
   * Record a successful generic adoption as a domain-scoped print. Writes
   * only when the shape is new (repeat visits match silently without
   * churning storage), prunes oldest-learned past the per-host cap, and
   * never throws: learning is an accelerator, and a failed learn must not
   * fail the adoption it rode in on.
   */
  #learnFromShell(shell) {
    try {
      const sdk = shell.sdk;
      const video = shell.video;
      if (!sdk || !video || !sdk.container || sdk.container.nodeType !== 1 ||
          !Number.isInteger(sdk.hops)) {
        return;
      }
      const print = fingerprintFor(video, sdk.container, sdk.hops);
      const key = printKey(print);
      const doc = { ...(this.#loadPrints() ?? {}) };
      const hostname = location.hostname;
      const list = Array.isArray(doc[hostname]) ? [...doc[hostname]] : [];
      if (list.some((existing) => printKey(existing) === key)) {
        return;
      }
      list.push({ ...print, learnedAt: Date.now() });
      while (list.length > PRINTS_PER_HOST) {
        let oldest = 0;
        for (let i = 1; i < list.length; i++) {
          if ((list[i].learnedAt ?? 0) < (list[oldest].learnedAt ?? 0)) {
            oldest = i;
          }
        }
        list.splice(oldest, 1);
      }
      doc[hostname] = list;
      this.#printsDoc = doc;
      gmSetValue(KEYS.prints, doc);
    } catch (err) {
      logger.error("kernel", "Failed to learn player print:", err);
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
    this.#dom.listen(document, "pageshow", this.#onPageShow, { signal });
    this.#dom.listen(window, "pagehide", this.#onPageHide, { signal });
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
   * A shell's boot threw. The session records whether this video already
   * consumed its one post-failure retry and releases the claim for it: the
   * full-document discovery tap feeds this path one record per mutation, so
   * an unbounded re-arm would spin on a deterministically-throwing boot. The
   * second failure stays claimed with no re-offer. Re-adoption itself still
   * rides future discovery offers, exactly as before - this path only decides
   * whether the video is claimable when one arrives.
   */
  #onShellBootFailed(video) {
    this.#sessions.get(video)?.noteBootFailed();
  }

  /** Adopt the video, emit discovery and start removal watching. */
  #adoptVideo(video) {
    // Ownership is decided JS-side only: the session claim (taken below,
    // before any yield), the registry slot, and the lifecycle's pending set.
    // The SHELL_MARKER attribute the shell writes is deliberately NOT read
    // here: it is observable state (the stylesheet's :fullscreen hook, the
    // DOM's boot signal), not identity — and attributes clone. A
    // cloneNode(true) of a managed video carries the marker onto a video no
    // shell owns, and a veto on it would refuse that clone for the life of
    // the document.
    const session = this.#sessionFor(video);
    if (session.claimed) {
      return;
    }
    // One unified resolve per offer: the registry probe, the learned prints
    // and the measured fallback share a single ancestry walk inside, in
    // that priority order. The fallback runs for videos no record claims,
    // so a renamed-everything fork costs one shared scan while every known
    // SDK keeps its single lookup.
    const sdk = resolvePlayer(video, {
      prints: this.#printsForHost(),
      enabled: this.#genericEnabled()
    });
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
    session.claim();
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
    session.watchRemoval(container, sdk.hops);
    this.#downgradeDiscoveryTap();
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

/* ── VideoSession ────────────────────────────────────────────────────────
 *
 * One adopted video's whole kernel-side life: the adoption claim, the
 * post-failure retry flag, the settle-skip flag, and the removal watch
 * (observer, anchors, sentinel, grace timer). Five Weak collections before;
 * one WeakMap entry now, keyed by the element so nothing here pins a video
 * past its own lifetime. The kernel keeps policy (adopt, registry,
 * lifecycle); the session keeps state and the watch machine. Never iterated;
 * every path addresses its own video.
 */
class VideoSession {
  #video;
  /** FIRST adopt's container: the parentless fallback when re-anchoring. */
  #container = null;
  /** Kernel scope: the observer disconnects and the grace cancels with it. */
  #scope;
  /** Re-offer entry back into kernel adoption. */
  #adopt;
  /** Shell teardown entry: the lifecycle's removal path. */
  #removeShell;
  /** Claimed for a shell, or a shell attempt still in flight. */
  #claimed = false;
  /** A boot failure already consumed this video's one retry. */
  #retried = false;
  /** Settle completed while detached; the reconnect edge consumes one-shot. */
  #skipArmed = false;
  /** A removal watcher is armed; re-entry while armed is a no-op. */
  #watching = false;
  /** Pending disconnect grace canceller, or null when none is armed. */
  #graceCancel = null;
  /** Watched ancestor range, video's parent first. */
  #anchors = [];
  /** First ancestor above the watched range; null when the chain ends. */
  #sentinel = null;
  /** Current watch-depth cap: tight on first arming, max after any move. */
  #anchorDepth = MAX_REMOVAL_DEPTH;
  #observer = null;
  /** Registry release for the watch observer, or null when unarmed. */
  #watchRelease = null;

  constructor(video, { scope, adopt, removeShell }) {
    this.#video = video;
    this.#scope = scope;
    this.#adopt = adopt;
    this.#removeShell = removeShell;
  }

  get claimed() {
    return this.#claimed;
  }

  claim() {
    this.#claimed = true;
  }

  releaseClaim() {
    this.#claimed = false;
  }

  /**
   * Record a shell-boot failure. The first releases the claim so a future
   * discovery offer may retry once; the second stays claimed with no
   * re-offer. Re-adoption itself rides future offers - this only decides
   * whether the video is claimable when one arrives.
   */
  noteBootFailed() {
    if (this.#retried) {
      this.#claimed = true;
      return;
    }
    this.#retried = true;
    this.#claimed = false;
  }

  armSettleSkip() {
    this.#skipArmed = true;
  }

  consumeSettleSkip() {
    const armed = this.#skipArmed;
    this.#skipArmed = false;
    return armed;
  }

  watchRemoval(container, hops) {
    // Re-adoption after a settle-skip or a container move lands here with the
    // original watcher still armed; a second observer pair would never be
    // torn down as a pair. The session keeps the FIRST adopt's
    // container/hops: re-anchoring only reads the container as the
    // parentless fallback and the depth as a cap, both fine for the same
    // video under a new parent.
    if (this.#watching) {
      return;
    }
    this.#watching = true;
    this.#container = container;
    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    this.#anchorDepth = Number.isInteger(hops) && hops > 0
      ? Math.min(hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;
    this.#anchors.length = 0;
    this.#sentinel = null;
    this.#observer = new MutationObserver(() => this.#checkAnchors());
    // Lifetime through the registry (disconnect + unlist on scope abort or
    // stopWatching's release): the observer itself stays native so the
    // browser keeps filtering the anchor range in C++.
    this.#watchRelease = trackScopedObserver(this.#observer, "removal-watch", this.#scope.signal);
    this.#reanchorObservers();
  }

  stopWatching() {
    this.#watchRelease?.();
    this.#watchRelease = null;
    this.#observer = null;
    this.#watching = false;
    this.#graceCancel?.();
    this.#graceCancel = null;
    this.#claimed = false;
  }

  /**
   * Removal-grace tick: a scheduler.postTask handle on the kernel scope. It
   * is pure deferral - nothing about it needs timer priority - and being
   * signal-bound means pagehide (or any kernel abort) cancels every pending
   * grace without the manual sweep loop racing the page.
   */
  #scheduleGraceTimer(done) {
    const handle = postTask(done, {
      priority: "user-visible",
      delay: FRAMEWORK_TUNING.removalGraceMs,
      signal: this.#scope.signal
    });
    return () => handle.abort();
  }

  /**
   * Is the observed chain still exactly the chain that was recorded? Walks
   * the anchors then the hop beyond them against the sentinel: moving the
   * whole player subtree keeps the video's parent - and even the anchors -
   * intact while the upper range sits on a node that is no longer an
   * ancestor, so the new chain's removal never reaches the check below
   * (measured live: host still inside the detached tree at +903ms; a
   * control mutation on an observed old root destroyed it at +708ms).
   * Bounded by anchors.length + 1 (<= MAX_REMOVAL_DEPTH + 1 parentElement
   * reads): 154ns at depth 2 (the plyr/JW shape) / 244ns worst-case per
   * batch on Gecko against a 48.9ns baseline - priced only to bound a
   * correctness walk, not sold as a win.
   */
  #isChainFresh() {
    let node = this.#video.parentElement;
    const anchors = this.#anchors;
    for (let i = 0; i < anchors.length; i++) {
      if (node !== anchors[i]) {
        return false;
      }
      node = node.parentElement;
    }
    return node === this.#sentinel;
  }

  #checkAnchors() {
    const video = this.#video;
    if (!video.isConnected) {
      // One single-shot grace per disconnect; while it is pending the timer
      // owns the re-check (further removal mutations are the same fact).
      if (this.#graceCancel) {
        return;
      }
      this.#graceCancel = this.#scheduleGraceTimer(() => {
        this.#graceCancel = null;
        if (!video.isConnected) {
          this.stopWatching();
          this.#removeShell(video);
        } else {
          this.#reanchorObservers();
        }
      });
      return;
    }
    // Connected again: any pending grace is stale - the event that brought
    // the video back (or moved it) replaces the time-based re-check, so the
    // stale timer is cancelled instead of firing later against outdated
    // state, and a fresh grace (if needed) is always measured from the
    // CURRENT disconnect. Between settled events nothing is pending.
    this.#graceCancel?.();
    this.#graceCancel = null;
    // The video leaving its parent means it moved OUT of the shell's
    // container (the host is injected INTO container - inject.js:88), so
    // the live HUD is stranded over the emptied slot while the claim refuses
    // the new location for the life of the document. Measured live: video
    // moved alone -> at +799ms the host was still in the old slot, zero
    // hosts in the new location, data-pf-shell still set even after the old
    // slot died. Re-adopt: destroy the stale shell (its destroy unmarks and
    // unregisters), release the claim, run adoption against the CURRENT
    // ancestry - which legitimately refuses an unrecognisable new location
    // (sdk null) and succeeds once the page wraps the video in a player
    // again. One shell rebuild per re-parent is the accepted cost; resume
    // re-adopts its saved entry by design.
    const movedOut = video.parentElement !== this.#anchors[0];
    if (movedOut || !this.#isChainFresh()) {
      this.#reanchorObservers();
    }
    // A settle that completed while this video was detached skipped shell
    // creation but left the session claiming it - and this very reconnect
    // just cancelled the grace that would have released the claim. With the
    // discovery tap already downgraded, this edge is the only re-discovery
    // signal there is: release the claim and run adoption again (fresh
    // findSdk/size validation; a video that no longer qualifies stays
    // unclaimed and refusable). One-shot consume, so ordinary re-anchors
    // with a live shell - and boot-failed videos waiting on their media
    // event - never re-enter adoption. The movedOut branch re-adopts too,
    // so the flag is consumed on that path as well instead of staying
    // armed for a later, now redundant, offer.
    const skipEdge = this.consumeSettleSkip();
    if (movedOut) {
      this.#removeShell(video);
      this.releaseClaim();
      this.#adopt(video);
    } else if (skipEdge) {
      this.releaseClaim();
      this.#adopt(video);
    }
  }

  /**
   * Single-target consolidation: `MutationObserver.observe()` supports
   * multiple root targets natively (childList filtered in C++), so up to the
   * active depth (cap: MAX_REMOVAL_DEPTH) per-video C++ wrappers collapse to
   * one instance. The kernel scope disconnects it at pagehide - no per-video
   * bookkeeping.
   */
  #reanchorObservers() {
    // MutationObserver has no per-target unobserve(): disconnect() is the
    // only way to drop the stale roots (the previous loop called a method
    // that does not exist and threw, leaving the anchors stranded on their
    // original parents). Records dropped by the disconnect cost nothing:
    // this callback never reads the queue - every decision below is
    // re-derived from live DOM state, which was just evaluated on this
    // very call - and the next mutation lands on the re-observed roots.
    const video = this.#video;
    const observer = this.#observer;
    const anchors = this.#anchors;
    observer.disconnect();
    anchors.length = 0;
    let anchor = video.parentElement || this.#container;
    for (let depth = 0; anchor && depth < this.#anchorDepth; depth++, anchor = anchor.parentElement) {
      observer.observe(anchor, { childList: true });
      anchors.push(anchor);
    }
    this.#anchorDepth = MAX_REMOVAL_DEPTH;
    /**
     * Sentinel: the first ancestor ABOVE the watched range. MutationObserver
     * only reports mutations of the nodes it observes, so removing the
     * outermost watched anchor was a childList change on a node nobody
     * watched - no record, no checkAnchors, and the video stayed claimed
     * forever (shell, listeners, marker, session entry). When the chain
     * ends at the document `anchor` is null and there is nothing to watch.
     * Kept out of `anchors` deliberately: that array is the watched RANGE,
     * and anchors[0] means "the video's parent" to the check above.
     * Tracked in `#sentinel` too: a subtree move can leave the whole range
     * intact while the node ABOVE it is no longer an ancestor, and only a
     * recorded sentinel can notice (#isChainFresh).
     */
    if (anchor && !anchors.includes(anchor)) {
      observer.observe(anchor, { childList: true });
      this.#sentinel = anchor;
    } else {
      this.#sentinel = null;
    }
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
  // Assigned after observe() below; done() only ever runs past setup, but
  // the nullable slot (same shape as the timer handles) keeps that an
  // invariant of the declarations rather than of postTask's timing.
  let releaseSettleObserver = null;

  const done = () => {
    if (settled) {
      return;
    }
    settled = true;
    releaseSettleObserver?.();
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
  // Lifetime through the registry; done() releases below, the signal aborts
  // to the same release.
  releaseSettleObserver = trackScopedObserver(observer, "settle", signal);

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
 *
 * Discovery lifecycle phases, in order, with what aborts each:
 * probe (shared tap + boot replay, kernel scope) -> settle (whenDomSettled,
 * lifecycle scope) -> mount (factory + shell boot, shell scope; the mount
 * flight dedups overlapping offers) -> ride (registry slot, session removal
 * watch, downgraded media-event tap) -> teardown (pagehide destroys kernel,
 * lifecycle, registry and every shell). An offer may re-enter at probe any
 * number of times; mount runs at most once per container per moment.
 */
export class LifecycleManager {
  #registry;
  #onShellCreated;
  /** Told which video's shell failed to come up, so the kernel can re-arm. */
  #onShellFailed;
  /** Told which video's settle completed while it was detached. The kernel
   *  keeps that fact on the video's session: the reconnect edge must re-enter
   *  adoption, because the session still claims the video and the discovery
   *  tap has already downgraded by then. */
  #onSettleSkipped;
  #shellFactory = null;
  /** Videos with a settle wait in flight - dedups repeated discovery. */
  #pending = new Set();
  /** Containers with a shell build in flight. #pending covers the settle
   *  window, but it is deleted before the factory runs while registration
   *  only lands after ready resolves - so a second offer arriving mid-build
   *  would mount a twin. The build window is short and the factory is the
   *  only writer, hence a set of containers rather than a second pending set. */
  #mounting = new WeakSet();
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
      // The claim stands (the session holds it) and the discovery tap is
      // downgraded, so this video is unreachable unless the removal watch's
      // reconnect edge re-offers it. Hand the kernel the fact it needs for that.
      this.#onSettleSkipped?.(video);
      return;
    }
    if (this.#registry.getByVideo(video)) {
      return;
    }
    if (this.#mounting.has(container)) {
      return;
    }
    this.#mounting.add(container);
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
    } finally {
      this.#mounting.delete(container);
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
