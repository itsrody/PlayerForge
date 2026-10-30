/**
 * Fan census: the runtime's ONE fan-out owner pinned against the real floor
 * browser. Its subscription semantics - positional payload fan-out, signal
 * teardown, the Disposable subscribe handle, a mid-dispatch subscription
 * joining the next batch - live inside the realm whose dispatch rules the
 * platform defines, so a node import smoke cannot witness them honestly;
 * the unit imports src/shared/runtime.js (import-clean by design)
 * straight from the working tree and exercises the class in the page.
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
  const route = `/check/fan-unit-${Date.now()}.js`;
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
            const { Fan } = M;
            const results = {};

            let captured = null;
            const f0 = new Fan("unit");
            f0.subscribe((v) => { captured = v; });
            const payload = { k: 1 };
            f0.emit(payload);
            results.payload = captured === payload;

            let called = 0;
            const f1 = new Fan("unit");
            const off = f1.subscribe(() => { called++; });
            f1.emit(1);
            off();
            f1.emit(2);
            results.callable = called === 1;

            let sigCalled = 0;
            const ac = new AbortController();
            const f2 = new Fan("unit");
            f2.subscribe(() => { sigCalled++; }, { signal: ac.signal });
            f2.emit(1);
            ac.abort();
            f2.emit(2);
            results.signal = sigCalled === 1;

            // An already-aborted owner signal is the documented no-op
            // subscription: nothing attaches, the handle is still callable.
            let abortedCalled = 0;
            const dead = new AbortController();
            dead.abort();
            const f2d = new Fan("unit");
            const deadHandle = f2d.subscribe(() => { abortedCalled++; }, { signal: dead.signal });
            f2d.emit(1);
            results.aborted = abortedCalled === 0 && typeof deadHandle === "function";

            let dCalled = 0;
            const f3 = new Fan("unit");
            const handle = f3.subscribe(() => { dCalled++; });
            results.disposeProp = typeof handle[Symbol.dispose] === "function";
            f3.emit(1);
            handle[Symbol.dispose]();
            f3.emit(2);
            results.dispose = dCalled === 1;

            let usingOutcome = null;
            try {
              let uCalled = 0;
              const f4 = new Fan("unit");
              const runUsing = new Function("fan", "cb", `
                "use strict";
                {
                  using h = fan.subscribe(cb);
                }
                return true;
              `);
              usingOutcome = runUsing(f4, () => { uCalled++; });
              f4.emit(1);
              usingOutcome = usingOutcome === true && uCalled === 0;
            } catch (err) {
              usingOutcome = "THROW " + err.name;
            }
            results.using = usingOutcome;

            const a = [];
            const b = [];
            const f5 = new Fan("unit");
            f5.subscribe((v) => {
              a.push(v);
              if (v === 1) {
                f5.subscribe((w) => { b.push(w); });
              }
            });
            f5.emit(1);
            f5.emit(2);
            results.midDispatch = a.join(",") === "1,2" && b.join(",") === "2";

            const f6 = new Fan("unit");
            f6.subscribe(() => {});
            const t0 = performance.now();
            for (let i = 0; i < 10000; i++) {
              f6.emit(i);
            }
            results.millis = Math.round(performance.now() - t0);

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
    name: "fan unit imports on the floor realm",
    status: probe.error === undefined ? "pass" : "fail",
    note: probe.error ?? null,
    ms: null
  });
  row("emit fans the payload positionally", probe.payload, true);
  row("the returned handle tears the subscription", probe.callable, true);
  row("signal teardown is native", probe.signal, true);
  row("an already-aborted owner signal subscribes nothing", probe.aborted, true);
  row("the subscribe handle carries [Symbol.dispose]", probe.disposeProp, true);
  row("the subscribe handle disposes via Symbol.dispose", probe.dispose, true);
  row("`using` releases the subscription", probe.using, true);
  row("a mid-dispatch subscription joins the next batch", probe.midDispatch, true);
  rows.push({
    name: "10k emissions land inside the echo-row budget",
    status: typeof probe.millis === "number" && probe.millis < 400 ? "pass" : "fail",
    note: `${probe.millis}ms`,
    ms: probe.millis ?? null
  });
  return rows;
}
