/**
 * Restart the accent "flash" on an element natively via the Web Animations
 * API (Element.animate). This replaces the classic
 * remove-class -> void offsetWidth (forced reflow) -> re-add pattern: the
 * WAAPI path hands the job to the compositor, needs no synchronous layout
 * flush, and guarantees a clean restart by cancelling any prior background
 * animation on the element. Mirrors the retired @keyframes pf-reset-flash
 * rule (transparent -> accent -> transparent, 0.4s ease-out).
 */
export function flashElement(el, { duration = 400 } = {}) {
  if (!el || typeof el.animate !== "function") {
    return;
  }
  const prior = (el.getAnimations?.() ?? []).filter((anim) => {
    const animatesBackground = anim.effect &&
      typeof anim.effect.getKeyframes === "function" &&
      anim.effect.getKeyframes().some((kf) => "backgroundColor" in kf);
    return animatesBackground && anim.playState !== "finished";
  });
  for (const anim of prior) {
    anim.cancel();
  }
  el.animate(
    [
      { backgroundColor: "transparent" },
      { backgroundColor: "var(--pf-accent)" },
      { backgroundColor: "transparent" }
    ],
    { duration, easing: "ease-out" }
  );
}
