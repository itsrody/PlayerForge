import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Contract-reference guard: every `file:line` cite in docs/ARCHITECTURE.md
 * (plus the live ones in src/tests/platform) resolves to the anchor it
 * claims to point at.
 *
 * Line numbers rot on every nearby edit — one change shifted all of shell.js
 * by +7, and a hygiene pass corrected fourteen cites at once — while the
 * prose around them keeps reading as true. Symbols alone do not fix it
 * either: `gmSetValue(KEYS.resume` appears three times in resume.js, so a
 * file+symbol cite is ambiguous exactly where precision matters. What fixes
 * it is making drift fail: each cite below pins its file, its line, and a
 * distinctive anchor that must sit on that line, and the completeness check
 * after it requires every cite the contract carries to be pinned here. A new
 * cite without an anchor fails; a moved line fails; both force the numbers
 * back to honest in the same change.
 *
 * External paths (the Violentmonkey sources quoted by hash, e.g. in
 * platform/harness) are deliberately out of scope: nothing in this tree can
 * keep them honest.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REFS = [
  // docs/ARCHITECTURE.md cites, in doc order.
  { file: "src/shell/resume.js", line: 685, anchor: "IntersectionObserver" },
  { file: "src/shell/media.js", line: 265, anchor: "export function claimMediaSession" },
  { file: "src/shell/shell.js", line: 367, anchor: "createActivity({" },
  { file: "src/shell/resume.js", line: 702, anchor: "createActivity({" },
  { file: "src/shared/shadow.js", line: 192, anchor: "fsGate = createActivity({" },
  { file: "src/shared/context.js", line: 637, anchor: "postTask(attempt" },
  { file: "src/shell/chrome/panel.js", line: 116, anchor: "setInterval" },
  { file: "src/kernel/contract.js", line: 21, anchor: "SHELL_MARKER" },
  { file: "esbuild.config.mjs", line: 173, anchor: "fingerprint" },
  { file: "src/shell/inputs/forge.js", line: 855, anchor: "ResizeObserver" },
  { file: "src/shared/status-manager.js", line: 70, anchor: "PIP" },
  { file: "src/shared/status-manager.js", line: 461, anchor: "VISIBLE or BACKGROUND" },
  { file: "src/shell/resume.js", line: 686, anchor: "new IntersectionObserver" },
  { file: "src/shared/status-manager.js", line: 363, anchor: "STATUS_EVENT" },
  { file: "src/shell/shell.js", line: 515, anchor: "status.subscribe" },
  { file: "src/shell/shell.js", line: 642, anchor: "destroy() {" },
  { file: "src/shell/shell.js", line: 420, anchor: "this.#gate = new RenderGate" },
  { file: "src/shell/shell.js", line: 507, anchor: "const gate = new RenderGate" },
  { file: "src/shell/chrome/panel.js", line: 293, anchor: "#compactGate = new RenderGate" },
  { file: "src/shell/chrome/toast.js", line: 123, anchor: "this.#gate = new RenderGate" },
  { file: "tests/scope.test.mjs", line: 76, anchor: "parent.child()" },
  { file: "src/shell/resume.js", line: 269, anchor: "gmSetValue(KEYS.resume" },
  { file: "tests/resume-tracker.test.mjs", line: 268, anchor: "wall floor gates" },
  // Live cites in src/tests/platform (not the contract, but the same rot).
  { file: "src/shell/chrome/inject.js", line: 88, anchor: "child ever changes index" },
  { file: "src/shell/shell.js", line: 682, anchor: "this.#onDestroy?.(this)" },
  { file: "src/shared/render.js", line: 140, anchor: "if (this.#running)" },
  { file: "src/shell/inputs/actions.js", line: 552, anchor: "x ** SCRUB_EXPONENT" },
  { file: "src/shell/inputs/forge.js", line: 983, anchor: "#swipeDirection" },
  { file: "src/shell/inputs/forge.js", line: 984, anchor: "#swipeBaseTransform" },
];

function lineOf(file, line) {
  const text = readFileSync(join(ROOT, file), "utf8").split("\n");
  assert.ok(
    line >= 1 && line <= text.length,
    `${file}:${line} is past the end of the file (${text.length} lines)`
  );
  return text[line - 1];
}

test("every pinned contract reference resolves to its anchor", () => {
  for (const { file, line, anchor } of REFS) {
    assert.ok(
      lineOf(file, line).includes(anchor),
      `${file}:${line} no longer contains "${anchor}" - move the cite with the code`
    );
  }
});

test("every file:line cite the contract carries is pinned here", () => {
  // Bare basenames in prose ("shell.js:481") resolve against the table by
  // suffix: basenames are unique across the pinned set, and a second file
  // sharing one would force fully-qualified cites instead.
  const pinned = new Set(REFS.map(({ file, line }) => `${basename(file)}:${line}`));
  const doc = readFileSync(join(ROOT, "docs", "ARCHITECTURE.md"), "utf8");
  const missing = [];
  for (const match of doc.matchAll(/[\w./-]+\.(mjs|js|css|json):(\d+)/g)) {
    const key = `${basename(match[0].split(":")[0])}:${match[2]}`;
    if (!pinned.has(key) && !missing.includes(key)) {
      missing.push(key);
    }
  }
  assert.deepEqual(missing, [], "new contract cites need {file, line, anchor} rows above");
});
