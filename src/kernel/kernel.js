import { logger, setDebugRuntime, postTask, Scope, runSteps, Fan } from "../shared/runtime.js";
import { KEYS, watchStorageKey, setValue, getConfigValue, setConfigValue } from "../shared/store.js";
import { getDomainKey } from "../shared/page.js";
import { SHELL_MARKER, GESTURE_EVENTS, DEBUG_LOGS_KEY, DEBUG_HASH_TAG, FRAMEWORK_TUNING, TAB_COMMAND, COMMANDS } from "./contract.js";
import { resolveAdoptionHome } from "./detection.js";
import { forEachVideoInDocument, meetsMinSize, createLayoutGate, createOnScreenGate, isOnScreen, createDiscoveryTap } from "./discovery.js";

/**
 * One settle wait: resolves once the container's child list has been quiet for
 * a run of consecutive quiet time, or when the cap expires - whichever comes
 * first. Owns its observer and both timer handles as private fields.
 */
class DomSettleWait {
  #settled = false;
  #settleHandle = null;
  #capHandle = null;
  #promise;

  constructor(container, { quietMs = 50, capMs = 150, signal = null } = {}) {
    const { promise, resolve } = Promise.withResolvers();
    this.#promise = promise;
    const observer = new MutationObserver(() => {
      // Any mutation re-arms the trailing quiet window from scratch.
      this.#settleHandle?.abort();
      this.#settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    });

    // One release controller makes the abort-listener teardown native: every
    // settle path (quiet window, cap, owner abort) fires `done`, and `done`
    // heads `release.abort()` so the owner-scope listener detaches itself.
    // Manual `signal?.removeEventListener("abort", done)` would be the pair
    // §5.5 bans - and the quiet-page settle must not leave the kernel-scope
    // signal subscribed page-long, which is exactly what the release buys.
    const release = new AbortController();
    const done = () => {
      if (this.#settled) {
        return;
      }
      this.#settled = true;
      observer.disconnect();
      this.#settleHandle?.abort();
      this.#capHandle?.abort();
      release.abort();
      resolve();
    };

    this.#settleHandle = postTask(done, { priority: "user-visible", delay: quietMs });
    this.#capHandle = postTask(done, { priority: "user-visible", delay: capMs });

    observer.observe(container, { childList: true });

    signal?.addEventListener("abort", done, { once: true, signal: release.signal });
  }

  get promise() {
    return this.#promise;
  }
}

/**
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
 * the full cap.
 */
function whenDomSettled(container, options) {
  return new DomSettleWait(container, options).promise;
}

/**
 * Holds the single live shell. PlayerForge is one-shell-per-session by design,
 * and under the one-main-video scope law the kernel's adoption guard makes
 * that employment-side fact (a shell is never adopted once one is live or
 * mid-boot): register()'s displaced-destroy stays only as the backstop.
 *
 * `onEmpty` (optional) fires when the last shell leaves through unregister -
 * the DOM-status edge the kernel uses to re-arm discovery. It is not wired to
 * destroyAll(): that is a page-teardown sweep, not a live page losing a player.
 *
 * Formerly registry.js; kept as a class (not collapsed into Kernel privates)
 * because its displacement/onEmpty contract is a story of its own. The
 * multi-shell `getAll()` array face retired with the one-main-video scope law:
 * the kernel's adoption guard leaves at most one live shell, so callers read
 * `current` directly, and the exact-census pins live in the browser rows
 * (re-anchor, re-wrap, moveBefore reorder count `=== 1`).
 */
class ShellSlot {
  #current = null;
  #onEmpty;

  constructor(onEmpty) {
    this.#onEmpty = onEmpty;
  }

  /** The one-main-video adoption guard's read: is any shell live here. */
  get occupied() {
    return this.#current !== null;
  }

  /** The one live shell, or null - the scope law's ceiling is one. */
  get current() {
    return this.#current;
  }

  /**
   * Install the session's shell. The displaced-destroy is the one-main-video
   * backstop: the kernel's adoption guard refuses every later candidate while
   * a shell is live, so a displacement should never fire - but a shell that
   * slips through (a boot racing a teardown edge) is destroyed here rather
   * than silently dropped, otherwise it would be orphaned (still in the DOM
   * and removal-watched, but unreachable from the registry and so never torn
   * down). The slot is filled before destroying the displaced shell so its
   * own onDestroy -> unregister() sees a different current and neither nulls
   * the slot nor reports an empty registry.
   */
  register(shell) {
    const previous = this.#current;
    this.#current = shell;
    if (previous && previous !== shell) {
      previous.destroy();
    }
    logger.log("registry", `Shell registered: ${shell.sdk.name}`);
  }

  unregister(shell) {
    if (this.#current === shell) {
      this.#current = null;
      this.#onEmpty?.();
    }
    logger.log("registry", `Shell unregistered: ${shell.sdk.name}`);
  }

  getByVideo(video) {
    return this.#current?.video === video ? this.#current : null;
  }

  destroyAll() {
    const shell = this.#current;
    this.#current = null;
    if (shell) {
      shell.destroy();
      logger.log("registry", "Destroyed shell");
    }
  }
}

/**
 * Top-level orchestrator: watches for <video> elements, identifies the player
 * SDK, drives discovery, and owns the shell slot plus the discovery-to-shell
 * settle pipeline (former lifecycle.js, absorbed as privates).
 * Under @run-at document-start nothing pre-exists us: the kernel rides the
 * shared discovery tap (discovery.js), catching SDK-created players the moment
 * their <video> enters the DOM and readiness transitions on existing ones.
 */

/** Skyline the removal watchdog never exceeds regardless of nesting. */
const MAX_REMOVAL_DEPTH = 8;
/** Extra ancestors (beyond the matched anchor) the removal watch observes. */
const REMOVAL_DEPTH_MARGIN = 1;

/**
 * One video's removal watchdog, extracted from a per-closure Kernel private.
 * Its anchors derive from the adoption home (contract's AdoptionHome): the
 * video and container the shell was adopted with, plus the SDK's hop count,
 * all one frozen record - the same identity the shell itself stores.
 *
 * Previously the watch lived in Kernel#watchVideoRemoval as a closure machine
 * whose state - the observed anchors, the MutationObserver, the pending grace
 * - was split between a kernel-level `Map` (video -> grace-cancel) and the
 * closure's own surround variables, kept in step by hand at every path. Here
 * that state hangs on one instance: `#anchors` (what is being observed),
 * `#observer` (one instance watching up to `watchDepth` roots natively) and
 * `#graceCancel` (the pending single-shot grace).
 *
 * Lifecycle: connected mutations re-check anchor currency (a re-parent
 * re-observes); a disconnect schedules exactly ONE grace timer (further
 * mutations are the same fact while it is pending); a grace fire that still
 * finds the video detached ends the watch and removes the shell, while one
 * that finds it reconnected re-anchors. stop() is the single teardown for
 * both ends - a really-removed video and a page that is leaving - and both
 * release the seen-video pin via the owner's onStop callback.
 *
 * The re-parent branch is also the one identity seam the tree carries: the
 * kernel's onReparent callback re-resolves detection there (universal
 * container identity), and when the resolved container differs from the
 * shell's boot identity it destroys that shell and re-adopts through the
 * boot path - meaning this watch may be stopped from inside its own
 * callback. A stopped watch therefore refuses to re-observe (#reanchor
 * no-ops), so the callback's trailing re-seat can never resurrect roots
 * the stop just dropped.
 */
class RemovalWatch {
  #video;
  #container;
  #watchDepth;
  #signal;
  #onRemoved;
  #onReparent;
  #onStop;
  #anchors = [];
  #observer = new MutationObserver(() => this.#checkAnchors());
  #graceCancel = null;
  #stopped = false;

  constructor({ home, signal, onRemoved, onReparent, onStop }) {
    this.#video = home.video;
    this.#container = home.container;
    this.#onRemoved = onRemoved;
    this.#onReparent = onReparent;
    this.#onStop = onStop;
    /** Adaptive watch depth: the matched anchor + a margin, never unbounded. */
    this.#watchDepth = Number.isInteger(home.hops) && home.hops > 0
      ? Math.min(home.hops + REMOVAL_DEPTH_MARGIN, MAX_REMOVAL_DEPTH)
      : MAX_REMOVAL_DEPTH;
    this.#signal = signal;
    this.#reanchor();
  }

  /** Spec-level multi-target consolidation: `MutationObserver.observe()`
   *  accepts multiple root targets on every engine (the subtree filter runs
   *  natively), so up to `watchDepth` per-video wrappers collapse to one
   *  instance. The kernel scope disconnects it at pagehide - no per-video
   *  bookkeeping. */
  #reanchor() {
    // The re-wrap may have stopped this watch from inside the very callback
    // that called here (the kernel's destroy-readopt seam) - a stopped
    // watch refuses to observe, so no roots resurrect past their stop.
    if (this.#stopped) {
      return;
    }
    // MutationObserver has no per-target unobserve(): disconnect() is the
    // only way to drop the stale roots (the previous loop called a method
    // that does not exist and threw, leaving the anchors stranded on their
    // original parents). Records dropped by the disconnect cost nothing:
    // this callback never reads the queue - every decision below is
    // re-derived from live DOM state, which was just evaluated on this
    // very call - and the next mutation lands on the re-observed roots.
    this.#observer.disconnect();
    this.#anchors.length = 0;
    let anchor = this.#video.parentElement || this.#container;
    for (let depth = 0; anchor && depth < this.#watchDepth; depth++, anchor = anchor.parentElement) {
      this.#observer.observe(anchor, { childList: true });
      this.#anchors.push(anchor);
    }
  }

  /**
   * Removal-grace tick: a scheduler.postTask handle on the kernel scope. It
   * is pure deferral - nothing about it needs timer priority - and being
   * signal-bound means pagehide (or any kernel abort) cancels every pending
   * grace without the manual sweep loop racing the page.
   */
  #scheduleGrace(done) {
    const handle = postTask(done, {
      priority: "user-visible",
      delay: FRAMEWORK_TUNING.removalGraceMs,
      signal: this.#signal
    });
    return () => handle.abort();
  }

  /**
   * Record-shape freedom: every decision re-derives from live DOM state and
   * never reads the queued records, so a host's state-preserving move
   * (`Element.moveBefore`, live on the 159 floor in both its Element and
   * Document forms) lands as the same removed/added records a remove+insert
   * produces - the queued "removal" reads a video that is still connected,
   * the pending grace is cancelled, and the parent-equality check below
   * re-anchors onto the new chain. No per-shape code exists to get wrong.
   */
  #checkAnchors() {
    const video = this.#video;
    if (!video.isConnected) {
      // One single-shot grace per disconnect; while it is pending the timer
      // owns the re-check (further removal mutations are the same fact).
      if (this.#graceCancel) {
        return;
      }
      this.#graceCancel = this.#scheduleGrace(() => {
        this.#graceCancel = null;
        if (!video.isConnected) {
          this.stop();
          this.#onRemoved();
        } else {
          this.#reanchor();
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
    if (video.parentElement !== this.#anchors[0]) {
      // Currency crossing: the parent changed under a connected video. The
      // kernel seam may resolve a NEW SDK container here and tear this
      // watch down (with its shell) - the trailing re-observe below no-ops
      // through the stopped guard when it does.
      this.#onReparent?.();
      this.#reanchor();
    }
  }

  stop() {
    // The onStop callback (seen-pin release) must fire exactly once, and
    // the kernel-scope dispose calls stop() again at pagehide on a watch
    // the re-wrap seam already stopped.
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#observer.disconnect();
    this.#graceCancel?.();
    this.#graceCancel = null;
    this.#onStop?.();
    this.#onStop = null;
  }
}

export class Kernel {
  /** The one live shell (one-shell-per-session; see ShellSlot). */
  #registry = new ShellSlot(() => this.#onRegistryEmpty());
  /** The video whose boot is mid-settle, registry entry not yet placed - the
   *  one-main scope's other occupancy fact. Single by the same guarantee the
   *  adoption guard enforces (nothing else can pass the guard while set, so
   *  the multi-shell Set this replaced is now generality); the `finally`
   *  clear is the price of narrowing: a stranded earlier Set entry outlived
   *  the storm, a stranded slot would refuse every later candidate forever. */
  #booting = null;
  /** Shell-ready fan-out audience (one event per registration). */
  #audience = new Fan("shell");
  #initialized = false;
  // Weak: an adopted video orphaned by an untracked removal path must not
  // pin the element (and its whole subtree) for the page's lifetime.
  #seenVideos = new WeakSet();
  /** The live discovery tap (createDiscoveryTap); dropped at pagehide. */
  #discoveryTap = null;
  /** True once the full-document discovery tap has been downgraded. */
  #discoveryDowngraded = false;
  /** Lazily built observer-driven presence gates, keyed by their engine
   *  factories (createLayoutGate/createOnScreenGate), stopped with the kernel
   *  scope (see #ensureGate). */
  #gates = new Map();
  /** Kernel lifecycle scope: removal observers disconnect via defer,
   *  grace timers and settle waits cancel via the signal. The scope is the
   *  single abort owner here - the separate settle-scope this signal absorbed
   *  rode the same pagehide disposal, two controllers telling one abort
   *  story. */
  #scope = new Scope();
  /** The shell host provider, registered by the shell plugin (never imported). */
  #shellProvider = null;

  /** The debug-watch latch: the stored debug value this frame booted with, so
   *  value-neutral foreign configs writes (a remote tab editing a filter,
   *  say) never clobber the boot-time #pf-debug hash override. */
  #debugWatchLast = null;

  #onPageShow = (event) => {
    // bfcache restores report persisted. The discarded-page arm
    // (`document.wasDiscarded`) is Chromium vocabulary retired here by probe:
    // Firefox 159 exposes no wasDiscarded property in any realm, and even a
    // Chromium discard-restore is a reload (a fresh realm re-runs this script
    // and boots a fresh kernel), so there is no resurrected-realm shape to
    // reconcile. A restored document whose shell video went detached during
    // the hide is the one restore shape; the reconcile below destroys the
    // orphan and the registry-empty edge re-arms discovery.
    if (!event.persisted) {
      return;
    }
    logger.log("kernel", "Restored from bfcache - reconciling");
    this.#reconcileOrphan();
  };

  /** The one-main-video scope's recycle-page reconcile: the registry holds at
   *  most one shell, and an orphaned one (its video gone while the page sat
   *  in the bfcache) is destroyed here so the recovery scan can adopt what
   *  actually lives on the page. */
  #reconcileOrphan() {
    const shell = this.#registry.current;
    if (shell && !shell.video.isConnected) {
      this.#seenVideos.delete(shell.video);
      shell.destroy();
      logger.log("kernel", `Reconciled orphaned shell: ${shell.sdk.name}`);
    }
  }

  #onPageHide = (event) => {
    if (event.persisted) {
      return;
    }
    logger.log("kernel", "Page hiding, cleaning up");
    runSteps([
      () => {
        this.#discoveryTap?.stop();
        this.#discoveryTap = null;
      },
      // Scope first: defer disconnects every removal observer, the
      // signal cancels pending removal-grace postTasks and resolves in-flight
      // settle waits instantly (their done() disconnects the MutationObserver
      // and aborts the quiet/cap handles), and the page-level
      // pageshow/pagehide listeners drop. Shell teardown below then runs
      // with all watch machinery already dead.
      () => this.#scope.dispose(),
      () => this.#registry.destroyAll()
    ]);
  };

  /**
   * The shell plugin registers its host provider here; the framework never
   * imports the shell, it only calls the provider it was handed. Provider
   * shape: `{ create({ home, onDestroy }) -> host | Promise<host> }` - the
   * frozen adoption home (contract's AdoptionHome) is the identity record
   * the shell stores; the framework never passes bare video/container/sdk
   * refs across this seam. The async shape is the lazy-shell surface: the
   * entry's provider awaits the shell module's first import, and the boot's
   * #booting latch covers the whole wait (see #onVideoFound).
   */
  registerShellProvider(provider) {
    this.#shellProvider = provider;
  }

  /** Register a shell-ready listener directly; returns an unsubscribe. */
  onShellCreated(cb) {
    return this.#audience.subscribe(cb);
  }

  /** Register the shell then fan out to every shell-ready listener.
   *  No per-listener try/catch: native dispatch isolates listener
   *  exceptions (reported to the global, never halting the rest of the
   *  dispatch) - the per-case audit rows already watch that path. */
  #notifyShellCreated(shell) {
    this.#registry.register(shell);
    this.#audience.emit(shell);
  }

  /**
   * Bridges video discovery to shell creation (former lifecycle.js): a settle
   * wait defers creation until the SDK's DOM has quiesced (or the cap expires),
   * with post-wait guards against videos that vanished or were adopted
   * meanwhile. A ready shell is handed to #notifyShellCreated. In-flight
   * waits ride the kernel scope's signal, so pagehide disposal aborts them.
   * The adoption home rides frozen: whatever the settle costs in time, the
   * identity the shell boots with is the one adoption resolved. A boot that
   * ends without a shell is handed to #abandonBoot - the pin and the
   * downgrade were placed before the wait, and nothing else releases them.
   * The #booting latch spans the WHOLE boot now - settle AND construction -
   * because construction is async twice over on the lazy-shell shape: the
   * provider's first create awaits the shell module import, and the
   * one-main-video refusal guard (this.#registry.occupied || #booting)
   * must refuse candidates for that whole window or a second candidate
   * could pass it while the first shell is still mid-import.
   */
  async #onVideoFound({ home, watch }) {
    const { video, container, sdk } = home;
    logger.log("lifecycle", `video:found - ${sdk.name}`);
    if (this.#registry.getByVideo(video)) {
      logger.log("lifecycle", "Video already has a shell, skipping");
      return;
    }
    if (!this.#shellProvider) {
      logger.error("lifecycle", "No shell factory set!");
      return;
    }
    if (this.#booting === video) {
      return;
    }
    this.#booting = video;
    try {
      await whenDomSettled(container, { signal: this.#scope.signal });
      if (this.#scope.disposed) {
        // Pagehide disposal aborted this wait (settle rides the kernel scope's
        // signal): the guards below run inside a leaving document where
        // isConnected still reads true and the destroyed registry no longer
        // refuses, so without this the continuation booted a shell onto a page
        // the teardown had already swept.
        return;
      }
      if (!video.isConnected || !container.isConnected) {
        this.#abandonBoot(watch, `${sdk.name} video left the document before settle`);
        return;
      }
      if (this.#registry.getByVideo(video)) {
        return;
      }
      let shell = null;
      try {
        shell = await this.#createShell({ home });
        await shell?.ready;
        this.#notifyShellCreated(shell);
        logger.log("lifecycle", `Shell created for ${sdk.name}`);
      } catch (err) {
        logger.error("lifecycle", `Failed to create shell for ${sdk.name}:`, err);
        // A shell that throws mid-boot (or rejects ready - including a failed
        // shell-module import) may already have injected DOM, timers, and
        // listeners. destroy() is scope-guarded and idempotent, so it reaps
        // the partial state without double-freeing a shell that never got
        // registered.
        await shell?.destroy?.();
        // The destroy either never registered (creation threw) or just
        // emptied the registry (a registered shell whose ready rejected), so
        // #onRegistryEmpty will not fire from this failure: without the
        // release below the pin refuses every later event for this video and
        // the downgrade strands.
        this.#abandonBoot(watch);
      }
    } finally {
      // Cleared on every exit path: the guarded body may return early
      // (video or container left the document before settle), a rejected
      // wait must not strand the slot (see the field doc), and the two
      // creation outcomes (registered or abandoned) end the boot either
      // way. The latch is the one-main-video law's mid-boot half.
      this.#booting = null;
    }
  }

  /**
   * Release a boot that produced no shell. Two side effects were placed
   * before the settle wait and are stranded by every shell-less exit:
   * the seen-pin (the boot's media-event laterality - a refused adoption
   * refuses the video for its whole lifetime) and the downgraded tap
   * (consistent only with a shell that is not there). The one automatic
   * recovery edge, #onRegistryEmpty off the registry's unregister, never
   * fires for these shapes. watch.stop() is exactly-once (idempotent with
   * the scope defer and the destroy-readopt seam), then the full tap re-arms
   * when no shell holds the page: its seed walk re-runs adoption, so a
   * re-connected video re-boots without waiting for a media event the
   * downgraded tap cannot deliver. A video whose boot threw deterministically
   * re-enters this same path through the re-armed tap - event-driven and
   * settle-bounded, the recovery shape #onRegistryEmpty already rides; the
   * stranded-forever alternative is what this method exists to repair.
   * Skipped under pagehide: the scope's defers stopped every watch already,
   * and a re-armed tap would outlive the teardown.
   */
  #abandonBoot(watch, why) {
    if (why && logger.enabled) {
      logger.log("lifecycle", why);
    }
    if (this.#scope.disposed) {
      return;
    }
    watch.stop();
    if (!this.#registry.current) {
      this.#armDiscoveryTap();
    }
  }

  #onVideoRemoved(video) {
    const shell = this.#registry.getByVideo(video);
    if (shell) {
      shell.destroy();
      logger.log("lifecycle", `Shell destroyed: ${shell.sdk.name}`);
    }
  }

  init() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;
    logger.log("kernel", "Initializing kernel");
    const { signal } = this.#scope;
    runSteps([
      // Debug logs activate from the persisted menu toggle or the debug
      // hash tag (contract) - a per-load override that never writes the
      // setting, and an explicit menu "Off" wins over it. The watch below
      // mirrors later foreign-instance flips.
      () => {
        const storedDebug = getConfigValue(DEBUG_LOGS_KEY, false);
        const hashDebug = location.hash.includes(DEBUG_HASH_TAG);
        this.#debugWatchLast = storedDebug;
        if (storedDebug || hashDebug) {
          setDebugRuntime(true);
          logger.log("kernel", `Debug logs on (${[storedDebug && "setting", hashDebug && "hash"].filter(Boolean).join(" + ")})`);
        }
      },
      () => this.#armDebugWatch(),
      () => document.addEventListener("pageshow", this.#onPageShow, { signal }),
      () => window.addEventListener("pagehide", this.#onPageHide, { signal }),
      () => this.#armDiscoveryTap()
    ]);
    logger.log("kernel", "Kernel ready - discovery tap active");
  }

  /**
   * Mirror foreign-instance flips of the debug setting mid-flight. The
   * storage echo's delivery contract decides the reach: the envelope
   * dedup in watchStorageKey filters this realm's own writes by identity,
   * while every FOREIGN realm - another tab OR another frame of this tab,
   * and the extension's own popup page - delivers once. This handler sees
   * exactly the outside write: the popup's top-frame toggle reaching the
   * video embed, a remote tab's settings panel, a sibling tab's command.
   * Frames boot silent - a flip must reach them after boot, or the frame
   * stays debug-deaf ("no logs at all" degenerates into a diagnosis trap).
   * Freshness is free (the echo lands the delivered doc into the store's
   * value map before watchers run, so this read serves the fresh state)
   * and the pre-write latch from init() keeps value-neutral writes from
   * clobbering the boot-time hash override.
   */
  #armDebugWatch() {
    watchStorageKey(KEYS.configs, () => {
      const next = getConfigValue(DEBUG_LOGS_KEY, false);
      if (next === this.#debugWatchLast) {
        return;
      }
      this.#debugWatchLast = next;
      setDebugRuntime(next === true);
      logger.log("kernel", `Debug logs mirrored ${next ? "on" : "off"} from a foreign write`);
    });
  }

  /**
   * (Re)establish the full-document discovery tap and replay the videos already
   * in the parsed DOM. The probe boots us precisely so a video already present
   * gets its shell without waiting for the next media event; the media-event
   * tap still catches script-lazy SDK players that surface after boot. Called
   * at init and again whenever the last shell leaves (see #onRegistryEmpty).
   */
  #armDiscoveryTap() {
    this.#discoveryTap?.stop();
    this.#discoveryTap = createDiscoveryTap((video) => this.#adoptVideo(video));
    this.#discoveryDowngraded = false;
    // Mutations only report future changes: a host rebuild can
    // leave a new player sitting in the tree with no pending record for us.
    forEachVideoInDocument((video) => this.#adoptVideo(video));
  }

  /**
   * The last shell left the live page. A host teardown rebuild can destroy the shell and
   * insert a fresh player that never fires a media event, and the first
   * adoption had downgraded us to the media-event tap - so re-arm the full
   * document tap to hunt again. Skipped during pagehide (scope already
   * disposed) and when nothing was ever downgraded (no shell has existed).
   */
  #onRegistryEmpty() {
    if (this.#scope.disposed || !this.#discoveryDowngraded) {
      return;
    }
    logger.log("kernel", "Last shell gone - re-arming full discovery tap");
    this.#armDiscoveryTap();
  }

  /**
   * After the first successful adoption, drop the full-document discovery tap
   * (the heavier childList+subtree observer) and fall back to the cheap
   * capture-mode media-event tap. There is never a second shell to surface -
   * the one-main-video scope law refuses any later qualifying candidate - so
   * keeping the per-mutation scan alive for the whole page taxes every DOM
   * change for nothing; the media-event tap still catches a
   * script-lazy SDK player that fires loadedmetadata/loadeddata/play, so
   * discovery never goes fully quiet, and #onRegistryEmpty re-arms the full
   * tap when that shell leaves (the next candidate's adoption path).
   * Idempotent; pagehide tears the tap down.
   */
  #downgradeDiscoveryTap() {
    if (this.#discoveryDowngraded) {
      return;
    }
    this.#discoveryDowngraded = true;
    this.#discoveryTap?.stop();
    this.#discoveryTap = createDiscoveryTap((video) => this.#adoptVideo(video), { mutations: false });
  }

  /**
   * The kernel's observer-driven presence gates (layout, on-screen): each built
   * on first need from its engine factory and torn down with the kernel scope.
   * Cached per factory - the gate lives in a map keyed by the engine import
   * itself, so there is no string key to misspell (a typo'd key would silently
   * fork a second RO/IO instance) - and one instance serves every candidate
   * the page offers, in either deferral order. Returns the live gate, or null
   * once the scope is disposed, so a late adoption after pagehide has nothing
   * to wait for.
   */
  #ensureGate(create) {
    let gate = this.#gates.get(create);
    if (!gate && !this.#scope.disposed) {
      gate = create();
      this.#gates.set(create, gate);
      this.#scope.defer(() => {
        gate.stop();
        this.#gates.delete(create);
      });
    }
    return gate ?? null;
  }

  /**
   * The adoption body, in detection-resolved vocabulary: `resolveAdoptionHome`
   * freezes the identity once (the provider, the removal watch, and the
   * destroy-readopt compare all speak the same frozen record), then the
   * presence gates run. The scope guard before the gates is the one-main-video
   * law (see the block comment below), so a refused candidate never pins
   * observers.
   */
  #adoptVideo(video) {
    if (this.#seenVideos.has(video) || video.hasAttribute(SHELL_MARKER)) {
      return;
    }
    const home = resolveAdoptionHome(video);
    if (!home) {
      return;
    }
    // The one-main-video scope law, the pick policy "first-qualifying wins":
    // once any shell is live here - or one is mid-boot through the settle
    // wait, its registry entry not yet placed - later qualifying candidates
    // are refused. The guard sits after SDK identity (the refusal log names
    // the candidate) and before the presence gates, so a refused video never
    // pins a layout/on-screen observer that would keep re-entering adoption
    // for a candidate the scope law will not adopt. Recovery is the existing
    // registry-empty edge: the main's RemovalWatch destroying its shell fires
    // #onRegistryEmpty, re-arms the full discovery tap, and its seed walk plus
    // the media tap re-run adoption so the next qualifying candidate wins.
    if (this.#registry.occupied || this.#booting != null) {
      if (logger.enabled) {
        logger.log("kernel", `${home.sdk.name} candidate refused - one main video per page (a shell is live or booting)`);
      }
      return;
    }
    if (!meetsMinSize(video)) {
      // Not player-sized yet: a one-shot rect here would strand the video
      // forever unless an unrelated media event re-ran adoption. The layout
      // gate re-enters this method the moment the delivered box qualifies
      // (RO callbacks run off the mutation batch, with layout already fresh,
      // and the size is read from the observation rather than a fresh reflow).
      this.#ensureGate(createLayoutGate)?.watch(video, () => this.#adoptVideo(video));
      return;
    }
    // Player-sized but off-screen (a carousel slide, a below-the-fold embed):
    // defer the shell until the lookahead intersection, so a page of embeds
    // does not boot a full shell for a video the user cannot see. isOnScreen
    // reports true when the viewport is unknown, so this can only delay.
    if (!isOnScreen(video)) {
      this.#ensureGate(createOnScreenGate)?.watch(video, () => this.#adoptVideo(video));
      return;
    }
    // No container guard: the record schema resolves the container to the
    // matched element itself whenever `host` is undeclared (the current
    // records' state), and the host branch falls back to the same element
    // when its selector misses - detection never answers a match without a
    // container element.
    this.#seenVideos.add(video);
    // Guarded like the logger contract promises: with chatter off (the
    // default), the dimensions/duration interpolation never runs - a disabled
    // log call must cost one boolean read, not a template build.
    if (logger.enabled) {
      logger.log("kernel", `${home.sdk.name} adopted (${video.videoWidth}x${video.videoHeight}, ${Math.round(video.duration)}s)`);
    }
    this.#onVideoFound({ home, watch: this.#watchVideoRemoval(home) });
    this.#downgradeDiscoveryTap();
  }

  /** Hand per-video removal watching to its one stateful owner and return
   *  the watch, so the boot it accompanies can release the seen-pin through
   *  an abandoned exit (#abandonBoot) - the pin is added before the settle
   *  wait, and this watch's onStop is its only release. */
  #watchVideoRemoval(home) {
    let watch = null;
    watch = new RemovalWatch({
      home,
      signal: this.#scope.signal,
      onRemoved: () => this.#onVideoRemoved(home.video),
      onReparent: () => this.#onRewrap(watch, home.video),
      onStop: () => this.#seenVideos.delete(home.video)
    });
    // Chromium-native single-target consolidation and the timer are both
    // handled inside the watch; the kernel scope is its pagehide backstop.
    this.#scope.defer(() => watch.stop());
    return watch;
  }

  /**
   * Universal container identity, the re-parent seam: the watch's
   * parent-equality check surfaced a live re-home, so identity re-resolves
   * through the same detection the adoption ran (the parent-stamped
   * descriptor cache invalidates exactly on this parent change), landing in
   * a NEW AdoptionHome while the live shell still reads its frozen boot
   * record. One decision rule, from the ShellSlot doctrine: container
   * identity is a shell-lifetime fact and a displaced shell is destroyed,
   * never re-seated - so a DIFFERENT resolved container stops this watch,
   * tears the boot-identity shell down (destroy rolls back every managed
   * marker, so nothing blocks the rebuild), and re-adopts through the
   * existing boot path at the new home. The equality shape - the pinned
   * moveBefore re-home onto a bare stage - resolves the same container and
   * falls out the comparison untouched. An unresolvable video (the full SDK
   * context left the composed ancestry - the re-resolve answers null) stands
   * on the boot identity: the adoption contract says
   * no SDK anchor means no shell, but there is no matching mid-flight
   * teardown contract, and the move may reverse.
   */
  #onRewrap(watch, video) {
    const shell = this.#registry.getByVideo(video);
    if (!shell) {
      return;
    }
    const redetected = resolveAdoptionHome(video);
    const container = redetected?.container ?? null;
    if (!container || container === shell.container) {
      return;
    }
    logger.log("lifecycle", `${redetected.sdk.name} re-wrapped: container identity changed - destroy-readopt`);
    watch.stop();
    shell.destroy();
    this.#adoptVideo(video);
  }

  async #createShell({ home }) {
    // The provider is guaranteed present - #onVideoFound checks and reports
    // before reaching here, and this is a private method with one caller.
    // The provider's create is allowed to be async (the shell is lazy-loaded
    // on first confirmed adoption: the module import rides the boot), so the
    // awaited shape is the provider contract at this seam.
    const shell = await this.#shellProvider.create({
      home,
      onDestroy: () => this.#registry.unregister(shell)
    });
    return shell;
  }

  /**
   * The shell host one-shot menu commands act on: the one live shell (the
   * one-main-video scope law leaves at most one). Null when no shell is live
   * here.
   */
  menuShellHost() {
    return this.#registry.current?.shellHost ?? null;
  }

  /**
   * The frame-local kernel half of the diagnostics dump (installFrameDiagnostics
   * composes the page half outside): kernel-owned state read synchronously at
   * dump time - the one live shell's SDK name and the mid-boot latch.
   */
  diagnosticSnapshot() {
    return {
      shell: this.#registry.current?.sdk?.name ?? null,
      booting: this.#booting != null
    };
  }

  /**
   * The debug toggle (MenuCommands, same kernel reference as menuShellHost)
   * reports its flip so the watch latch tracks the fresh stored value - a
   * later foreign echo of this doc must read value-neutral and never
   * re-mirror our own flip.
   */
  noteDebugFlip(value) {
    this.#debugWatchLast = value === true;
  }

  /**
   * Toggle the active shell's panel from outside the input stack (GM menu).
   * Warns unconditionally when nothing can host a panel - the user clicked
   * something and must know why nothing happened.
   */
  togglePanel() {
    const host = this.menuShellHost();
    if (!host) {
      logger.warn("kernel", "Panel toggle requested but no player is active on this page");
      return;
    }
    host.dispatchEvent(new CustomEvent(GESTURE_EVENTS.panel, {
      detail: { method: "menu" }
    }));
  }
}

/**
 * The frame-state dump itself: one console line per script realm, and the
 * whole field-triage surface. It exists because the fs-ui field loop burned
 * about ten console probes on one question - "which document is the
 * player's state in?" - that one popup tap answers for every realm at
 * once, no devtools frame-context dance. logger.warn (not log) carries it:
 * warn is not debug-gated, and the dump MUST land on a stock install
 * without debug mode - that gate is the surface's reason to exist.
 * Composition: page facts here, kernel facts through the same lazy
 * resolver the commands ride (kernel boots after eval; a video-less host
 * frame still dumps - "shell:null, videos:0" is itself the diagnosis).
 * Also exported for the debug sentinel (the console twin of the popup's
 * dump command - a debug-mode boot can answer "which document holds the
 * player's state" without the popup).
 */
export function dumpFrameState(resolveKernel) {
  const videos = [];
  forEachVideoInDocument((video) => {
    const home = resolveAdoptionHome(video);
    videos.push({
      sdk: home?.sdk.name ?? null,
      size: meetsMinSize(video),
      screened: isOnScreen(video)
    });
  });
  const snapshot = resolveKernel?.()?.diagnosticSnapshot?.() ?? null;
  const record = {
    realm: window.top === window ? "top" : "frame",
    domain: getDomainKey(location.hostname),
    fsEl: document.fullscreenElement?.tagName.toLowerCase() ?? null,
    debug: logger.enabled,
    videos,
    shell: snapshot?.shell ?? null,
    booting: snapshot?.booting === true
  };
  logger.warn("diag", JSON.stringify(record));
  // The record returns so the caller decides the surface (the warn line is
  // the console twin's own write; the debug handle's arm JSON-serializes
  // this return, the only shape that crosses a compartment boundary).
  return record;
}

/**
 * Install the diagnostics responder: the pf:diag echo listener, per realm.
 * The watch contract filters own-write echoes, so the originating top frame
 * dumps directly in its command click and every OTHER instance of this
 * script - another tab OR another frame, the same reach the settings bus already
 * rides - answers on the echo. Page-lifetime install like the frame bridge:
 * the returned stop is never consumed, and a real unload disposes with it.
 */
export function installFrameDiagnostics(resolveKernel = null) {
  watchStorageKey(KEYS.diag, () => dumpFrameState(resolveKernel));
}

/** BrowserAction command wiring, owned at the kernel layer instead of
 *  inside the Kernel so the command surface exists from script eval - not
 *  just after a video is discovered. The debug toggle works fully without a
 *  kernel: it persists the setting and flips the shared debug runtime (the
 *  console log flag). The one-shot reset commands need a live shell,
 *  resolved lazily through the entry's kernel reference at command time
 *  (the kernel boots after eval). The popup (dist/popup.js) sends
 *  TAB_COMMAND messages; this receiver answers them. One instance owns the
 *  surface; the debug toggle answers its fresh state so the popup's row
 *  relabels in place. */
class TabCommands {
  /** () -> kernel: the entry keeps the kernel reference for commands to
   *  resolve their target shell host at command time. */
  #resolveKernel = null;
  /** The message-surface teardown, owned so install stays idempotent. */
  #teardown = null;

  constructor(resolveKernel = null) {
    this.#resolveKernel = resolveKernel ?? null;
  }

  #hostFor(label) {
    const kernel = this.#resolveKernel?.();
    const host = kernel?.menuShellHost?.() ?? null;
    if (!host) {
      logger.warn("kernel", `${label} requested but no player is active on this page`);
    }
    return host;
  }

  #resetEvent(eventKey, label) {
    const host = this.#hostFor(label);
    if (host) {
      host.dispatchEvent(new CustomEvent(GESTURE_EVENTS[eventKey], {
        detail: { method: "extension" }
      }));
    }
    return host != null;
  }

  /** The debug toggle flips the stored setting and the shared runtime; the
   *  storage echo (foreign realms) and the popup's own return value carry
   *  the result. Returns the fresh state so the popup relabels without a
   *  second query. */
  #toggleDebug() {
    const next = !getConfigValue(DEBUG_LOGS_KEY, false);
    setConfigValue(DEBUG_LOGS_KEY, next);
    this.#resolveKernel?.()?.noteDebugFlip?.(next);
    setDebugRuntime(next);
    return next;
  }

  install() {
    // The command surface is the browserAction popup's: this receiver is
    // TOP-FRAME ONLY (the popup acts on the active tab's top document, the
    // same reach the userscript's top-frame-only menu registration had).
    // The commands exist from script eval - they do not wait for video
    // discovery - so a page without a supported player still answers the
    // popup (the resets answer false, the popup toasts "no player active").
    if (window.top !== window) {
      return () => {};
    }
    const listener = (message) => {
      if (message?.type !== TAB_COMMAND) {
        return undefined;
      }
      switch (message.command) {
        case COMMANDS.debugToggle:
          return Promise.resolve(this.#toggleDebug());
        case COMMANDS.debugQuery:
          return Promise.resolve(getConfigValue(DEBUG_LOGS_KEY, false) === true);
        case COMMANDS.diag:
          // The consumers are every instance of this script through the
          // pf:diag echo; the watch filters own writes, so the originator
          // reports itself here and the echo brings every other realm in -
          // one click, one console line per frame.
          setValue(KEYS.diag, crypto.randomUUID());
          dumpFrameState(this.#resolveKernel);
          return undefined;
        case COMMANDS.filterReset:
          return Promise.resolve(this.#resetEvent("filterReset", "Color filter reset"));
        case COMMANDS.syncReset:
          return Promise.resolve(this.#resetEvent("syncReset", "Subtitle sync reset"));
        default:
          return undefined;
      }
    };
    browser.runtime.onMessage.addListener(listener);
    this.#teardown = () => browser.runtime.onMessage.removeListener(listener);
    return () => this.#teardown?.();
  }
}

export function installTabCommands(resolveKernel = null) {
  return new TabCommands(resolveKernel).install();
}
