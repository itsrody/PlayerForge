import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * §5 invariant "No self-rearming `postTask`" — structural half.
 *
 * §2.4's Trap 1 is the reason this row exists, and it is a measurement rather
 * than a rule of thumb: a 40-deep self-rearming `user-visible` `postTask` chain
 * was measured draining in 0.26ms with zero rAF callbacks in between, against
 * an idle rAF baseline of 25 frames per 200ms. The zero is starvation, not a
 * dead frame, so a tight self-rearming chain freezes paint and input for the
 * whole page.
 *
 * The row used to read "No `postTask` callback re-arms itself" with the
 * verification column repeating it verbatim, which is not a verification — and
 * it was also false as written. `context.js`'s ancestor handshake self-rearms
 * through `postTask` on purpose. What makes that safe, and what Trap 1 does not
 * license, is its `delay`: every iteration is ≥60ms apart, so it is
 * timer-shaped and interleaves, which is the same reason `setTimeout(0)` chains
 * are fine in the measurement above. The invariant that holds is therefore the
 * sharp one — **a `postTask` may re-arm itself only from a delayed task** — and
 * that is what this file pins.
 *
 * The inventory assertion is the load-bearing half, for the same reason
 * `tests/idle-guard.test.mjs` pins the rAF sites: a starvation chain is not a
 * bug anyone writes by accident. It appears as a reasonable "just retry on the
 * next task" in one file and becomes a permanent frame-handle thief. A new
 * `postTask` call site fails this file until someone writes down which of the
 * two shapes it is.
 *
 * Limitation, recorded rather than papered over: a callback passed as a private
 * field (`RenderGate` uses `postTask(this.#task, …)`) cannot be resolved to its
 * body by the scan below, so a self-arm inside one would not be caught here.
 * What does cover that shape is dynamic and lives with the behaviour —
 * `RenderGate.#running` refuses any re-arm from inside its own commit
 * (`render-gate.js:129`, asserted by `tests/render-gate.test.mjs`), so the gate
 * cannot starve regardless. The inventory assertion is what makes a new private
 * callback visible to review.
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

/**
 * The body of a named declaration, brace-matched, or null when the name is not
 * declared as a top-level-ish function/arrow we can resolve. Deliberately
 * simple: the tree uses three shapes (`function f() {}`, `const f = () => {}`,
 * `const f = function() {}`) and a fourth shape only needs a line here.
 */
function bodyOf(text, name) {
  const decl = new RegExp(
    `(?:function\\s+${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*)?\\()`,
    "g"
  );
  const match = decl.exec(text);
  if (!match) return null;
  const open = text.indexOf("{", match.index + match[0].length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * Every `postTask` that re-arms its own callback, with that re-arm's options
 * read out of the call itself. One implementation on purpose — an earlier
 * draft had the site scan and the delay check as two loops, they drifted, and
 * the delay check silently indexed a function body with an offset taken from
 * the whole file, so it reported the one *correct* self-arm in the tree as
 * tight. Sharing the scan is what keeps the two assertions in agreement.
 */
function selfArms() {
  const found = [];
  for (const [path, text] of sources) {
    for (const match of text.matchAll(/(?:^|[^.\w])postTask\(\s*([A-Za-z_$][\w$]*)\s*,/g)) {
      const name = match[1];
      const body = bodyOf(text, name);
      if (!body) continue;
      const rearm = new RegExp(`postTask\\(\\s*${name}\\s*,`).exec(body);
      if (!rearm) continue;
      // The options object of the re-arm: from just past its comma to the paren
      // that closes the call, balanced so a nested call cannot end it early.
      const from = rearm.index + rearm[0].length;
      let depth = 1;
      let end = from;
      for (; end < body.length && depth > 0; end += 1) {
        if (body[end] === "(") depth += 1;
        else if (body[end] === ")") depth -= 1;
      }
      const options = body.slice(from, end);
      found.push({
        site: `${path}:${name}`,
        delayed: /\bdelay\s*:/.test(options),
        delay: (/\bdelay\s*:\s*([^,}\n]+)/.exec(options) || [])[1]?.trim() ?? null
      });
    }
  }
  return found;
}

test("the shipping tree keeps exactly the known postTask call sites", () => {
  const files = [...sources]
    .filter(([, text]) => /(?:^|[^.\w])postTask\s*\(/.test(text))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(files, [
    "src/kernel/kernel.js",
    "src/kernel/lifecycle.js",
    "src/shared/context.js",
    "src/shared/dom-manager.js",
    "src/shared/render-gate.js",
    "src/shared/scheduler.js"
  ], "a new postTask site needs a line here saying whether it self-arms and whether it is delayed");
});

test("the only self-rearming postTask in the tree is the context handshake retry", () => {
  assert.deepEqual(
    selfArms().map((entry) => entry.site),
    ["src/shared/context.js:attempt"],
    "any second self-arming postTask is a Trap 1 starvation chain until proven otherwise"
  );
});

test("every self-rearming postTask is delayed, which is what makes it safe", () => {
  // The distinction Trap 1 turns on. A self-arm with no delay re-arms inside one
  // task turn and never yields to rendering; a self-arm with a real delay is a
  // timer that interleaves, exactly as `setTimeout(0)` chains do in the Trap 1
  // measurement. So this is asserted over *every* self-arm found rather than
  // over the one site we expect — a new tight self-arm has to fail here.
  assert.deepEqual(
    selfArms().filter((entry) => !entry.delayed).map((entry) => entry.site),
    [],
    "a self-rearming postTask with no delay is Trap 1's starvation chain"
  );
});

test("the context handshake retry is backed off, not immediate", () => {
  const text = sources.get("src/shared/context.js");
  assert.match(text, /const CTX_RETRY_BACKOFF = \[60,/, "the first retry must not be immediate");
  assert.match(
    text,
    /retryHandle = postTask\(attempt, \{\s*\n\s*delay: base \+ Math\.floor/,
    "the self-rearm must go through the backed-off delay, not a bare re-arm"
  );
  assert.equal(
    selfArms()[0].delay,
    "base + Math.floor(Math.random() * (CTX_RETRY_JITTER_MS + 1))",
    "the floor is CTX_RETRY_BACKOFF[0], so no iteration is ever immediate"
  );
});

test("RenderGate cannot re-arm from inside its own commit", () => {
  // The one self-rearm shape the static scan cannot see is a private-field
  // callback, and the gate is exactly that (`postTask(this.#task, …)`). What
  // rules out starvation there is the `#running` latch, checked before the
  // priority comparison so no priority label can get past it.
  const gate = sources.get("src/shared/render-gate.js");
  assert.match(gate, /if \(this\.#running\) \{\s*\n\s*return false;/, "the latch must short-circuit request()");
  assert.match(
    gate,
    /#run\(\) \{\s*\n\s*this\.#running = true;/,
    "the latch must be set for the whole commit, not just its first line"
  );
  assert.ok(
    !/postTask\(\s*attempt|postTask\(\s*run\b/.test(gate),
    "the gate schedules from request(), never from the task it runs"
  );
});
