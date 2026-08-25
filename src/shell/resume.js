import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { getSetting, TUNING } from "./chrome/config.js";
import { KEYS, gmGetValue, gmSetValue, loadJsonObject } from "../shared/storage.js";
import { formatTime } from "../shared/time.js";
import { logger } from "../shared/logger.js";

/**
 * Persistent store of per-video entries (keyed by path+duration hash) holding
 * the resume position. Owned by ResumeTracker; per-entry last-write-wins
 * merging keeps concurrent shells/tabs - and any future whole-blob transport -
 * converging without clobbering each other's entries.
 */
export class ResumeStore {
  #state = null;
  #loaded = false;

  constructor() {
    // Live reload across tabs: whoever writes pf:resume elsewhere triggers a
    // merge-only adoption here (never written back - the writer owns that
    // round trip). This is also the seam where Violentmonkey's eventual value
    // sync would land for free.
    if (typeof GM_addValueChangeListener === "function") {
      GM_addValueChangeListener(KEYS.resume, () => this.#adoptExternal());
    }
  }

  #adoptExternal() {
    if (!this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (raw && Array.isArray(raw.entries)) {
      this.#mergeRaw(raw);
    }
  }

  /**
   * LWW merge of foreign entries into memory. Unknown ids join the store;
   * known ids keep whichever side carries the newer updatedAt. Known entries
   * are updated IN PLACE so trackers holding references stay live.
   */
  #mergeRaw(raw) {
    let added = 0;
    let updated = 0;
    const byId = new Map(this.#state.entries.map((entry) => [entry.id, entry]));
    for (const incoming of raw.entries) {
      if (!incoming || typeof incoming !== "object" || typeof incoming.id !== "string") {
        continue;
      }
      const known = byId.get(incoming.id);
      if (!known) {
        byId.set(incoming.id, incoming);
        added++;
      } else if ((incoming.updatedAt || 0) > (known.updatedAt || 0)) {
        Object.assign(known, incoming);
        updated++;
      }
    }
    this.#state.entries = [...byId.values()];
    return { added, updated };
  }

  #ensureLoaded() {
    if (this.#loaded) {
      return;
    }
    const raw = loadJsonObject(KEYS.resume, null);
    if (raw && Array.isArray(raw.entries)) {
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
  #enforceBounds(days = TUNING.resume.staleDays) {
    const cutoff = Date.now() - days * 86400000;
    let kept = this.#state.entries.filter((entry) => entry.updatedAt > cutoff);
    if (kept.length > TUNING.resume.maxEntries) {
      kept.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
      kept = kept.slice(kept.length - TUNING.resume.maxEntries);
    }
    return kept;
  }

  #persist() {
    try {
      const raw = loadJsonObject(KEYS.resume, null);
      if (raw && Array.isArray(raw.entries)) {
        this.#mergeRaw(raw);
      }
      // Bounds run AFTER the merge so a stale disk copy can never resurrect
      // pruned entries - cleanup converges instead of oscillating.
      this.#state.entries = this.#enforceBounds();
      this.#state.updatedAt = Date.now();
      gmSetValue(KEYS.resume, this.#state);
    } catch (err) {
      logger.error("resume", "Failed to persist resume store:", err);
    }
  }

  findMatch(domainKey, path, duration) {
    this.#ensureLoaded();
    const targetDuration = duration || 0;
    const maxFuzz = getSetting("resume.durationFuzz");
    let best = null;
    let bestScore = -Infinity;
    for (const entry of this.#state.entries) {
      if (entry.path !== path || entry.pending || !domainsMatch(entry.domain, domainKey)) {
        continue;
      }
      const fuzz = Math.abs(entry.duration - targetDuration);
      if (fuzz > maxFuzz) {
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
    this.#ensureLoaded();
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
      duration: duration || 0,
      resume: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.#state.entries.push(entry);
    this.#persist();
    return entry;
  }

  updateResume(id, position) {
    this.#ensureLoaded();
    const entry = this.#state.entries.find((candidate) => candidate.id === id);
    if (entry) {
      entry.resume = position;
      entry.updatedAt = Date.now();
      this.#persist();
    }
  }

  cleanStale(days = TUNING.resume.staleDays) {
    this.#ensureLoaded();
    const raw = loadJsonObject(KEYS.resume, null);
    if (raw && Array.isArray(raw.entries)) {
      this.#mergeRaw(raw);
    }
    const before = this.#state.entries.length;
    this.#state.entries = this.#enforceBounds(days);
    const removed = before - this.#state.entries.length;
    if (removed > 0) {
      this.#persist();
      logger.log("resume", `Pruned ${removed} resume entries`);
    }
  }

  /** Whole-store JSON snapshot for the clipboard bridge and backups. */
  exportData() {
    this.#ensureLoaded();
    return JSON.stringify(this.#state);
  }

  /**
   * Merge a previously exported JSON document via LWW. Returns
   * {added, updated} counts, or null when the text is not a data document.
   */
  importData(text) {
    this.#ensureLoaded();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) {
      return null;
    }
    const result = this.#mergeRaw(raw);
    if (result.added || result.updated) {
      this.#persist();
    }
    return result;
  }
}

/**
 * Shell-owned playback tracker: persists progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 * Saves are event-driven: a dynamic setInterval gated on play/pause plus
 * an immediate flush on pause and destroy.
 */
export class ResumeTracker {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  /** Every media listener this tracker attaches dies with this signal. */
  #scope = new AbortController();
  #lastSavedPosition = 0;
  #progressTimer = 0;
  #destroyed = false;

  constructor(shell) {
    this.#shell = shell;
    this.#init().catch((err) => logger.error("resume", "Init failed:", err));
  }

  async #init() {
    const shell = this.#shell;
    const context = await getPageContext();
    if (!context) {
      logger.log("resume", "Top context unavailable - skipping");
      return;
    }
    if (!getSetting("resume.enabled")) {
      logger.log("resume", "Resume disabled by setting - skipping");
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
      const timeoutHandle = setTimeout(finishWaiting, TUNING.resume.metadataWaitMs);
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

    const duration = video.duration || 0;
    if (duration <= 0) {
      logger.log("resume", "No duration available - skipping");
      return;
    }

    this.#store.cleanStale();
    const match = this.#store.findMatch(context.domain, context.path, duration);
    let startAt = shell.currentTime || 0;
    if (match) {
      this.#entry = match;
      logger.log("resume", `Matched ${match.id} - resume at ${match.resume}s`);
    } else {
      this.#entry = this.#store.createEntry(context.domain, context.path, context.title, duration);
      logger.log("resume", `Created ${this.#entry.id} for ${context.domain}${context.path}`);
    }

    const savedPosition = this.#entry.resume || 0;
    if (savedPosition > TUNING.resume.minPosition) {
      startAt = savedPosition;
      // The seeked flag guards re-entry; the scope removes these listeners
      // on destroy, so no manual stop bookkeeping is needed.
      let seeked = false;
      const trySeek = () => {
        if (!seeked) {
          seeked = true;
          if (!(video.currentTime > savedPosition - 5)) {
            shell.seek(savedPosition);
            shell.toast({
              icon: "resume",
              text: `Resumed at ${formatTime(savedPosition)}`,
              duration: TUNING.toast.actionMs,
              group: "resume",
              actions: [{
                icon: "reload",
                title: "Start over",
                onClick: () => {
                  this.#lastSavedPosition = 0;
                  shell.seek(0);
                }
              }]
            });
          }
        }
      };
      const onPlay = () => trySeek();
      video.addEventListener("play", onPlay, { signal: this.#scope.signal, passive: true });
    }

    this.#lastSavedPosition = startAt;
    this.#startProgressWatch(shell);
  }

  #saveProgress(currentTime) {
    if (Math.abs(currentTime - this.#lastSavedPosition) < TUNING.resume.saveEpsilonSeconds) {
      return;
    }
    this.#lastSavedPosition = currentTime;
    if (this.#entry.duration > 0 && currentTime / this.#entry.duration >= TUNING.resume.completionRatio) {
      this.#entry.resume = 0;
      this.#store.updateResume(this.#entry.id, 0);
      return;
    }
    this.#store.updateResume(this.#entry.id, currentTime);
  }

  #startProgressWatch(shell) {
    const video = shell.video;

    const saveIfDue = () => {
      if (!shell.paused) {
        this.#saveProgress(shell.currentTime);
      }
    };

    const onPlay = () => {
      if (!this.#progressTimer) {
        this.#progressTimer = setInterval(saveIfDue, TUNING.resume.saveIntervalMs);
      }
    };

    const onPause = () => {
      if (this.#progressTimer) {
        clearInterval(this.#progressTimer);
        this.#progressTimer = 0;
      }
      this.#saveProgress(shell.currentTime);
    };

    video.addEventListener("play", onPlay, { signal: this.#scope.signal, passive: true });
    video.addEventListener("pause", onPause, { signal: this.#scope.signal, passive: true });

    // Catch autoplay or already-playing videos.
    if (!video.paused) {
      this.#progressTimer = setInterval(saveIfDue, TUNING.resume.saveIntervalMs);
    }
  }

  /** Clipboard bridge passthroughs (see ResumeStore exportData/importData). */
  exportResume() {
    return this.#store.exportData();
  }

  importResume(text) {
    return this.#store.importData(text);
  }

  destroy() {
    if (this.#progressTimer) {
      clearInterval(this.#progressTimer);
      this.#progressTimer = 0;
    }
    this.#scope.abort();
    if (this.#entry && !this.#destroyed) {
      this.#saveProgress(this.#shell?.currentTime || 0);
    }
    this.#destroyed = true;
  }
}
