/**
 * Bundle parse+compile CPU benchmark.
 *
 * Measures the V8 parse + compile cost of the minified bundle by evaluating
 * it in an isolated V8 context without executing the IIFE.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "..", "dist");

let minifiedBundle;
try {
  // The minified bundle lives at playerforge.user.js (the primary output).
  minifiedBundle = readFileSync(join(DIST, "playerforge.user.js"), "utf8");
} catch {}

const cases = [];

if (minifiedBundle) {
  cases.push(
    measure("bundle parse+compile (minified)", () => {
      const body = minifiedBundle.slice(minifiedBundle.indexOf("==/UserScript==") + 16);
      return () => {
        // new Function triggers V8 parse + compile without executing the IIFE.
        new Function(body); // eslint-disable-line no-new-func
      };
    })
  );
}

export default cases;
