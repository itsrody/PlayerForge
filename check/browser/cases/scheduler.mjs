/**
 * The scheduler façade pinned against the real floor browser. The retirement
 * audit (runtime.js header) rests on measured facts - the engine honors the
 * priority tiers, the façade's dead-handle/release/rejection-swallow
 * choreography is the one owner, the two-controller shape survives an abort
 * landing inside the task body, and the yield_() guard recovers what raw
 * scheduler.yield() rejects. The unit imports src/shared/runtime.js
 * (import-clean, the same module the fan case serves) straight from the
 * working tree and exercises the shipped façade in the page realm.
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
  const route = `/check/sched-unit-${Date.now()}.js`;
  session.registerAsset(route, Buffer.from(source), "text/javascript");

  const probe = await session.eval(async (url) => {
    const { postTask, yield_, delay, debounce } = await import(url);
    const results = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Capture unhandled rejections: the façade swallows the task rejection -
    // every teardown abort must stay off the page error surface.
    const unhandled = [];
    window.addEventListener("unhandledrejection", (e) => { unhandled.push(String(e.reason?.name ?? e.reason)); });

    let fired = false;
    postTask(() => { fired = true; });
    await new Promise((r) => setTimeout(r, 10));
    results.fires = fired === true;

    // Cancel: a pending delayed task aborted before its window never lands.
    let late = false;
    const cancel = postTask(() => { late = true; }, { delay: 400 });
    cancel.abort();
    await new Promise((r) => setTimeout(r, 20));
    results.cancel = late === false;

    // Owner-signal teardown: abort mid-window lands the pending task and
    // nothing surfaces (the swallow charge is row 8).
    let doomed = false;
    const ac = new AbortController();
    postTask(() => { doomed = true; }, { delay: 400, signal: ac.signal });
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));
    results.ownerAbort = doomed === false;

    // Already-aborted owner signal: dead handle, no scheduling, no throw.
    const dead = new AbortController();
    dead.abort();
    let schedNoop = true;
    postTask(() => { schedNoop = false; }, { signal: dead.signal });
    await new Promise((r) => setTimeout(r, 10));
    results.deadHandle = schedNoop === true;

    // The two-controller fence: the yield guard's own-aborted-task context
    // is the shape an over-merged façade would strand.
    let raw = null;
    let landedDirect = null;
    {
      const acRaw = new AbortController();
      const t = globalThis.scheduler.postTask(async () => {
        acRaw.abort();
        try { await globalThis.scheduler.yield(); raw = "raw-resolved"; }
        catch (err) { raw = "raw-reject " + err.name; }
      }, { signal: acRaw.signal });
      await t.catch(() => {});
    }
    {
      const acOwn = new AbortController();
      const t = globalThis.scheduler.postTask(async () => {
        acOwn.abort();
        await yield_();
        landedDirect = "guard-landed";
      }, { signal: acOwn.signal });
      await t.catch(() => {});
    }
    results.rawYield = raw;

    // Priority tiers order natively on this engine.
    const order = [];
    for (let round = 0; round < 3; round++) {
      await Promise.all([
        globalThis.scheduler.postTask(() => order.push("bg"), { priority: "background" }),
        globalThis.scheduler.postTask(() => order.push("uv")),
        globalThis.scheduler.postTask(() => order.push("blk"), { priority: "user-blocking" })
      ]);
      order.push("|");
    }
    results.priorities = order.join(",");

    // delay: lands after the window; its handle cancels the pending run.
    let timerFired = false;
    const cancelDelay = delay(() => { timerFired = true; }, 10);
    cancelDelay();
    await new Promise((r) => setTimeout(r, 30));
    results.delayCancel = timerFired === false;
    delay(() => { timerFired = true; }, 10);
    await new Promise((r) => setTimeout(r, 30));
    results.delayFires = timerFired === true;

    // debounce: trailing args win, cancel drops, flush commits now.
    const got = [];
    const debounced = debounce((x) => { got.push(x); }, 5);
    debounced(1);
    debounced(2);
    await new Promise((r) => setTimeout(r, 30));
    results.debounceTrailing = got.join(",") === "2";
    debounced(3);
    debounced.cancel();
    await new Promise((r) => setTimeout(r, 30));
    results.debounceCancel = got.join(",") === "2";
    debounced(4);
    debounced.flush();
    results.debounceFlush = got.join(",") === "2,4";

    // yield: resolves inside a healthy task.
    let yielded = false;
    await globalThis.scheduler.postTask(async () => {
      await yield_();
      yielded = true;
    }, {});
    results.yieldResolves = yielded === true;

    // Give any stray rejection a beat, then freeze the recorder and the
    // guard landing: the recovery rides microtasks behind the task promise's
    // abort rejection, so both must be read after settling, not inline.
    await new Promise((r) => setTimeout(r, 40));
    results.unhandled = unhandled.slice(0, 4);
    results.guardLands = landedDirect === "guard-landed";
    return results;
  }, `${baseUrl}${route}`);

  const row = (name, got, accepted) => rows.push({
    name,
    status: got === accepted ? "pass" : "fail",
    note: got === accepted ? null : `got ${JSON.stringify(got)}`,
    ms: null
  });
  row("the façade schedules and fires", probe.fires, true);
  row("the abort handle cancels a pending task", probe.cancel, true);
  row("owner-signal abort lands the pending task", probe.ownerAbort, true);
  row("an already-aborted owner signal is a dead handle", probe.deadHandle, true);
  row("raw scheduler.yield rejects in the own-aborted task", probe.rawYield, "raw-reject AbortError");
  row("the yield_() guard lands the chain raw strands", probe.guardLands, true);
  row("the engine orders the priority tiers natively", probe.priorities, "blk,uv,bg,|,blk,uv,bg,|,blk,uv,bg,|");
  row("delay cancels the pending run", probe.delayCancel, true);
  row("delay fires after its window", probe.delayFires, true);
  row("debounce lands the trailing call", probe.debounceTrailing, true);
  row("debounce cancel drops the pending call", probe.debounceCancel, true);
  row("debounce flush commits now", probe.debounceFlush, true);
  row("yield_() resolves inside a healthy task", probe.yieldResolves, true);
  rows.push({
    name: "teardown aborts keep task rejections off the error surface",
    status: probe.unhandled.length === 0 ? "pass" : "fail",
    note: probe.unhandled.length === 0 ? null : `unhandled: ${probe.unhandled.join(",")}`,
    ms: null
  });
  return rows;
}
