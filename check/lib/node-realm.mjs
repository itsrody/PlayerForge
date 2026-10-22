/**
 * Child-realm prelude for the import smoke (flaws gate).
 *
 * A handful of src modules touch realm globals at import time by design:
 * - GM_getValue (config bootstrap reads through the store)
 * - self (the VTT transform) - a worker realm global
 * - ./styles.css - esbuild's userscript transform is what makes that import
 *   meaningful; plain Node needs the loader hook this prelude registers.
 *
 * Seeding exactly these (nothing more) keeps the smoke honest: any import
 * failure beyond them is a genuine repo-side flaw.
 */
import { registerHooks } from "node:module";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) {
      const parent = context.parentURL ?? import.meta.url;
      const css = readFileSync(fileURLToPath(new URL(specifier, parent)), "utf8");
      // Node cannot load CSS; the bundle transform turns the import into a JS
      // string, so the hook hands Node the same shape the bundle has.
      return {
        url: "data:text/javascript;charset=utf8," +
          encodeURIComponent(`export default ${JSON.stringify(css)};`),
        format: "module",
        shortCircuit: true
      };
    }
    return next(specifier, context);
  }
});

globalThis.self ??= globalThis;
globalThis.GM_info ??= { script: { version: "0.0.0-check" }, scriptHandler: "check", version: "0.0.0" };
globalThis.GM_getValue ??= (key, fallback = null) => fallback;

const url = process.argv[2];
await import(url);
