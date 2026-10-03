import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the version drift §8 carried forward: `@version` in the banner and
 * `package.json` are separately maintained, and nothing derived one from the
 * other. The runtime reports `GM_info.script.version`, so the banner is what
 * an installed copy claims to be; package.json is what the release notes and
 * the version bump itself act on. Two hand-written numbers, plus the copy of
 * the package version package-lock.json keeps for itself - which drifted to
 * 0.7.0 and stayed there until the 2.0 release looked.
 *
 * The banner is read from its source in esbuild.config.mjs (the single version
 * source, per that file's own comment) and from the committed artifact in
 * dist/. The artifact is checked too because §8's policy is that dist is
 * regenerated at release time rather than on incidental rebuilds - which means
 * a bump without a rebuild leaves the committed bundle reporting the old
 * number, and that is exactly the drift this file exists to catch. A gate run
 * rebuilding dist is harmless: it rebuilds from the same banner the source
 * assertion already pinned.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The banner's @version value, or null when the file has no such line. */
function bannerVersion(file) {
  const match = readFileSync(join(ROOT, file), "utf8").match(/^\s*\/\/\s*@version\s+(\S+)$/m);
  return match ? match[1] : null;
}

test("the banner's @version and package.json version are the same number", () => {
  const banner = bannerVersion("esbuild.config.mjs");
  assert.ok(banner, "esbuild.config.mjs carries a // @version line");
  assert.equal(banner, JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
});

test("the committed dist bundle reports the version it was built with", () => {
  const banner = bannerVersion("esbuild.config.mjs");
  assert.ok(banner, "esbuild.config.mjs carries a // @version line");
  assert.equal(bannerVersion("dist/playerforge.user.js"), banner);
});

test("the banner declares @version exactly once", () => {
  const source = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf8");
  const lines = source.match(/^\s*\/\/\s*@version\s.*$/gm) ?? [];
  assert.equal(lines.length, 1, `expected one // @version line, found ${lines.length}`);
});

test("package-lock.json carries the same version as the package it locks", () => {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  // The lock keeps its own copy of the package version in two places, and
  // neither is derived from package.json - which is how the 2.0 release found
  // it still saying 0.7.0 from an older bump.
  assert.equal(lock.version, version, "the lockfile's top-level version");
  assert.equal(lock.packages[""].version, version, "the lockfile's root package version");
});
