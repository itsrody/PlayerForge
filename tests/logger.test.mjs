import test from "node:test";
import assert from "node:assert/strict";

let logCalls = 0;
let warnCalls = 0;
const originalLog = console.log;
const originalWarn = console.warn;

test("logger chatter gates on enable/disable, warn stays unconditional", async () => {
  console.log = () => { logCalls++; };
  console.warn = () => { warnCalls++; };

  try {
    const { logger } = await import("../src/shared/logger.js");

    // Fresh module state: silent until enabled.
    logger.log("test", "hidden");
    logger.group("test", "hidden");
    assert.equal(logCalls, 0);

    logger.enable();
    logger.log("test", "visible");
    assert.equal(logCalls, 1);
    logger.disable();
    logger.log("test", "hidden again");
    assert.equal(logCalls, 1);

    // warn/error bypass the gate - exceptional paths must always surface.
    logger.warn("test", "always");
    assert.equal(warnCalls, 1);

    assert.equal(logger.enabled, false);
    logger.enable();
    assert.equal(logger.enabled, true);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
});
