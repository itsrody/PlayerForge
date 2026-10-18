/**
 * Ordered lifecycle step lists.
 *
 * Every boot and teardown sequence in the tree is the same shape - "run these
 * steps, in this order". These helpers are the one place that shape lives, so
 * the order stays visible as a data list instead of being implied by the
 * statement order of a long method body. Each step is a thunk that closes over
 * its own context.
 *
 * `runSteps` is synchronous: teardown must finish in the same turn (the owner
 * may be detached by the time it returns), so it never yields. `runStepsAsync`
 * awaits its steps in order and, with `yieldBetween`, hands control to the
 * event loop between them (past the first) - used where a first-call
 * construction burst would otherwise wedge input. Its resolved value is the
 * per-step results, so a caller can collect handles to tear down later.
 */

import { yield_ } from "./scheduler.js";

/**
 * @param {Array<() => void>} steps
 */
export function runSteps(steps) {
  for (let i = 0; i < steps.length; i++) {
    steps[i]();
  }
}

/**
 * @param {Array<() => any>} steps
 * @param {{ yieldBetween?: boolean }} [opts]
 * @returns {Promise<any[]>}
 */
export async function runStepsAsync(steps, { yieldBetween = false } = {}) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    if (yieldBetween && i > 0) {
      await yield_();
    }
    results.push(steps[i]());
  }
  return results;
}
