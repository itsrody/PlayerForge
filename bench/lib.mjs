/**
 * Minimal pure-CPU benchmark harness in the spirit of uBO's dig tool:
 * warm up, take several adaptive batches, report the median ns/op.
 *
 * A case file declares definitions with define() and the RUNNER decides when
 * and in what order they are measured. That indirection is what makes an A/B
 * possible: ab.mjs can measure the case files of two source trees minutes
 * apart, alternating which side goes first, so machine load drifts across both
 * sides equally. A case file that timed itself at import time could only ever
 * be compared against a baseline recorded in some earlier session, which is
 * the gate that could not be trusted.
 */

const BATCH_TARGET_MS = 80;
const BATCHES = 7;
const WARMUP_MS = 60;

/** Calibrate iterations until one batch clears BATCH_TARGET_MS. */
function calibrate(run) {
  let n = 1;
  for (;;) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) {
      run();
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= BATCH_TARGET_MS || n >= 2 ** 26) {
      return Math.max(1, n);
    }
    // Scale up proportionally, with headroom for jitter.
    n = Math.min(2 ** 26, Math.ceil((n * BATCH_TARGET_MS * 1.3) / Math.max(ms, 0.01)));
  }
}

/**
 * Declare a benchmark case. `makeRun` is called once to build the operation
 * and the returned closure is what gets timed, so expensive setup stays out
 * of the measured region.
 */
export function define(name, makeRun) {
  return { name, makeRun };
}

/**
 * Time one definition: warm up, calibrate, then take BATCHES samples and
 * report the median ns/op plus the spread.
 *
 * Compatibility: case files written before the define()/measure() split called
 * measure(name, makeRun) and used the returned value directly. Those call
 * sites now mean "declare this" and return the definition, so an A/B against a
 * ref that still has the old case files measures both sides with the same
 * engine instead of comparing two different measurement methodologies.
 */
export function measure(definitionOrName, makeRun) {
  // Legacy call site: declare and return the definition, do NOT time it here.
  // The runner times both sides, so an old-format case file becomes measurable
  // rather than self-timing behind the A/B's back.
  if (typeof definitionOrName === "string") {
    return define(definitionOrName, makeRun);
  }
  const { name } = definitionOrName;
  const run = definitionOrName.makeRun();
  if (typeof run !== "function") {
    throw new Error(`case "${name}" did not produce a runnable`);
  }

  const t0 = process.hrtime.bigint();
  do {
    run();
  } while (Number(process.hrtime.bigint() - t0) / 1e6 < WARMUP_MS);

  const iters = calibrate(run);
  const samples = [];
  for (let b = 0; b < BATCHES; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      run();
    }
    const ns = Number(process.hrtime.bigint() - start);
    samples.push(ns / iters);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const spread = (samples[samples.length - 1] - samples[0]) / median;
  return { name, medianNsPerOp: median, spread };
}
