import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { TUNING } from "../shared/tuning.js";
import { KEYS, gmSetValue, loadJsonObject, gmAddValueChangeListener, gmRemoveValueChangeListener } from "../shared/storage.js";
import { formatTime } from "../shared/time.js";
import { Multiplexer } from "../shared/multiplexer.js";
import { HAS_RVFC } from "../shared/capabilities.js";
import { composeTimeout } from "../shared/signal.js";
import { logger } from "../shared/logger.js";
import { Destroyable } from "../shared/destroyable.js";

/** Sort entries by updatedAt - ascending (oldest-first, for eviction) or
 *  descending (newest-first, for history display). */
function sortByUpdatedAt(entries, descending = false) {
  return [...entries].sort((a, b) => {
    const diff = (a.updatedAt || 0) - (b.updatedAt || 0);
    return descending ? -diff : diff;
  });
}

// Hoisted TUNING.resume.* scalars: mutation-free calibration, so V8 folds
// them as invariants on the media-clock path rather than re-resolving the
// deep TUNING chain on every timeupdate/save decision.
const RESUME_STALE_DAYS = TUNING.resume.staleDays;
const RESUME_MAX_ENTRIES = TUNING.resume.maxEntries;
const RESUME_DURATION_FUZZ = TUNING.resume.durationFuzz;
const RESUME_METADATA_WAIT_MS = TUNING.resume.metadataWaitMs;
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
 * Pure persistence layer for resume entries. Handles storage I/O, LWW merge
 * semantics, bounds enforcement, and query. Owns no notifications — the
 * tracker layer drives cross-tab sync and change propagation.
 */
export class ResumeStore {
  #state = null;
  #loaded = false;

  ensureLoaded() {
    if (this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      const valid = raw.entries.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string");
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
    this.#loaded = true;
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
        const filtered = {};
        for (const key of RESUME_ENTRY_FIELDS) {
          if (key in incoming) {
            filtered[key] = incoming[key];
          }
        }
        filtered.id = incoming.id;
        byId.set(incoming.id, filtered);
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
    return { added, updated };
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

  /** Merge remote state then persist. Returns true when the write landed. */
  persist(structural = false) {
    try {
      const raw = loadJsonObject(KEYS.resume, null);
      if (isValidStore(raw)) {
        this.#mergeRaw(raw);
      }
      this.#state.entries = this.#enforceBounds();
      this.#state.updatedAt = Date.now();
      gmSetValue(KEYS.resume, this.#state);
      return structural;
    } catch (err) {
      logger.error("resume", "Failed to persist resume store:", err);
      return false;
    }
  }

  findMatch(domainKey, path, duration) {
    this.ensureLoaded();
    const targetDuration = Number(duration) || NaN;
    const maxFuzz = RESUME_DURATION_FUZZ;
    let best = null;
    let bestScore = -Infinity;
    for (const entry of this.#state.entries) {
      if (entry.path !== path || entry.pending || !domainsMatch(entry.domain, domainKey)) {
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
    const existingById = this.#state.entries.find((entry) => entry.id === id);
    if (existingById && domainsMatch(existingById.domain, domainKey)) {
      return existingById;
    }
    const existingByMatch = this.findMatch(domainKey, path, duration);
    if (existingByMatch) {
      return existingByMatch;
    }
    const entry = {
      id,
      domain: domainKey,
      path,
      title: (title || "").normalize("NFC"),
      duration: Number(duration) || NaN,
      resume: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.#state.entries.push(entry);
    this.persist(true);
    return entry;
  }

  updateResume(id, position) {
    this.ensureLoaded();
    const entry = this.#state.entries.find((candidate) => candidate.id === id);
    if (entry) {
      entry.resume = position;
      entry.updatedAt = Date.now();
      this.persist();
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
      this.persist(true);
    }
  }

  cleanStale(days = RESUME_STALE_DAYS) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#enforceBounds(days);
    const removed = before - this.#state.entries.length;
    if (removed > 0) {
      this.persist(true);
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
      this.persist(true);
    }
    return result;
  }

  /**
   * Adopt foreign state from GM storage (cross-tab sync). Returns
   * {added, updated} counts, or null when nothing changed.
   */
  adoptExternal() {
    if (!this.#loaded) {
      return null;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      const result = this.#mergeRaw(raw);
      if (result.added || result.updated) {
        return result;
      }
    }
    return null;
  }
}

/**
 * Shell-owned playback tracker: persists progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 *
 * Uses the shell's shared MediaStateWatcher and VisibilityWatcher for event
 * subscriptions — zero manual addEventListener calls, full AbortSignal lifecycle.
 */
export class ResumeTracker extends Destroyable {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  /** Eagerly resolved context promise — kicked off in the constructor. */
  #contextPromise;
  #lastSavedPosition = 0;
  /** Wall-clock floor for persists - keeps the write cadence bounded. */
  #lastSavedWall = 0;
  /** Change multiplexer — fans out structural/position-only events to consumers. */
  #changeMultiplexer = new Multiplexer();
  /** Cross-tab sync listener id — unregistered on destroy. */
  #listenerId = null;

  /**
   * @param {object} shell - The shell facade (video, media, mediaWatcher, toastAction, currentTime, paused).
   */
  constructor(shell) {
    super();
    this.#shell = shell;
    this.#contextPromise = getPageContext();
    this.#store.ensureLoaded();
    // Cross-tab live reload: writes in other tabs trigger a merge here.
    this.#listenerId = gmAddValueChangeListener(KEYS.resume, () => this.#onForeignWrite());
    this.#init().catch((err) => logger.error("resume", "Init failed:", err));
  }

  /** Expose the store for UI consumers (history, import/export). */
  get store() {
    return this.#store;
  }

  /** Subscribe to store changes (structural vs position-only). */
  onChange(cb) {
    return this.#changeMultiplexer.subscribe(cb);
  }

  async #init() {
    const shell = this.#shell;
    const context = await this.#contextPromise;
    if (!context) {
      logger.log("resume", "Top context unavailable - skipping");
      return;
    }

    const video = shell.video;
    if (!video.duration || !isFinite(video.duration)) {
      // Wait for metadata via composeTimeout — auto-cancels on scope abort.
      const waitSignal = composeTimeout(this.signal, RESUME_METADATA_WAIT_MS);
      await new Promise((resolve) => {
        const finish = () => {
          waitSignal.removeEventListener("abort", finish);
          video.removeEventListener("loadedmetadata", finish);
          video.removeEventListener("durationchange", onDuration);
          video.removeEventListener("error", finish);
          resolve();
        };
        const onDuration = () => {
          if (video.duration && isFinite(video.duration)) {
            finish();
          }
        };
        waitSignal.addEventListener("abort", finish, { once: true });
        video.addEventListener("loadedmetadata", finish, { signal: this.signal });
        video.addEventListener("durationchange", onDuration, { signal: this.signal });
        video.addEventListener("error", finish, { signal: this.signal });
      });
      if (this.isDestroyed) {
        logger.log("resume", "Shell destroyed before metadata - skipping");
        return;
      }
      if (!video.isConnected) {
        logger.log("resume", "Video detached before metadata - skipping");
        return;
      }
    }

    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      logger.log("resume", "No duration available - skipping");
      return;
    }

    this.#store.cleanStale();
    const match = this.#store.findMatch(context.domain, context.path, duration);
    if (match) {
      this.#entry = match;
      logger.log("resume", `Matched ${match.id} - resume at ${match.resume}s`);
    } else {
      this.#entry = this.#store.createEntry(context.domain, context.path, context.title, duration);
      logger.log("resume", `Created ${this.#entry.id} for ${context.domain}${context.path}`);
    }

    const savedPosition = Number(this.#entry.resume) || NaN;
    if (savedPosition > RESUME_MIN_POSITION) {
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
    this.#startProgressWatch(shell);
  }

  #saveProgress(currentTime) {
    if (Math.abs(currentTime - this.#lastSavedPosition) < RESUME_SAVE_EPSILON_S) {
      return;
    }
    this.#lastSavedPosition = currentTime;
    this.#lastSavedWall = Date.now();
    if (this.#entry.duration > 0 && currentTime / this.#entry.duration >= RESUME_COMPLETION_RATIO) {
      this.#entry.resume = 0;
      this.#store.updateResume(this.#entry.id, 0);
      this.#changeMultiplexer.dispatch(false);
      return;
    }
    this.#store.updateResume(this.#entry.id, currentTime);
    this.#changeMultiplexer.dispatch(false);
  }

  #startProgressWatch(shell) {
    const video = shell.video;
    const { signal } = this;
    this.#lastSavedWall = Date.now();

    const saveIfDue = () => {
      if (shell.paused || Date.now() - this.#lastSavedWall < TUNING.resume.saveIntervalMs) {
        return;
      }
      this.#saveProgress(shell.currentTime);
    };

    // Visibility gating: off-screen incremental saves are suppressed.
    let onScreen = true;
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
      });
      io.observe(video);
      signal.addEventListener("abort", () => io.disconnect(), { once: true });
    }
    const gatedSaveIfDue = () => {
      if (onScreen) {
        saveIfDue();
      }
    };

    // Subscribe to the shared MediaStateWatcher — zero manual addEventListener calls.
    const watcher = shell.mediaWatcher;
    if (watcher) {
      // timeupdate fires while the playhead advances (~4 Hz) — the media clock is the save crank.
      watcher.onChange(gatedSaveIfDue, signal);
      // pause flush: immediate save on pause (bypasses wall floor).
      watcher.onPlayPause(() => {
        if (!shell.paused) return;
        if (HAS_RVFC) {
          video.requestVideoFrameCallback((_now, metadata) => {
            this.#saveProgress(metadata.mediaTime);
          });
        } else {
          this.#saveProgress(shell.currentTime);
        }
      }, signal);
      // ended/error: final save.
      watcher.onDestroy(() => {
        this.#saveProgress(shell.currentTime);
      }, signal);
    } else {
      // Fallback for tests that don't provide a watcher.
      video.addEventListener("timeupdate", gatedSaveIfDue, { signal, passive: true });
      video.addEventListener("pause", () => {
        if (HAS_RVFC) {
          video.requestVideoFrameCallback((_now, metadata) => {
            this.#saveProgress(metadata.mediaTime);
          });
        } else {
          this.#saveProgress(shell.currentTime);
        }
      }, { signal, passive: true });
    }
  }

  #onForeignWrite() {
    const result = this.#store.adoptExternal();
    if (result) {
      this.#changeMultiplexer.dispatch(true);
    }
  }

  destroy() {
    if (this.isDestroyed) return;
    if (this.#listenerId) {
      gmRemoveValueChangeListener(this.#listenerId);
      this.#listenerId = null;
    }
    if (this.#entry) {
      this.#saveProgress(this.#shell?.currentTime || NaN);
    }
    this.#changeMultiplexer.clear();
    super.destroy();
  }
}
