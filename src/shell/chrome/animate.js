import { FLASH_MS, FLASH_EASING } from "../../shared/timing.js";

/**
 * Restart the accent "flash" on an element natively via the Web Animations
 * API (Element.animate). This replaces the classic
 * remove-class -> void offsetWidth (forced reflow) -> re-add pattern: the
 * WAAPI path hands the job to the compositor, needs no synchronous layout
 * flush, and guarantees a clean restart by cancelling any prior background
 * animation on the element. Mirrors the retired @keyframes pf-reset-flash
 * rule (transparent -> accent -> transparent, 0.4s ease-out).
 *
 * Shell-owned UI effect; lives here (not in shared/) because every consumer
 * is chrome/subtitles, so shared/ stays limited to modules the framework and
 * the app use together.
 */
export function flashElement(el, { duration = FLASH_MS } = {}) {
  if (!el || typeof el.animate !== "function") {
    return;
  }
  // Single pass over the element's active animations: finished entries are
  // always accumulated prior flashes (backgroundColor - this module is the
  // only background animator on flash targets), so they cancel without a
  // keyframe scan; running/pending animations are scanned so unrelated CSS /
  // WAAPI animations (transforms, view-transitions) survive the restart.
  for (const anim of el.getAnimations?.() ?? []) {
    if (anim.playState === "finished") {
      anim.cancel();
      continue;
    }
    const keyframes = anim.effect && typeof anim.effect.getKeyframes === "function"
      ? anim.effect.getKeyframes()
      : [];
    if (keyframes.some((kf) => "backgroundColor" in kf)) {
      anim.cancel();
    }
  }
  el.animate(
    [
      { backgroundColor: "transparent" },
      { backgroundColor: "var(--pf-accent)" },
      { backgroundColor: "transparent" }
    ],
    { duration, easing: FLASH_EASING }
  );
}
