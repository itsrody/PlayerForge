import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §5 invariant 1, structural half: "Zero steady-state main-thread cost when
 * idle — no rAF handle retained while idle".
 *
 * The page-side half (an idle shell mutates nothing) lives in
 * `platform/integration/idle-cost.test.mjs`, and the dynamic halves live
 * where the behaviour does: `tests/perf-diag.test.mjs` proves the frame loop
 * is not installed when debug is off and that teardown cancels it, and
 * `tests/scheduler.test.mjs` proves `yield_()` is one-shot with a backstop
 * rather than a re-arming loop.
 *
 * What neither can see is the *next* change. An idle loop is not a bug anyone
 * writes by accident; it is added for a legitimate reason in one file and
 * quietly becomes a permanent handle on the frame, so the guard here is the
 * inventory itself: the shipping tree owns exactly two rAF call sites, both
 * already pinned by a test that says what they are allowed to do. A third one
 * fails this file until someone writes down which test now covers it.
 *
 * The second half of the invariant — "profiler shows no markers between
 * transitions" — is a Gecko Profiler reading and stays manual. Firefox
 * exposes no layout, paint or longtask counters to content, so there is no
 * honest way to automate it from this side of the realm.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) jsFiles(path, out);
    else if (entry.endsWith(".js")) out.push(path);
  }
  return out;
}

const sources = new Map(
  jsFiles(join(ROOT, "src")).map((path) => [path.slice(ROOT.length + 1), readFileSync(path, "utf8")])
);

/** Files under src/ whose text matches, sorted, as paths relative to the root. */
const matching = (pattern) =>
  [...sources].filter(([, text]) => pattern.test(text)).map(([path]) => path).sort();

test("the shipping tree keeps exactly the two known rAF call sites", () => {
  assert.deepEqual(matching(/requestAnimationFrame\s*\(/), [
    "src/shared/diagnostics.js",
    "src/shared/scheduler.js"
  ], "a new rAF site needs its own test naming what keeps it off the idle path");
});

test("the only re-arming frame is the debug-gated diagnostics loop", () => {
  // `requestAnimationFrame(onFrame)` inside `onFrame` is the shape of a loop;
  // `requestAnimationFrame(() => {...})` is a one-shot that dies when its
  // callback runs. Only diagnostics may have the first — once to start the
  // loop and once to keep it going — and perf-diag.test.mjs pins the debug
  // gate and the teardown that stop it.
  const rearming = [];
  for (const [path, text] of sources) {
    for (const match of text.matchAll(/requestAnimationFrame\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      rearming.push({ path, callback: match[1] });
    }
  }
  assert.deepEqual(
    rearming.map((entry) => entry.callback),
    ["onFrame", "onFrame"],
    "a named callback is a loop; only the diagnostics watchdog may have one"
  );
  assert.deepEqual([...new Set(rearming.map((entry) => entry.path))], ["src/shared/diagnostics.js"]);
});

test("yield_() arms one frame, never from inside its own callback", () => {
  const scheduler = sources.get("src/shared/scheduler.js");
  assert.match(scheduler, /requestAnimationFrame\s*\(\s*\(\)\s*=>/, "the one-shot is an inline callback");
  assert.ok(
    !/requestAnimationFrame\s*\(\s*yield_/.test(scheduler),
    "yield_() must not be its own callback, which is how a loop starts"
  );
});

test("setInterval survives only as the panel's hold-to-repeat", () => {
  const sites = matching(/\bsetInterval\s*\(/);
  assert.deepEqual(sites, ["src/shell/chrome/panel.js"], "every other timer in this tree is one-shot");
  const occurrences = sources.get("src/shell/chrome/panel.js").match(/\bsetInterval\s*\(/g);
  assert.equal(occurrences.length, 1, "and only once, for the key-hold");
});
