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
 *    SDK anchor, so an anchorless fixture silently proves nothing. The pages are
 *    built by the shared fixture builders, the same Plyr-shaped trees the
 *    integration suite uses, and they carry real media because adoption needs
 *    readyState > 0.
 *
 * It covers all five embed topologies, not just the top document, because that
 * is where the manager is doing something this harness cannot fake: real VM
 * injects the userscript into EVERY frame at document-start, so a shell inside a
 * frame proves the manager injected there on its own. The frames are on
 * genuinely different origins (same host, different ports), so the cross-origin
 * cases cross a real boundary rather than a simulated one:
 *
 *   direct              top document
 *   same-origin iframe  the bridge is never needed, so a broken one is invisible
 *   cross-origin iframe window.top throws; the bridge is the only way through
 *   nested iframe       two hops, so a relay that forwards but never replies
 *                       fails here and nowhere else
 *   switchboard         N cross-origin cards, one live; both placeholder
 *                       strategies, because "nothing is loaded" and "a src-less
 *                       frame stays inert" are different claims
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestPage,
  createTestMedia,
  createIframeChildPage,
  createIframeParentPage,
  createNestedIframePages,
  createMultiOriginServersN,
  createSwitchboardChildPage,
  createSwitchboardPage,
} from "./harness/firefox.mjs";
import { resolveFirefoxTarget } from "./harness/target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUNDLE = join(ROOT, "dist", "playerforge.user.js");
// Banner lines are comments: "// @version      0.7.2".
const BANNER_VERSION = /^\/\/\s*@version\s+(\S+)/m;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const xpi = process.argv[2] || process.env.VIOLENTMONKEY_XPI;
if (!xpi || !existsSync(xpi)) {
  console.log("SKIP: no Violentmonkey xpi. Pass one as an argument or set");
  console.log("      VIOLENTMONKEY_XPI=/path/to/violentmonkey.xpi");
  process.exit(0);
}

const bundle = readFileSync(BUNDLE, "utf8");
const expectedVersion = BANNER_VERSION.exec(bundle)?.[1];
const EXPECTED_GRANTS = (bundle.match(/^\/\/\s*@grant\s+\S+/gm) || []).length;

// Five origins. The direct case needs one, but an iframe case only proves
// anything if the frame is on a genuinely different origin than its embedder -
// same host, different port is a different origin, which is enough and is what
// the bridge actually has to cross.
const servers = await createMultiOriginServersN(5);
const server = servers[0];
const pageUrl = createTestPage(server, { videoSrc: createTestMedia(server, 90) });
server.addPage("/vm-bundle.user.js", bundle);
const bundleUrl = `${server.url}/vm-bundle.user.js`;

const ffOptions = new firefox.Options()
  .set("acceptInsecureCerts", true)
  .setPreference("browser.shell.checkDefaultBrowser", false)
  .setPreference("datareporting.policy.dataSubmissionEnabled", false)
  .setPreference("toolkit.telemetry.reportingpolicy.firstRun", false);
const bin = resolveFirefoxTarget().binary;
if (bin) ffOptions.setBinary(bin);

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxOptions(ffOptions)
  // WebExtensionPolicy lives in the chrome context and is not reachable from a
  // normal content script without this.
  .setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access"))
  .build();

/**
 * Read every error the console service has recorded, from the chrome context.
 * Services is a global there; importing resource://gre/modules/Services.sys.mjs
 * by path fails, because Marionette evaluates in a sandbox whose module loader
 * is not the system one.
 */
const readConsoleErrors = async () => {
  await driver.setContext("chrome");
  try {
    return await driver.executeScript(`
      const list = Services.console.getMessageArray
        ? Services.console.getMessageArray()
        : Array.from(Services.console.getMessageList() || []);
      return list
        .filter((m) => m.error)
        .map((m) => (m.sourceName || "") + " :: " + (m.errorMessage || m.message || ""));
    `);
  } finally {
    await driver.setContext("content");
  }
};

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

  // Baseline for the error diff, taken before a single fixture page loads.
  const errorBaseline = await readConsoleErrors();

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

  // ── Embed topologies ────────────────────────────────────────────────
  //
  // Everything above runs in the top document. These are the shapes PF is
  // actually shipped into, and they are where the manager differs most: real VM
  // injects the userscript into every frame at document-start, with no wake-up
  // nudge and no harness to call. A shell in a frame therefore proves the
  // manager injected AND PF adopted there on its own, and each frame's DOM is
  // only visible from inside that frame - so every check below has to switch
  // into the frame rather than looking for it from the top.
  const probeFrame = async (url, framePath, videoId = "test-video") => {
    await driver.get(url);
    const ctx = driver.switchTo();
    for (const id of framePath) await ctx.frame(id);
    let p = null;
    try {
      for (let i = 0; i < 40; i++) {
        p = await driver.executeScript(`
          const v = document.getElementById(arguments[0]);
          return {
            url: location.pathname,
            shellHosts: document.querySelectorAll(".pf-shell").length,
            shadowOpen: !!(document.querySelector(".pf-shell") || {}).shadowRoot,
            marked: !!(v && v.hasAttribute("data-pf-shell")),
            readyState: v ? v.readyState : -1,
          };
        `, videoId);
        if (p.shellHosts > 0 && p.readyState > 0) break;
        await sleep(500);
      }
    } finally {
      await driver.switchTo().defaultContent();
    }
    return p || { shellHosts: 0, readyState: -1 };
  };

  // same-origin: the child is served by the same server as the parent
  {
    const media = createTestMedia(servers[1], 90);
    const child = createIframeChildPage(servers[1], { videoSrc: media });
    const parent = createIframeParentPage(servers[1], child, { iframeId: "child-frame" });
    const p = await probeFrame(parent, ["child-frame"]);
    check(
      "same-origin iframe: adopted with no wake-up",
      p.shellHosts > 0 && p.marked && p.readyState > 0,
      `hosts=${p.shellHosts} marked=${p.marked} readyState=${p.readyState}`
    );
  }

  // cross-origin: child on servers[2], parent on servers[0], so window.top
  // throws in the frame and the page context can only arrive over the bridge
  {
    const media = createTestMedia(servers[2], 90);
    const child = createIframeChildPage(servers[2], { videoSrc: media });
    const parent = createIframeParentPage(servers[0], child, { iframeId: "child-frame" });
    const p = await probeFrame(parent, ["child-frame"]);
    const blocked = await (async () => {
      const ctx = driver.switchTo();
      await ctx.frame("child-frame");
      try {
        return await driver.executeScript(`
          try { return { ok: true, path: window.top.location.pathname }; }
          catch (e) { return { ok: false, name: e.name }; }
        `);
      } finally {
        await driver.switchTo().defaultContent();
      }
    })();
    check(
      "cross-origin iframe: adopted, and really cross-origin",
      p.shellHosts > 0 && p.readyState > 0 && blocked.ok === false,
      `hosts=${p.shellHosts} readyState=${p.readyState} topBlocked=${blocked.name}`
    );
  }

  // nested: parent -> relay -> video, the video two hops from the top document
  {
    const media = createTestMedia(servers[3], 90);
    const { parentUrl } = createNestedIframePages(servers[0], servers[3], { depth: 3, videoSrc: media });
    const p = await probeFrame(parentUrl, ["outer-frame", "inner-frame"]);
    check(
      "nested iframe: video adopted two frames down",
      p.shellHosts > 0 && p.marked && p.readyState > 0,
      `hosts=${p.shellHosts} marked=${p.marked} readyState=${p.readyState} at=${p.url}`
    );
  }

  // switchboard: N cross-origin cards, one live at a time, the rest inert.
  // Both placeholder strategies, because they are different claims: swap
  // proves teardown is real (nothing survives a switch), parked proves a frame
  // that never got a src never produced a shell.
  {
    const cards = [];
    for (let i = 0; i < 3; i++) {
      cards.push({
        name: `Server ${i}`,
        url: createSwitchboardChildPage(servers[i], {
          name: `Server ${i}`,
          videoSrc: createTestMedia(servers[i], 90),
          id: `video-${i}`,
        }),
      });
    }

    // swap
    const swapParent = createSwitchboardPage(servers[0], cards, { placeholderMode: "swap" });
    await driver.get(swapParent);
    const beforeClick = await driver.executeScript(`
      return { loaded: window.__getLoadedCount(),
               allPlaceholder: Array.from(document.querySelectorAll(".server-card"))
                 .every((c) => c.classList.contains("placeholder")) };
    `);
    check(
      "switchboard: nothing loaded, every card a placeholder",
      beforeClick.loaded === 0 && beforeClick.allPlaceholder,
      JSON.stringify(beforeClick)
    );

    await driver.executeScript(`return window.__loadIframe(1);`);
    await driver.wait(async () => driver.executeScript(`return window.__getLoadedCount() === 1;`), 10000);
    const swapCtx = driver.switchTo();
    await swapCtx.frame("active-frame");
    let sp = null;
    try {
      for (let i = 0; i < 40; i++) {
        sp = await driver.executeScript(`
          const v = document.getElementById("video-1");
          return { shellHosts: document.querySelectorAll(".pf-shell").length,
                   readyState: v ? v.readyState : -1 };
        `);
        if (sp.shellHosts > 0 && sp.readyState > 0) break;
        await sleep(500);
      }
    } finally {
      await driver.switchTo().defaultContent();
    }
    check(
      "switchboard: live card adopted its media",
      sp && sp.shellHosts > 0 && sp.readyState > 0,
      `hosts=${sp && sp.shellHosts} readyState=${sp && sp.readyState}`
    );

    await driver.executeScript(`return window.__switchTo(2);`);
    await driver.wait(async () => driver.executeScript(`return window.__getLoadedCount() === 1;`), 10000);
    const afterSwitch = await driver.executeScript(`
      return { loaded: window.__getLoadedCount(), frames: document.querySelectorAll("#iframe-slot iframe").length };
    `);
    check(
      "switchboard: switching leaves exactly one frame",
      afterSwitch.loaded === 1 && afterSwitch.frames === 1,
      JSON.stringify(afterSwitch)
    );

    // parked
    const parkedParent = createSwitchboardPage(servers[0], cards, { placeholderMode: "parked" });
    await driver.get(parkedParent);
    const parkedIdle = await driver.executeScript(`
      const fs = Array.from(document.querySelectorAll(".server-card iframe"));
      return { frames: fs.length, withSrc: fs.filter((f) => f.getAttribute("src")).length,
               topShells: document.querySelectorAll(".pf-shell").length };
    `);
    // A src-less frame has an about:blank document, and VM may well inject into
    // it. What must not happen is a SHELL: there is no media to adopt there, so
    // a shell would mean PF built a player for a frame that never loaded.
    check(
      "switchboard parked: src-less frames stay inert",
      parkedIdle.frames === 3 && parkedIdle.withSrc === 0 && parkedIdle.topShells === 0,
      JSON.stringify(parkedIdle)
    );
    await sleep(1500);
    const parkedStillIdle = await driver.executeScript(`
      return document.querySelectorAll(".pf-shell").length;
    `);
    check(
      "switchboard parked: still no shell after the manager settles",
      parkedStillIdle === 0,
      `topShells=${parkedStillIdle}`
    );
  }

  // Real uncaught-error collection. The old check read window.__pfErrors, which
  // nothing in this repository ever writes, so it could not fail and the
  // "no uncaught page errors" line was decoration. The console service in the
  // chrome context records errors from every frame AND from the userscript's
  // content realm, which is the coverage the check was claiming and which no
  // per-page window variable can provide.
  //
  // Three things keep it honest rather than noisy:
  //  - It is a DIFF against a snapshot taken before any page was loaded, so
  //    Firefox's own startup complaints (ClientID telemetry on a fresh profile,
  //    for one) are never attributed to PF.
  //  - It keeps a POSITIVE allowlist - a fixture origin, or the manager's own
  //    extension origin - rather than a denylist of platform noise. A denylist
  //    grows one entry per Firefox quirk and silently swallows real errors;
  //    an allowlist states exactly whose failures this check is about.
  //  - Both are needed. A userscript error is reported against the script the
  //    manager compiled, so its source is the extension origin; a page or frame
  //    error is reported against the fixture URL. PF can fail in either place.
  //
  // Deliberately NOT filtered, because PF causes it and a reader should see it:
  // Firefox's PictureInPictureChild throws InvalidStateError from its own
  // MutationObserver on every video DOM mutation. It is a platform-internal
  // error with no bearing on PF's behaviour, and it is left in the output rather
  // than added to an allowlist as a special case.
  const newErrorsSinceBaseline = async (baseline) => {
    const seen = new Set(baseline);
    return (await readConsoleErrors()).filter((t) => !seen.has(t));
  };
  // Gecko's m.error flag is NOT a severity filter: a content console.warn is
  // never recorded at all, but a "Layout was forced before the page was fully
  // loaded" FOUC warning IS recorded with error:true, and it arrives whenever PF
  // happens to force layout early. Left in, it made this check fail on roughly
  // one run in five for a condition that is not a failure. The message text
  // carries the real severity, so filter on that instead.
  const ours = [...servers.map((s) => s.url), `moz-extension://${origin}`];
  const attributable = (errs) => errs.filter(
    (t) => !/favicon/i.test(t) &&
           !/JavaScript Warning:/i.test(t) &&
           ours.some((o) => t.includes(o))
  );
  const finalErrors = attributable(await newErrorsSinceBaseline(errorBaseline));
  check(
    "no uncaught errors from a fixture page, any frame, or the manager's realm",
    finalErrors.length === 0,
    finalErrors.length ? JSON.stringify(finalErrors.slice(0, 3)) : "clean"
  );
} finally {
  await driver.quit().catch(() => {});
  for (const s of servers) await s.stop().catch(() => {});
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
process.exit(failed.length ? 1 : 0);
