/**
 * Harness environment contract.
 *
 * These assert the browser environment the rest of the suite is written
 * against, not PlayerForge behaviour. They exist because the inputs a headless
 * browser reports come from the host, and the hosts disagree: headless Linux has
 * no input devices and answers `(hover: hover)` and `(pointer: fine)` with
 * false, where headless macOS answers true.
 *
 * PlayerForge branches on `(pointer: coarse)` for its first-run hint and gates
 * roughly a dozen `(hover: hover)` / `(pointer: coarse)` blocks in the panel
 * stylesheet. Unpinned, that means the same suite exercises a different UI on CI
 * than on a developer's machine - silently, with no failing assertion. Pinning
 * turns that class of drift into a loud failure here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChromiumDriver, TestServer } from "../harness/chromium.mjs";

// Returns a JSON string, not an object: evalAsync hands back a serialized
// value, and asking it to deserialize "[object Object]" would throw.
const MEDIA_QUERY_PROBE = `(async () => JSON.stringify({
  coarse: matchMedia("(pointer: coarse)").matches,
  fine: matchMedia("(pointer: fine)").matches,
  hover: matchMedia("(hover: hover)").matches,
  anyCoarse: matchMedia("(any-pointer: coarse)").matches
}))()`;

async function probeWith(launchOptions) {
  const server = new TestServer();
  await server.start();
  server.addPage("/media.html", "<!DOCTYPE html><html><body>media</body></html>");
  const driver = await ChromiumDriver.launch({ headless: true, ...launchOptions });
  try {
    await driver.navigate(`${server.url}/media.html`);
    return JSON.parse(await driver.evalAsync(`const done = arguments[arguments.length - 1];
      ${MEDIA_QUERY_PROBE}.then(done);`));
  } finally {
    await driver.destroy();
    await server.stop();
  }
}

test("a default launch reports a mouse, on every host", async () => {
  // The suite's baseline. If this fails, a Chromium or host change moved the
  // reporting and every pointer/hover assertion below is suspect until it is
  // re-baselined deliberately.
  assert.deepEqual(await probeWith({}), {
    coarse: false,
    fine: true,
    hover: true,
    anyCoarse: false
  });
});

test("emulatePointer touch reports a finger", async () => {
  // Touch-sensitive styling and the coarse-pointer first-run branch are
  // unreachable otherwise, so this is how they get covered at all.
  assert.deepEqual(await probeWith({ emulatePointer: "touch" }), {
    coarse: true,
    fine: false,
    hover: false,
    anyCoarse: true
  });
});