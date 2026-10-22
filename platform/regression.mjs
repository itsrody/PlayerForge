/**
 * Shared regression engine for the two benchmark families: the pure-CPU cases
 * (bench/cases, ns/op) and the ChromiumDriver rows (platform/browser-bench,
 * ms/op). Both used to carry their own baseline read/write, threshold copy,
 * and compare marks, and they had drifted - the browser runner knew about
 * gateable rows, unusable zero baselines, and noisy-record skipping while the
 * CPU runner gated on a duplicated, weaker copy of the same rules. One
 * threshold, one record policy, one marks vocabulary, one file here.
 *
 * A "row" is `{ name, value, spread, gateable }` where `value` is the median
 * per-op metric in whatever unit the family measures. Unit-neutral by design:
 * the engine never divides anything but numbers.
 */
import { readFileSync, writeFileSync } from "node:fs";

export const REGRESSION_THRESHOLD = 1.2; // +20% median

export function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Overwrite the baseline at `path` from `rows`. Recording follows the same
 * contract for both families:
 *  - `gateable === false` rows are skipped: a row too coarse to gate on would
 *    bake today's noise into the file - keep whatever baseline entry it has.
 *  - a row whose spread across passes exceeds the threshold headroom is
 *    skipped when `repeat > 1`: if it can wander further than the gate flags,
 *    a recorded median is not a reference, it is a coin flip.
 * Entries for rows absent from this write self-clean (a removed case leaves
 * no dead baseline behind to silently pass future compares).
 * Returns the skipped labels so a runner can print what it declined to seal.
 */
export function recordBaseline(path, rows, { threshold = REGRESSION_THRESHOLD, repeat = 1 } = {}) {
  const data = {};
  const skipped = [];
  for (const r of rows) {
    if (r.gateable === false) {
      skipped.push(r.name);
      continue;
    }
    if (repeat > 1 && r.spread > threshold - 1) {
      skipped.push(`${r.name} (spread ±${(r.spread * 100).toFixed(0)}% over ${repeat} passes)`);
      continue;
    }
    data[r.name] = r.value;
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
  return skipped;
}

/**
 * Compare `rows` against a baseline map and print the verdict table. Marks:
 *   REGRESSED - median exceeds the threshold; fails the run.
 *   improved  - median fell well below it (reported, never fails).
 *   ok        - within headroom.
 *   NEW       - the row has no baseline entry yet.
 *   NO-BASE   - the entry exists but is 0/non-number: the row was below the
 *               clock when captured; only a --record can fix that entry.
 *   INFO      - not gateable; looks like noise, reported but never judged.
 * Returns whether anything regressed; the runner owns the exit code.
 */
export function compareBaseline(baseline, rows, { threshold = REGRESSION_THRESHOLD, io = console } = {}) {
  io.log(`\n  comparison vs baseline (regression threshold +${((threshold - 1) * 100).toFixed(0)}%):`);
  let failed = false;
  const out = (mark, msg) => io.log(`    ${mark.padEnd(9)} ${msg}`);
  for (const r of rows) {
    if (r.gateable === false) {
      out("INFO", `${r.name}  (too coarse to gate - reported only)`);
      continue;
    }
    const base = baseline?.[r.name];
    if (base === undefined) {
      out("NEW", r.name);
      continue;
    }
    if (!(base > 0)) {
      out("NO-BASE", `${r.name}  (baseline 0 - re-record with --record)`);
      continue;
    }
    const ratio = r.value / base;
    const pct = ((ratio - 1) * 100).toFixed(1);
    const mark = ratio > threshold ? "REGRESSED" : ratio < 0.83 ? "improved" : "ok";
    if (mark === "REGRESSED") {
      failed = true;
    }
    out(mark, `${r.name}  (${pct > 0 ? "+" : ""}${pct}%)`);
  }
  return failed;
}
