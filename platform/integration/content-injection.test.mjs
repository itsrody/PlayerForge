/**
 * `@inject-into content` integration tests.
 *
 * The rest of the suite injects the bundle with Selenium's executeScript, which
 * always lands in the PAGE world - and a page-world injection passes every
 * assertion content mode is supposed to make fail. These tests inject into a
 * CDP isolated world instead, which is the closest a WebDriver-exposed tool can
 * get to what ScriptCat actually does: a separate JS realm with its own
 * `window` and globals, sharing only the DOM.
 *
 * What that can and cannot prove:
 *   CAN - the kernel boots in a foreign world; PF's globals and window.PlayerForge
 *         are invisible to the page; the page cannot squat on the name to block
 *         boot; the data-pf-version marker reads the same from both worlds; the
 *         DOM/shadow HUD is reachable from the isolated world.
 *   CANNOT - the manager side of it. GM API wiring, @early-start ordering, and
 *         UserConfig synthesis are supplied by the harness stubs and by unit
 *         tests, not by ScriptCat. Those need a real manager run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer, createTestPage, STUB_SCRIPT_VERSION } from "../harness/chromium.mjs";
import { waitForShell } from "../harness/page.mjs";

let driver;
let server;

/** Navigate, inject into a fresh isolated world, and wake the probe. */
async function bootInContentWorld(options = {}) {
  await driver.navigate(createTestPage(server, options));
  await driver.injectScriptInIsolatedWorld(options);
  await driver.wakeProbe();
  await waitForShell(driver, 10000);
}

test.before(async () => {
  server = new TestServer();
  await server.start();
  driver = await ChromiumDriver.launch();
});

test.after(async () => {
  await driver?.destroy();
  await server?.stop();
});

test("kernel boots inside an isolated world and paints the shared DOM", async () => {
  await bootInContentWorld();

  assert.equal(
    await driver.eval(() => !!document.querySelector(".pf-shell")),
    true,
    "HUD host is in the shared DOM, so the page world can see it"
  );

  // Read the shell's own internals FROM the isolated world - proof the bundle
  // really ran there rather than in the page.
  const fromIsolated = await driver.evalInIsolatedWorld(
    `(() => {
       const shell = document.querySelector(".pf-shell");
       return shell?.shadowRoot?.querySelector(".pf-hud-layer") ? "hud" : "missing";
     })()`
  );
  assert.equal(fromIsolated, "hud", "bundle executed in the isolated world");
});

test("the page cannot see PF's window global", async () => {
  await bootInContentWorld();

  // This is the whole reason the version moved to a DOM attribute. A window
  // property set in the content world is invisible to the page...
  assert.equal(
    await driver.eval(() => typeof window.PlayerForge),
    "undefined",
    "page world must not observe window.PlayerForge"
  );

  // ...and is genuinely a different property, not merely shadowed in one view.
  assert.equal(
    await driver.evalInIsolatedWorld(`typeof window.PlayerForge`),
    "undefined",
    "kernel handle stays private unless #pf-debug is in the URL"
  );
});

test("#pf-debug exposes the kernel handle inside the content world only", async () => {
  // Negative control for the tests above: they would all pass if the bundle
  // simply never ran. With the debug flag the handle MUST exist in the content
  // world - and must still not leak to the page.
  await driver.navigate(`${createTestPage(server)}#pf-debug`);
  await driver.injectScriptInIsolatedWorld();
  await driver.wakeProbe();
  await waitForShell(driver, 10000);

  assert.equal(
    await driver.evalInIsolatedWorld(`typeof window.PlayerForge`),
    "object",
    "debug mode defines the handle in its own world"
  );
  assert.equal(
    await driver.evalInIsolatedWorld(`window.PlayerForge.version`),
    `${STUB_SCRIPT_VERSION}-test`,
    "handle carries the GM_info version"
  );
  assert.equal(
    await driver.evalInIsolatedWorld(
      `(() => {
         try {
           Object.defineProperty(window, "PlayerForge", { value: "hijack" });
           return "replaced";
         } catch {
           return "locked";
         }
       })()`
    ),
    "locked",
    "handle resists redefinition even from inside its own world"
  );
  assert.equal(
    await driver.eval(() => typeof window.PlayerForge),
    "undefined",
    "and it remains invisible to the page world"
  );
});

test("the DOM marker, not a global, is what defends page-world injection", async () => {
  // The test above proves a page cannot stop the CONTENT world. That safety
  // comes from realm isolation, not from the re-entry guard: mutating the guard
  // back to `window.PlayerForge ||` leaves that test green. So this test covers
  // the other half - the page world, where the page and PF share every global
  // and only the DOM marker survives a hostile decoy.
  //
  // Verified by mutation: with a window-global guard this case does not boot
  // (shell absent); with the marker guard it does. If this ever fails, the
  // guard was reverted to a global and page-world injection is hijackable.
  await driver.navigate(createTestPage(server));
  await driver.eval(() => {
    Object.defineProperty(window, "PlayerForge", {
      value: "hostile page decoy",
      configurable: false,
      writable: false
    });
  });

  await driver.injectGMStubs();
  await driver.injectScript();
  await waitForShell(driver, 10000);

  assert.equal(
    await driver.eval(() => !!document.querySelector(".pf-shell")),
    true,
    "page-world boot survives a decoy only because the guard reads the DOM"
  );
  assert.equal(
    await driver.eval(() => window.PlayerForge),
    "hostile page decoy",
    "and the kernel did not clobber the page's own global"
  );
});

test("a page that squats on window.PlayerForge cannot stop the kernel", async () => {
  // Content-mode counterpart to the test above: here the decoy cannot even be
  // observed by the kernel, so the marker is belt-and-braces.
  await driver.navigate(createTestPage(server));
  await driver.eval(() => {
    window.PlayerForge = "hostile page decoy";
    Object.defineProperty(window, "PlayerForge", {
      value: "hostile page decoy",
      configurable: false,
      writable: false
    });
  });

  await driver.injectScriptInIsolatedWorld();
  await driver.wakeProbe();
  await waitForShell(driver, 10000);

  assert.equal(
    await driver.eval(() => !!document.querySelector(".pf-shell")),
    true,
    "PF boots despite a non-configurable decoy in the page world"
  );
  assert.equal(
    await driver.eval(() => window.PlayerForge),
    "hostile page decoy",
    "the page's own value is left intact - isolation is not a bridge"
  );
});

test("the version marker reads identically from both worlds", async () => {
  await bootInContentWorld();

  const fromPage = await driver.eval(() => document.documentElement.dataset.pfVersion ?? null);
  assert.ok(fromPage, "page world reads the version off the DOM");

  const fromIsolated = await driver.evalInIsolatedWorld(
    `document.documentElement.dataset.pfVersion ?? null`
  );
  assert.equal(fromIsolated, fromPage, "same value from the content world");

  // The harness stub reports the package version; proving the exact value ties the
  // marker to GM_info rather than to a hardcoded string.
  assert.equal(fromPage, `${STUB_SCRIPT_VERSION}-test`);
});

test("globals are mutually invisible while the DOM stays shared", async () => {
  await driver.navigate(createTestPage(server));
  await driver.eval(() => {
    window.__pfPageOnly = "from-page";
  });

  await driver.injectScriptInIsolatedWorld();
  await driver.wakeProbe();
  await waitForShell(driver, 10000);

  // Direction 1: a global the page defines does not exist in the content
  // world. This is what stops a page from shadowing anything PF reads.
  assert.equal(
    await driver.evalInIsolatedWorld(`typeof window.__pfPageOnly`),
    "undefined",
    "page-defined global is absent from the isolated world"
  );

  // Direction 2: a global the content world defines is absent from the page.
  // The harness stubs are content-world-only by construction, so their absence
  // in the page world is the same property seen from the other side.
  assert.equal(
    await driver.eval(() => typeof window.GM_getValue),
    "undefined",
    "content-world GM stub is absent from the page world"
  );

  // And the DOM - the one shared surface - carries the version across.
  assert.equal(
    await driver.eval(() => document.documentElement.dataset.pfVersion),
    `${STUB_SCRIPT_VERSION}-test`,
    "DOM is the shared channel even though globals are not"
  );
});

test("a strict worker-src CSP is NOT lifted for the isolated world", async () => {
  // Negative result, recorded deliberately. It is tempting to assume content
  // mode inherits the CSP exemption real extension content scripts get, but a
  // CDP isolated world is not an extension context and does not: the page's
  // worker-src reaches into it and the blob worker is refused.
  //
  // Read this as a bound on the harness, not a prediction about ScriptCat. A
  // real Chrome extension content script runs under the EXTENSION's CSP, so
  // the real manager very likely does exempt it. This test cannot settle that
  // question - it only pins the CDP behavior so nobody reads the other tests
  // in this file as "content mode verified, therefore workers are fine".
  //
  // Practical consequence if ScriptCat does exempt it: none, since
  // vtt-worker-loader degrades to an equivalent in-band parse either way. The
  // worker is an optimization, so being wrong in either direction is safe.
  //
  // Control 1 below is what keeps this test honest: the same probe must spawn
  // where no CSP applies. That control is what licenses reading the refusal
  // below as CSP enforcement rather than a broken probe - and it is the reason
  // the harness-wide --disable-web-security switch is not treated as
  // invalidating CSP results (measured: spawning here is unaffected by it).
  const probe = `(async () => {
     let url = null;
     try {
       url = URL.createObjectURL(new Blob(["self.postMessage(1)"], { type: "text/javascript" }));
       const w = new Worker(url, { name: "pf-csp-probe" });
       const ok = await new Promise((res) => {
         w.onmessage = () => res(true);
         w.onerror = () => res(false);
         setTimeout(() => res(false), 2000);
       });
       w.terminate();
       return ok ? "spawned" : "errored";
     } catch {
       return "blocked";
     } finally {
       if (url) URL.revokeObjectURL(url);
     }
   })()`;

  const path = `/csp-${Date.now()}.html`;
  const html = `<!DOCTYPE html><html><head><title>CSP</title></head><body>
      <div class="plyr" data-plyr><div class="plyr__video-wrapper">
        <video id="test-video" preload="metadata"></video>
      </div></div>
    </body></html>`;

  // Control 1: same probe, no CSP anywhere. If this cannot spawn, the probe is
  // broken and the two results below would prove nothing.
  const openPath = `/csp-open-${Date.now()}.html`;
  server.addPage(openPath, html);
  await driver.navigate(`${server.url}${openPath}`);
  await driver.injectScriptInIsolatedWorld();
  assert.equal(
    await driver.evalInIsolatedWorld(probe),
    "spawned",
    "control: the probe spawns a blob worker when no CSP applies"
  );

  server.addPageWithHeaders(path, html, {
    "Content-Security-Policy": "worker-src 'none'; script-src 'self' 'unsafe-inline'"
  });

  // Control 2: CSP in force, page world. evalAsync is required - the probe is
  // a promise and executeScript would return null instead of the result.
  await driver.navigate(`${server.url}${path}`);
  assert.notEqual(
    await driver.evalAsync(`const done = arguments[arguments.length - 1]; (${probe}).then(done);`),
    "spawned",
    "control: the page's worker-src 'none' is actually in force"
  );

  // The finding: the isolated world inherits the page's restriction.
  await driver.injectScriptInIsolatedWorld();
  assert.notEqual(
    await driver.evalInIsolatedWorld(probe),
    "spawned",
    "documented limit: a CDP isolated world gets no CSP exemption"
  );

  // PF still boots on such a page - the subtitle path just stays in-band.
  await driver.wakeProbe();
  await waitForShell(driver, 10000);
  assert.equal(
    await driver.eval(() => !!document.querySelector(".pf-shell")),
    true,
    "CSP-strict pages still get a working shell via the in-band fallback"
  );
});

test("the isolated world is scoped to one document", async () => {
  await bootInContentWorld();
  assert.equal(await driver.hasIsolatedWorld, true);

  // navigate() must invalidate the context, so a stale eval fails loudly rather
  // than silently measuring the previous page.
  await driver.navigate(createTestPage(server));
  assert.equal(await driver.hasIsolatedWorld, false);
  await assert.rejects(
    () => driver.evalInIsolatedWorld("1"),
    /before injectScriptInIsolatedWorld/,
    "stale world is not reusable"
  );
});