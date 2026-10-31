/**
 * GC-cleaner unit: the runtime's ONE GC-backed cleanup net pinned against
 * the real floor browser. Its enlist/drop/signal semantics - run-once
 * release across three independent arms, the Disposable drop handle,
 * release-throw containment along the Scope teardown convention - live
 * inside the realm whose FinalizationRegistry and abort wiring the
 * platform defines, so a node import smoke cannot witness them honestly;
 * the unit imports src/shared/runtime.js (import-clean by design) straight
 * from the working tree and exercises the class in the page.
 *
 * Deliberately absent: a posthumous-fire row. The registry's collect arm
 * fires on garbage collection, which the content realm cannot force or
 * observe deterministically (no gc() leak, no observer for the registry's
 * own task) - a row that can be green without the fire would be false
 * confidence, so the collect arm is spec-trusted (FinalizationRegistry's
 * own contract) and the unit pins every deterministic surface the engine
 * adds around it. The engine's posthumous warn() lands in the case's
 * informational console rows whenever a real leak sentence reaches it.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function run({ session, baseUrl }) {
  const rows = [];
  const source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "shared", "runtime.js"),
    "utf8"
  );
  const route = `/check/gc-unit-${Date.now()}.js`;
  session.registerAsset(route, Buffer.from(source), "text/javascript");

  const probe = await session.eval(function main(url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      import(url).then(
        (M) => {
          try {
            const { GcCleaner } = M;
            const results = {};

            // Explicit drop: one release, the second drop is the run-once
            // guard the double-fire paths (net + drop) rely on.
            let calls = 0;
            const c = new GcCleaner();
            const record = {};
            const h0 = c.enlist(record, () => calls++);
            h0();
            h0();
            const h0b = c.enlist({ x: 1 }, () => calls++);
            h0b();
            h0b();
            results.dropOnce = calls === 2;

            // Signal arm: the owner lifecycle abort releases exactly once,
            // and a later drop cannot re-run the release.
            let sig = 0;
            const ac = new AbortController();
            const h1 = c.enlist({}, () => sig++, { signal: ac.signal });
            ac.abort();
            h1();
            results.signalOnce = sig === 1;

            // Disposable handle: [Symbol.dispose] parity with the runtime's
            // other subscription handles.
            let disp = 0;
            const h2 = c.enlist({}, () => disp++);
            const viaDispose = typeof h2[Symbol.dispose] === "function";
            h2[Symbol.dispose]();
            results.dispose = viaDispose && disp === 1;

            // Release-throw containment: a throwing release runs the Scope
            // teardown convention - the error surfaces, the engine does not
            // throw into the caller's teardown flow - and the enrollment is
            // still finished (a second drop no-ops).
            let threw = false;
            let threwSecondNoop = false;
            const h3 = c.enlist({}, () => {
              throw new Error("boom");
            });
            try {
              h3();
            } catch {
              threw = true;
            }
            try {
              h3();
            } catch {
              threwSecondNoop = true;
            }
            results.contain = !threw && !threwSecondNoop;

            // The net is armed, not eager: before any release arm, the
            // resource descriptor is untouched.
            let lazy = 0;
            const rec = { dead: false };
            c.enlist(rec, () => { rec.dead = true; lazy++; }, {});
            results.lazy = lazy === 0;

            finish(results);
          } catch (err) {
            finish({ error: err.name + ": " + String(err.message).slice(0, 120) });
          }
        },
        (err) => finish({ error: "import " + String(err && err.message ? err.message : err).slice(0, 120) })
      );
    });
  }, `${baseUrl}${route}`);

  const row = (name, got, accepted) => rows.push({
    name,
    status: got === accepted ? "pass" : "fail",
    note: got === accepted ? null : `got ${JSON.stringify(got)}`,
    ms: null
  });
  rows.push({
    name: "gc-cleaner unit imports on the floor realm",
    status: probe.error === undefined ? "pass" : "fail",
    note: probe.error ?? null,
    ms: null
  });
  row("drop() releases exactly once", probe.dropOnce, true);
  row("the signal arm releases exactly once", probe.signalOnce, true);
  row("the drop handle carries [Symbol.dispose]", probe.dispose, true);
  row("a throwing release is contained, not rethrown", probe.contain, true);
  row("enlist arms the net without releasing", probe.lazy, true);
  return rows;
}
