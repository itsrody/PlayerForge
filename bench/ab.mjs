/**
 * Same-session A/B benchmarking.
 *
 * Why this exists: bench/baseline.json is a set of absolute ns/op numbers
 * recorded in one earlier session. A gate built on it cannot distinguish "this
 * refactor is slower" from "the machine is busier now" - and under load every
 * case inflates together, which is the signature of noise, not of a diff. The
 * symptom that motivated this was a uniform +43%..+75% across unrelated cases
 * on a codebase whose diff could not have touched all of them at once.
 *
 * So the gate compares two SOURCE TREES measured on the same machine, minutes
 * apart, interleaved: A (the working tree) and B (a git ref, HEAD by default).
 * Each side runs in its own process (see measure-side.mjs - the case files
 * share globalThis stubs), and the parent alternates which side goes first so
 * monotonic drift within the run cannot favour whoever is measured second.
 *
 * B is materialized with `git worktree add --detach` INSIDE the repo, so the
 * reference tree's bare imports (jsdom) still resolve through the repo's
 * node_modules by normal upward lookup.
 */
import { execFileSync } from "node:child_process";
import { rmSync, existsSync, copyFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUNDS = 3;
const REGRESSION_THRESHOLD = 1.2; // +20%

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function measureSide(casesDir) {
  const out = execFileSync(process.execPath, [join(HERE, "measure-side.mjs"), casesDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  return JSON.parse(out);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function runAB({ ref = "HEAD", root } = {}) {
  const worktree = join(root, ".ab-worktree");

  if (existsSync(worktree)) {
    rmSync(worktree, { recursive: true, force: true });
  }
  git(["worktree", "prune"], root);
  git(["worktree", "add", "--detach", worktree, ref], root);

  try {
    // Hold the timing engine constant across both sides. The engine is not
    // what is under test - the source is - and a ref whose bench/lib.mjs
    // predates the define()/measure() split would otherwise be timed by a
    // different methodology than the working tree, making the ratio
    // meaningless. The reference's own case files stay untouched.
    copyFileSync(join(root, "bench", "lib.mjs"), join(worktree, "bench", "lib.mjs"));

    const casesA = join(root, "bench", "cases");
    const casesB = join(worktree, "bench", "cases");
    const rounds = [[], []];

    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 === 0 ? [casesA, casesB] : [casesB, casesA];
      for (const [side, casesDir] of order.entries()) {
        rounds[side].push(measureSide(casesDir));
      }
    }

    const namesA = new Set(Object.keys(rounds[0][0]));
    const namesB = new Set(Object.keys(rounds[0][1]));
    const shared = [...namesA].filter((n) => namesB.has(n));

    const rows = shared.map((name) => {
      const a = median(rounds[0].map((r) => r[name]));
      const b = median(rounds[1].map((r) => r[name]));
      // A is the working tree under test and B the reference, so the ratio that
      // answers "did this change make it slower" is A/B. Reporting B/A here
      // would invert the gate and fail the run on an IMPROVEMENT.
      return { name, a, b, ratio: a / b };
    });

    return {
      rows,
      onlyA: [...namesA].filter((n) => !namesB.has(n)),
      onlyB: [...namesB].filter((n) => !namesA.has(n)),
      ref,
      worktreeLabel: relative(root, worktree)
    };
  } finally {
    // Leave no worktree registration behind: a stale entry in .git/worktrees
    // outlives the directory and confuses the next `git worktree` command.
    try {
      git(["worktree", "remove", "--force", worktree], root);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      git(["worktree", "prune"], root);
    }
  }
}

export function reportAB({ rows, onlyA, onlyB, ref }) {
  console.log(`\n  A/B vs ${ref}  (A = working tree, B = ${ref}), ${ROUNDS} interleaved rounds, one process per side`);
  console.log(`  ${"case".padEnd(44)} ${"A ns/op".padStart(11)} ${"B ns/op".padStart(11)}  ${"A/B".padStart(8)}`);
  console.log("  " + "-".repeat(80));

  let failed = false;
  for (const row of rows) {
    const pct = ((row.ratio - 1) * 100).toFixed(1);
    const mark = row.ratio > REGRESSION_THRESHOLD ? "REGRESSED" : row.ratio < 0.83 ? "improved" : "ok";
    if (mark === "REGRESSED") {
      failed = true;
    }
    console.log(
      `  ${mark.padEnd(9)} ${row.name.padEnd(44)} ${row.a.toFixed(0).padStart(11)} ${row.b.toFixed(0).padStart(11)}  ${pct > 0 ? "+" : ""}${pct}%`
    );
  }
  for (const name of onlyA) {
    console.log(`  ${"NEW".padEnd(9)} ${name}  (only in the working tree - not compared)`);
  }
  for (const name of onlyB) {
    console.log(`  ${"GONE".padEnd(9)} ${name}  (only in ${ref} - not compared)`);
  }
  console.log();
  return failed;
}

export { REGRESSION_THRESHOLD };
