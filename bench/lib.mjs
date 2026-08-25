/**
 * Minimal pure-CPU benchmark harness in the spirit of uBO's dig tool:
 * warm up, take several adaptive batches, report the median ns/op.
 * run.mjs adds --record/--compare so refactors must beat-or-match a
 * recorded baseline instead of trusting eyeballed smoothness.
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

export function measure(name, makeRun) {
  const run = makeRun();
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
