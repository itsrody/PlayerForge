import { getPageContext, domainsMatch, domainScore, hashEntry } from "../../shared/page-context.js";
import { getSetting } from "../../shared/config.js";
import { gmGetValue, gmSetValue } from "../../shared/storage.js";
import { formatTime } from "../../shared/format.js";
import { logger } from "../../shared/logger.js";

const RESUME_SAVE_INTERVAL_MS = 60000;
/** Progress at/after which the entry resets so the video restarts next time. */
const COMPLETION_RATIO = 0.95;
/** Ignore tiny drifts between saves. */
const SAVE_EPSILON_SECONDS = 3;
/** Only auto-seek when the saved position is meaningful. */
const RESUME_MIN_POSITION = 5;

const RESUME_STORE_KEY = "pf:resume";
const DEFAULT_STALE_DAYS = 14;

/**
 * Persistent store of per-video entries (keyed by path+duration hash) holding
 * the resume position. Owned by ResumeFeature; merge-on-persist keeps
 * concurrent shells/tabs from clobbering each other's entries.
 */
class ResumeStore {
  #state = null;
  #loaded = false;

  #ensureLoaded() {
    if (this.#loaded) {
      return;
    }
    const raw = gmGetValue(RESUME_STORE_KEY, null);
    if (raw && typeof raw === "object" && Array.isArray(raw.entries)) {
      this.#state = raw;
    } else {
      this.#state = { version: 1, entries: [] };
      gmSetValue(RESUME_STORE_KEY, this.#state);
      logger.warn("resume", "Resume store missing or corrupt — reset");
    }
    const stalePending = this.#state.entries.filter((entry) => entry.pending).length;
    if (stalePending) {
      this.#state.entries = this.#state.entries.filter((entry) => !entry.pending);
      this.#state.updatedAt = Date.now();
      gmSetValue(RESUME_STORE_KEY, this.#state);
      logger.log("resume", `Dropped ${stalePending} stale pending entries`);
    }
    this.#loaded = true;
  }

  #persist() {
    try {
      const raw = gmGetValue(RESUME_STORE_KEY, null);
      if (raw && typeof raw === "object" && Array.isArray(raw.entries)) {
        const knownIds = new Set(this.#state.entries.map((entry) => entry.id));
        for (const entry of raw.entries) {
          if (entry && typeof entry === "object" && !knownIds.has(entry.id)) {
            this.#state.entries.push(entry);
          }
        }
      }
      this.#state.updatedAt = Date.now();
      gmSetValue(RESUME_STORE_KEY, this.#state);
    } catch (err) {
      logger.error("resume", "Failed to persist resume store:", err);
    }
  }

  findMatch(domainKey, path, duration) {
    this.#ensureLoaded();
    const targetDuration = duration || 0;
    let best = null;
    let bestScore = -Infinity;
    for (const entry of this.#state.entries) {
      if (
        entry.path !== path ||
        entry.pending ||
        !domainsMatch(entry.domain, domainKey) ||
        Math.abs(entry.duration - targetDuration) > getSetting("resume.durationFuzz")
      ) {
        continue;
      }
      const fuzz = Math.abs(entry.duration - targetDuration);
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
    const id = hashEntry(path, duration);
    const existingById = this.#state.entries.find((entry) => entry.id === id);
    if (existingById) {
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
      title: title || "",
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

  cleanStale(days = DEFAULT_STALE_DAYS) {
    this.#ensureLoaded();
    const cutoff = Date.now() - days * 86400000;
    const before = this.#state.entries.length;
    this.#state.entries = this.#state.entries.filter((entry) => entry.updatedAt > cutoff);
    if (this.#state.entries.length !== before) {
      this.#persist();
      logger.log("resume", `Cleaned ${before - this.#state.entries.length} stale entries`);
    }
  }
}

/**
 * Shell-owned feature: persists playback progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 */
export class ResumeFeature {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  #saveTimer = null;
  /** Teardown hook that removes the resume-seek media listeners. */
  #stopResumeSeekWatch = null;
  /** Teardown hook that removes the periodic-save "pause" listener. */
  #stopPauseWatch = null;
  #lastSavedPosition = 0;
  #destroyed = false;

  constructor(shell) {
    this.#shell = shell;
    this.#init();
  }

  async #init() {
    const shell = this.#shell;
    const context = await getPageContext();
    if (!context) {
      logger.log("resume", "Top context unavailable — skipping");
      return;
    }

    const video = shell.video;
    if (!video.duration || !isFinite(video.duration)) {
      const { promise: metadataReady, resolve: resolveMetadata } = Promise.withResolvers();
      let timeoutHandle;
      const finishWaiting = () => {
        video.removeEventListener("loadedmetadata", onLoaded);
        video.removeEventListener("error", onError);
        clearTimeout(timeoutHandle);
        resolveMetadata();
      };
      const onLoaded = () => finishWaiting();
      const onError = () => finishWaiting();
      timeoutHandle = setTimeout(finishWaiting, 10000);
      video.addEventListener("loadedmetadata", onLoaded);
      video.addEventListener("error", onError);
      await metadataReady;
      if (this.#destroyed || !video.isConnected) {
        return;
      }
    }

    const duration = video.duration || 0;
    if (duration <= 0) {
      logger.log("resume", "No duration available — skipping");
      return;
    }

    this.#store.cleanStale();
    const match = this.#store.findMatch(context.domain, context.path, duration);
    let startAt = shell.currentTime || 0;
    if (match) {
      this.#entry = match;
      logger.log("resume", `Matched ${match.id} — resume at ${match.resume}s`);
    } else {
      this.#entry = this.#store.createEntry(context.domain, context.path, context.title, duration);
      logger.log("resume", `Created ${this.#entry.id} for ${context.domain}${context.path}`);
    }

    const savedPosition = this.#entry.resume || 0;
    if (savedPosition > RESUME_MIN_POSITION) {
      startAt = savedPosition;
      let seeked = false;
      const trySeek = () => {
        if (!seeked) {
          seeked = true;
          stopWatching();
          if (!(video.currentTime > savedPosition - 5)) {
            shell.seek(savedPosition);
            shell.toast({
              icon: "resume",
              text: `Resumed at ${formatTime(savedPosition)}`,
              duration: 3000,
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
      const onTimeUpdate = () => {
        if (!shell.paused) {
          trySeek();
        }
      };
      const onPlay = () => trySeek();
      const stopWatching = () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("play", onPlay);
      };
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("play", onPlay);
      this.#stopResumeSeekWatch = stopWatching;
    }

    this.#lastSavedPosition = startAt;
    this.#startPeriodicSave(shell);
  }

  #saveProgress(currentTime) {
    if (Math.abs(currentTime - this.#lastSavedPosition) < SAVE_EPSILON_SECONDS) {
      return;
    }
    this.#lastSavedPosition = currentTime;
    if (this.#entry.duration > 0 && currentTime / this.#entry.duration >= COMPLETION_RATIO) {
      this.#entry.resume = 0;
      this.#store.updateResume(this.#entry.id, 0);
      return;
    }
    this.#store.updateResume(this.#entry.id, currentTime);
  }

  #startPeriodicSave(shell) {
    clearInterval(this.#saveTimer);

    let lastSeen = this.#lastSavedPosition;
    this.#saveTimer = setInterval(() => {
      const currentTime = shell.currentTime;
      if (!shell.paused && currentTime !== lastSeen) {
        this.#saveProgress(currentTime);
        lastSeen = currentTime;
      }
    }, RESUME_SAVE_INTERVAL_MS);

    const onPause = () => {
      this.#saveProgress(shell.currentTime);
    };
    shell.video.addEventListener("pause", onPause);
    this.#stopPauseWatch = () => shell.video.removeEventListener("pause", onPause);
  }

  destroy() {
    this.#stopResumeSeekWatch?.();
    this.#stopResumeSeekWatch = null;
    this.#stopPauseWatch?.();
    this.#stopPauseWatch = null;
    clearInterval(this.#saveTimer);
    this.#saveTimer = null;
    if (this.#entry && !this.#destroyed) {
      this.#saveProgress(this.#shell?.currentTime || 0);
    }
    this.#destroyed = true;
  }
}
