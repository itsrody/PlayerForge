import { getPageContext, domainsMatch, domainScore, hashEntry } from "../shared/context.js";
import { onNavigate } from "../shared/navigation.js";
import { TUNING } from "../shared/tuning.js";
import { KEYS, gmSetValue, loadJsonObject, gmAddValueChangeListener, gmRemoveValueChangeListener } from "../shared/storage.js";
import { formatTime } from "../shared/time.js";
import { logger } from "../shared/logger.js";
import { Scope } from "../shared/scope.js";

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

  /** Release the cross-tab change subscription (SPA re-entry / shell teardown). */
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

  /**
   * Whole-store JSON snapshot. Currently unreferenced outside tests - the
   * clipboard bridge it was written for was never built, and no clipboard grant
   * is requested (see storage.js), so this is dormant import/export plumbing
   * rather than a shipped path.
   */
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
 * Saves are playback-status driven: an rVFC crank (frames are presented only
 * while playing) checkpoints every duration-scaled span of content, and every
 * boundary - pause, seeked, ended, hidden, freeze, pagehide, destroy - flushes
 * immediately. No wall-clock interval.
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
  /** Exact mediaTime of the most recently presented frame, refreshed by the
   *  rVFC crank and by every seek; the flush paths prefer it over currentTime
   *  (which is the decoder position and may lead/lag the display). NaN until
   *  the first frame/seek. */
  #lastFrameMediaTime = NaN;
  /** Pending rVFC id for the frame crank; cancelled in destroy() so a queued
   *  callback can never fire into a dead shell. */
  #rvfcHandle = null;
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

    // A resource swap reuses the element, so the previous resource's last
    // presented frame is meaningless here; wait for this one's first frame/seek.
    this.#lastFrameMediaTime = NaN;
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
   * Follow same-document navigations (shared/navigation.js): flush the entry
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
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(([entry]) => {
        onScreen = entry.isIntersecting;
      });
      io.observe(video);
      this.#scope.onDispose(() => io.disconnect());
    }

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
      if (this.#adopting || !this.#entry || !onScreen || document.hidden || shell.paused) {
        return false;
      }
      return positionDue(position);
    };

    // Playback-status crank: requestVideoFrameCallback fires only while frames
    // are actually presented - it IS the "is playing" signal - and reports the
    // exact mediaTime of the frame on screen. The callback re-arms itself and
    // idles for free whenever the element is paused, stalled, or off-screen.
    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = (_now, metadata) => {
        this.#rvfcHandle = null;
        if (this.#scope.disposed) {
          return;
        }
        this.#lastFrameMediaTime = metadata.mediaTime;
        if (checkpointDue(metadata.mediaTime)) {
          this.#saveProgress(metadata.mediaTime);
        }
        this.#rvfcHandle = video.requestVideoFrameCallback(onFrame);
      };
      this.#rvfcHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      // Fallback crank for engines without rVFC (test harness): the media clock
      // (~4 Hz while the playhead advances) drives the same dynamic gate.
      const saveIfDue = () => {
        if (checkpointDue(shell.currentTime)) {
          this.#saveProgress(shell.currentTime);
        }
      };
      video.addEventListener("timeupdate", saveIfDue, { signal, passive: true });
    }

    const flush = () => this.#saveProgress(this.#flushPosition());

    // Status flushes: persist the position at every playback boundary, so the
    // incremental crank only has to cover steady playback gaps.
    video.addEventListener("pause", flush, { signal, passive: true });
    video.addEventListener("seeked", () => {
      // A seek is an explicit position choice: record the landed target as the
      // exact frame time and persist it now, regardless of the checkpoint span.
      this.#lastFrameMediaTime = shell.currentTime;
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

  /** Position for a boundary flush: the last presented frame when known (the
   *  pixels the user actually saw), else the decoder's currentTime. */
  #flushPosition() {
    if (Number.isFinite(this.#lastFrameMediaTime)) {
      return this.#lastFrameMediaTime;
    }
    return this.#shell?.currentTime ?? NaN;
  }

  /**
 * Clipboard bridge passthroughs (see ResumeStore exportData/importData). Also
 * currently unwired: no caller in src/, and the clipboard grant is deliberately
 * not requested. Kept as the coherent pair they are meant to be used as.
 */
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
    this.#readoptScope?.abort();
    this.#readoptScope = null;
    if (this.#rvfcHandle != null) {
      this.#shell?.video?.cancelVideoFrameCallback?.(this.#rvfcHandle);
      this.#rvfcHandle = null;
    }
    // Final save while the scope is still undisposed - #saveProgress has no
    // disposed guard of its own (it only skips while adopting or with no entry),
    // so this ordering is what keeps a torn-down shell from writing. Then the
    // scope takes down the media listeners + off-screen observer.
    if (this.#entry) {
      this.#saveProgress(this.#flushPosition());
    }
    this.#scope.dispose();
    this.#store.destroy();
  }
}
