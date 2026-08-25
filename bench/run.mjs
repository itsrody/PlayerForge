#!/usr/bin/env node
/**
 * Pure-CPU benchmark runner with uBO-dig-style record/compare workflow:
 *
 *   node bench/run.mjs              # print table only
 *   node bench/run.mjs --record     # overwrite bench/baseline.json
 *   node bench/run.mjs --compare    # diff against baseline, exit 1 on regressions
 *
 * A regression is any case whose median ns/op exceeds the baseline by more
 * than REGRESSION_THRESHOLD (noise headroom included). Improvements are
 * reported but never fail the run.
 */
import { readdirSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, "cases");
const BASELINE = join(HERE, "baseline.json");
const REGRESSION_THRESHOLD = 1.2; // +20% median ns/op

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
if (compare || record) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    if (compare) {
      console.error("\n  no baseline.json - run --record first");
      process.exit(2);
    }
  }
}

if (record) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(results.map((r) => [r.name, r.medianNsPerOp])), null, 2));
  console.log(`\n  baseline recorded: ${BASELINE}\n`);
} else if (compare && baseline) {
  let failed = false;
  console.log(`\n  comparison vs baseline (regression threshold +${((REGRESSION_THRESHOLD - 1) * 100).toFixed(0)}%):`);
  for (const r of results) {
    const base = baseline[r.name];
    if (!base) {
      console.log(`    NEW       ${r.name}`);
      continue;
    }
    const ratio = r.medianNsPerOp / base;
    const pct = ((ratio - 1) * 100).toFixed(1);
    const mark = ratio > REGRESSION_THRESHOLD ? "REGRESSED" : ratio < 0.83 ? "improved" : "ok";
    if (mark === "REGRESSED") {
      failed = true;
    }
    console.log(`    ${mark.padEnd(9)} ${r.name}  (${pct > 0 ? "+" : ""}${pct}%)`);
  }
  console.log();
  process.exit(failed ? 1 : 0);
}
