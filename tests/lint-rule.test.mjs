import test from "node:test";
import assert from "node:assert/strict";
import { Linter } from "eslint";
import config from "../eslint.config.js";
import { pfRules } from "../platform/eslint-rules.mjs";

/**
 * Pins §5's "No forced synchronous layout" invariant, whose stated
 * verification is a lint rule. Two things can rot without this file: the rule
 * itself (it would keep parsing and stop firing, and nothing else in the tree
 * would notice - a forced layout is not a wrong answer, just a slow one), and
 * the wiring in eslint.config.js (the rule exists but nothing runs it over
 * src/).
 *
 * The rule block is read back out of the imported config rather than restated
 * here, so what is exercised is what `npm run lint` runs.
 */
const layoutBlock = config.find((entry) => entry.rules?.["pf/no-forced-layout"]);
assert.ok(layoutBlock, "eslint.config.js registers pf/no-forced-layout");

const run = (source) => {
  const linter = new Linter();
  // The filename has to match the block's `files` glob or the config never
  // applies and every "should report" case below passes vacuously.
  return linter.verify(source, [layoutBlock], "src/__fixture.js");
};

test("the forced-layout rule is an error, and only over src/", () => {
  assert.equal(layoutBlock.rules["pf/no-forced-layout"], "error");
  assert.deepEqual(layoutBlock.files, ["src/**/*.js"]);
  assert.equal(config.filter((entry) => entry.rules?.["pf/no-forced-layout"]).length, 1);
  assert.ok(layoutBlock.plugins.pf.rules["no-forced-layout"].create, "the plugin is wired, not just named");
  assert.equal(typeof pfRules["no-forced-layout"].create, "function");
});

test("a layout read after a layout write in one task is reported", () => {
  const messages = run(`
    export function fit(el) {
      el.style.width = "10px";
      return el.getBoundingClientRect().width;
    }
  `);
  assert.equal(messages.length, 1, JSON.stringify(messages));
  assert.equal(messages[0].ruleId, "pf/no-forced-layout");
  assert.match(messages[0].message, /el\.style\.width/);
});

test("every write shape dirties the tree, not just style assignments", () => {
  const writes = [
    `el.style.top = "0";`,
    `el.style.setProperty("--x", "1");`,
    `el.style.cssText = "top:0";`,
    `el.className = "pf-x";`,
    `el.classList.add("pf-x");`,
    `el.hidden = true;`,
    `el.textContent = "x";`,
    `el.setAttribute("class", "pf-x");`,
    `el.append(document.createElement("i"));`,
    `el.remove();`
  ];
  for (const write of writes) {
    const messages = run(`export function f(el) { ${write} return el.offsetLeft; }`);
    assert.equal(messages.length, 1, `${write} -> ${JSON.stringify(messages)}`);
  }
});

test("a non-layout attribute write is not one", () => {
  const messages = run(`
    export function f(el) {
      el.setAttribute("aria-label", "x");
      return el.clientHeight;
    }
  `);
  assert.deepEqual(messages, []);
});

test("reading layout before writing it is the cheap order, and stays allowed", () => {
  const messages = run(`
    export function f(el) {
      const width = el.offsetWidth;
      el.style.width = width + "px";
      return width;
    }
  `);
  assert.deepEqual(messages, []);
});

test("an await boundary puts the read in a later task", () => {
  const messages = run(`
    export async function f(el) {
      el.style.width = "10px";
      await Promise.resolve();
      return el.getBoundingClientRect().width;
    }
  `);
  assert.deepEqual(messages, []);
});

test("the awaited argument is evaluated before the boundary, so it still counts", () => {
  const messages = run(`
    export async function f(el) {
      el.style.width = "10px";
      await Promise.resolve(el.getBoundingClientRect().width);
    }
  `);
  assert.equal(messages.length, 1, JSON.stringify(messages));
});

test("a nested function is its own task, so the callback does not inherit the write", () => {
  const messages = run(`
    export function f(el) {
      el.classList.add("pf-x");
      return [1].map(() => el.clientHeight)[0];
    }
  `);
  assert.deepEqual(messages, []);
});

test("a geometry read off a resolved-value style read counts, a plain one does not", () => {
  assert.equal(run(`
    export function f(el) {
      el.style.width = "1px";
      return getComputedStyle(el).width;
    }
  `).length, 1, "geometry off getComputedStyle flushes");
  assert.equal(run(`
    export function f(el) {
      el.style.width = "1px";
      return getComputedStyle(el).position;
    }
  `).length, 0, "position does not");
  assert.equal(run(`
    export function f(video) {
      video.width = 640;
      return video.width;
    }
  `).length, 0, "video.width reflects an attribute, it reads no layout");
});
