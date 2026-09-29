import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the capability manifest (platform/capabilities.json).
 *
 * The point of this file is that the fork's platform assumptions are data,
 * not prose. A comment can drift silently; a manifest entry that names a file
 * which no longer exists, or a grant that is declared but not in the built
 * header, fails the build.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "platform", "capabilities.json"), "utf8"));
const esbuildConfig = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf8");

/** Every `// @grant X` line in the userscript banner. */
function declaredGrants() {
  return [...esbuildConfig.matchAll(/^\/\/ @grant\s+(\S+)/gm)].map((m) => m[1]).sort();
}

/**
 * Strip comments so the retirement guard reads CODE, not prose. The comment
 * that explains why a capability was retired is exactly what we want to keep -
 * it is the guard tripping on its own documentation that would push someone to
 * delete the explanation instead of the usage.
 *
 * `//` is only a comment when the preceding character is not `:` , so a URL in
 * a string ("https://...") survives.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      if (idx <= 0) {
        return line;
      }
      const before = line.slice(0, idx);
      return before.trimEnd().endsWith(":") ? line : before;
    })
    .join("\n");
}

/** Recursively collect source files under a repo-relative directory (or the
 *  single file itself), as repo-relative paths. */
function sourceFiles(relPath) {
  const abs = join(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`manifest names a path that does not exist: ${relPath}`);
  }
  if (!statSync(abs).isDirectory()) {
    return [relPath];
  }
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(mjs|js|css)$/.test(entry.name)) {
      continue;
    }
    out.push(join(entry.parentPath, entry.name).slice(ROOT.length + 1).replace(/\\/g, "/"));
  }
  return out;
}

test("every manifest capability points at files that exist", () => {
  assert.ok(manifest.capabilities.length > 0, "the manifest declares capabilities");
  for (const capability of manifest.capabilities) {
    assert.ok(capability.id, "capability has an id");
    assert.ok(capability.summary, `${capability.id} explains what it is for`);
    for (const used of capability.usedBy) {
      assert.ok(existsSync(join(ROOT, used)), `${capability.id}: usedBy ${used} exists`);
    }
    if (capability.verifiedBy) {
      assert.ok(existsSync(join(ROOT, capability.verifiedBy)), `${capability.id}: verifiedBy ${capability.verifiedBy} exists`);
    }
  }
});

test("no capability depends on a Firefox newer than the target floor", () => {
  for (const capability of manifest.capabilities) {
    assert.ok(
      capability.shipsInFirefox <= manifest.target.minFirefox,
      `${capability.id} ships in Firefox ${capability.shipsInFirefox}, above the ${manifest.target.minFirefox} floor`
    );
  }
});

test("declared grants and the userscript banner agree exactly", () => {
  // esbuild.config.mjs's banner is copied verbatim into the built header, so
  // it - not dist/, which may predate the change being tested - is the single
  // source of truth for what the script asks the manager for.
  const declared = manifest.grants.map((g) => g.api).sort();
  assert.deepEqual(
    declaredGrants(),
    declared,
    "manifest grants must match the @grant lines in esbuild.config.mjs exactly - no undeclared permission, no dead declaration"
  );
});

test("every grant states why the manager API is required", () => {
  for (const grant of manifest.grants) {
    assert.ok(grant.why?.trim(), `${grant.api} explains what the page cannot do without it`);
  }
});

test("retired capabilities do not reappear", () => {
  for (const retired of manifest.retired) {
    const pattern = new RegExp(retired.matchPattern);
    for (const rel of retired.mustNotAppearIn) {
      for (const file of sourceFiles(rel)) {
        const text = stripComments(readFileSync(join(ROOT, file), "utf8"));
        assert.ok(
          !pattern.test(text),
          `${file} matches /${retired.matchPattern}/, retired because: ${retired.why}`
        );
      }
    }
  }
});

test("capability ids are unique", () => {
  const ids = manifest.capabilities.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate capability ids");
});
