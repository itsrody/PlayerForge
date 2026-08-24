/**
 * Seconds -> "M:SS" (or "H:MM:SS" past the hour). Shared by toast text,
 * resume prompts, and scrub hints.
 */
export function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Cancellable setTimeout: the returned function cancels a pending run. */
export function delay(fn, ms) {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/** Trailing-edge debounce. Re-calling within the window reschedules. */
export function debounce(fn, ms) {
  let cancel = null;
  return (...args) => {
    cancel?.();
    cancel = delay(() => fn(...args), ms);
  };
}
