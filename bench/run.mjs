#!/usr/bin/env node
/**
 * Pure-CPU benchmark runner:
 *
 *   node bench/run.mjs              # print table only
 *   node bench/run.mjs --record     # overwrite bench/baseline.json
 *   node bench/run.mjs --compare    # diff against baseline, exit 1 on regressions
 *
 * Baseline I/O, the +20% threshold, and the compare verdict table come from
 * platform/regression.mjs - the same engine the ChromiumDriver browser bench
 * gates through, so both families fail on the same rule and print the same
 * vocabulary. Refactors must beat-or-match a recorded baseline instead of
 * trusting eyeballed smoothness.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGRESSION_THRESHOLD, readBaseline, recordBaseline, compareBaseline } from "../platform/regression.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");
const BASELINE = join(HERE, "baseline.json");

const record = process.argv.includes("--record");
const compare = process.argv.includes("--compare");

const results = [];
const caseFiles = readdirSync(CASES_DIR).filter((f) => f.endsWith(".mjs")).sort();
for (const file of caseFiles) {
  const { default: cases } = await import(join(CASES_DIR, file));
  for (const result of cases) {
    results.push(result);
  }
}

console.log(`\n  ${"case".padEnd(44)} ${"ns/op".padStart(12)} ${"ops/s".padStart(14)}  spread`);
console.log("  " + "-".repeat(82));
for (const r of results) {
  console.log(
    `  ${r.name.padEnd(44)} ${r.medianNsPerOp.toFixed(0).padStart(12)} ${(1e9 / r.medianNsPerOp).toFixed(0).padStart(14)}  ±${(r.spread * 100).toFixed(1)}%`
  );
}

let baseline = null;
if (record) {
  // Rows whose in-process spread cannot sit inside the gate headroom are left
  // unrecorded by the shared engine (same rule both families obey) - a noisy
  // median is a coin flip waiting to flake a future compare.
  const rows = results.map((r) => ({ name: r.name, value: r.medianNsPerOp, spread: r.spread }));
  const skipped = recordBaseline(BASELINE, rows, { threshold: REGRESSION_THRESHOLD });
  console.log(`\n  baseline recorded: ${BASELINE}\n`);
  for (const s of skipped) {
    console.log(`    SKIPPED   ${s}`);
  }
} else if (compare) {
  baseline = readBaseline(BASELINE);
  if (!baseline) {
    console.error("\n  no baseline.json - run --record first");
    process.exit(2);
  }
  const rows = results.map((r) => ({ name: r.name, value: r.medianNsPerOp, spread: r.spread }));
  if (compareBaseline(baseline, rows, { threshold: REGRESSION_THRESHOLD })) {
    process.exit(1);
  }
}