import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../src/shared/version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "dist", "playerforge.user.js");

/**
 * Release integrity.
 *
 * The version used to exist in two places - a literal @version in the banner
 * and package.json - with nothing comparing them. The integration suite could
 * not have caught a mismatch: its GM stubs read GM_info.script.version from
 * package.json and the assertions compare that against a string derived from
 * the same constant, so both sides moved together.
 *
 * These tests pin the two things that can still go wrong now that the banner
 * derives its value: a stale dist that was not rebuilt after a bump, and a
 * version string ScriptCat would refuse to order.
 */

test("PACKAGE_VERSION is MAJOR.MINOR.PATCH, which is what ScriptCat orders on", () => {
  assert.match(
    PACKAGE_VERSION,
    /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
    `version "${PACKAGE_VERSION}" is not orderable semver`
  );
});

test("version.js reads the same value package.json holds", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(
    PACKAGE_VERSION,
    pkg.version,
    "PACKAGE_VERSION does not reflect package.json - the derived source is broken"
  );
});

test("the built bundle's @version matches package.json", (t) => {
  // Skipped rather than failed on a fresh clone: dist is committed, but a
  // checkout that predates a bump should report "not built yet", not a
  // misleading version failure.
  if (!existsSync(BUNDLE)) {
    t.skip("dist not built");
    return;
  }
  const banner = readFileSync(BUNDLE, "utf8").slice(0, 2048);
  const match = banner.match(/@version\s+(\S+)/);
  assert.ok(match, "bundle has no @version in its metadata header");
  assert.equal(
    match[1],
    PACKAGE_VERSION,
    "dist is stale: rebuild with `npm run build` so the shipped @version matches package.json"
  );
});