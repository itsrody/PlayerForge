/**
 * Single source of truth for the shipped version.
 *
 * The banner's @version was a literal in esbuild.config.mjs while package.json
 * carried a second copy, under a comment calling the banner "the single
 * version source". It was not, and nothing checked it.
 *
 * The harness had already drifted on exactly this: ChromiumDriver hardcoded
 * `script: { version: '0.7.1-test' }` in two injection paths while package.json
 * sat at 0.7.2, so GM_info.script.version reported a version the project was no
 * longer on. Here it is derived instead, so that class of drift cannot return.
 *
 * Read as JSON rather than imported so the value stays a plain string and the
 * build cannot pull in module caching or an accidental code path from it.
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
 * Semver-ish guard. Managers order @version numerically to decide whether to
 * offer an upgrade, so a malformed value is not cosmetic: it can make a release
 * unpublishable, or make an existing install silently un-upgradable.
 */
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) {
  throw new Error(
    `package.json version "${PACKAGE_VERSION}" is not MAJOR.MINOR.PATCH; ` +
      `managers order @version numerically to decide upgrades`
  );
}