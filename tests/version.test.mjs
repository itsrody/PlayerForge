import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../src/shared/version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "dist", "playerforge.user.js");
const HARNESS = join(ROOT, "platform", "harness", "chromium.mjs");

/**
 * Release integrity.
 *
 * The version lived in two places - a literal @version in the banner and
 * package.json - with nothing comparing them, and it had already drifted once:
 * the harness hardcoded '0.7.1-test' in both GM injection paths while the
 * project was on 0.7.2. These pin the failure modes that remain now that the
 * banner derives its value.
 */

test("PACKAGE_VERSION is MAJOR.MINOR.PATCH, which is what managers order on", () => {
  assert.match(
    PACKAGE_VERSION,
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    `version "${PACKAGE_VERSION}" is not orderable semver`
  );
});

test("version.js reflects package.json", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(PACKAGE_VERSION, pkg.version, "the derived source is broken");
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