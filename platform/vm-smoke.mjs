/**
 * Real-manager smoke test: install the ACTUAL built dist/playerforge.user.js
 * into a real Violentmonkey and boot it on a page with a real player.
 *
 * The native userScripts harness in this directory proves PF's own logic in an
 * isolated realm, but it is NOT Violentmonkey: it has no banner parsing, no
 * @grant resolution, no @run-at, and it hands the bundle its own GM bridge.
 * This script is the one place the shipping target is actually exercised.
 *
 * Two things it deliberately does NOT do, both learned the hard way:
 *
 *  - It does not read window.PlayerForge or window.GM_* to decide whether PF
 *    booted. A @grant-ed script runs in Violentmonkey's CONTENT realm, so those
 *    are legitimately absent from the page world and probing for them there
 *    reports a failure that does not exist. The DOM is shared across realms, so
 *    the shell host and its shadow root are the honest signal.
 *  - It does not use a bare <video>. PF's SDK detection is selector-based on the
 *    composed DOM ancestry and the kernel deliberately rejects a video with no
 *    SDK anchor, so an anchorless fixture silently proves nothing. The page is
 *    built by createTestPage(), the same Plyr-shaped tree the integration suite
 *    uses, and it carries real media because adoption needs readyState > 0.
 *
 * Usage: node platform/vm-smoke.mjs [path/to/violentmonkey.xpi]
 *        VIOLENTMONKEY_XPI=/path/to/vm.xpi node platform/vm-smoke.mjs
 * Exits 0 when every check passes, 1 otherwise, and 0 with a SKIP notice when
 * no xpi is supplied (the file is not vendored - it is a large third-party
 * build that does not belong in this repository).
 */
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestServer, createTestPage, createTestMedia } from "./harness/firefox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "dist", "playerforge.user.js");
// Banner lines are comments: "// @version      0.7.2".
const BANNER_VERSION = /^\/\/\s*@version\s+(\S+)/m;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveFirefoxBinary() {
  if (process.env.FIREFOX_PATH && existsSync(process.env.FIREFOX_PATH)) {
    return process.env.FIREFOX_PATH;
  }
  for (const p of [
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    join(homedir(), "Applications", "Firefox.app", "Contents", "MacOS", "firefox"),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const xpi = process.argv[2] || process.env.VIOLENTMONKEY_XPI;
if (!xpi || !existsSync(xpi)) {
  console.log("SKIP: no Violentmonkey xpi. Pass one as an argument or set");
  console.log("      VIOLENTMONKEY_XPI=/path/to/violentmonkey.xpi");
  process.exit(0);
}

const bundle = readFileSync(BUNDLE, "utf8");
const expectedVersion = BANNER_VERSION.exec(bundle)?.[1];
const EXPECTED_GRANTS = (bundle.match(/^\/\/\s*@grant\s+\S+/gm) || []).length;

// A Plyr-anchored page with real media: the SDK anchor is what the kernel
// looks for, and the media is what makes readyState > 0 so a shell is adopted.
const server = new TestServer();
await server.start();
const pageUrl = createTestPage(server, { videoSrc: createTestMedia(server, 90) });
server.addPage("/vm-bundle.user.js", bundle);
const bundleUrl = `${server.url}/vm-bundle.user.js`;

const ffOptions = new firefox.Options()
  .set("acceptInsecureCerts", true)
  .setPreference("browser.shell.checkDefaultBrowser", false)
  .setPreference("datareporting.policy.dataSubmissionEnabled", false)
  .setPreference("toolkit.telemetry.reportingpolicy.firstRun", false);
const bin = resolveFirefoxBinary();
if (bin) ffOptions.setBinary(bin);

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(ffOptions)
  // WebExtensionPolicy lives in the chrome context and is not reachable from a
  // normal content script without this.
  .setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access"))
  .build();

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  console.log(` ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
};

try {
  await driver.installAddon(xpi, true);
  await sleep(4000);

  // Resolve the manager's extension origin by its fixed add-on id rather than
  // by reading whichever tab happens to be focused. Violentmonkey registers
  // asynchronously, so poll for the policy entry to exist.
  const VM_ADDON_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
  await driver.setContext("chrome");
  const origin = await driver.executeAsyncScript(`
    const id = arguments[0], done = arguments[arguments.length - 1];
    (function poll(n) {
      const p = WebExtensionPolicy.getByID(id);
      if (p && p.mozExtensionHostname) return done(p.mozExtensionHostname);
      if (n <= 0) return done(null);
      setTimeout(() => poll(n - 1), 300);
    })(40);
  `, VM_ADDON_ID);
  if (!origin) throw new Error("Violentmonkey did not register an extension origin");
  check("Violentmonkey installed and registered", true, origin);
  // mozExtensionHostname is the bare UUID, not a full origin.
  const popupUrl = `moz-extension://${origin}/popup/index.html`;

  // Back to content before navigating: the chrome context cannot drive
  // WebDriver:Navigate at all.
  await driver.setContext("content");
  const tab = (await driver.getAllWindowHandles())[0];
  await driver.switchTo().window(tab);
  await driver.get(popupUrl);
  await sleep(2000);

  // ParseScript through the background. The confirm page must not be used: it
  // disables its own Install button and then awaits a promise that never
  // settles, so the caller hangs instead of failing.
  const installed = await driver.executeAsyncScript(`
    const url = arguments[0], done = arguments[arguments.length - 1];
    (async () => {
      const code = await (await fetch(url)).text();
      const p = await browser.runtime.sendMessage({ cmd: "ParseMeta", data: code });
      const r = await browser.runtime.sendMessage({
        cmd: "ParseScript",
        data: { meta: p.meta, custom: {}, props: {}, code, url, from: "",
                require: {}, cache: {}, reloadTab: false, bumpDate: true }
      });
      // Assert on ParseMeta, not on ParseScript's echo: what this check is
      // really asking is whether the manager understood our banner, and
      // ParseMeta is the parse of it. ParseScript's props.version comes back
      // null on 2.49.0 regardless of the banner.
      done({ id: r?.update?.props?.id, isNew: r?.isNew,
             metaVersion: p.meta?.version, metaName: p.meta?.name,
             grants: p.meta?.grant?.length ?? p.meta?.grants?.length ?? null,
             runAt: p.meta?.runAt ?? null, noframes: p.meta?.noframes ?? null });
    })().catch((e) => done("ERR " + (e && (e.message || e))));
  `, bundleUrl);
  check("Violentmonkey accepted the built bundle", installed && installed.id != null, JSON.stringify(installed));
  check(
    "manager parsed the banner version",
    installed && installed.metaVersion === expectedVersion,
    `${installed && installed.metaVersion} (banner ${expectedVersion})`
  );
  check(
    "manager parsed all 8 grants",
    installed && installed.grants === EXPECTED_GRANTS,
    `grants=${installed && installed.grants}`
  );
  check(
    "manager honoured @run-at document-start",
    installed && installed.runAt === "document-start",
    `runAt=${installed && installed.runAt}`
  );

  // Boot the real page. The shell host is the honest signal because the DOM is
  // shared: a content-realm script that adopts a video puts the host where the
  // page realm can see it, even though window.PlayerForge stays hidden there.
  await driver.get(pageUrl);

  let probe = null;
  for (let i = 0; i < 40; i++) {
    probe = await driver.executeScript(`
      const host = document.querySelector(".pf-shell");
      return {
        shellHosts: document.querySelectorAll(".pf-shell").length,
        shadowOpen: !!(host && host.shadowRoot),
        adopted: !!(host && host.shadowRoot && host.shadowRoot.adoptedStyleSheets
                    && host.shadowRoot.adoptedStyleSheets.length),
        // Proof of the content realm: these must be ABSENT from the page world.
        pagePlayerForge: typeof window.PlayerForge,
        pageGmGetValue: typeof window.GM_getValue,
        readyState: document.getElementById("test-video")?.readyState ?? -1,
      };
    `);
    if (probe.shellHosts > 0) break;
    await sleep(500);
  }

  check("shell parasite host built", probe.shellHosts > 0, `hosts=${probe.shellHosts}`);
  check("open shadow root", probe.shadowOpen, "shadowRoot");
  check("adopted stylesheet applied", probe.adopted, "adoptedStyleSheets");
  check(
    "script really ran in the content realm, not the page",
    probe.pagePlayerForge === "undefined" && probe.pageGmGetValue === "undefined",
    `PlayerForge=${probe.pagePlayerForge} GM_getValue=${probe.pageGmGetValue}`
  );
  check("media was real (readyState > 0)", probe.readyState > 0, `readyState=${probe.readyState}`);

  const pageErrors = await driver.executeScript(`
    return (window.__pfErrors || []).filter((m) => !/favicon/i.test(m));
  `);
  check("no uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await driver.quit().catch(() => {});
  await server.stop();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
