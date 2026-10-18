/**
 * First-available fallback chains.
 *
 * A backend or capability is chosen by evaluating candidates in order and
 * taking the first that yields a truthy result. Each candidate is a thunk, so
 * probing is lazy and short-circuits: candidates after the winner never run -
 * and, for subscriptions, never attach a listener. An exhausted chain returns
 * null; the caller decides what "no backend" means (usually an inert no-op).
 *
 * This is the one place the "try the best backend, else the next" step shape
 * lives, so consumers stop re-spelling `if (typeof x?.y === ...) { ... }`
 * ladders and their no-API tail.
 */
export function firstAvailable(candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const value = candidates[i]();
    if (value) {
      return value;
    }
  }
  return null;
}
