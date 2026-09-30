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
 *
 * The load direction came first and was not enough. Every check below the
 * original set walked manifest -> code, so a capability could be adopted with
 * no entry at all and nothing failed: scheduler.postTask serviced the
 * removal grace, the mutation-dispatch defer, the lifecycle settle, the context retry
 * and the resume throttle without ever being named, and the whole native
 * WebVTT backend - the fork's subtitle renderer - was unrecorded too. So the
 * scan below walks code -> manifest: every `typeof` feature-detection chain
 * rooted at a platform global has to be classified as load-bearing
 * (capabilities) or degrading (hostProbes), and every declared token has to
 * appear in the files it claims. See the manifest's _comment for what the
 * scan cannot see.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "platform", "capabilities.json"), "utf8"));
const esbuildConfig = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf8");

/**
 * Platform globals that are lowercase, so a `typeof` on one of them counts as
 * a platform probe even though the Capitalised heuristic below would drop it:
 * host objects whose members are APIs (document.startViewTransition), and
 * the two API *functions* the shell feature-detects directly (matchMedia,
 * requestAnimationFrame). Everything else has to be Capitalised or explicitly
 * globalThis-prefixed to count - that is what keeps `typeof opts.signal` and
 * `typeof entry.id` out of the scan.
 */
const HOST_OBJECTS = new Set([
  "document", "navigator", "screen", "location", "history",
  "performance", "crypto", "matchMedia", "structuredClone", "requestAnimationFrame"
]);

/** Every `typeof` chain in src/, keyed by chain -> files that read it. */
function probeChains() {
  const chains = new Map();
  for (const file of sourceFiles("src")) {
    const code = stripComments(readFileSync(join(ROOT, file), "utf8"));
    for (const match of code.matchAll(/typeof\s+([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+|\??[A-Za-z_$][\w$]*)/g)) {
      const raw = match[1];
      const root = raw.replace(/^\??/, "").split(/[.?]/)[0];
      const isGlobal = raw.includes(".")
        ? raw.startsWith("globalThis.") || HOST_OBJECTS.has(root)
        : /^[A-Z]/.test(root) || HOST_OBJECTS.has(root);
      if (!isGlobal) {
        continue;
      }
      const chain = raw.replace(/^\??/, "").replace(/\?/g, "");
      if (!chains.has(chain)) {
        chains.set(chain, new Set());
      }
      chains.get(chain).add(file);
    }
  }
  return chains;
}

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

test("the banner's @allFrames matches the manager contract", () => {
  // The three supported managers disagree here by default: TM/VM inject into
  // sub-frames unless told otherwise, FireMonkey v3 does not. So the banner
  // has to say it out loud, and the manifest has to record that it means to.
  const contract = manifest.managerContract.allFrames;
  assert.equal(contract.value, true, "PF needs sub-frame injection for nested embeds");
  assert.ok(
    /^\/\/ @allFrames\s+true$/m.test(esbuildConfig),
    "the banner must carry an explicit @allFrames true - FireMonkey defaults it false"
  );
});

test("grants whose manager shape differs record it", () => {
  // These five are the ones where FireMonkey v3 is not a drop-in for
  // Tampermonkey/Violentmonkey. Each difference is absorbed in
  // src/shared/storage.js, so a future reader who finds that wrapper has to be
  // able to find out which manager forced each decision.
  const shaped = manifest.grants.filter((g) => g.managerShape).map((g) => g.api).sort();
  assert.deepEqual(
    shaped,
    ["GM_addValueChangeListener", "GM_registerMenuCommand", "GM_removeValueChangeListener", "GM_setValue", "GM_xmlhttpRequest"],
    "the grants with a non-TM/VM manager shape are enumerated, not left to memory"
  );
  for (const grant of manifest.grants) {
    if (grant.managerShape) {
      assert.ok(grant.managerShape.trim().length > 40, `${grant.api} explains the shape difference`);
    }
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

/** The literals an entry is searched for: an explicit token, else the first probe
 *  chain, else the API name, else the id - always as a list, because the code
 *  rarely spells the capability's own name. Token is separate from id so an id
 *  that reads like a capability name ("navigator-mediaSession") still has
 *  something findable, and a list lets an entry name every handle it has on
 *  the platform ("cuechange", "activeCues", "getCueAsHTML" for TextTrack). */
function entryTokens(entry) {
  const token = entry.token ?? entry.probes?.[0] ?? entry.api ?? entry.id;
  return Array.isArray(token) ? token : [token];
}

/** Every entry that can claim a probe chain, with the chain it claims. */
function probeClaims() {
  const claims = new Map();
  for (const entry of [...manifest.capabilities, ...manifest.hostProbes]) {
    for (const chain of entry.probes ?? []) {
      if (!claims.has(chain)) {
        claims.set(chain, []);
      }
      claims.get(chain).push(entry.id);
    }
  }
  return claims;
}

test("every feature-detection chain in src/ is classified in the manifest", () => {
  const chains = probeChains();
  // Floor guards against the scan silently matching nothing, not a census:
  // scheduler.postTask is required unconditionally on the floor, so its probe
  // is gone and the count dropped 14 -> 13.
  assert.ok(chains.size >= 13, `the scan still finds the platform probes (found ${chains.size})`);
  const claims = probeClaims();
  for (const chain of chains.keys()) {
    const owners = claims.get(chain) ?? [];
    assert.equal(
      owners.length,
      1,
      `\`typeof ${chain}\` (in ${[...chains.get(chain)].join(", ")}) is classified by ${owners.length} entries: ${owners.join(" + ") || "none"} - add it to capabilities (load-bearing, with a shipsInFirefox floor) or hostProbes (degrades, with a why)`
    );
  }
});

test("every classified probe chain still exists in the code", () => {
  const chains = probeChains();
  for (const [chain, owners] of probeClaims()) {
    assert.ok(chains.has(chain), `manifest classifies \`typeof ${chain}\` (${owners.join(" + ")}) but no src/ file probes it - drop the row or fix the scan`);
  }
});

test("a probe cannot be claimed by two entries", () => {
  for (const [chain, owners] of probeClaims()) {
    assert.equal(owners.length, 1, `\`typeof ${chain}\` is claimed by ${owners.join(" and ")}`);
  }
});

test("every capability and host probe really appears in the files it claims", () => {
  for (const entry of [...manifest.capabilities, ...manifest.hostProbes]) {
    const tokens = entryTokens(entry);
    for (const used of entry.usedBy) {
      const code = stripComments(readFileSync(join(ROOT, used), "utf8"));
      // One handle per file, not all of them: an API reached by different
      // routes in different modules (el.animate vs video.animate) is still
      // one entry, so a file has to carry at least one of the names.
      const named = tokens.filter((token) => code.includes(token));
      assert.ok(
        named.length > 0,
        `${entry.id} claims ${used} but none of ${tokens.map((t) => `"${t}"`).join(", ")} appear in it - the manifest describes code that moved or was deleted`
      );
    }
  }
});

test("every host probe says what is lost when the host lacks it", () => {
  for (const probe of manifest.hostProbes) {
    assert.ok(probe.why?.trim(), `${probe.id} names what degrades without it`);
    assert.ok(probe.usedBy?.length, `${probe.id} names where it is probed`);
  }
});

test("a capability declares a Firefox floor and a host probe does not pretend to", () => {
  for (const capability of manifest.capabilities) {
    assert.equal(
      typeof capability.shipsInFirefox,
      "number",
      `${capability.id} is load-bearing, so it states the floor it needs`
    );
  }
  for (const probe of manifest.hostProbes) {
    assert.equal(
      probe.shipsInFirefox,
      undefined,
      `${probe.id} degrades without it, so a version floor would claim more than the code promises`
    );
  }
});
