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
  // The adoption plane's mirror: detection imports only its contract (a
  // zero-import leaf), so two files serve the identity engine whole.
  session.registerAsset(`/check/hotpath/kernel/contract.js`, Buffer.from(await readFile(join(root, "kernel", "contract.js"), "utf8")), "text/javascript");
  session.registerAsset(`/check/hotpath/kernel/detection.js`, Buffer.from(await readFile(join(root, "kernel", "detection.js"), "utf8")), "text/javascript");

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
      // Format-string churn is the one allocation the HUD's own budget row
      // rides: strings cannot be pooled across calls with different values
      // (and a value-keyed memo would be an unbounded cache), so the row
      // measures the strings' own cost - which is the shape already adopted.
      t0 = performance.now();
      let sink = 0;
      for (let i = 0; i < 250000; i++) {
        sink += formatTime((i % 3600) + (i % 1000) / 1000).length;
      }
      out.formatMs = performance.now() - t0;
      // The sink keeps the whole loop live: dead-code elimination would be
      // a free win nobody measured.
      out.sinkAlive = sink > 0;

      // ---- Allocation-approach probes: fresh-vs-pooled shapes measured
      // side by side over the same arithmetic, so any adoption is a
      // measured win and any decline is a recorded verdict.
      // (a) The subtitle derivePicture result box at rVFC cadence: fresh
      // object per render vs a two-slot ping-pong (compare before mutate,
      // swap on move) — the shape a pooled rewrite would adopt.
      const freshBoxes = () => {
        let acc = 0;
        let shapeA = null;
        let shapeB = null;
        for (let i = 0; i < 1000000; i++) {
          const box = { x: i % 7, y: (i * 3) % 11, width: 100 + (i % 5), height: 50 + (i % 3) };
          const prev = i % 2 ? shapeA : shapeB;
          if (!prev || prev.x !== box.x || prev.y !== box.y
            || prev.width !== box.width || prev.height !== box.height) {
            if (i % 2) { shapeA = box; } else { shapeB = box; }
            acc++;
          }
        }
        return acc;
      };
      const pooledBoxes = () => {
        let acc = 0;
        // The shape a pooled rewrite would adopt: ONE retained picture and
        // ONE derive scratch - fully written before the compare, swapped by
        // reference on move - never a stale-aliased self-compare (the
        // per-side latched-slot model this probe first used aliased scratch
        // into its own latched slot, and the self-compare froze it).
        let picture = { x: -1, y: -1, width: 0, height: 0 };
        const scratch = { x: 0, y: 0, width: 0, height: 0 };
        for (let i = 0; i < 1000000; i++) {
          scratch.x = i % 7;
          scratch.y = (i * 3) % 11;
          scratch.width = 100 + (i % 5);
          scratch.height = 50 + (i % 3);
          if (picture.x !== scratch.x || picture.y !== scratch.y
            || picture.width !== scratch.width || picture.height !== scratch.height) {
            picture.x = scratch.x;
            picture.y = scratch.y;
            picture.width = scratch.width;
            picture.height = scratch.height;
            acc++;
          }
        }
        return acc;
      };
      freshBoxes();
      pooledBoxes();
      out.boxFresh = freshBoxes();
      t0 = performance.now();
      out.boxFreshCensus = freshBoxes();
      out.boxFreshMs = performance.now() - t0;
      t0 = performance.now();
      out.boxPooledCensus = pooledBoxes();
      out.boxPooledMs = performance.now() - t0;
      // Same work both variants: divergent move censuses mean the shapes
      // diverged and only the matching censuses are a like-for-like pair.
      out.boxLike = out.boxFreshCensus === out.boxPooledCensus;

      // (b) The sync-offset cue-list rebuild (#applyBase) at stepper cadence:
      // fresh Array + fresh cue object per cue per commit vs reusing the
      // list and its objects (only start/end rewritten) with a module-level
      // comparator. 15 commits over the REAL parsed cue list.
      const COMMITS = 15;
      const IMPULSE = 250;
      const comparator = (a, b) => a.start - b.start || a.end - b.end;
      const rebuildFresh = () => {
        const out2 = new Array(c1.length);
        for (let i = 0; i < c1.length; i++) {
          const src = c1[i];
          out2[i] = {
            start: src.start + IMPULSE,
            end: src.end + IMPULSE,
            text: src.text,
            line: src.line,
            position: src.position,
            align: src.align
          };
        }
        out2.sort((a, b) => a.start - b.start || a.end - b.end);
        return out2.length;
      };
      const rebuildPooled = (() => {
        // The pooled variant's state mirrors what the src rewrite would
        // hold: one list, one object per cue, rewritten in place.
        const list = new Array(c1.length);
        for (let i = 0; i < c1.length; i++) {
          const src = c1[i];
          list[i] = {
            start: 0, end: 0, text: src.text, line: src.line,
            position: src.position, align: src.align
          };
        }
        let flipped = false;
        return () => {
          for (let i = 0; i < c1.length; i++) {
            const dst = list[i];
            const src = c1[i];
            if (flipped) {
              dst.start = src.start;
              dst.end = src.end;
            } else {
              dst.start = src.start + IMPULSE;
              dst.end = src.end + IMPULSE;
            }
          }
          flipped = !flipped;
          list.sort(comparator);
          return list.length;
        };
      })();
      rebuildFresh();
      rebuildPooled();
      out.rebuildFreshCensus = 0;
      t0 = performance.now();
      for (let i = 0; i < COMMITS; i++) {
        out.rebuildFreshCensus += rebuildFresh();
      }
      out.rebuildFreshMs = performance.now() - t0;
      out.rebuildPooledCensus = 0;
      t0 = performance.now();
      for (let i = 0; i < COMMITS; i++) {
        out.rebuildPooledCensus += rebuildPooled();
      }
      out.rebuildPooledMs = performance.now() - t0;

      // ---- The adoption identity path. Detection's engine is the uBO
      // one-pass shape riding native C++ delegates: one composed chain per
      // scan, per-anchor matches() bounded by the best hops so far, and the
      // parent-stamped descriptor cache converting every repeat query into
      // one WeakMap read + one parentNode compare. Two budgets pin the
      // plane: the FIRST-RESOLVE walk (per distinct parenting state - the
      // miss path matchSdk bounds) and the REPEAT resolve (the hit path
      // every discovery re-entry and the kernel re-wrap seam ride). The
      // hit row is the regression tripwire for the one shape failure this
      // plane can suffer: a change that turns its steady state back into
      // walk-rate work.
      const { resolveAdoptionHome } = await import(`/check/hotpath/kernel/detection.js?ts=${bust}`);
      const mkStub = () => {
        const wrap = document.createElement("div");
        wrap.className = "plyr";
        const inner = document.createElement("div");
        inner.className = "plyr__video-wrapper";
        inner.setAttribute("data-plyr", "");
        const video = document.createElement("video");
        inner.appendChild(video);
        wrap.appendChild(inner);
        return video;
      };
      const missVideos = [];
      for (let i = 0; i < 1000; i++) missVideos.push(mkStub());
      resolveAdoptionHome(mkStub());
      t0 = performance.now();
      let misses0 = 0;
      for (let i = 0; i < 1000; i++) {
        misses0 += resolveAdoptionHome(missVideos[i]) ? 1 : 0;
      }
      out.adoptFirstMs = performance.now() - t0;
      out.adoptFirstHits = misses0;
      const hitVideo = mkStub();
      resolveAdoptionHome(hitVideo);
      t0 = performance.now();
      for (let i = 0; i < 100000; i++) resolveAdoptionHome(hitVideo);
      out.adoptHitMs = performance.now() - t0;

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
  st(
    "allocation probe: fresh picture-box churn at 1M renders inside the shape budget",
    stats.boxLike === true && stats.boxFreshMs < 800,
    `fresh=${noteOf("boxFreshMs")} pooled=${noteOf("boxPooledMs")} moves=${stats.boxFreshCensus}`
  );
  st(
    "allocation probe: pooled picture ping-pong rides the same shape budget",
    stats.boxPooledMs < 800,
    `pooled=${noteOf("boxPooledMs")} vs fresh=${noteOf("boxFreshMs")} - the delta is the pooling adoption's whole measured case`
  );
  st(
    "allocation probe: 15 fresh cue-list rebuilds at 19k cues inside the stepper-drag budget",
    stats.rebuildFreshMs < 3000,
    `fresh=${noteOf("rebuildFreshMs")} pooled=${noteOf("rebuildPooledMs")}`
  );
  st(
    "allocation probe: in-place cue rebuild rides the comparison row",
    stats.rebuildPooledMs < 3000,
    `pooled=${noteOf("rebuildPooledMs")} vs fresh=${noteOf("rebuildFreshMs")} over ${stats.cueCount} cues x 15 commits`
  );
  st(
    "adoption identity: 1000 first-resolve walks resolve (thoroughness) inside the miss-rate budget",
    stats.adoptFirstHits === 1000 && stats.adoptFirstMs < 50,
    `${stats.adoptFirstHits}/1000 resolved in ${noteOf("adoptFirstMs")} - ~5us per composed walk over the real registry is the measured baseline; this row catches a walker regression at ~10x`
  );
  st(
    "adoption identity: 100k repeat resolves ride the hit-path budget (the descriptor cache's steady state)",
    stats.adoptHitMs < 70,
    `${noteOf("adoptHitMs")} - ~70ns per hit (one WeakMap read + one parentNode compare + the record alloc) is the measured baseline; a hit-path climb means the walk leaked into the steady state`
  );
  return rows;
}
