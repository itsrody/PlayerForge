import { logger } from "./logger.js";
import { gmGetValue, gmSetValue } from "./storage.js";
import { getSetting } from "./config.js";
import { domainsMatch, domainScore, hashEntry } from "./page-context.js";

export const RESUME_STORE_KEY = "pf:resume";
export const DEFAULT_STALE_DAYS = 14;

/**
 * Persistent store of per-video entries (keyed by path+duration hash) holding
 * the resume position. Used by the resume feature.
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

export const resumeStore = new ResumeStore();
