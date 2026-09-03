import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level invariants for the Firefox 155+ porting principles. These are
 * NOT functional tests - they pin the engine-native decisions this branch
 * relies on so a future edit can't silently regress them:
 *
 *   - esbuild targets `firefox155` (Warp-safe minification baseline).
 *   - scheduler.yield()/postTask() are native in FF 142+ (baseline 155), so
 *     no dead Chromium-style setTimeout fallback may drift back into the
 *     sizeable parse / construction paths.
 *   - backdrop-filter was removed from the HUD so the video is never sampled
 *     or blurred through panel/toast glass (FF-native #pf-hud-glass).
 *   - the keep-awake wake-lock re-acquires on the sentinel's system-forced
 *     `release` and is gated by a live setting.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const esbuild = readFileSync(join(ROOT, "esbuild.config.mjs"), "utf8");
const shellSrc = readFileSync(join(ROOT, "src", "shell", "shell.js"), "utf8");
const forgevttSrc = readFileSync(join(ROOT, "src", "shell", "subtitles", "forgevtt.js"), "utf8");
const styles = readFileSync(join(ROOT, "src", "shell", "chrome", "styles.css"), "utf8");

test("build targets the firefox155 baseline", () => {
  assert.match(esbuild, /target:\s*\[["']firefox155["']\]/, "esbuild target is firefox155");
  // Minification is the primary shipped output and is Warp-safe by design.
  assert.match(esbuild, /minify:\s*true/, "default build is minified");
});

test("no dead setTimeout scheduler fallback in the shell's DOM-injection yield path", () => {
  // scheduler.yield() is native in FF 142+ (baseline 155); the fallback would
  // be dead code and would lose the prioritized continuation.
  assert.match(shellSrc, /await\s+scheduler\.yield\(\)/, "shell yields via scheduler.yield()");
  assert.doesNotMatch(
    shellSrc.replace(/\/\*[\s\S]*?\*\//g, ""),
    /scheduler\?\.yield[^]*?setTimeout/,
    "no setTimeout fallback may accompany the scheduler.yield() call"
  );
});

test("forgevtt runs large parses under background priority and is abortable", () => {
  assert.match(forgevttSrc, /scheduler\?\.postTask/, "forgevtt uses scheduler.postTask");
  assert.match(forgevttSrc, /priority:\s*"background"/, "parse runs at background priority");
  assert.match(forgevttSrc, /AbortError/, "postTask abort surfaces as AbortError");
  assert.match(forgevttSrc, /signal\.aborted/, "cooperative fallback checks the abort signal");
});

test("HUD glass never samples or blurs the video (no backdrop-filter)", () => {
  assert.doesNotMatch(styles, /backdrop-filter/, "no backdrop-filter may return to the HUD surfaces");
  assert.doesNotMatch(styles, /--pf-blur/, "no unused --pf-blur tokens may return");
});

test("keep-awake wake lock re-acquires on sentinel release and obeys a setting", () => {
  assert.match(shellSrc, /addEventListener\("release"/, "sentinel release listener re-acquires the lock");
  assert.match(shellSrc, /getSetting\("features\.wakeLock"\)/, "wake lock is gated by the features.wakeLock setting");
});
