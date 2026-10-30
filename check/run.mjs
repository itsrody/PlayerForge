#!/usr/bin/env node
/**
 * check/run.mjs - the repo's one testing interface.
 *
 * Gates run in order and stop at the first failure, because a later gate fed
 * broken input produces noise, not signal:
 *
 *   1. syntax  - parse-only V8 check of every src module
 *   2. flaws   - repo ESLint + isolated module-import smoke
 *   3. bundle  - real esbuild build + artifact shape validation
 *   4. browser - real native Firefox running the real bundle: boot, the
 *                gesture contract, real playback, panel plumbing
 *
 * Usage:
 *   node check/run.mjs              # all gates, in order
 *   node check/run.mjs browser      # a single gate (browser implies bundle)
 *   node check/run.mjs syntax flaws # an explicit combination
 */
import { banner, row, verdict, fatal } from "./lib/report.mjs";
import { ensureFirefoxDriver } from "./lib/driver.mjs";

const GATES = [
  ["syntax", "./stages/syntax.mjs", null],
  ["flaws", "./stages/flaws.mjs", null],
  ["bundle", "./stages/bundle.mjs", null],
  ["browser", "./stages/browser.mjs", "bundle"]
];

function usage() {
  console.error(`Usage: node check/run.mjs [${GATES.map((g) => g[0]).join("|")}|all ...]`);
}

const args = process.argv.slice(2);
const requested = [];
for (const arg of args.length > 0 ? args : ["all"]) {
  if (arg === "all") {
    requested.push(...GATES.map((g) => g[0]));
    continue;
  }
  if (GATES.find(([name]) => name === arg) === undefined) {
    console.error(`Unknown gate: ${arg}`);
    usage();
    process.exit(1);
  }
  requested.push(arg);
}

// Canonical gate order: deduping and a stable sort turn "browser bundle" into
// "bundle browser" instead of failing the precondition hunt in midstream.
const order = (g) => GATES.findIndex(([name]) => name === g);
const steps = [...new Set(requested)].sort((a, b) => order(a) - order(b));

// browser evaluates the bundle artifact; make sure it exists no matter how
// the gate was selected.
if (steps.includes("browser") && !steps.includes("bundle")) {
  steps.unshift("bundle");
}

const runStart = Date.now();
for (const name of steps) {
  const [, modulePath] = GATES.find(([g]) => g === name);
  banner(`gate ${name}`);
  try {
    if (name === "browser") {
      // Fail fast on a missing browser/driver pair; geckodriver needs no
      // version-matched major, so the probe informs and brew-heals an empty
      // disk, never blocks on a mismatch.
      ensureFirefoxDriver();
    }
    const { run } = await import(modulePath);
    const { rows, ok } = await run();
    row(rows);
    if (!ok) {
      fatal(name, new Error("gate failed"));
      process.exit(1);
    }
    console.log();
  } catch (err) {
    fatal(name, err);
    process.exit(1);
  }
}

if (!verdict(`${steps.join(" + ")}`, { failed: 0, skipped: 0 }, Date.now() - runStart)) {
  process.exit(1);
}
