/**
 * Rejections from `play()`, `requestPictureInPicture()`, and friends that are
 * ordinary browser policy, not application bugs: AbortError = the request was
 * superseded (new load / pause race), NotAllowedError = autoplay or
 * user-gesture policy. Callers rethrow (or surface) anything else.
 */
export function isBenignMediaPolicyError(err) {
  return err?.name === "AbortError" || err?.name === "NotAllowedError";
}
