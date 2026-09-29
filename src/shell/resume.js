import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { TUNING } from "../shared/tuning.js";
import { KEYS, gmSetValue, loadJsonObject, gmAddValueChangeListener, gmRemoveValueChangeListener } from "../shared/storage.js";
import { formatTime } from "../shared/primitives.js";
import { logger } from "../shared/diagnostics.js";
import { Scope } from "../shared/scope.js";
import { createActivity } from "../shared/activity.js";

/** Sort entries by updatedAt - ascending (oldest-first, for eviction) or
 *  descending (newest-first, for history display). */
function sortByUpdatedAt(entries, descending = false) {
  return [...entries].sort((a, b) => {
    const diff = (a.updatedAt || 0) - (b.updatedAt || 0);
    return descending ? -diff : diff;
  });
}

// Hoisted TUNING.resume.* scalars: mutation-free calibration, so the JIT
// folds them as invariants on the media-clock path rather than re-resolving the
// deep TUNING chain on every timeupdate/save decision.
const RESUME_STALE_DAYS = TUNING.resume.staleDays;
const RESUME_MAX_ENTRIES = TUNING.resume.maxEntries;
const RESUME_DURATION_FUZZ = TUNING.resume.durationFuzz;
const RESUME_MIN_POSITION = TUNING.resume.minPosition;
const RESUME_SAVE_EPSILON_S = TUNING.resume.saveEpsilonSeconds;
const RESUME_COMPLETION_RATIO = TUNING.resume.completionRatio;
// NOTE: saveIntervalMs is deliberately NOT hoisted - tests mutate
// TUNING.resume.saveIntervalMs at runtime to set the wall floor, so it must
// stay a live object read on the save-decision path.

/**
 * LWW merge of foreign entries into memory. Unknown ids join the store;
 * known ids keep whichever side carries the newer updatedAt. Known entries
 * are updated IN PLACE so trackers holding references stay live.
 *
 * Only known resume-entry fields are copied to prevent field injection from
 * cross-tab or import sources with extra properties.
 */
const RESUME_ENTRY_FIELDS = new Set([
  "id", "domain", "path", "title", "duration", "resume",
  "createdAt", "updatedAt", "pending"
]);

function isValidStore(raw) {
  return raw && typeof raw === "object" && Array.isArray(raw.entries);
}

/**
 * Project any incoming entry (disk, cross-tab, import, our own literal)
 * onto the fixed whitelist so every in-memory entry carries the same keys.
 * Foreign writers omit optional fields, which used to hand the JIT a new
 * object shape per adopted entry and deoptimize every store scan over them.
 */
function toFixedShape(incoming) {
  const out = {};
  for (const key of RESUME_ENTRY_FIELDS) {
    out[key] = incoming[key];
  }
  return out;
}

/**
 * Persistent store of per-video entries (keyed by path+duration hash) holding
 * the resume position. Owned by ResumeTracker; per-entry last-write-wins
 * merging keeps concurrent shells/tabs - and any future whole-blob transport -
 * converging without clobbering each other's entries.
 */
export class ResumeStore {
  #state = null;
  #loaded = false;
  #listenerId = null;
  #listeners = new Set();
  /** Lazily built path -> entries buckets for findMatch; nulled at every
   *  structural mutation so a stale bucket can never serve a match. */
  #byPath = null;

  /**
   * Subscribe to store changes. The callback receives a `structural` flag -
   * true when the entry SET changed (create/remove/import/cross-tab merge),
   * false for pure position/timestamp updates. Returns an unsubscribe fn.
   * Consumers that snapshot the whole list (History) re-render on structural
   * changes only; position-only persists stay invisible to them.
   */
  onChange(cb) {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  #notify(structural = false) {
    for (const cb of this.#listeners) {
      cb(structural);
    }
  }

  constructor() {
    // Live reload across tabs: whoever writes pf:resume elsewhere triggers a
    // merge-only adoption here (never written back - the writer owns that
    // round trip). This is also the seam where a future value-sync transport
    // would land for free.
    //
    // Two costs are cut here without weakening the merge:
    //  - `remote === false` marks OUR OWN write echoing back through the
    //    manager. The in-memory store is by definition already that value, so
    //    re-reading + re-merging it would be a pure duplicate parse per save.
    //    Anything remote (or any implementation that omits the flag) still
    //    adopts exactly as before.
    //  - when the change does carry the new value, it is merged straight from
    //    the listener argument instead of paying a second GM read + parse.
    this.#listenerId = gmAddValueChangeListener(KEYS.resume, (_name, _old, value, remote) => {
      if (remote === false) {
        return;
      }
      this.#adoptExternal(value);
    });
  }

  /** Release the cross-tab change subscription (shell teardown). */
  destroy() {
    gmRemoveValueChangeListener(this.#listenerId);
    this.#listenerId = null;
    this.#listeners.clear();
  }

  /** Merge an external store. `value` is the listener's own new value when it
   *  supplied one (saves a GM read + parse); falling back to a direct read
   *  keeps implementations that pass nothing working unchanged. */
  #adoptExternal(value) {
    if (!this.#loaded) {
      return;
    }
    const raw = isValidStore(value) ? value : loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      const { added, updated } = this.#mergeRaw(raw);
      if (added || updated) {
        this.#notify(true);
      }
    }
  }

#mergeRaw(raw) {
  let added = 0;
  let updated = 0;
  const byId = new Map();
  for (const entry of this.#state.entries) {
    byId.set(entry.id, entry);
  }
  for (const incoming of raw.entries) {
    if (!incoming || typeof incoming !== "object" || typeof incoming.id !== "string") {
      continue;
    }
    const known = byId.get(incoming.id);
    if (!known) {
      const shaped = toFixedShape(incoming);
      byId.set(incoming.id, shaped);
      added++;
    } else if ((incoming.updatedAt || 0) > (known.updatedAt || 0)) {
      for (const key of RESUME_ENTRY_FIELDS) {
        if (key in incoming) {
          known[key] = incoming[key];
        }
      }
      updated++;
    }
  }
  if (added === 0 && updated === 0) {
    return { added, updated };
  }
  this.#state.entries = [...byId.values()];
  this.#invalidateCaches();
  return { added, updated };
}

  /** Drop lazy lookup state; called after every structural entries change. */
  #invalidateCaches() {
    this.#byPath = null;
  }

  #buildByPath() {
    const map = new Map();
    for (const entry of this.#state.entries) {
      const bucket = map.get(entry.path);
      if (bucket) {
        bucket.push(entry);
      } else {
        map.set(entry.path, [entry]);
      }
    }
    this.#byPath = map;
    return map;
  }

  ensureLoaded() {
    if (this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      // Tolerate foreign or future writers: adopt their entries as-is and
      // restamp our schema version - resetting would destroy history. Each
      // adopted entry is projected onto the fixed whitelist shape.
      const valid = [];
      for (const entry of raw.entries) {
        if (entry && typeof entry === "object" && typeof entry.id === "string") {
          valid.push(toFixedShape(entry));
        }
      }
      if (valid.length !== raw.entries.length) {
        logger.warn("resume", `Dropped ${raw.entries.length - valid.length} malformed entries`);
      }
      this.#state = { ...raw, version: 1, entries: valid };
    } else {
      this.#state = { version: 1, entries: [] };
      gmSetValue(KEYS.resume, this.#state);
      logger.warn("resume", "Resume store missing or corrupt - reset");
    }
    const stalePending = this.#state.entries.filter((entry) => entry.pending).length;
    if (stalePending) {
      this.#state.entries = this.#state.entries.filter((entry) => !entry.pending);
      this.#state.updatedAt = Date.now();
      gmSetValue(KEYS.resume, this.#state);
      logger.log("resume", `Dropped ${stalePending} stale pending entries`);
    }
    this.#invalidateCaches();
    this.#loaded = true;
  }

  /**
   * Store-level invariants over the current entries: age pruning plus the
   * hard entry cap (oldest evicted). Returns a fresh array; callers assign.
   */
  #enforceBounds(days = RESUME_STALE_DAYS) {
    const entries = this.#state.entries;
    if (entries.length <= RESUME_MAX_ENTRIES) {
      const cutoff = Date.now() - days * 86400000;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].updatedAt <= cutoff) {
          return entries.filter((e) => e.updatedAt > cutoff);
        }
      }
      return entries;
    }
    const cutoff = Date.now() - days * 86400000;
    const kept = entries.filter((entry) => entry.updatedAt > cutoff);
    kept.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return kept.slice(kept.length - RESUME_MAX_ENTRIES);
  }

  #persist(structural = false) {
    try {
      const raw = loadJsonObject(KEYS.resume, null);
      if (isValidStore(raw)) {
        this.#mergeRaw(raw);
      }
      // Bounds run AFTER the (cross-tab) merge so a stale disk copy can never
      // resurrect pruned entries - cleanup converges instead of oscillating.
      this.#state.entries = this.#enforceBounds();
      this.#invalidateCaches();
      this.#state.updatedAt = Date.now();
      gmSetValue(KEYS.resume, this.#state);
      this.#notify(structural);
    } catch (err) {
      logger.error("resume", "Failed to persist resume store:", err);
    }
  }

  findMatch(domainKey, path, duration) {
    this.ensureLoaded();
    // Path bucket first: stores hold hundreds of distinct paths, so the
    // domain/fuzz scoring below usually runs over 1-2 candidates instead of
    // the whole entry list.
    const candidates = (this.#byPath || this.#buildByPath()).get(path);
    if (!candidates) {
      return null;
    }
    const targetDuration = Number(duration) || NaN;
    const maxFuzz = RESUME_DURATION_FUZZ;
    let best = null;
    let bestScore = -Infinity;
    for (const entry of candidates) {
      if (entry.pending || !domainsMatch(entry.domain, domainKey)) {
        continue;
      }
      const fuzz = Math.abs(entry.duration - targetDuration);
      if (fuzz > maxFuzz || Number.isNaN(fuzz)) {
        continue;
      }
      const score = 4000000 + domainScore(entry.domain, domainKey) * 1000 - Math.min(fuzz, 999);
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  }

  createEntry(domainKey, path, title, duration) {
    this.ensureLoaded();
    const id = hashEntry(domainKey, path, duration);
    // The id is only a cache key - trust it solely when the domain agrees.
    // Legacy ids (hashed without domain) and true collisions fall through to
    // findMatch, which is domain-aware, so old stores keep matching.
    const existingById = this.#state.entries.find((entry) => entry.id === id);
    if (existingById && domainsMatch(existingById.domain, domainKey)) {
      return existingById;
    }
    const existingByMatch = this.findMatch(domainKey, path, duration);
    if (existingByMatch) {
      return existingByMatch;
    }
    const entry = toFixedShape({
      id,
      domain: domainKey,
      path,
      // NFC so stored titles compare equal regardless of source encoding.
      title: (title || "").normalize("NFC"),
      duration: Number(duration) || NaN,
      resume: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    this.#state.entries.push(entry);
    this.#invalidateCaches();
    this.#persist(true);
    return entry;
  }

  updateResume(id, position) {
    this.ensureLoaded();
    const entry = this.#state.entries.find((candidate) => candidate.id === id);
    if (entry) {
      // No-op guard: an identical write (paused at the same position, a
      // completion-reset 0 again, resetEntry on an already-zero entry) skips
      // the disk read + merge + serialize entirely instead of churning GM
      // storage every tick.
      if (entry.resume === position) {
        return;
      }
      entry.resume = position;
      entry.updatedAt = Date.now();
      this.#persist();
    }
  }

  getEntries() {
    this.ensureLoaded();
    return sortByUpdatedAt(this.#state.entries, true);
  }

  removeEntry(id) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#state.entries.filter((entry) => entry.id !== id);
    if (this.#state.entries.length < before) {
      this.#invalidateCaches();
      this.#persist(true);
    }
  }

  cleanStale(days = RESUME_STALE_DAYS) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#enforceBounds(days);
    const removed = before - this.#state.entries.length;
    if (removed > 0) {
      this.#invalidateCaches();
      this.#persist(true);
      logger.log("resume", `Pruned ${removed} resume entries`);
    }
  }

  /** Whole-store JSON snapshot for the clipboard bridge and backups. */
  exportData() {
    this.ensureLoaded();
    return JSON.stringify(this.#state);
  }

  /**
   * Merge a previously exported JSON document via LWW. Returns
   * {added, updated} counts, or null when the text is not a data document.
   */
  importData(text) {
    this.ensureLoaded();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isValidStore(raw)) {
      return null;
    }
    const result = this.#mergeRaw(raw);
    if (result.added || result.updated) {
      this.#persist(true);
    }
    return result;
  }
}

/**
 * Shell-owned playback tracker: persists progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 * Saves are media-clock driven, and the clock only ticks while the playhead
 * advances - so the `timeupdate` listener lives inside a playback activity,
 * alongside an immediate flush of the last rendered frame on the exit edge
 * (pause/ended/emptied), a `seeked` save while paused, and a final flush on
 * destroy.
 */
export class ResumeTracker {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  /** Every media listener this tracker attaches dies with this signal; the
   *  off-screen save observer disconnects through it as well. */
  #scope = new Scope();
  /** Eagerly resolved context promise — kicked off in the constructor. */
  #contextPromise;
  #lastSavedPosition = 0;
  /** Wall-clock floor for persists - keeps the write cadence bounded. */
  #lastSavedWall = 0;
  /** Pending rVFC id from the pause flush; cancelled in destroy() so a
   *  queued final-save callback can never fire into a dead shell. */
  #rvfcHandle = null;

  constructor(shell) {
    this.#shell = shell;
    // Kick off context resolution eagerly so the cross-origin bridge request
    // (if any) runs in parallel with DOM injection and metadata loading.
    // For top frames this resolves synchronously; for iframes it parallelizes
    // the postMessage round-trip with the shell construction window.
    this.#contextPromise = getPageContext();
    // Warm the store from GM storage now so the read happens during the
    // shell construction + paint window, not sequentially in #init().
    this.#store.ensureLoaded();
    this.#init().catch((err) => logger.error("resume", "Init failed:", err));
  }

  async #init() {
    const shell = this.#shell;
    const context = await this.#contextPromise;
    if (!context) {
      logger.log("resume", "Top context unavailable - skipping");
      return;
    }
    if (!(await this.#waitForDuration()) || !this.#adoptEntry(context)) {
      return;
    }
    this.#startProgressWatch(shell);
  }

  /**
   * Resolve once the element reports a finite duration - purely event-driven:
   * loadedmetadata / durationchange / error settle the wait, and destroy
   * aborts the scope (which both resolves it and drops the media listeners).
   * Returns false when the caller must give up (destroyed / detached / no
   * duration), so first discovery and swap re-adoption share one wait with no
   * wall-clock deadline: a slow source is adopted whenever its metadata
   * actually arrives instead of being abandoned at a cap.
   */
  async #waitForDuration() {
    const shell = this.#shell;
    const video = shell.video;
    if (Number.isFinite(video.duration) && video.duration > 0) {
      return true;
    }
    // Resolving twice is a no-op, so racing media events against destroy is safe.
    const { signal } = this.#scope;
    const { promise: metadataReady, resolve: resolveMetadata } = Promise.withResolvers();
    const finishWaiting = () => resolveMetadata();
    const onDurationChange = () => {
      if (video.duration && isFinite(video.duration)) {
        finishWaiting();
      }
    };
    const onLoaded = () => finishWaiting();
    const onError = () => finishWaiting();
    signal.addEventListener("abort", finishWaiting, { once: true });
    video.addEventListener("loadedmetadata", onLoaded, { signal });
    video.addEventListener("durationchange", onDurationChange, { signal });
    video.addEventListener("error", onError, { signal });
    await metadataReady;
    if (this.#scope.disposed) {
      logger.log("resume", "Shell destroyed before metadata - skipping");
      return false;
    }
    if (!video.isConnected) {
      logger.log("resume", "Video detached before metadata - skipping");
      return false;
    }
    if (!(Number.isFinite(video.duration) && video.duration > 0)) {
      logger.log("resume", "No duration available - skipping");
      return false;
    }
    return true;
  }

  /**
   * Bind the tracker to the entry for `context` at the media's CURRENT
   * duration: match-or-create, resume-seek when that entry carries a saved
   * position, reseed the save gates. Runs once per tracker - a player the
   * page swaps out gets a new shell, and a new shell adopts against its own
   * (path, duration) entry.
   */
  #adoptEntry(context) {
    const shell = this.#shell;
    const duration = Number(shell.video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      logger.log("resume", "No duration available - skipping");
      return false;
    }

    this.#store.cleanStale();
    const match = this.#store.findMatch(context.domain, context.path, duration);
    if (match) {
      this.#entry = match;
      // One pair of branches per adopted resource (boot + each swap); guarded
      // so the default (chatter off) never builds the templates.
      if (logger.enabled) {
        logger.log("resume", `Matched ${match.id} - resume at ${match.resume}s`);
      }
    } else {
      this.#entry = this.#store.createEntry(context.domain, context.path, context.title, duration);
      if (logger.enabled) {
        logger.log("resume", `Created ${this.#entry.id} for ${context.domain}${context.path}`);
      }
    }

    const savedPosition = Number(this.#entry.resume) || NaN;
    if (savedPosition > RESUME_MIN_POSITION) {
      // Seek immediately — the browser buffers from the target position in the
      // background. No need to wait for `canplay` (which requires buffered
      // data) since seeking is safe at metadata time and the user sees the
      // jump as soon as duration is known.
      shell.media.seekTo(savedPosition);
      shell.toastAction("resume", `Resumed at ${formatTime(savedPosition)}`, "resume", [{
        icon: "reload",
        title: "Start over",
        onClick: () => {
          this.#lastSavedPosition = 0;
          shell.media.seekTo(0);
        }
      }]);
    }

    this.#lastSavedPosition = Number.isFinite(savedPosition) ? savedPosition : (shell.currentTime || NaN);
    return true;
  }

  /** Save gate: an entry-less tracker never writes. */
  #saveProgress(currentTime) {
    if (!this.#entry) {
      return;
    }
    const entry = this.#entry;
    if (Math.abs(currentTime - this.#lastSavedPosition) < RESUME_SAVE_EPSILON_S) {
      return;
    }
    this.#lastSavedPosition = currentTime;
    // Every persist resets the cadence floor so the timeupdate path's
    // wall gate starts counting from real writes (including flushes).
    this.#lastSavedWall = Date.now();
    if (entry.duration > 0 && currentTime / entry.duration >= RESUME_COMPLETION_RATIO) {
      entry.resume = 0;
      this.#store.updateResume(entry.id, 0);
      return;
    }
    this.#store.updateResume(entry.id, currentTime);
  }

  #startProgressWatch(shell) {
    const video = shell.video;
    const { signal } = this.#scope;
    // Seed the floor at watch start so the first qualifying persist lands where
    // the old interval's first tick used to - byte-identical cadence. The
    // position gate is seeded from the saved position earlier in #init.
    this.#lastSavedWall = Date.now();

    // Position alone does not bound write frequency - a fast-forward or scrub
    // trips the epsilon every ~3 s of content - so the wall floor keeps the
    // incremental cadence where the old interval put it (≤1 write per
    // saveIntervalMs). The exit flush is fully immediate, so the "pause to
    // pause" contract still lands the final position regardless of the floor.
    const saveIfDue = () => {
      if (shell.paused || Date.now() - this.#lastSavedWall < TUNING.resume.saveIntervalMs) {
        return;
      }
      this.#saveProgress(shell.currentTime);
    };
    // Gate persistent saves while the player scrolls out of the viewport
    // (carousel / off-screen embeds): an IntersectionObserver drives a
    // layout-free "is this player on screen" boolean, so the media-clock saves
    // stop churning GM storage writes for a video the user cannot see. The
    // pause flush above still runs whenever playback actually pauses, so the
    // final position is never lost by this gate. IntersectionObserverInit has
    // no `signal` member, so the observer registers its disconnect with the
    // scope - otherwise a shell torn down while the element stays in the page
    // (a player the page moves rather than removes) would leak the observer +
    // target for the rest of the page lifetime.
    let onScreen = true;
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
      });
      io.observe(video);
      this.#scope.onDispose(() => io.disconnect());
    }
    const gatedSaveIfDue = () => {
      if (onScreen) {
        saveIfDue();
      }
    };
    // The media clock is the save crank, but it only ticks while the playhead
    // advances - so it belongs to the playback activity and is torn down on the
    // exit edge rather than idling through a pause. Whatever the clock cannot
    // cover while stopped is handled by the exit flush and the seeked save
    // below.
    createActivity({
      target: video,
      events: ["play", "playing", "pause", "ended", "emptied"],
      isActive: () => !shell.paused,
      signal,
      onEnter: (work) => {
        video.addEventListener("timeupdate", gatedSaveIfDue, { signal: work.signal, passive: true });
      },
      onExit: () => this.#flushProgress(video)
    });

    // A seek is a boundary event the media clock cannot cover while paused: the
    // exit flush saved the pre-seek position, so a paused scrub would otherwise
    // resume at the stale marker. Persist the settled position on `seeked`
    // itself when paused; during playback the media clock already carries it.
    video.addEventListener("seeked", () => {
      if (shell.paused) {
        this.#saveProgress(shell.currentTime);
      }
    }, { signal, passive: true });
  }

  /**
   * Persist the exact position of the last rendered frame on the playback exit
   * edge, preferring requestVideoFrameCallback's mediaTime - the position the
   * user actually saw - over currentTime, the decoder position which may lead
   * or lag the display. Falls back to currentTime when the API is unavailable
   * (jsdom harness). rVFC ids are not AbortSignal-cancellable, so the pending
   * id is held on a field: destroy() cancels it, and a flush that races an
   * undelivered frame supersedes it instead of stacking a redundant save.
   */
  #flushProgress(video) {
    if (typeof video.requestVideoFrameCallback === "function") {
      if (this.#rvfcHandle != null) {
        video.cancelVideoFrameCallback?.(this.#rvfcHandle);
      }
      this.#rvfcHandle = video.requestVideoFrameCallback((_now, metadata) => {
        this.#rvfcHandle = null;
        this.#saveProgress(metadata.mediaTime);
      });
    } else {
      this.#saveProgress(this.#shell.currentTime);
    }
  }

  /** Clipboard bridge passthroughs (see ResumeStore exportData/importData). */
  exportResume() {
    return this.#store.exportData();
  }

  importResume(text) {
    return this.#store.importData(text);
  }

  getEntries() {
    return this.#store.getEntries();
  }

  removeEntry(id) {
    this.#store.removeEntry(id);
  }

  resetEntry(id) {
    this.#store.updateResume(id, 0);
  }

  /** Subscribe to store changes (see ResumeStore#onChange). */
  onChange(cb) {
    return this.#store.onChange(cb);
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    if (this.#rvfcHandle != null) {
      this.#shell?.video?.cancelVideoFrameCallback?.(this.#rvfcHandle);
      this.#rvfcHandle = null;
    }
    // Final save while disposed is still false (#saveProgress guards on it),
    // then the scope takes down the media listeners + off-screen observer.
    if (this.#entry) {
      this.#saveProgress(this.#shell?.currentTime || NaN);
    }
    this.#scope.dispose();
    this.#store.destroy();
  }
}
