/**
 * Bundle parse+compile CPU benchmark.
 *
 * Measures the V8 parse + compile cost of the shipped bundle by evaluating it in
 * an isolated V8 context without executing the IIFE.
 *
 * The case name deliberately does not name a format. It used to read
 * "bundle parse+compile (minified)", which was accurate while the bundle was
 * minified; after the switch to an optimized-but-unminified artifact that label
 * would have quietly started describing something the build no longer produces,
 * and the stale minified baseline would have been compared against a larger
 * bundle as though it were a regression in V8 rather than a change of input.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "..", "dist");

let bundle;
try {
  bundle = readFileSync(join(DIST, "playerforge.user.js"), "utf8");
} catch {}

const cases = [];

if (bundle) {
  cases.push(
    measure("bundle parse+compile (shipped)", () => {
      const body = bundle.slice(bundle.indexOf("==/UserScript==") + 16);
      return () => {
        // new Function triggers V8 parse + compile without executing the IIFE.
        new Function(body); // eslint-disable-line no-new-func
      };
    })
  );
}

export default cases;