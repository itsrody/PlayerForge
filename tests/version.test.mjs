import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "dist", "playerforge.user.js");
const HARNESS = join(ROOT, "platform", "harness", "chromium.mjs");
const CONFIG = join(ROOT, "esbuild.config.mjs");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/**
 * Release integrity.
 *
 * The version lived in three places - a literal @version in the banner, a
 * second copy in package.json, and hardcoded '0.7.1-test' literals in both GM
 * injection paths - with nothing comparing them, and it had already drifted
 * while the project moved on to 0.7.2. package.json is now the single source;
 * the build config and the harness derive from it. These pin the failure
 * modes that remain.
 */

test("package.json version is MAJOR.MINOR.PATCH, which is what managers order on", () => {
  assert.match(
    PACKAGE_VERSION,
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    `version "${PACKAGE_VERSION}" is not orderable semver`
  );
});

test("the built bundle's @version matches package.json", (t) => {
  if (!existsSync(BUNDLE)) {
    t.skip("dist not built");
    return;
  }
  const banner = readFileSync(BUNDLE, "utf8").slice(0, 2048);
  const match = banner.match(/@version\s+(\S+)/);
  assert.ok(match, "bundle has no @version in its metadata header");
  assert.equal(match[1], PACKAGE_VERSION, "dist is stale: rebuild with `npm run build`");
});

test("the build config interpolates @version instead of hardcoding it", () => {
  // Regression guard for the literal @version era. The banner is a template
  // string, so a correct config carries a ${...} interpolation on the @version
  // line and no bare number.
  const src = readFileSync(CONFIG, "utf8");
  const match = src.match(/^\/\/ @version\s+(.+)$/m);
  assert.ok(match, "banner has no @version line");
  assert.doesNotMatch(
    match[1],
    /^\d/,
    "banner hardcodes a version literal: - the build throws on an unorderable package.json"
  );
  assert.match(match[1], /\$\{/, "banner @version should be interpolated, not literal");
});

test("the harness derives its stub version rather than hardcoding one", () => {
  // Regression guard for the 0.7.1-test drift. Read as source text because the
  // literal can sit in either injection path and a plain search catches both
  // without importing the harness (which would need a browser binary).
  //
  // Two things are deliberately allowed through: the `${STUB_SCRIPT_VERSION}`
  // interpolation (both injection paths are template strings executed inside
  // the browser, so the constant must be interpolated, not referenced), and the
  // sibling `version: '5.5.0'`, which is the emulated *manager* version and a
  // correct literal. So this matches hardcoded version NUMBERS only.
  const src = readFileSync(HARNESS, "utf8");
  const literals = src.match(/script:\s*\{\s*version:\s*['"](?!\$\{)[^'"]+['"]/g) ?? [];
  assert.deepEqual(
    literals,
    [],
    `harness hardcodes a script version literal: ${literals.join(", ")} - derive it from package.json`
  );
  assert.ok(
    src.includes("${STUB_SCRIPT_VERSION}"),
    "harness should interpolate GM_info.script.version from the derived constant"
  );
});

test("the build config still guards against an unorderable version", () => {
  // The guard lives in esbuild.config.mjs (the only runtime that consumes the
  // derived value), so a bad bump fails the build rather than reaching dist/.
  const guard = /^\s*throw new Error\(\s*`package\.json version .*not MAJOR\.MINOR\.PATCH/m;
  assert.match(readFileSync(CONFIG, "utf8"), guard, "semver guard missing from the build");
});
