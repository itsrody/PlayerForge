import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Realm-surface contract: everything the userscript touches in the page
 * realm goes through DOM nodes and DOM events, never through page code.
 *
 * Two pins, both file scans in the doc-refs tradition (which already reads
 * the tree to keep cites honest):
 *
 *   1. No string-to-DOM sinks and no Xray-unwrapping primitives anywhere in
 *      src/. The shell builds with createElement/DOMParser/textContent; a
 *      single innerHTML assignment would execute page-controlled markup in
 *      our realm, and wrappedJSObject/cloneInto/exportFunction would punch
 *      through the Xray vision the isolated userscript realm relies on.
 *   2. The raw document/window listener census: every addEventListener on
 *      document or window that does NOT route through DOMManager is listed
 *      below with its reason. A new bare listener fails here until it is
 *      either routed through a manager or recorded as a deliberate
 *      singleton - the census is the point, not the count.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      jsFiles(path, out);
    } else if (entry.endsWith(".js")) {
      out.push(path);
    }
  }
  return out;
}

const SINK_PATTERNS = [
  /\.innerHTML/,
  /\.outerHTML/,
  /insertAdjacentHTML/,
  /document\.write/,
  /wrappedJSObject/,
  /cloneInto/,
  /exportFunction/,
  /new Function/,
  /(^|[^.\w$])eval\(/,
];

test("src/ holds no string-to-DOM sinks or realm-escape primitives", () => {
  const violations = [];
  for (const file of jsFiles(ROOT)) {
    const text = readFileSync(file, "utf8");
    // Comments may name the forbidden thing (toolbox.js documents why it
    // uses DOMParser "never innerHTML"); only code counts.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'])\/\/.*$/gm, "$1");
    for (const pattern of SINK_PATTERNS) {
      if (pattern.test(code)) {
        violations.push(`${file}: ${pattern}`);
      }
    }
  }
  assert.deepEqual(violations, [], "page markup must never execute in our realm");
});

const RAW_LISTENERS = [
  // Media-event tap factory: capture listeners with an explicit unsubscribe,
  // bound to the caller's scope at every call site.
  "src/kernel/sdk.js :: document :: loadeddata",
  "src/kernel/sdk.js :: document :: play",
  // Boot probe: one-shot static sweep trigger.
  "src/kernel/discovery.js :: document :: DOMContentLoaded",
  // First-run hint cancels: once + hint-signal bound.
  "src/entry.js :: document :: pointerdown",
  "src/entry.js :: document :: keydown",
  "src/entry.js :: document :: wheel",
  // Hidden-tab deferred flush resume: bound to the defer scope it releases.
  "src/shared/dom-manager.js :: document :: visibilitychange",
  // Ancestor/iframe bridge: message channel listeners, scope-bound.
  "src/shared/context.js :: window :: message",
  // Bridge router: the second message listener dispatches pf:-typed traffic
  // to sibling routes (kept separate so one route's throw cannot eat the next).
  "src/shared/context.js :: window :: message",
  // Keyboard broker: the one document pair for the whole page, armed only
  // while an engine is registered.
  "src/shell/inputs/forge.js :: document :: keydown",
  "src/shell/inputs/forge.js :: document :: keyup",
  // Session-end pointer releases outside the zone: forge scope signal.
  "src/shell/inputs/forge.js :: window :: pointerup",
  "src/shell/inputs/forge.js :: window :: pointercancel",
  // Panel drag releases + guarded fallbacks: panel scope signal.
  "src/shell/chrome/panel.js :: window :: pointerup",
  "src/shell/chrome/panel.js :: window :: pointercancel",
  "src/shell/chrome/panel.js :: document :: keydown",
  "src/shell/chrome/panel.js :: document :: pointerdown",
];

test("every raw document/window listener is a recorded singleton", () => {
  const found = [];
  for (const file of jsFiles(ROOT)) {
    const rel = file.slice(file.indexOf("src/"));
    const text = readFileSync(file, "utf8");
    const pattern = /(document|window)\.addEventListener\(\s*["']([^"']+)["']/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      found.push(`${rel} :: ${match[1]} :: ${match[2]}`);
    }
  }
  found.sort();
  assert.deepEqual(found, [...RAW_LISTENERS].sort());
});
