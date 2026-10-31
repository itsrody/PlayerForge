/**
 * Fan census: the runtime's ONE fan-out owner pinned against the real floor
 * browser. Its subscription semantics - positional payload fan-out, signal
 * teardown, the Disposable subscribe handle, a mid-dispatch subscription
 * joining the next batch - live inside the realm whose dispatch rules the
 * platform defines, so a node import smoke cannot witness them honestly;
 * the unit imports src/shared/runtime.js (import-clean by design)
 * straight from the working tree and exercises the class in the page.
 * The last row witnesses native dispatch isolation, and does so from a
 * page-realm stack: exceptions raised inside a Marionette eval stack -
 * sync or task-scheduled - report nowhere (the sandbox realm's error
 * surface is not the page's, probed), so the throw emits from a module
 * script the page itself imports, where the platform's report the
 * exception to the window error surface is the by-design behavior the
 * kernel's retired per-listener try/catch trusted. Witnesses run on both
 * listeners and the deliberate, asserted error sentences itself out of
 * __pfErrors: a deliberate exception is not an accidental uncaught page
 * error (the menus case holds the same position for command throws).
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

  // Native dispatch isolation, witnessed from a page-realm stack. Two
  // probed harness facts shape this row: exceptions raised inside a
  // Marionette eval stack - synchronously or from a task it scheduled -
  // report nowhere (the sandbox realm's error surface is not the page's),
  // while the same throw from a page-stack module script reports to the
  // window error surface normally. So the witness module script injected
  // from the eval turn owns the import, the dispatch, and the throw's
  // surface reading, the poll settles on the report (queued as a DOM task
  // around the throw), and the deliberate, asserted error is then
  // sentenced out of __pfErrors - it entered through the forensic listener
  // EARLIER in registration order than anything this case can install, so
  // no preventDefault ordering can keep it off the surface - spelling it
  // into the audit's own ledger terms is the only honest accounting (the
  // menus case holds the same position for deliberate command throws).
  const isoMarker = `pf-fan-iso-${Math.random().toString(36).slice(2, 8)}`;
  const iso = await session.evalAsync(function main(asset, marker, done) {
    window.__isoMsg = null;
    window.__isoThrew = "pending";
    window.__isoSeen = null;
    window.addEventListener("error", (e) => { window.__isoMsg ??= String(e.message); }, { capture: true });
    const script = document.createElement("script");
    script.type = "module";
    script.textContent =
      'import("' + asset + '").then((M) => {' +
      '  const fan = new M.Fan("unit");' +
      '  const seen = [];' +
      '  fan.subscribe(() => { throw new Error("' + marker + '"); });' +
      '  fan.subscribe((v) => { seen.push(v); });' +
      '  let threw = null;' +
      '  try { fan.emit(7); } catch (e) { threw = String(e?.message ?? e); }' +
      '  window.__isoSeen = seen.slice();' +
      '  window.__isoThrew = threw;' +
      '});';
    document.body.append(script);
    const deadline = performance.now() + 5000;
    const tick = () => {
      const errs = window.__pfErrors ?? [];
      const settled = window.__isoThrew !== "pending"
        && (errs.some((e) => e.includes(marker)) || String(window.__isoMsg ?? "").includes(marker));
      const timedOut = performance.now() > deadline;
      if (!settled && !timedOut) {
        setTimeout(tick, 100);
        return;
      }
      const idx = errs.findIndex((e) => e.includes(marker));
      if (idx >= 0) {
        errs.splice(idx, 1);
      }
      done({
        threw: window.__isoThrew === "pending" ? "unsettled" : window.__isoThrew,
        seen: window.__isoSeen,
        surfaced: String(window.__isoMsg ?? "").includes(marker),
        reported: idx >= 0
      });
    };
    tick();
  }, `${baseUrl}${route}`, isoMarker);
  rows.push({
    name: "a throwing subscriber strands neither followers nor the emit call (native dispatch isolation)",
    status: iso.threw === null && iso.seen?.length === 1 && iso.seen?.[0] === 7
      && iso.surfaced === true && iso.reported === true ? "pass" : "fail",
    note: iso.error ?? `threw=${JSON.stringify(iso.threw)} seen=${JSON.stringify(iso.seen)} surfaced=${iso.surfaced} reported=${iso.reported}`,
    ms: null
  });
  return rows;
}
