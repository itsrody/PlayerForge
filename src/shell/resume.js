import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { getSetting } from "./config.js";
import { gmGetValue, gmSetValue } from "../shared/storage.js";
import { formatTime } from "./toast.js";
import { logger } from "../shared/logger.js";

const RESUME_SAVE_INTERVAL_MS = 60000;
/** How long to wait for media metadata before giving up on resume. */
const METADATA_WAIT_MS = 10000;
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
 * the resume position. Owned by ResumeTracker; merge-on-persist keeps
 * concurrent shells/tabs from clobbering each other's entries.
 */
export class ResumeStore {
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
      logger.warn("resume", "Resume store missing or corrupt - reset");
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
 * Shell-owned playback tracker: persists progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 * Saves are event-driven - throttled timeupdate ticks plus pause flushes -
 * never a polling timer.
 */
export class ResumeTracker {
  #shell;
  #store = new ResumeStore();
  #entry = null;
  /** Every media listener this tracker attaches dies with this signal. */
  #scope = new AbortController();
  #lastSavedPosition = 0;
  #lastSaveAt = 0;
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

    const video = shell.video;
    if (!video.duration || !isFinite(video.duration)) {
      let resolveMetadata;
      const metadataReady = new Promise((resolve) => {
        resolveMetadata = resolve;
      });
      // Resolving twice is a no-op, so timeout and signal races are safe.
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
      const { signal } = this.#scope;
      const timeoutHandle = setTimeout(finishWaiting, METADATA_WAIT_MS);
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
    if (savedPosition > RESUME_MIN_POSITION) {
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
      video.addEventListener("timeupdate", onTimeUpdate, { signal: this.#scope.signal });
      video.addEventListener("play", onPlay, { signal: this.#scope.signal });
    }

    this.#lastSavedPosition = startAt;
    this.#startProgressWatch(shell);
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

  #startProgressWatch(shell) {
    const video = shell.video;
    this.#lastSaveAt = Date.now();

    const onTimeUpdate = () => {
      if (!shell.paused && Date.now() - this.#lastSaveAt >= RESUME_SAVE_INTERVAL_MS) {
        this.#lastSaveAt = Date.now();
        this.#saveProgress(shell.currentTime);
      }
    };
    const onPause = () => {
      this.#saveProgress(shell.currentTime);
    };
    video.addEventListener("timeupdate", onTimeUpdate, { signal: this.#scope.signal });
    video.addEventListener("pause", onPause, { signal: this.#scope.signal });
  }

  destroy() {
    this.#scope.abort();
    if (this.#entry && !this.#destroyed) {
      this.#saveProgress(this.#shell?.currentTime || 0);
    }
    this.#destroyed = true;
  }
}
