/**
 * Worker-scoped `userScripts` grant, cloned per launch.
 *
 * `userScripts` is an optional MV3 permission, so a freshly created profile
 * cannot inject page scripts at all - `chrome.userScripts` is simply undefined
 * until the extension is granted user-script access. ScriptCat's own harness
 * (`e2e/fixtures.ts`) grants it once per worker, then copies the granted profile
 * for each test so the grant persists without re-running the grant.
 *
 * The grant itself has to go through `chrome.developerPrivate
 * .updateExtensionConfiguration`, which is only reachable from the internal
 * WebUI at `chrome://extensions/`. Hand-seeding `user_scripts_enabled` into
 * `Secure Preferences` does not work: Chrome rewrites that file through its
 * integrity-protected `protection.macs` and silently drops the edit.
 *
 * Copying a granted temp profile is safe precisely because it is one this
 * module created. Copying a *real user profile* is not - that omits
 * `protection.macs`, and Chrome responds by deleting the extension's files out
 * of the copy. See `docs/platform-harness.md`.
 */
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromiumDriver } from "./chromium.mjs";

/**
 * @typedef {object} GrantOptions
 * @property {string[]} extensions - Unpacked extension dirs that need the grant.
 * @property {boolean} [headless=true]
 */

/**
 * Create (once per process) a profile whose extensions already hold
 * user-script access, and return its path. Repeated calls reuse it, so a whole
 * test run pays for the two-phase launch exactly once.
 *
 * @param {GrantOptions} options
 * @returns {Promise<string>} Path to a caller-must-not-delete granted profile.
 */
export async function grantedUserScriptsProfile(options) {
  if (cached) return cached;
  // Collapse concurrent callers onto one grant; parallel workers in the same
  // process would otherwise each drive a phase-1 launch.
  cached = grantOnce(options).catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

let cached = null;

async function grantOnce({ extensions, headless = true }) {
  const profileDir = mkdtempSync(join(tmpdir(), "pf-granted-"));

  // Phase 1 - a throwaway launch purely to reach the internal WebUI. It is
  // closed immediately: updateExtensionConfiguration reloads the extension, and
  // the extension's own pages answer ERR_BLOCKED_BY_CLIENT while that happens.
  const driver = await ChromiumDriver.launch({ headless, extensions, profileDir });
  let extensionId;
  try {
    extensionId = await discoverExtensionId(driver);
    if (!extensionId) throw new Error("no extension service worker target; is the build stale or unloadable?");
    await driver.navigate("chrome://extensions/");
    // developerPrivate is injected into the WebUI asynchronously; polling the
    // element is not a reliable proxy for it being bound.
    await driver.waitFor(() => typeof chrome !== "undefined" && !!chrome.developerPrivate, 15_000, 100);
    // driver.evalAsync forwards no extra arguments (see ChromiumDriver#evalAsync),
    // so the extension id is inlined. It comes from Chrome's own target list, so
    // it is a well-formed chrome-extension id rather than caller input.
    const granted = await driver.evalAsync(`const done = arguments[arguments.length - 1];
      chrome.developerPrivate.updateExtensionConfiguration(
        { extensionId: ${JSON.stringify(extensionId)}, userScriptsAccess: true },
        () => done(JSON.stringify({ ok: !chrome.runtime.lastError, error: chrome.runtime.lastError?.message ?? null })));`);
    const result = JSON.parse(granted);
    if (!result.ok) throw new Error(`updateExtensionConfiguration failed: ${result.error}`);
  } finally {
    await driver.destroy();
  }

  // Phase 2 happens in the caller's launch. The grant is persisted in the
  // profile, but the extension context only picks it up on a fresh launch.
  return profileDir;
}

/**
 * Clone the granted profile so a test can mutate it freely without leaking
 * scripts or storage into the next test.
 *
 * @returns {string} A fresh temp dir the caller owns and must remove.
 */
export function cloneGrantedProfile() {
  if (!cached) throw new Error("call grantedUserScriptsProfile() before cloning");
  const dir = mkdtempSync(join(tmpdir(), "pf-test-"));
  cpSync(cached, dir, { recursive: true });
  return dir;
}

/** Remove a directory returned by {@link cloneGrantedProfile}. */
export function removeProfile(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Drop the cached grant. Exported for tests; not needed in normal use. */
export function resetGrantedProfile() {
  if (cached) rmSync(cached, { recursive: true, force: true });
  cached = null;
}

/**
 * Read the extension id off the browser's own target list rather than assuming
 * a service-worker filename, which is manager-specific.
 */
async function discoverExtensionId(driver) {
  const { targetInfos } = await driver.cdp("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
  return sw ? new URL(sw.url).host : null;
}

/** True when a profile directory already carries the grant marker ScriptCat writes. */
export function profileLooksGranted(dir) {
  return existsSync(join(dir, "Default", "Secure Preferences"));
}
