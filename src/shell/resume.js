import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { TUNING } from "../shared/tuning.js";
import { KEYS, gmSetValue, loadJsonObject } from "../shared/storage.js";
import { formatTime } from "../shared/time.js";
import { logger } from "../shared/logger.js";

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
    if (typeof GM_addValueChangeListener === "function") {
      this.#listenerId = GM_addValueChangeListener(KEYS.resume, () => this.#adoptExternal());
    }
  }

  /** Release the cross-tab change subscription (SPA re-entry / shell teardown). */
  destroy() {
    if (this.#listenerId != null && typeof GM_removeValueChangeListener === "function") {
      GM_removeValueChangeListener(this.#listenerId);
      this.#listenerId = null;
    }
  }

  #adoptExternal() {
    if (!this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
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

  ensureLoaded() {
    if (this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      // Tolerate foreign or future writers: adopt their entries as-is and
      // restamp our schema version - resetting would destroy history.
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
      // Bounds run AFTER the merge so a stale disk copy can never resurrect
      // pruned entries - cleanup converges instead of oscillating.
      this.#state.entries = this.#enforceBounds();
      this.#state.updatedAt = Date.now();
      gmSetValue(KEYS.resume, this.#state);
      this.#notify(structural);
    } catch (err) {
      logger.error("resume", "Failed to persist resume store:", err);
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
    const entry = {
      id,
      domain: domainKey,
      path,
      // NFC so stored titles compare equal regardless of source encoding.
      title: (title || "").normalize("NFC"),
      duration: Number(duration) || NaN,
      resume: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.#state.entries.push(entry);
    this.#persist(true);
    return entry;
  }

  updateResume(id, position) {
    this.ensureLoaded();
    const entry = this.#state.entries.find((candidate) => candidate.id === id);
    if (entry) {
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
      this.#persist(true);
    }
  }

  cleanStale(days = RESUME_STALE_DAYS) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#enforceBounds(days);
    const removed = before - this.#state.entries.length;
    if (removed > 0) {
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
 * Saves are media-clock driven: a passive `timeupdate` listener (which only
 * fires while playback advances) plus an immediate flush on pause and destroy.
 */
export class ResumeTracker {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  /** Every media listener this tracker attaches dies with this signal. */
  #scope = new AbortController();
  /** Eagerly resolved context promise — kicked off in the constructor. */
  #contextPromise;
  #lastSavedPosition = 0;
  /** Wall-clock floor for persists - keeps the write cadence bounded. */
  #lastSavedWall = 0;
  #destroyed = false;

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

    const video = shell.video;
    if (!video.duration || !isFinite(video.duration)) {
      // Resolving twice is a no-op, so timeout and signal races are safe.
      const { signal } = this.#scope;
      const { promise: metadataReady, resolve: resolveMetadata } = Promise.withResolvers();
      const finishWaiting = () => {
        clearTimeout(timeoutHandle);
        resolveMetadata();
      };
      const onDurationChange = () => {
        if (video.duration && isFinite(video.duration)) {
          finishWaiting();
        }
      };
      const onLoaded = () => finishWaiting();
      const onError = () => finishWaiting();
      const timeoutHandle = setTimeout(finishWaiting, RESUME_METADATA_WAIT_MS);
      video.addEventListener("loadedmetadata", onLoaded, { signal });
      video.addEventListener("durationchange", onDurationChange, { signal });
      video.addEventListener("error", onError, { signal });
      await metadataReady;
      if (this.#destroyed) {
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
    this.#startProgressWatch(shell);
  }

  #saveProgress(currentTime) {
    if (Math.abs(currentTime - this.#lastSavedPosition) < RESUME_SAVE_EPSILON_S) {
      return;
    }
    this.#lastSavedPosition = currentTime;
    // Every persist resets the cadence floor so the timeupdate path's
    // wall gate starts counting from real writes (including flushes).
    this.#lastSavedWall = Date.now();
    if (this.#entry.duration > 0 && currentTime / this.#entry.duration >= RESUME_COMPLETION_RATIO) {
      this.#entry.resume = 0;
      this.#store.updateResume(this.#entry.id, 0);
      return;
    }
    this.#store.updateResume(this.#entry.id, currentTime);
  }

  #startProgressWatch(shell) {
    const video = shell.video;
    const { signal } = this.#scope;
    // Seed the floor at watch start so the first qualifying persist lands where
    // the old interval's first tick used to - byte-identical cadence. The
    // position gate is seeded from the saved position earlier in #init.
    this.#lastSavedWall = Date.now();

    // `timeupdate` fires while the playhead advances (~4 Hz continuous), so the
    // media clock itself is the save crank: no interval to keep alive, and a
    // video that is "playing" but stalled simply stops writing. Position alone
    // does not bound write frequency - a fast-forward or scrub trips the
    // epsilon every ~3 s of content - so the wall floor keeps the incremental
    // cadence where the old interval put it (≤1 write per saveIntervalMs). The
    // `pause` flush below is fully immediate, so the "pause to pause" contract
    // still lands the final position regardless of the floor.
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
    // final position is never lost by this gate. Chromium supports `signal` in
    // IntersectionObserver options for automatic teardown; feature-detect for
    // hosts (jsdom) without it.
    let onScreen = true;
    if (typeof IntersectionObserver === "function") {
      try {
        const io = new IntersectionObserver(([entry]) => {
          onScreen = entry.isIntersecting;
        }, { signal });
        io.observe(video);
      } catch {}
    }
    const gatedSaveIfDue = () => {
      if (onScreen) {
        saveIfDue();
      }
    };
    video.addEventListener("timeupdate", gatedSaveIfDue, { signal, passive: true });
    video.addEventListener("pause", () => {
      // requestVideoFrameCallback gives the exact mediaTime of the last rendered
      // frame — the position the user actually saw — whereas currentTime is the
      // decoder position which may lead or lag the display. Falls back to
      // currentTime when the API is unavailable (non-Chromium, test harness).
      if (typeof video.requestVideoFrameCallback === "function") {
        video.requestVideoFrameCallback((_now, metadata) => {
          this.#saveProgress(metadata.mediaTime);
        });
      } else {
        this.#saveProgress(shell.currentTime);
      }
    }, { signal, passive: true });
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
    this.#scope.abort();
    if (this.#entry && !this.#destroyed) {
      this.#saveProgress(this.#shell?.currentTime || NaN);
    }
    this.#destroyed = true;
    this.#store.destroy();
  }
}
