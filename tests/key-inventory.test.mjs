import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Key-inventory guard: every storage/config/event name in the tree has one
 * owning constant, so a typo'd string cannot silently fork a setting, a
 * store, or an event channel. A bare literal in a config access splits the
 * configs document (the writer and the reader never meet); a bench naming
 * an event src/ never fires desyncs the measurement from the product.
 *
 * Two inventories, both fail-closed on new entries:
 * config access takes only the legacy "firstRun" literal (mid-migration,
 * swept on read) or a `${PREFIX}.` template off a closed constant;
 * bench "pf:" event names must already exist in src/.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function jsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      jsFiles(path, out);
    } else if (entry.name.endsWith(".js")) {
      out.push(path);
    }
  }
  return out;
}

const sources = new Map(
  jsFiles(join(ROOT, "src")).map((path) => [path.slice(ROOT.length + 1), readFileSync(path, "utf8")])
);
const benchSources = new Map(
  jsFiles(join(ROOT, "platform", "browser-bench")).map((path) => [path.slice(ROOT.length + 1), readFileSync(path, "utf8")])
);

const CONFIG_CALL = /(?:getConfigValue|setConfigValue|setConfigFields|deleteConfigField|configStore\.(?:adopt|get|set))\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;

test("config access takes no new bare literals", () => {
  // The one grandfathered literal is the legacy firstRun field: read once,
  // swept in the same boot, never written. Anything else forks the configs
  // document into a key no reader shares.
  const found = new Set();
  for (const [path, text] of sources) {
    for (const match of text.matchAll(CONFIG_CALL)) {
      const arg = match[1];
      if ((arg.startsWith('"') || arg.startsWith("'")) && arg !== '"firstRun"' && arg !== "'firstRun'") {
        found.add(`${path}: ${arg}`);
      }
    }
  }
  assert.deepEqual([...found], [], "a bare config key forks the store - use a constant");
});

test("templated config keys build off closed prefixes only", () => {
  // `${CONFIG_PREFIX}.${key}` (filter names, closed list) and
  // `${SETTINGS_PREFIX}.${key}` (schema keys, coerced): any other base
  // is an unlisted namespace.
  const found = new Set();
  for (const [path, text] of sources) {
    for (const match of text.matchAll(CONFIG_CALL)) {
      const arg = match[1];
      if (!arg.startsWith("`")) {
        continue;
      }
      const base = /^\$\{([A-Za-z_$][A-Za-z0-9_$]*)\}/.exec(arg.slice(1));
      if (!base || (base[1] !== "CONFIG_PREFIX" && base[1] !== "SETTINGS_PREFIX")) {
        found.add(`${path}: ${arg.slice(0, 40)}`);
      }
    }
  }
  assert.deepEqual([...found], [], "templated config keys must hang off CONFIG_PREFIX or SETTINGS_PREFIX");
});

test("bench event names already exist in src", () => {
  // Bench ops serialize into the page, so they cannot import the event
  // table - but a literal src/ never fires desyncs the measurement, so
  // every bench "pf:" name must resolve against the shipping set.
  const known = new Set();
  for (const text of sources.values()) {
    for (const match of text.matchAll(/"pf:[A-Za-z-]+"/g)) {
      known.add(match[0].slice(1, -1));
    }
  }
  const stray = new Set();
  for (const [path, text] of benchSources) {
    for (const match of text.matchAll(/"pf:[A-Za-z-]+"/g)) {
      const name = match[0].slice(1, -1);
      if (!known.has(name)) {
        stray.add(`${path}: ${name}`);
      }
    }
  }
  assert.deepEqual([...stray], [], "bench events must name events src/ fires");
});
