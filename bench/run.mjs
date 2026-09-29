#!/usr/bin/env node
/**
 * Pure-CPU benchmark runner.
 *
 *   node bench/run.mjs                 # table only
 *   node bench/run.mjs --ab [ref]      # gate: working tree vs ref, same session
 *   node bench/run.mjs --compare       # informational only, never fails
 *   node bench/run.mjs --record        # overwrite bench/baseline.json
 *
 * The GATE is --ab. It measures the working tree and a git ref (HEAD by
 * default) minutes apart, interleaved, each side in its own process, so the
 * ratio survives machine load. The absolute baseline cannot: baseline.json is
 * a set of ns/op numbers from one earlier session, and on a busy machine every
 * case inflates together - a uniform +43%..+75% across unrelated cases is the
 * signature of load, not of a diff. So --compare prints those numbers for
 * context and is explicitly not allowed to fail the run, and --record is
 * discouraged for the same reason: recording on a busy machine just launders
 * the noise into the baseline.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runAB, reportAB, REGRESSION_THRESHOLD } from "./ab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CASES_DIR = join(HERE, "cases");
const BASELINE = join(HERE, "baseline.json");

const argv = process.argv.slice(2);
const record = argv.includes("--record");
const compare = argv.includes("--compare");
const abIndex = argv.indexOf("--ab");
const ab = abIndex !== -1;
const abRef = ab ? (argv[abIndex + 1] && !argv[abIndex + 1].startsWith("-") ? argv[abIndex + 1] : "HEAD") : null;

const { measure } = await import(pathToFileURL(join(HERE, "lib.mjs")).href);

async function loadDefinitions() {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith(".mjs")).sort();
  const defs = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(CASES_DIR, file)).href);
    defs.push(...mod.default);
  }
  return defs;
}

function printTable(results, title) {
  if (title) {
    console.log(`\n  ${title}`);
  }
  console.log(`\n  ${"case".padEnd(44)} ${"ns/op".padStart(12)} ${"ops/s".padStart(14)}  spread`);
  console.log("  " + "-".repeat(82));
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(44)} ${r.medianNsPerOp.toFixed(0).padStart(12)} ${(1e9 / r.medianNsPerOp).toFixed(0).padStart(14)}  ±${(r.spread * 100).toFixed(1)}%`
    );
  }
}

// The A/B measures each side in its own child process, so it must run before
// this process imports the working tree's cases: those files install GM_*
// stubs on globalThis at import time, and there is nothing here to gain from
// paying for them twice.
if (ab) {
  const result = await runAB({ ref: abRef, root: ROOT });
  const failed = reportAB(result);
  process.exit(failed ? 1 : 0);
}

const definitions = await loadDefinitions();

const results = definitions.map((def) => measure(def));
printTable(results);

let baseline = null;
if (compare || record) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    if (record) {
      console.log("\n  no baseline.json yet - recording");
    } else {
      console.log("\n  no baseline.json - informational only, nothing to compare against");
    }
  }
}

if (record) {
  writeFileSync(BASELINE, JSON.stringify(Object.fromEntries(results.map((r) => [r.name, r.medianNsPerOp])), null, 2));
  console.log(`\n  baseline recorded: ${BASELINE}`);
  console.log("  Note: recorded under whatever load the machine had right now. The gate is --ab, not this file.");
} else if (compare && baseline) {
  const thresholdPct = `+${Math.round((REGRESSION_THRESHOLD - 1) * 100)}%`;
  console.log(`\n  vs bench/baseline.json (recorded in an earlier session, ${thresholdPct} threshold, INFORMATIONAL - this never fails the run):`);
  for (const r of results) {
    const base = baseline[r.name];
    if (!base) {
      console.log(`    ${"NEW".padEnd(9)} ${r.name}`);
      continue;
    }
    const pct = ((r.medianNsPerOp / base - 1) * 100).toFixed(1);
    const mark = r.medianNsPerOp / base > REGRESSION_THRESHOLD ? "slow" : r.medianNsPerOp / base < 0.83 ? "faster" : "ok";
    console.log(`    ${mark.padEnd(9)} ${r.name}  (${pct > 0 ? "+" : ""}${pct}%)`);
  }
  console.log("\n  A uniform shift across unrelated cases means the machine moved, not the code.");
  console.log("  Use --ab to gate.");
}
