import { Scope } from "./scope.js";

/**
 * Passive-by-default activity windows, driven by Gecko's own events and
 * properties.
 *
 * The shell does no work until something happens. An activity is that
 * something: playback advancing, a fullscreen session, a visible tab. Each
 * activity answers one question - is it active? - the way the platform answers
 * it, by reading Gecko's property at the moment Gecko fires its event, never
 * from a copy that can drift out of sync.
 *
 *   const playback = createActivity({
 *     target: video,
 *     events: ["play", "playing", "pause", "ended", "emptied"],
 *     isActive: () => !video.paused && !video.ended,
 *     onEnter: (work) => {
 *       video.addEventListener("timeupdate", tick, { signal: work.signal });
 *     },
 *     onExit: () => flush()
 *   });
 *
 * Until `play` fires, the activity listens for exactly its detection events
 * and nothing more. The first time `isActive()` turns true it mints a work
 * scope and hands it to `onEnter`; everything the active window needs is
 * attached to that scope, so it all dies in one step. When `isActive()` turns
 * false the scope is disposed first - every listener `onEnter` registered is
 * already gone - then `onExit` runs the final flush, which reads platform
 * properties rather than listeners, so it needs none. The activity is passive
 * again until the next start.
 *
 * Transitions are edges, not events: `playing` arriving after `play` does not
 * re-enter, because `isActive()` still answers true. `refresh()` re-reads the
 * property for the rare caller that changed state through a route Gecko does
 * not fire an event for.
 */
export function createActivity({ target, events, isActive, onEnter, onExit, signal }) {
  let work = null;
  let disposed = false;

  const active = () => work !== null;

  const sync = () => {
    if (disposed) {
      return;
    }
    const next = !!isActive();
    if (next === active()) {
      return;
    }
    if (next) {
      if (signal?.aborted) {
        return;
      }
      work = new Scope();
      onEnter?.(work);
    } else {
      const closing = work;
      work = null;
      closing.dispose();
      onExit?.();
    }
  };

  const onOwnerAbort = () => {
    if (work) {
      const closing = work;
      work = null;
      closing.dispose();
    }
  };

  for (const event of events) {
    target.addEventListener(event, sync, { signal, passive: true });
  }
  signal?.addEventListener("abort", onOwnerAbort, { once: true });
  sync();

  return {
    get active() {
      return active();
    },

    /** Re-read `isActive()` after a state change Gecko did not announce. */
    refresh: sync,

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      onOwnerAbort();
      for (const event of events) {
        target.removeEventListener(event, sync);
      }
      signal?.removeEventListener("abort", onOwnerAbort);
    }
  };
}
