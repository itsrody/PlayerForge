import { Plugin } from "./base.js";
import { resumeStore } from "../shared/resume-store.js";
import { getPageContext } from "../shared/page-context.js";
import { formatTime } from "../shared/format.js";
import { logger } from "../shared/logger.js";

const RESUME_SAVE_INTERVAL_MS = 60000;
/** Progress at/after which the entry resets so the video restarts next time. */
const COMPLETION_RATIO = 0.95;
/** Ignore tiny drifts between saves. */
const SAVE_EPSILON_SECONDS = 3;
/** Only auto-seek when the saved position is meaningful. */
const RESUME_MIN_POSITION = 5;

/**
 * Persists playback progress per (domain, path, duration) and resumes where
 * the user left off, with a "Start over" toast action.
 */
export class ResumePlugin extends Plugin {
  #store = resumeStore;
  #entry = null;
  #saveTimer = null;
  #pauseUnsub = null;
  /** Detach-time flush hook installed by onAttach (removes media listeners). */
  #stopResumeSeekWatch = null;
  #lastSavedPosition = 0;

  constructor() {
    super("resume");
  }

  async onAttach(shell) {
    const context = await getPageContext();
    if (!this.isActive) {
      return;
    }
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
      if (!this.isActive) {
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
      this.addCleanup(stopWatching);
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
    this.#saveTimer = null;
    this.#pauseUnsub?.();
    this.#pauseUnsub = null;

    let lastSeen = this.#lastSavedPosition;
    this.#saveTimer = setInterval(() => {
      const currentTime = shell.currentTime;
      if (!shell.paused && currentTime !== lastSeen) {
        this.#saveProgress(currentTime);
        lastSeen = currentTime;
      }
    }, RESUME_SAVE_INTERVAL_MS);
    this.addCleanup(() => clearInterval(this.#saveTimer));

    this.#pauseUnsub = this.onVideo("pause", () => {
      this.#saveProgress(shell.currentTime);
    });
  }

  onDetach() {
    this.#stopResumeSeekWatch?.();
    this.#stopResumeSeekWatch = null;
    clearInterval(this.#saveTimer);
    this.#saveTimer = null;
    this.#pauseUnsub?.();
    this.#pauseUnsub = null;
    if (this.#entry) {
      this.#saveProgress(this.shell?.currentTime || 0);
    }
  }

  onDestroy() {
    if (this.#entry) {
      this.#saveProgress(this.shell?.currentTime || 0);
    }
    super.onDestroy();
  }
}
