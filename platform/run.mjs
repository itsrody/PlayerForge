#!/usr/bin/env node
/**
 * Unified platform runner.
 *
 *   node platform/run.mjs test              # Node.js unit tests only
 *   node platform/run.mjs bench             # Pure-CPU benchmarks only
 *   node platform/run.mjs integration       # FirefoxDriver integration tests
 *   node platform/run.mjs browser-bench     # FirefoxDriver browser benchmarks
 *   node platform/run.mjs all               # Everything in sequence
 *   node platform/run.mjs ci                # test + bench + integration (no browser-bench)
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { assertMeetsFloor, formatTarget, resolveFirefoxTarget } from "./harness/target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const BENCH_BASELINE = join(HERE, "browser-bench", "baseline.json");
const REGRESSION_THRESHOLD = 1.2; // +20%

const modes = process.argv.slice(2);
const mode = modes[0] || "all";

function log(msg) {
  console.log(`\n  ${msg}`);
}

/**
 * Format a per-op duration. Most browser rows are sub-millisecond, and
 * toFixed(2) left them with a single significant digit - a 0.12ms row and a
 * 0.124ms row printed identically, which is exactly the resolution a
 * regression check needs. Sub-ms values get 4 decimals; anything larger keeps
 * 2, since past a millisecond the extra digits are noise.
 */
function formatMs(ms) {
  if (!Number.isFinite(ms)) {
    return String(ms);
  }
  if (ms === 0) {
    return "0.0000";
  }
  return ms < 1 ? ms.toFixed(4) : ms.toFixed(2);
}

function separator() {
  console.log("  " + "─".repeat(60));
}

// ── Browser target ──────────────────────────────────────────────────

/**
 * Announce the browser this run will drive.
 *
 * Printed once, before anything launches, because an integration or benchmark
 * result is only evidence about the engine that produced it. A green run that
 * never said whether it was on a 157 release or a 158 beta cannot be told apart
 * from one that silently fell back to whatever geckodriver found.
 */
function printTarget() {
  let target;
  try {
    target = resolveFirefoxTarget();
    assertMeetsFloor(target);
  } catch (err) {
    console.error(`\n  ${err.message}`);
    process.exit(1);
  }
  log(`Browser target: ${formatTarget(target)}`);
  return target;
}

// ── Node.js unit tests ──────────────────────────────────────────────
async function runTests() {
  log("Running Node.js unit tests...");
  separator();
  try {
    execSync("node --import ./tests/loader.mjs --test", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    log("Unit tests passed.");
  } catch {
    log("Unit tests FAILED.");
    process.exit(1);
  }
}

// ── Pure-CPU benchmarks ─────────────────────────────────────────────
async function runBench() {
  log("Running pure-CPU benchmarks...");
  separator();
  try {
    execSync("node bench/run.mjs", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    log("Benchmarks completed.");
  } catch {
    log("Benchmarks FAILED.");
    process.exit(1);
  }
}

// ── FirefoxDriver integration tests ────────────────────────────────
async function runIntegration() {
  log("Running FirefoxDriver integration tests...");
  separator();

  const integrationDir = join(HERE, "integration");
  const testFiles = readdirSync(integrationDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort();

  if (testFiles.length === 0) {
    log("No integration test files found.");
    return;
  }

  // Run via Node.js test runner with the integration files.
  const testPaths = testFiles.map((f) => join(integrationDir, f)).join(" ");
  try {
    execSync(`node --test ${testPaths}`, {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 600_000, // 10 minutes total for all test files.
    });
    log("Integration tests passed.");
  } catch {
    log("Integration tests FAILED.");
    process.exit(1);
  }
}

// ── Browser benchmarks ──────────────────────────────────────────────
async function runBrowserBench(bundlePath) {
  log("Running FirefoxDriver browser benchmarks...");
  separator();

  const benchDir = join(HERE, "browser-bench");
  const benchFiles = readdirSync(benchDir)
    .filter((f) => f.endsWith(".bench.mjs"))
    .sort();

  if (benchFiles.length === 0) {
    log("No browser benchmark files found.");
    return [];
  }

  const record = modes.includes("--record");
  const compare = modes.includes("--compare");

  let baseline = null;
  if (compare || record) {
    try {
      baseline = JSON.parse(readFileSync(BENCH_BASELINE, "utf8"));
    } catch {
      if (compare) {
        log("No baseline.json — run with --record first.");
        process.exit(2);
      }
    }
  }

  const bundle = bundlePath ? readFileSync(bundlePath, "utf8") : undefined;
  // Recording defaults to 3 passes: a single pass is exactly the load-biased
  // sample this whole mechanism exists to avoid, so making it the default for
  // --record means the easy path is also the correct one.
  const repeat = Number(modes.find((m) => m.startsWith("--repeat="))?.slice(9)) || (record ? 3 : 1);

  // Each bench file launches its own browser, so a "run" here is a full
  // suite pass. Taking the median across R passes is what makes a recorded
  // baseline trustworthy: a single pass is dominated by ambient machine load
  // (identical code measured 11.79ms and 7.69ms for script injection on the
  // same day, a 53% swing against a 20% gate), so the per-run median of
  // samples within one process is not enough. Spread across passes is the
  // number that actually predicts a flaky gate.
  const passes = [];
  for (let pass = 0; pass < repeat; pass++) {
    if (repeat > 1) {
      log(`  Pass ${pass + 1}/${repeat}`);
    }
    const results = [];
    for (const file of benchFiles) {
      const filePath = join(benchDir, file);
      const { default: benchFn } = await import(filePath);
      log(`  Benchmark: ${file.replace(".bench.mjs", "")}`);
      const rowResults = await benchFn(bundle);
      for (const r of rowResults) {
        results.push(r);
      }
    }
    passes.push(results);
  }

  // Collapse passes into one row per case.
  const byName = new Map();
  for (const pass of passes) {
    for (const r of pass) {
      if (!byName.has(r.name)) byName.set(r.name, []);
      byName.get(r.name).push(r);
    }
  }
  const allResults = [];
  for (const [name, rows] of byName) {
    const medians = rows.map((r) => r.medianMsPerOp).sort((a, b) => a - b);
    const medianMsPerOp = medians[Math.floor(medians.length / 2)];
    const spread =
      medians.length > 1
        ? (medians[medians.length - 1] - medians[0]) / medianMsPerOp
        : rows[0].spread;
    allResults.push({ ...rows[rows.length - 1], name, medianMsPerOp, spread });
  }

  // Print results table.
  console.log(`\n  ${"case".padEnd(50)} ${"ms/op".padStart(10)}  spread`);
  console.log("  " + "─".repeat(70));
  for (const r of allResults) {
    const tag = r.gateable === false ? " (not gated)" : "";
    console.log(
      `  ${(r.name + tag).padEnd(50)} ${formatMs(r.medianMsPerOp).padStart(10)}  ±${(r.spread * 100).toFixed(1)}%`
    );
  }

  if (record) {
    // Non-gateable rows keep whatever baseline they already have. Recording a
    // median for a row too coarse to gate on would bake today's noise into
    // the file and guarantee a future flake.
    //
    // Same rule for a row whose spread across passes exceeds the gate: if it
    // moved more than the threshold we would flag on, a recorded median is
    // not a reference, it is a coin flip. Leave its existing entry alone.
    const baselineData = { ...baseline };
    const skipped = [];
    for (const r of allResults) {
      if (r.gateable === false) {
        skipped.push(r.name);
        continue;
      }
      if (repeat > 1 && r.spread > REGRESSION_THRESHOLD - 1) {
        skipped.push(`${r.name} (spread ±${(r.spread * 100).toFixed(0)}% over ${repeat} passes)`);
        continue;
      }
      baselineData[r.name] = r.medianMsPerOp;
    }
    writeFileSync(BENCH_BASELINE, JSON.stringify(baselineData, null, 2));
    log(`Baseline recorded: ${BENCH_BASELINE}`);
    for (const s of skipped) {
      console.log(`    SKIPPED   ${s}`);
    }
  } else if (compare && baseline) {
    log(`Comparison vs baseline (regression threshold +${((REGRESSION_THRESHOLD - 1) * 100).toFixed(0)}%):`);
    let failed = false;
    for (const r of allResults) {
      if (r.gateable === false) {
        console.log(`    INFO     ${r.name}  (too coarse to gate - reported only)`);
        continue;
      }
      const base = baseline[r.name];
      if (base === undefined) {
        console.log(`    NEW       ${r.name}`);
        continue;
      }
      if (!(base > 0)) {
        // A recorded 0 is not a fast baseline, it is an unusable one - the row
        // was below the clock when it was captured. Reporting it as NEW made
        // these rows look unregistered forever while sitting in the file.
        console.log(`    NO-BASE   ${r.name}  (baseline 0 - re-record with --record)`);
        continue;
      }
      const ratio = r.medianMsPerOp / base;
      const pct = ((ratio - 1) * 100).toFixed(1);
      const mark = ratio > REGRESSION_THRESHOLD ? "REGRESSED" : ratio < 0.83 ? "improved" : "ok";
      if (mark === "REGRESSED") failed = true;
      console.log(`    ${mark.padEnd(9)} ${r.name}  (${pct > 0 ? "+" : ""}${pct}%)`);
    }
    console.log();
    if (failed) process.exit(1);
  }

  log("Browser benchmarks completed.");
  return allResults;
}

// ── Main ────────────────────────────────────────────────────────────
log(`PlayerForge platform runner — mode: ${mode}`);

// Only the modes that actually launch a browser pay for the probe, and only
// those need the engine named out loud.
if (mode === "integration" || mode === "browser-bench" || mode === "all" || mode === "ci") {
  printTarget();
  separator();
}

switch (mode) {
  case "test":
    await runTests();
    break;
  case "bench":
    await runBench();
    break;
  case "integration":
    await runIntegration();
    break;
  case "browser-bench":
    await runBrowserBench();
    break;
  case "all":
    await runTests();
    await runBench();
    await runIntegration();
    await runBrowserBench();
    break;
  case "ci":
    await runTests();
    await runBench();
    await runIntegration();
    break;
  default:
    console.error(`\n  Unknown mode: ${mode}`);
    console.error("  Usage: node platform/run.mjs [test|bench|integration|browser-bench|all|ci]");
    process.exit(1);
}

separator();
log("Done.");
