#!/usr/bin/env node
/**
 * Unified platform runner - one interface for every gate the repo owns.
 *
 * Targets combine freely (space-separated args or `+`-joined in one arg):
 *
 *   node platform/run.mjs test              # Node.js unit tests
 *   node platform/run.mjs bench             # Pure-CPU benchmarks (table)
 *   node platform/run.mjs bench:compare     # CPU bench vs baseline (gates)
 *   node platform/run.mjs bench:record      # overwrite bench/baseline.json
 *   node platform/run.mjs build lint        # two targets in one process
 *   node platform/run.mjs integration       # ChromiumDriver integration tests
 *   node platform/run.mjs browser-bench     # ChromiumDriver browser bench
 *   node platform/run.mjs visual            # HUD glass material check
 *   node platform/run.mjs all               # test bench integration browser-bench visual
 *   node platform/run.mjs ci                # test bench integration
 *   node platform/run.mjs verify            # lint test build bench:compare
 *
 * `--record`, `--compare`, `--repeat=N` are bench flags and apply to every
 * bench-family target in the invocation. npm scripts (verify, ci, ...)
 * remain thin aliases of exactly these targets, so the npm surface and this
 * runner cannot drift apart again: the scripts call the runner, the runner
 * implements the one policy in platform/regression.mjs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { REGRESSION_THRESHOLD, readBaseline, recordBaseline, compareBaseline } from "./regression.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(HERE, "..");
const BENCH_BASELINE = join(HERE, "browser-bench", "baseline.json");

const argv = process.argv.slice(2);
// Flags belong to the bench-family targets; targets name the work.
const flags = argv.filter((a) => a.startsWith("--"));
const targets = argv.filter((a) => !a.startsWith("--")).flatMap((t) => t.split("+"));

const BUNDLES = {
  all: ["test", "bench", "integration", "browser-bench", "visual"],
  ci: ["test", "bench", "integration"],
  verify: ["lint", "test", "build", "bench:compare"]
};

/** Notices a bundle carries for the targets it deliberately leaves out. */
const BUNDLE_NOTES = {
  ci: [
    "Skipping browser-bench (timing gate is not meaningful on a shared runner).",
    "Skipping visual (needs a real browser and a stable renderer).",
    "Run `npm run visual` locally before shipping a HUD change."
  ]
};

const mode = targets[0] || "all";
const bundleInvoked = targets.length === 1 && BUNDLES[mode] != null;
const targets_ = bundleInvoked ? BUNDLES[mode] : targets;

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

/** The npm script owns this gate's definition; the runner only runs it. */
function runNpmScript(script, label) {
  try {
    execSync(`npm run ${script}`, { cwd: PROJECT_ROOT, stdio: "inherit" });
    log(`${label} passed.`);
  } catch {
    log(`${label} FAILED.`);
    process.exit(1);
  }
}

// ── npm-owned gates ──────────────────────────────────────────────────
async function runLint() {
  log("Linting src/...");
  separator();
  runNpmScript("lint", "Lint");
}

async function runTests() {
  log("Running Node.js unit tests...");
  separator();
  // Delegated to the npm `test` script (the single definition: loader import
  // + explicit tests/*.test.mjs list). A parallel re-derivation here drifted
  // once already - a bare `node --test` sweep pulls platform/integration
  // ChromiumDriver files in with file parallelism and starves real browsers.
  runNpmScript("test", "Unit tests");
}

// ── build (the bundle gate) ──────────────────────────────────────────
async function runBuild() {
  log("Building min bundle...");
  separator();
  runNpmScript("build", "Build");
}

// ── Pure-CPU benchmarks ─────────────────────────────────────────────
async function runBench(extraFlags = []) {
  log("Running pure-CPU benchmarks...");
  separator();
  try {
    execSync(["node", "bench/run.mjs", ...extraFlags].filter(Boolean).join(" "), {
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

  // Serial file execution on purpose. Node's test runner parallelizes test
  // FILES by default, but every file here launches real Chromium instances;
  // a dozen concurrent browsers starve each other and push waitForShell past
  // its timeout (observed as intermittent shell-boot/`__loadIframe` failures
  // while every file passes in isolation). Shared CPU also skews the perf
  // reports these files print. One browser at a time is slower end to end but
  // deterministic.
  const testPaths = testFiles.map((f) => join(integrationDir, f)).join(" ");
  try {
    execSync(`node --test --test-concurrency=1 ${testPaths}`, {
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

  const record = flags.includes("--record") || targets_.includes("browser-bench:record");
  const compare = flags.includes("--compare") || targets_.includes("browser-bench:compare");

  let baseline = null;
  if (compare || record) {
    baseline = readBaseline(BENCH_BASELINE);
    if (!baseline && compare) {
      log("No baseline.json — run with --record first.");
      process.exit(2);
    }
  }

  const bundle = bundlePath ? readFileSync(bundlePath, "utf8") : undefined;
  // Recording defaults to 3 passes: a single pass is exactly the load-biased
  // sample this whole mechanism exists to avoid, so making it the default for
  // --record means the easy path is also the correct one.
  const repeat = Number(flags.find((m) => m.startsWith("--repeat="))?.slice(9)) || (record ? 3 : 1);

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
    // Record/compare go through the shared engine (platform/regression.mjs):
    // non-gateable rows keep their existing entry, overlapping-spread rows are
    // left unsealed when repeating, and one threshold governs both bench
    // families.
    const rows = allResults.map((r) => ({ name: r.name, value: r.medianMsPerOp, spread: r.spread, gateable: r.gateable }));
    const skipped = recordBaseline(BENCH_BASELINE, rows, { threshold: REGRESSION_THRESHOLD, repeat });
    log(`Baseline recorded: ${BENCH_BASELINE}`);
    for (const s of skipped) {
      console.log(`    SKIPPED   ${s}`);
    }
  } else if (compare && baseline) {
    const rows = allResults.map((r) => ({ name: r.name, value: r.medianMsPerOp, spread: r.spread, gateable: r.gateable }));
    if (compareBaseline(baseline, rows, { threshold: REGRESSION_THRESHOLD })) {
      process.exit(1);
    }
  }

  log("Browser benchmarks completed.");
  return allResults;
}

// ── HUD glass visual capture ────────────────────────────────────────
async function runVisual() {
  log("Running HUD glass visual capture...");
  separator();

  // Spawned as a child process rather than imported, so the tool keeps its
  // own exit-code contract (0 pass, 1 material invariant failed, 2 no
  // baseline) and this runner inherits it instead of re-deriving it. An
  // exception thrown across an import boundary would collapse those three
  // distinct outcomes into one non-zero code.
  try {
    execSync("node platform/visual/hud-glass.mjs --compare", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 300_000,
    });
    log("Visual capture passed.");
  } catch (err) {
    // execSync throws on non-zero exit. 2 means the baseline is missing, which
    // is a setup problem rather than a regression, so it is called out
    // separately instead of reading as a failed design check.
    if (err.status === 2) {
      log("Visual capture has no baseline — run `npm run visual:record` first.");
      process.exit(2);
    }
    log("Visual capture FAILED — the HUD glass changed materially.");
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────────
log(`PlayerForge platform runner — targets: ${targets_.join(", ")}`);

for (const target of targets_) {
  switch (target) {
    case "lint":
      await runLint();
      break;
    case "test":
      await runTests();
      break;
    case "build":
      await runBuild();
      break;
    case "bench":
      await runBench(flags.filter((f) => !f.startsWith("--repeat=")));
      break;
    case "bench:record":
      await runBench(flags.includes("--record") ? [...flags] : [...flags, "--record"]);
      break;
    case "bench:compare":
      await runBench(flags.includes("--compare") ? [...flags] : [...flags, "--compare"]);
      break;
    case "integration":
      await runIntegration();
      break;
    case "browser-bench":
    case "browser-bench:record":
    case "browser-bench:compare":
      await runBrowserBench();
      break;
    case "visual":
      await runVisual();
      break;
    default:
      console.error(`\n  Unknown target: ${target}`);
      console.error("  Usage: node platform/run.mjs [lint|test|build|bench|bench:record|bench:compare|integration|browser-bench|browser-bench:record|browser-bench:compare|visual|all|ci|verify]");
      process.exit(1);
  }
}

if (bundleInvoked) {
  for (const note of BUNDLE_NOTES[mode] ?? []) {
    log(note);
  }
}

separator();
log("Done.");
