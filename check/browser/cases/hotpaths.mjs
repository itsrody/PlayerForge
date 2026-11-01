/**
 * Hot-path budgets: the per-frame/hot-echo loops the tree rides, measured in
 * the REAL engine (the harness's Firefox page realm), as regression tripwires.
 * This is the measurement discipline the redesign ledger enforced applied as
 * a permanent gate: micro-costs are either measured here or declined as
 * noise - and a budget row is the measured decline's living record (a red
 * row names the loop that regressed; nothing moves a budget without the
 * optimization story in the same commit).
 *
 * Benchmarks import the modules into the page realm the way the fan/sdk
 * cases do - the served working tree, mirror-structured so forgevtt's
 * relative import of shared/runtime.js resolves by the browser's own module
 * semantics (the fixture server matches pathnames, so one shared.ts-hint
 * registration serves every query-carrying subrequest).
 *
 * Budgets carry generous multipliers over measured baselines: the tripwire
 * exists to catch SHAPE regressions (an accidental allocation loop, a
 * megamorphic rewrite), not CI jitter - never a knife-edge that flakes.
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export async function run({ session, baseUrl }) {
  const rows = [];
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
  const bust = Date.now();

  // Mirror-structured registrations: forgevtt.ts imports ../../shared/runtime.js,
  // so both tree levels are mirrored (hotpath/shell/subtitles -> hotpath/shared).
  session.registerAsset(`/check/hotpath/shared/runtime.js`, Buffer.from(await readFile(join(root, "shared", "runtime.js"), "utf8")), "text/javascript");
  session.registerAsset(`/check/hotpath/shared/core.js`, Buffer.from(await readFile(join(root, "shared", "core.js"), "utf8")), "text/javascript");
  session.registerAsset(`/check/hotpath/shell/subtitles/forgevtt.js`, Buffer.from(await readFile(join(root, "shell", "subtitles", "forgevtt.js"), "utf8")), "text/javascript");

  const stats = await session.eval(function main(bust) {
    return import(`/check/hotpath/shell/subtitles/forgevtt.js?ts=${bust}`).then(async (forgevtt) => {
      const { Fan } = await import(`/check/hotpath/shared/runtime.js?ts=${bust}`);
      const { formatTime } = await import(`/check/hotpath/shared/core.js?ts=${bust}`);
      const out = {};

      // ---- Fan emit+dispatch at scale. 10 subscribers = the settings-bus
      // shape (the echo-storm row's audience); 0 subscribers = the
      // read-and-discard warm path. One warm pass first so the tripwire
      // measures the warmed JIT shape, not tier-up noise.
      const warmFan = new Fan("hot");
      for (let i = 0; i < 10; i++) {
        warmFan.subscribe(() => {});
      }
      const payload = { k: 1 };
      for (let i = 0; i < 1000; i++) {
        warmFan.emit(payload);
      }
      const echoFan = new Fan("hot");
      for (let i = 0; i < 10; i++) {
        echoFan.subscribe(() => { void payload.k; });
      }
      let t0 = performance.now();
      for (let i = 0; i < 100000; i++) {
        echoFan.emit(payload);
      }
      out.emit10x100k = performance.now() - t0;

      const quietFan = new Fan("hot");
      for (let i = 0; i < 1000; i++) {
        quietFan.emit(payload);
      }
      t0 = performance.now();
      for (let i = 0; i < 100000; i++) {
        quietFan.emit(payload);
      }
      out.emit0x100k = performance.now() - t0;

      // ---- The ingest arm's shape at over-512KiB scale: one full parse of
      // a ~1.1MB SRT (the over-threshold shape the subtitles case proves
      // lands its cue) and one again - the reparse the sync steppers ride.
      // Distinct sequential timecodes, ~10k cues.
      let text = "";
      let i = 1;
      while (text.length < 1100000) {
        const start = i * 1.25;
        const h = String(Math.floor(start / 3600)).padStart(2, "0");
        const m = String(Math.floor(start / 60) % 60).padStart(2, "0");
        const s = String(Math.floor(start) % 60).padStart(2, "0");
        const endMs = String(Math.round(((start + 1) % 1) * 1000)).padStart(3, "0");
        const endS = String(Math.floor(start + 1) % 60).padStart(2, "0");
        text += i + "\n" + h + ":" + m + ":" + s + "," + String(Math.round((start % 1) * 1000)).padStart(3, "0")
          + " --> " + h + ":" + m + ":" + endS + "," + endMs + "\nPF hotpath cue " + i + "\n\n";
        i++;
      }
      out.cueCount = i - 1;
      out.bytes = text.length;
      t0 = performance.now();
      const c1 = forgevtt.parseSubtitles(text);
      out.parseMs = performance.now() - t0;
      t0 = performance.now();
      const c2 = forgevtt.parseSubtitles(text, 500);
      out.reparseMs = performance.now() - t0;
      out.parsed = c1.length === c2.length && c1.length > 0;

      // ---- The formatters' warm cost (timeupdate cadence ~ 4Hz per HUD
      // element; 250k calls = ~17 hours of 4Hz updates on ONE formatter).
      t0 = performance.now();
      let sink = 0;
      for (let i = 0; i < 250000; i++) {
        sink += formatTime((i % 3600) + (i % 1000) / 1000).length;
      }
      out.formatMs = performance.now() - t0;
      // The sink keeps the whole loop live: dead-code elimination would be a
      // free win nobody measured.
      out.sinkAlive = sink > 0;
      return out;
    }, (err) => ({ importFailed: String(err) }));
  }, `${bust}`).then((v) => v, (err) => ({ importFailed: String(err) }));

  const noteOf = (k) => typeof stats[k] === "number" ? stats[k].toFixed(1) + "ms" : String(stats[k]);
  const st = (name, ok, note) => {
    rows.push({ name, status: ok ? "pass" : "fail", note: note ?? null, ms: null });
  };

  if (stats.importFailed) {
    st("hot-path unit modules import in the page realm", false, stats.importFailed);
    return rows;
  }
  st("hot-path unit modules import in the page realm", true);

  st(
    "fan dispatch: 100k emits with 10 subscribers inside the echo-audience budget",
    stats.emit10x100k < 2500,
    noteOf("emit10x100k")
  );
  st(
    "fan dispatch: 100k emits with zero subscribers inside the warm-read budget",
    stats.emit0x100k < 1000,
    noteOf("emit0x100k")
  );
  st(
    "ingest shape: the ~1.1MB track parses inside the over-threshold budget",
    stats.parsed === true && stats.parseMs < 4000,
    `${stats.cueCount} cues / ${stats.bytes} bytes in ${noteOf("parseMs")}`
  );
  st(
    "ingest shape: the offset reparse rides the same budget",
    stats.reparseMs < 4000,
    noteOf("reparseMs")
  );
  st(
    "formatters: 250k formatTime calls inside the HUD-cadence budget",
    stats.formatMs < 400,
    noteOf("formatMs")
  );
  return rows;
}
