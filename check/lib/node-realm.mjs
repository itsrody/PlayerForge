/**
 * Child-realm prelude for the import smoke (flaws gate).
 *
 * A handful of src modules touch realm globals at import time by design:
 * - browser.storage.onChanged.addListener - config.js constructs the
 *   Settings singleton at eval, which registers its cross-tab echo through
 *   the store plane; the seeded noop keeps the registration mechanics real
 *   (a second registration harnessing still exercises the same seam) while
 *   the page's actual storage stays untouched.
 * - ./styles.css - esbuild's bundle transform is what makes that import
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

// The one extension-realm seed the eval-time surfaces need: nothing in
// the smoke imports the content entry (its `browser.*` scope is only the
// bundle/browser gates' business) - the chrome members live in the
// dist/extension package and ship through those gates too.
globalThis.browser ??= {
  runtime: {},
  storage: {
    local: {},
    onChanged: {
      addListener() {}, removeListener() {}
    }
  }
};

const url = process.argv[2];
await import(url);
