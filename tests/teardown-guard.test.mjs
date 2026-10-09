import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Teardown vocabulary guard: every teardown in the tree goes through Scope.
 *
 * A bare `new AbortController()` is a second teardown vocabulary beside
 * `Scope.dispose()`: it bypasses the disposed flag and any registered
 * disposer, and a reader can no longer tell which rule a given teardown
 * follows. The primitive holds its controller rather than extending it (see
 * `src/shared/scope.js` for why late binding matters), so the vocabulary
 * rule is enforced here, at the inventory level, the way
 * `tests/posttask-guard.test.mjs` pins the postTask sites.
 *
 * Exactly two constructions survive, and both are the rule's boundary rather
 * than exceptions to it: `scope.js` itself (the primitive owns the one
 * controller everything else shares), and `render-gate.js`, whose controller
 * is a child of the session scope that a bare signal parameter cannot
 * express — giving the gate a Scope would mean widening its constructor for
 * no behavioural difference. A new `new AbortController()` anywhere else
 * fails this file until someone writes down why it cannot be a Scope.
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

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx <= 0) {
        return line;
      }
      const before = line.slice(0, idx);
      return before.trimEnd().endsWith(":") ? line : before;
    })
    .join("\n");
}

test("the shipping tree constructs AbortController in exactly two places", () => {
  const files = jsFiles(join(ROOT, "src"))
    .filter((path) => /new AbortController\(\)/.test(stripComments(readFileSync(path, "utf8"))))
    .map((path) => path.slice(ROOT.length + 1))
    .sort();
  assert.deepEqual(files, [
    "src/shared/render-gate.js",
    "src/shared/scope.js"
  ], "a new AbortController construction needs a line here saying why it cannot be a Scope");
});
