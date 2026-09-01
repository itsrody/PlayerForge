#!/usr/bin/env node
/**
 * Unified platform runner.
 *
 *   node platform/run.mjs test              # Node.js unit tests only
 *   node platform/run.mjs bench             # Pure-CPU benchmarks only
 *   node platform/run.mjs integration       # ChromiumDriver integration tests
 *   node platform/run.mjs browser-bench     # ChromiumDriver browser benchmarks
 *   node platform/run.mjs compare-bundles   # readable vs minified side-by-side
 *   node platform/run.mjs all               # Everything in sequence
 *   node platform/run.mjs ci                # test + bench + integration (no browser-bench)
 */
import { readdirSync, statSync } from "node:fs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const BENCH_BASELINE = join(HERE, "browser-bench", "baseline.json");
const REGRESSION_THRESHOLD = 1.2; // +20%

const modes = process.argv.slice(2);
const mode = modes[0] || "all";

function log(msg) {
  console.log(`\n  ${msg}`);
}

function separator() {
  console.log("  " + "─".repeat(60));
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

// ── ChromiumDriver integration tests ────────────────────────────────
async function runIntegration() {
  log("Running ChromiumDriver integration tests...");
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
      timeout: 120_000, // 2 minutes per test file.
    });
    log("Integration tests passed.");
  } catch {
    log("Integration tests FAILED.");
    process.exit(1);
  }
}

// ── Browser benchmarks ──────────────────────────────────────────────
async function runBrowserBench(bundlePath) {
  log("Running ChromiumDriver browser benchmarks...");
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
  const allResults = [];

  for (const file of benchFiles) {
    const filePath = join(benchDir, file);
    const { default: benchFn } = await import(filePath);
    log(`  Benchmark: ${file.replace(".bench.mjs", "")}`);
    const results = await benchFn(bundle);
    for (const r of results) {
      allResults.push(r);
    }
  }

  // Print results table.
  console.log(`\n  ${"case".padEnd(50)} ${"ms/op".padStart(10)}  spread`);
  console.log("  " + "─".repeat(70));
  for (const r of allResults) {
    console.log(
      `  ${r.name.padEnd(50)} ${r.medianMsPerOp.toFixed(2).padStart(10)}  ±${(r.spread * 100).toFixed(1)}%`
    );
  }

  if (record) {
    const baselineData = Object.fromEntries(
      allResults.map((r) => [r.name, r.medianMsPerOp])
    );
    writeFileSync(BENCH_BASELINE, JSON.stringify(baselineData, null, 2));
    log(`Baseline recorded: ${BENCH_BASELINE}`);
  } else if (compare && baseline) {
    log(`Comparison vs baseline (regression threshold +${((REGRESSION_THRESHOLD - 1) * 100).toFixed(0)}%):`);
    let failed = false;
    for (const r of allResults) {
      const base = baseline[r.name];
      if (!base) {
        console.log(`    NEW       ${r.name}`);
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

// ── Compare bundles: readable vs minified ───────────────────────────
async function runCompareBundles() {
  log("Comparing readable vs minified bundles...");
  separator();

  const readablePath = join(PROJECT_ROOT, "dist", "playerforge.readable.js");
  const minifiedPath = join(PROJECT_ROOT, "dist", "playerforge.minified.js");

  if (!existsSync(readablePath) || !existsSync(minifiedPath)) {
    log("Both dist/playerforge.readable.js and dist/playerforge.minified.js must exist.");
    log("Run: node esbuild.config.mjs  (builds both)");
    process.exit(2);
  }

  const readableSize = statSync(readablePath).size;
  const minifiedSize = statSync(minifiedPath).size;
  const ratio = ((1 - minifiedSize / readableSize) * 100).toFixed(1);

  console.log(`\n  ${"metric".padEnd(40)} ${"readable".padStart(12)} ${"minified".padStart(12)} ${"delta".padStart(10)}`);
  console.log("  " + "─".repeat(76));
  console.log(`  ${"bundle size (bytes)".padEnd(40)} ${String(readableSize).padStart(12)} ${String(minifiedSize).padStart(12)} ${(`-${ratio}%`).padStart(10)}`);

  // Run browser benchmarks against both bundles.
  const benchDir = join(HERE, "browser-bench");
  const benchFiles = readdirSync(benchDir)
    .filter((f) => f.endsWith(".bench.mjs"))
    .sort();

  if (benchFiles.length === 0) {
    log("No browser benchmark files found.");
    return;
  }

  const readableBundle = readFileSync(readablePath, "utf8");
  const minifiedBundle = readFileSync(minifiedPath, "utf8");

  log("\n  Running benchmarks against readable bundle...");
  const readableResults = [];
  for (const file of benchFiles) {
    const filePath = join(benchDir, file);
    const { default: benchFn } = await import(filePath);
    const results = await benchFn(readableBundle);
    for (const r of results) readableResults.push(r);
  }

  log("\n  Running benchmarks against minified bundle...");
  const minifiedResults = [];
  for (const file of benchFiles) {
    const filePath = join(benchDir, file);
    const { default: benchFn } = await import(filePath);
    const results = await benchFn(minifiedBundle);
    for (const r of results) minifiedResults.push(r);
  }

  // Side-by-side comparison table.
  console.log(`\n  ${"case".padEnd(50)} ${"readable".padStart(10)} ${"minified".padStart(10)} ${"delta".padStart(10)}`);
  console.log("  " + "─".repeat(82));

  for (let i = 0; i < readableResults.length; i++) {
    const r = readableResults[i];
    const m = minifiedResults.find((x) => x.name === r.name);
    if (!m) continue;
    const delta = ((m.medianMsPerOp / r.medianMsPerOp - 1) * 100).toFixed(1);
    const mark = Math.abs(parseFloat(delta)) < 5 ? "~" : parseFloat(delta) > 0 ? "+" : "";
    console.log(
      `  ${r.name.padEnd(50)} ${r.medianMsPerOp.toFixed(1).padStart(10)} ${m.medianMsPerOp.toFixed(1).padStart(10)} ${(mark + delta + "%").padStart(10)}`
    );
  }

  console.log();
  log("Bundle comparison completed.");
}

// ── Main ────────────────────────────────────────────────────────────
log(`PlayerForge platform runner — mode: ${mode}`);

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
  case "compare-bundles":
    await runCompareBundles();
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
    console.error("  Usage: node platform/run.mjs [test|bench|integration|browser-bench|compare-bundles|all|ci]");
    process.exit(1);
}

separator();
log("Done.");
