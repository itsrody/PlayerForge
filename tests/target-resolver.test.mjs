import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { resolveFirefoxTarget, formatTarget } = await import("../platform/harness/target.mjs");

/**
 * The resolver names channels by app bundle, but the engine is named by the
 * build: a beta riding in Firefox.app must still report bleeding-edge, or a
 * run silently certifies a prerelease as a settled release. Fake binaries
 * (shell scripts answering --version) drive the real resolution path through
 * FIREFOX_PATH.
 */
function fakeFirefox(versionLine) {
  const dir = mkdtempSync(join(tmpdir(), "pf-target-"));
  const binary = join(dir, "firefox");
  writeFileSync(binary, `#!/bin/sh\necho "${versionLine}"\n`);
  chmodSync(binary, 0o755);
  return binary;
}

function withFirefoxPath(binary, fn) {
  const saved = process.env.FIREFOX_PATH;
  process.env.FIREFOX_PATH = binary;
  try {
    return fn();
  } finally {
    if (saved === undefined) {
      delete process.env.FIREFOX_PATH;
    } else {
      process.env.FIREFOX_PATH = saved;
    }
  }
}

test("a beta build reports bleeding-edge whatever the app is named", () => {
  const binary = fakeFirefox("Mozilla Firefox 158.0b5");
  withFirefoxPath(binary, () => {
    const t = resolveFirefoxTarget();
    assert.equal(t.channel, "custom");
    assert.equal(t.version, "158.0b5");
    assert.equal(t.prerelease, "b5");
    assert.equal(t.bleedingEdge, true, "the prerelease letter, not the app name, decides");
    assert.ok(formatTarget(t).includes("bleeding-edge"));
  });
});

test("a settled release build reports non-bleeding-edge", () => {
  const binary = fakeFirefox("Mozilla Firefox 158.0");
  withFirefoxPath(binary, () => {
    const t = resolveFirefoxTarget();
    assert.equal(t.prerelease, null);
    assert.equal(t.bleedingEdge, false);
    assert.ok(!formatTarget(t).includes("bleeding-edge"));
  });
});

test("a nightly build keeps its prerelease letter for triage", () => {
  const binary = fakeFirefox("Mozilla Firefox 160.0a1");
  withFirefoxPath(binary, () => {
    const t = resolveFirefoxTarget();
    assert.equal(t.major, 160);
    assert.equal(t.prerelease, "a1");
    assert.equal(t.bleedingEdge, true);
  });
});
