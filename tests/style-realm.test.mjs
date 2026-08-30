import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level invariants for the encapsulation restructure (NOT a CSS parse -
 * jsdom has no stylesheet engine). These pin the realm split documented in the
 * stylesheet header so a future edit can't silently re-export component rules
 * into the page: document-realm rules first, everything else inside the layer.
 */
const STYLES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "shell", "chrome", "styles.css");
const css = readFileSync(STYLES, "utf8");
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("stylesheet braces stay balanced (comment-stripped)", () => {
  const opens = (noComments.match(/{/g) || []).length;
  const closes = (noComments.match(/}/g) || []).length;
  assert.equal(opens, closes, "every opened block is closed");
});

test("document-realm rules precede the component layer", () => {
  const wrapStart = noComments.indexOf("@layer pf-hud");
  assert.ok(wrapStart > 0, "@layer pf-hud wraps the component surface");
  for (const rule of [".pf-shell {", "[data-pf-shell]:fullscreen {"]) {
    const idx = noComments.indexOf(rule);
    assert.ok(idx !== -1 && idx < wrapStart, `"${rule.trim()}" stays in the document realm, above @layer pf-hud`);
  }
});

test(".pf-hud-layer appears only as the @scope prelude", () => {
  const hudRefs = noComments.match(/\.pf-hud-layer/g) || [];
  assert.deepEqual(hudRefs, [".pf-hud-layer"], "no component rule may be anchored by a raw page-level class");
  const prelude = noComments.indexOf("@scope (.pf-hud-layer)");
  assert.ok(prelude > noComments.indexOf("@layer pf-hud"), "scope prelude anchors the HUD root inside the layer");
});

test("root-anchored chrome rules are written against :scope", () => {
  assert.ok(noComments.includes(":scope > .pf-panel-backdrop"), "backdrop uses :scope, not .pf-hud-layer");
  assert.ok(noComments.includes(":scope:has(.pf-panel.pf-open)"), "backdrop gate uses :scope:has");
});

test("@container / @media / @starting-style stay inside the layered scope", () => {
  const wrapStart = noComments.indexOf("@layer pf-hud");
  for (const at of ["@container pf-panel", "@media (pointer: coarse)", "@media (max-width: 520px)", "@starting-style"]) {
    const idx = noComments.indexOf(at);
    assert.ok(idx > wrapStart, `${at} lives inside @layer pf-hud`);
  }
});