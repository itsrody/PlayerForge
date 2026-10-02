/**
 * Single source of truth for the shipped version.
 *
 * The banner's @version used to be a literal here while package.json carried a
 * second copy, and the comment above it claimed this file was "the single
 * version source" - which was not true, and nothing checked it. The integration
 * suite could not catch a mismatch either: its GM stubs report
 * GM_info.script.version from package.json, and the assertions compare that
 * against `${STUB_SCRIPT_VERSION}-test`, so both sides moved together and the
 * tests passed either way. A release could have shipped a package.json claiming
 * one version and a banner claiming another with a fully green suite.
 *
 * So the banner is derived from package.json instead. One copy, one place to
 * bump, and the stale claim is now load-bearing rather than aspirational.
 *
 * Read as JSON rather than imported so the value stays a plain string and the
 * build cannot pick up module caching or an accidental code path from it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** @type {string} */
export const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(HERE, "..", "..", "package.json"), "utf8")
).version;

/**
 * Semver-ish guard. ScriptCat orders versions to decide whether to offer an
 * update, so a malformed value here is not a cosmetic problem: it can make an
 * upgrade unpublishable or silently un-installable for existing users.
 */
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) {
  throw new Error(
    `package.json version "${PACKAGE_VERSION}" is not MAJOR.MINOR.PATCH; ` +
      `ScriptCat orders @version numerically to decide upgrades`
  );
}