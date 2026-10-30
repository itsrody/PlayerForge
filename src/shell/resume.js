import { getPageContext, domainsMatch, domainScore, getDomainKey, hashEntry, onNavigate } from "../shared/page.js";
import { TUNING, formatTime } from "../shared/core.js";
import { KEYS, gmSetValue, loadJsonObject, watchStorageKey } from "../shared/store.js";
import { logger, Scope, Fan } from "../shared/runtime.js";

/** Sort entries by updatedAt - ascending (oldest-first, for eviction) or
 *  descending (newest-first, for history display). */
function sortByUpdatedAt(entries, descending = false) {
  // toSorted (110): the native copy-sort - the spread+sort pair it replaced.
  return entries.toSorted((a, b) => {
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
const RESUME_MIN_POSITION = TUNING.resume.minPosition;
const RESUME_SAVE_EPSILON_S = TUNING.resume.saveEpsilonSeconds;
const RESUME_COMPLETION_RATIO = TUNING.resume.completionRatio;
// NOTE: checkpointRatio/min/max are deliberately NOT hoisted - tests mutate
// TUNING.resume.* at runtime to pin the checkpoint span, so they must stay
// live object reads on the save-decision path.

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
  "subOffset", "subsUrl",
  "createdAt", "updatedAt", "pending"
]);

function isValidStore(raw) {
  return raw && typeof raw === "object" && Array.isArray(raw.entries);
}

/**
 * Project any incoming entry (disk, cross-tab, import, our own literal)
 * onto the fixed whitelist so every in-memory entry carries the same keys.
 * Foreign writers omit optional fields, which used to hand V8 a new hidden
 * class per adopted entry and deoptimize every store scan over them.
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
class ResumeStore {
  #state = null;
  #loaded = false;
  /** storage watchStorageKey handle for the cross-tab change subscription. */
  #watch = null;
  /** Entry-set audience on the shared Fan. */
  #audience = new Fan("resume-store");
  /** Lazily built path -> entries buckets for findMatch; nulled at every
   *  structural mutation so a stale bucket can never serve a match. */
  #byPath = null;
  /** Lazily built id -> entry map for direct lookups (createEntry/updateResume),
   *  same invalidation contract as #byPath. */
  #byId = null;
  /** Cached sorted snapshot for getEntries; refreshed whenever the caches
   *  above are invalidated (which is every persist). */
  #sorted = null;
  /** Signature of the disk copy our own last write produced. Persist skips
   *  the merge walk when the freshly parsed disk doc matches it exactly -
   *  by construction that is our own write echoing back. Never trusts a
   *  foreign doc: any writer we did not produce leaves a mismatch. */
  #diskEcho = null;

  /**
   * Subscribe to store changes. The callback receives a `structural` flag -
   * true when the entry SET changed (create/remove/import/cross-tab merge),
   * false for pure position/timestamp updates. Returns an unsubscribe fn.
   * Consumers that snapshot the whole list (History) re-render on structural
   * changes only; position-only persists stay invisible to them. A `{ signal }`
   * rides the shared Fan, so a bound scope un-subscribes on abort.
   */
  onChange(cb, { signal } = {}) {
    return this.#audience.subscribe(cb, { signal });
  }

  #notify(structural = false) {
    this.#audience.emit(structural);
  }

  constructor() {
    // Live reload across tabs: whoever writes pf:resume elsewhere triggers a
    // merge-only adoption here (never written back - the writer owns that
    // round trip). This is also the seam where a future value-sync transport
    // would land for free.
    //
    // Two costs are cut here without weakening the merge:
    //  - own writes echo back through the watch (remote === false); the
    //    storage-owned filter drops them - the in-memory store is by
    //    definition already that value, so re-reading + re-merging it would
    //    be a pure duplicate parse per save. Anything remote (or any
    //    implementation that omits the flag) still adopts exactly as before.
    //  - when the change does carry the new value, it is merged straight from
    //    the listener argument instead of paying a second GM read + parse.
    this.#watch = watchStorageKey(KEYS.resume, (_name, _old, value) => this.#adoptExternal(value));
  }

  /** Release the cross-tab change subscription (SPA re-entry / shell teardown). */
  destroy() {
    this.#watch.stop();
    this.#watch = null;
    // No fan detach: after the storage watch stops, no notify source remains
    // (update paths ride the tracker, whose teardown destroyed this store),
    // so post-destroy dispatch is unreachable and the audience GCs with the
    // store it lives on.
  }

  /** Merge an external store. `value` is the listener's own new value when it
   *  supplied one (saves a GM read + parse); falling back to a direct read
   *  keeps implementations that pass nothing working unchanged. A successful
   *  adoption leaves the disk still holding the foreign doc, so the echo can
   *  no longer attest to it - cleared, the next persist re-merges. */
  #adoptExternal(value) {
    if (!this.#loaded) {
      return;
    }
    const raw = isValidStore(value) ? value : loadJsonObject(KEYS.resume, null);
    if (isValidStore(raw)) {
      const { added, updated } = this.#mergeRaw(raw);
      if (added || updated) {
        this.#diskEcho = null;
        this.#notify(true);
      }
    }
  }

  #mergeRaw(raw) {
    let added = 0;
    let updated = 0;
    // The same lazy map createEntry/updateResume use; entries referenced here
    // are the live in-memory objects, so the adoption walk never forks.
    const byId = this.#entriesById();
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
    // The entries array holds the exact same objects byId maps: in-place-only
    // merges (every known id, LWW-adopted newer timestamps) reshare it - the
    // Set-spread rebuild ran on every cross-tab echo otherwise.
    if (added > 0) {
      this.#state.entries = [...byId.values()];
      this.#invalidateLookupCaches();
    } else {
      // In-place adoption mutates updatedAt values only: the entry objects
      // (and their id/path keys) are unchanged, so #byId/#byPath stay exact -
      // but a cached sorted snapshot sorts on updatedAt and is stale now.
      this.#sorted = null;
    }
    return { added, updated };
  }

  /**
   * Drop the id/path lookup caches. Only a change to the entry SET invalidates
   * these: they key on object identity plus immutable id/path, which in-place
   * position/timestamp writes never touch. Rebuilding them per position-only
   * persist was the pointless slice of the old invalidate-all helper.
   */
  #invalidateLookupCaches() {
    this.#byPath = null;
    this.#byId = null;
    this.#sorted = null;
  }

  #buildByPath() {
    const map = Map.groupBy(this.#state.entries, (entry) => entry.path);
    this.#byPath = map;
    return map;
  }

  /** Lazy id -> entry map; rebuilt only when the caches were invalidated. */
  #entriesById() {
    if (!this.#byId) {
      const map = new Map();
      for (const entry of this.#state.entries) {
        map.set(entry.id, entry);
      }
      this.#byId = map;
    }
    return this.#byId;
  }

  /**
   * True when the parsed disk doc is verifiably our own last write: same doc
   * timestamp, version, entry count, and newest entry updatedAt. Any writer
   * outside this store (another tab, a sync tool) bumps one of those, so this
   * is a strict empowerment check, not a stamp guess - non-stamped foreign
   * writers (cloud sync, imports) always take the full merge path. A foreign
   * write that coincidentally matches all fields would land LWW-equal anyway
   * and re-converge on the next persist. The scan is allocation-free numeric
   * comparisons; the merge walk it replaces builds a Map over every id.
   */
  #diskEchoMatches(raw) {
    const echo = this.#diskEcho;
    if (echo == null || raw.version !== 1 || raw.entries.length !== echo.count) {
      return false;
    }
    let maxUpdatedAt = 0;
    for (const entry of raw.entries) {
      const t = entry.updatedAt || 0;
      if (t > maxUpdatedAt) {
        maxUpdatedAt = t;
      }
    }
    return raw.updatedAt === echo.docUpdatedAt && maxUpdatedAt === echo.maxUpdatedAt;
  }

  /**
   * Certify the echo for the store JUST written: the doc timestamp is the
   * write time we stamped into the doc, so any foreign writer that omits or
   * rewrites that field can never match. maxUpdatedAt needs the scan only
   * because cross-tab merges can carry entries stamped newer than our own
   * doc timestamp.
   */
  #stampDiskEcho(now) {
    let maxUpdatedAt = 0;
    const entries = this.#state.entries;
    for (let i = 0; i < entries.length; i++) {
      const t = entries[i].updatedAt || 0;
      if (t > maxUpdatedAt) {
        maxUpdatedAt = t;
      }
    }
    this.#diskEcho = {
      docUpdatedAt: now,
      count: entries.length,
      maxUpdatedAt
    };
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
      // NOT certified here: a doc read from disk is not a write of ours (it
      // may carry foreign future-stamped revisions this store must keep
      // conceding to, per LWW) - #diskEcho is minted only in write paths.
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
    this.#invalidateLookupCaches();
    this.#loaded = true;
  }

  /**
   * Store-level invariants over the current entries: age pruning plus the
   * hard entry cap (oldest evicted). Returns a fresh array; callers assign.
   */
  #enforceBounds(days = RESUME_STALE_DAYS) {
    const entries = this.#state.entries;
    const cutoff = Date.now() - days * 86400000;
    if (entries.length <= RESUME_MAX_ENTRIES) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].updatedAt <= cutoff) {
          return entries.filter((e) => e.updatedAt > cutoff);
        }
      }
      return entries;
    }
    const kept = entries.filter((entry) => entry.updatedAt > cutoff);
    kept.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    return kept.slice(kept.length - RESUME_MAX_ENTRIES);
  }

  #persist(structural = false) {
    try {
      const raw = loadJsonObject(KEYS.resume, null);
      if (isValidStore(raw) && !this.#diskEchoMatches(raw)) {
        this.#mergeRaw(raw);
      }
      // Bounds run AFTER the (cross-tab) merge so a stale disk copy can never
      // resurrect pruned entries - cleanup converges instead of oscillating.
      const before = this.#state.entries;
      this.#state.entries = this.#enforceBounds();
      if (this.#state.entries !== before) {
        // An eviction changed the entry set: lookups must rebuild.
        this.#invalidateLookupCaches();
      } else {
        // Position-only persist: updatedAt moved in place, so only the sorted
        // snapshot is stale; the id/path lookups still describe the same set.
        this.#sorted = null;
      }
      const now = Date.now();
      this.#state.updatedAt = now;
      gmSetValue(KEYS.resume, this.#state);
      this.#stampDiskEcho(now);
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
    const existingById = this.#entriesById().get(id);
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
    this.#invalidateLookupCaches();
    this.#persist(true);
    return entry;
  }

  updateResume(id, position) {
    this.ensureLoaded();
    const entry = this.#entriesById().get(id);
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

  /** Per-entry subtitle sync offset (seconds, clamped by the caller). Same
   *  LWW/no-op contract as updateResume: a bump is what carries the new
   *  value through cross-tab merges. */
  updateSubOffset(id, offset) {
    this.ensureLoaded();
    const entry = this.#entriesById().get(id);
    if (entry && entry.subOffset !== offset) {
      entry.subOffset = offset;
      entry.updatedAt = Date.now();
      this.#persist();
    }
  }

  /** Per-entry subtitle source URL (or "" to detach). "" == "no subtitles
   *  remembered"; a string is the restore fetch (the session owns fetch
   *  dedupe). Restoring the same URL twice must not bump the LWW clock. */
  setSubsUrl(id, url) {
    this.ensureLoaded();
    const entry = this.#entriesById().get(id);
    if (entry && entry.subsUrl !== url) {
      entry.subsUrl = url;
      entry.updatedAt = Date.now();
      this.#persist();
    }
  }

  /**
   * Publish the current entry identity to listeners without awaiting a save:
   * adoption bookkeeping consumers (sync-grain resolution, zoom domain bind,
   * subtitle URL restore) subscribe to onChange but a matched adoption - the
   * findMatch path - persists nothing, so without an announce they would never
   * learn their grain/entry is live. Position-only `structural=false`.
   */
  announce() {
    this.#notify(false);
  }

  getEntries() {
    this.ensureLoaded();
    // Sorted snapshot cached until the next #sorted invalidation: every
    // updatedAt mutation flows through a persist (updateResume, merge
    // adoption, pruning) which drops it, so it serves repeat fetches -
    // History re-renders, exports - between writes without re-spreading +
    // re-sorting per call. Consumers treat the array as read-only;
    // re-sorting it in place would corrupt the cached order only until the
    // next persist.
    if (!this.#sorted) {
      this.#sorted = sortByUpdatedAt(this.#state.entries, true);
    }
    return this.#sorted;
  }

  removeEntry(id) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#state.entries.filter((entry) => entry.id !== id);
    if (this.#state.entries.length < before) {
      this.#invalidateLookupCaches();
      this.#persist(true);
    }
  }

  cleanStale(days = RESUME_STALE_DAYS) {
    this.ensureLoaded();
    const before = this.#state.entries.length;
    this.#state.entries = this.#enforceBounds(days);
    const removed = before - this.#state.entries.length;
    if (removed > 0) {
      this.#invalidateLookupCaches();
      this.#persist(true);
      logger.log("resume", `Pruned ${removed} resume entries`);
    }
  }
}

/**
 * Shell-owned playback tracker: persists progress per (domain, path, duration)
 * and resumes where the user left off, with a "Start over" toast action.
 * Saves are playback-status driven: native playback events (timeupdate while
 * the clock advances) checkpoints every duration-scaled span of content, and
 * every boundary - pause, seeked, ended, hidden, freeze, pagehide, destroy -
 * flushes immediately. No wall-clock interval.
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
  /** One-shot swap listener armed per route change; null when not armed. */
  #readoptScope = null;
  /** True from a resource swap until the new resource has been adopted:
   *  saves are muted so the reset currentTime cannot land in the old entry. */
  #adopting = false;

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
    this.#watchNavigation();
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
   * position, reseed the save gates. Shared by first discovery and every
   * swap re-adoption, so an SPA route change lands on its own (path,
   * duration) entry instead of the one discovered at boot.
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

    // One notify for both adoption paths: bookkeeping consumers (subtitle
    // sync grain, zoom domain, subs URL restore) read the entry off this
    // tracker's accessors, including the silent findMatch adoption.
    this.#store.announce();

    const savedPosition = Number(this.#entry.resume);
    if (Number.isFinite(savedPosition) && savedPosition > RESUME_MIN_POSITION) {
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

    // A fresh entry has resume 0; anchor the span baseline at a finite
    // playhead so the first checkpoint can compare instead of going NaN.
    this.#lastSavedPosition = Number.isFinite(savedPosition) ? savedPosition : (shell.currentTime || 0);
    return true;
  }

  /**
   * Follow same-document navigations (shared/page.js): flush the entry
   * we are leaving - if the player swaps resources before the next
   * timeupdate, that flush is the last write this route gets - then arm the
   * re-adoption the swap triggers. A hash/query-only change resolves to the
   * same (domain, path) and stops here.
   */
  #watchNavigation() {
    onNavigate(() => {
      if (this.#scope.disposed || !this.#entry) {
        return;
      }
      this.#saveProgress(this.#shell.currentTime);
      this.#followRoute();
    }, { signal: this.#scope.signal });
  }

  async #followRoute() {
    try {
      const context = await getPageContext();
      if (this.#scope.disposed || !context || !this.#entry) {
        return;
      }
      const current = this.#entry;
      if (current.path === context.path && domainsMatch(current.domain, context.domain)) {
        return;
      }
      this.#armReadopt();
    } catch (err) {
      logger.error("resume", "Route follow after navigation failed:", err);
    }
  }

  /**
   * One-shot: the next resource selection on the element belongs to the route
   * we navigated to, so adoption runs against THAT resource's metadata and
   * duration. Saves mute (see #adopting) from the swap until adoption
   * finishes, so the element's reset currentTime can never land in the entry
   * we are leaving - the navigation flush already holds its position.
   */
  #armReadopt() {
    if (this.#scope.disposed || this.#readoptScope) {
      return;
    }
    const ac = new AbortController();
    this.#readoptScope = ac;
    const video = this.#shell.video;
    const run = () => {
      if (this.#readoptScope !== ac) {
        return;
      }
      this.#readoptScope = null;
      this.#adopting = true;
      ac.abort();
      this.#readopt();
    };
    video.addEventListener("loadstart", run, { signal: ac.signal, once: true });
    // The SPA may have kicked off the new resource BEFORE it pushed history:
    // that loadstart already fired, and waiting for a second one would strand
    // the adoption. Adopt now when the element is mid-selection.
    if (video.readyState === 0 && video.networkState === 2) {
      run();
    }
  }

  async #readopt() {
    try {
      const context = await getPageContext();
      if (this.#scope.disposed || !context) {
        return;
      }
      if (!(await this.#waitForDuration())) {
        return;
      }
      if (this.#scope.disposed || !this.#entry) {
        return;
      }
      // Deliberately no pre-switch flush here: by loadstart the element has
      // already reset its playhead, so writing currentTime now would stamp
      // the NEW resource's 0 onto the entry we are leaving. Its position was
      // captured by the navigation flush plus every save before the swap
      // (this.#adopting mutes the window in between).
      this.#adoptEntry(context);
    } catch (err) {
      logger.error("resume", "Re-adoption after resource swap failed:", err);
    } finally {
      this.#adopting = false;
    }
  }

  /** Save gate: entry-less or swap-in-flight states never write. */
  #saveProgress(currentTime) {
    if (this.#adopting || !this.#entry) {
      return;
    }
    const entry = this.#entry;
    if (Math.abs(currentTime - this.#lastSavedPosition) < RESUME_SAVE_EPSILON_S) {
      return;
    }
    this.#lastSavedPosition = currentTime;
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

    // Gate persistent saves while the player scrolls out of the viewport
    // (carousel / off-screen embeds): an IntersectionObserver drives a
    // layout-free "is this player on screen" boolean, so saves stop churning
    // GM storage for a video the user cannot see. IntersectionObserverInit has
    // no `signal` member, so the observer registers its disconnect with the
    // scope - otherwise a shell torn down while the element stays in the page
    // (SPA video swaps) would leak the observer + target for the rest of the
    // page lifetime. The status flushes below still run, so the final position
    // is never lost by this gate.
    let onScreen = true;
    const io = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
    });
    io.observe(video);
    this.#scope.onDispose(() => io.disconnect());

    // Dynamic content-relative cadence: due once the playhead has advanced a
    // duration-scaled span since the last persist. No wall clock, so a paused
    // video, buffering, and playbackRate never distort the cadence.
    const positionDue = (position) => {
      const duration = this.#entry.duration;
      const span = Math.min(
        TUNING.resume.maxCheckpointSeconds,
        Math.max(TUNING.resume.minCheckpointSeconds, duration * TUNING.resume.checkpointRatio)
      );
      return Math.abs(position - this.#lastSavedPosition) >= span;
    };
    const checkpointDue = (position) => {
      if (this.#adopting || !this.#entry || !onScreen || document.visibilityState === "hidden" || shell.paused) {
        return false;
      }
      return positionDue(position);
    };

    // The native media-clock broadcast: `timeupdate` fires on the element's
    // own playback clock (~4Hz while advancing) and carries no payload, so
    // the position read is `currentTime` - the decoder's authoritative
    // playhead. It idles for free whenever the element is paused or stalled
    // (no advancing -> no event), and the boundaries below flush at hidden /
    // freeze before throttling can eat a write; the rVFC per-frame crank
    // retired with user direction - a presented-frame callback (~15x the
    // event cost of timeupdate) bought sub-frame flush precision the 10s
    // checkpoint span never consumed.
    video.addEventListener("timeupdate", () => {
      if (this.#scope.disposed) {
        return;
      }
      if (checkpointDue(shell.currentTime)) {
        this.#saveProgress(shell.currentTime);
      }
    }, { signal, passive: true });

    const flush = () => this.#saveProgress(shell.currentTime);

    // Status flushes: persist the position at every playback boundary, so the
    // incremental cadence only has to cover steady playback gaps.
    video.addEventListener("pause", flush, { signal, passive: true });
    video.addEventListener("seeked", () => {
      // A seek is an explicit position choice: the landed target IS the
      // position; persist it now, regardless of the checkpoint span.
      this.#saveProgress(shell.currentTime);
    }, { signal, passive: true });
    video.addEventListener("ended", flush, { signal, passive: true });
    // A hidden tab throttles (or discards) media events; flush before it can.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    }, { signal });
    // Page Lifecycle: freeze and pagehide cover OS freeze / tab close / bfcache,
    // where destroy() may never run.
    document.addEventListener("freeze", flush, { signal });
    window.addEventListener("pagehide", flush, { signal });
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
  onChange(cb, { signal } = {}) {
    return this.#store.onChange(cb, { signal });
  }

  /* - Entry accessors for boot-time bookkeeping consumers (the sync state
   *  machine, the zoom domain, the subtitle restorer) - the entry adopted
   *  later than the shell, so the getters read live at notify time. */

  /** The adopted entry id, or null before the first adoption. */
  get entryId() {
    return this.#entry?.id ?? null;
  }

  /** Top-document domain key of the current entry (null before adoption). */
  get domainKey() {
    return this.#entry ? getDomainKey(this.#entry.domain) : null;
  }

  /** Per-entry subtitle sync offset in seconds (0 with none). */
  get subOffset() {
    const offset = Number(this.#entry?.subOffset);
    return Number.isFinite(offset) ? offset : 0;
  }

  setSubOffset(offset) {
    if (this.#entry) {
      this.#store.updateSubOffset(this.#entry.id, offset);
    }
  }

  /** Per-entry subtitle source URL ("" = none remembered). */
  get subsUrl() {
    return typeof this.#entry?.subsUrl === "string" ? this.#entry.subsUrl : "";
  }

  setSubsUrl(url) {
    if (this.#entry) {
      this.#store.setSubsUrl(this.#entry.id, url);
    }
  }

  destroy() {
    if (this.#scope.disposed) {
      return;
    }
    this.#readoptScope?.abort();
    this.#readoptScope = null;
    // Final save while the scope is still undisposed - #saveProgress has no
    // disposed guard of its own (it only skips while adopting or with no entry),
    // so this ordering is what keeps a torn-down shell from writing. Then the
    // scope takes down the media listeners + off-screen observer.
    if (this.#entry) {
      this.#saveProgress(this.#shell?.currentTime ?? NaN);
    }
    this.#scope.dispose();
    this.#store.destroy();
  }
}
