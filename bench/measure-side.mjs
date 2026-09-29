#!/usr/bin/env node
/**
 * Measure every case in one tree and print JSON on stdout.
 *
 * One PROCESS PER SIDE, on purpose. The case files install GM_* stubs on
 * globalThis, so loading two source trees into a single process has them
 * share (and overwrite) each other's stubs - the two sides then measure
 * different things, and the "A" side can look 8x faster purely because it is
 * being driven through the other side's stub. Isolation per process is the
 * only way both sides can be measured on the same terms.
 *
 * Usage: node bench/measure-side.mjs <cases-dir>
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { measure } from "./lib.mjs";

const casesDir = process.argv[2];
if (!casesDir) {
  console.error("usage: node bench/measure-side.mjs <cases-dir>");
  process.exit(2);
}

const out = {};
for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".mjs")).sort()) {
  const mod = await import(pathToFileURL(join(casesDir, file)).href);
  for (const def of mod.default) {
    out[def.name] = measure(def).medianNsPerOp;
  }
}
process.stdout.write(JSON.stringify(out));
