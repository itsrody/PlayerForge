/**
 * Bundle parse+compile CPU benchmarks.
 *
 * Measures the V8 parse + compile time for both readable and minified bundles
 * by evaluating them in isolated V8 contexts. This captures the compile-time
 * cost difference between the two bundle variants.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "..", "dist");

let readableBundle;
let minifiedBundle;

try {
  readableBundle = readFileSync(join(DIST, "playerforge.readable.js"), "utf8");
} catch {}
try {
  // The minified bundle lives at playerforge.user.js (the primary output).
  minifiedBundle = readFileSync(join(DIST, "playerforge.user.js"), "utf8");
} catch {}

const cases = [];

if (readableBundle) {
  cases.push(
    measure("bundle parse+compile (readable)", () => {
      // Strip UserScript header — Tampermonkey parses it separately.
      const body = readableBundle.slice(readableBundle.indexOf("==/UserScript==") + 16);
      return () => {
        // new Function triggers V8 parse + compile without executing the IIFE.
        new Function(body); // eslint-disable-line no-new-func
      };
    })
  );
}

if (minifiedBundle) {
  cases.push(
    measure("bundle parse+compile (minified)", () => {
      const body = minifiedBundle.slice(minifiedBundle.indexOf("==/UserScript==") + 16);
      return () => {
        new Function(body); // eslint-disable-line no-new-func
      };
    })
  );
}

if (readableBundle && minifiedBundle) {
  cases.push(
    measure("bundle eval overhead (readable vs minified)", () => {
      const rBody = readableBundle.slice(readableBundle.indexOf("==/UserScript==") + 16);
      const mBody = minifiedBundle.slice(minifiedBundle.indexOf("==/UserScript==") + 16);
      return () => {
        new Function(rBody); // eslint-disable-line no-new-func
        new Function(mBody); // eslint-disable-line no-new-func
      };
    })
  );
}

export default cases;
