/**
 * Active-cue lookup for the per-timeupdate render path.
 *
 * Register-pattern like uBO's short-lived evaluation registers: callers
 * pass a persistent buffer and the function fills it in place, so steady-
 * state playback allocates nothing and never reverses. The buffer must be
 * consumed (rendered) before the next call - it is reused, not owned.
 *
 * Semantics are byte-for-byte the legacy ones: among all cues starting at
 * or before `time`, collect every cue whose end is still ahead - including
 * far-left cues that outlive later ones on malformed tracks.
 */
export function findActiveCues(cues, time, out) {
  out.length = 0;
  let low = 0;
  let high = cues.length;
  while (low < high) {
    const mid = low + high >> 1;
    if (cues[mid].start <= time) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  for (let i = 0; i < low; i++) {
    if (cues[i].end > time) {
      out.push(cues[i]);
    }
  }
  return out;
}
