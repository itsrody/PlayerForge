/**
 * JIT-shape browser benchmark — what megamorphic and allocating shapes cost
 * in real Gecko, as opposed to in Node.
 *
 * The sibling `chromium` branch ran five waves of this work against Node 26.9 /
 * V8 14.6, and its headline numbers (an 8.6x on `matchPreset`, a 1.6x on the
 * scrub curve) are V8 numbers. SpiderMonkey has its own inline caches and its
 * own Warp tiering, so those figures do not transfer and cannot be quoted as
 * evidence for a Gecko-targeted change. This file exists to re-price the
 * candidate shapes on the engine PF actually ships on.
 *
 * WHAT IS AND IS NOT MEASURED. Like `write-cost.bench.mjs`, these rows are
 * driven page-side, because PF runs in the manager's isolated userscript realm
 * and no page-side timing can reach into it. That caveat is fatal for a DOM
 * measurement — realm isolation changes what the CSS engine costs — and it is
 * *not* fatal for this one: every row below is pure JS with no DOM access, and
 * it is compiled by the same SpiderMonkey instance in the same process,
 * wherever it is sourced from. IC shape and tier-up do not depend on which
 * content realm the bytecode came from.
 *
 * So the honest claim these rows license is narrow and specific: **the shape
 * costs X in Gecko 158**. Not "PF's filter is X times faster". A row earns the
 * right to change `src/` because the fixture is a faithful copy of the shape
 * that code already has, and the win is applied there on that basis.
 *
 * Fidelity notes, because a sloppy fixture would flatter the candidate:
 *
 *   - Each row replicates its shape verbatim rather than calling a shared
 *     helper, so a per-call property load never lands on both sides unevenly.
 *   - `matchPreset` is priced on both of its real paths. Mid-drag the inner
 *     loop breaks at j=0 for nearly every preset, so the keyed sites are rarely
 *     reached deeply; on preset select the values match a preset and one scan
 *     runs all nine keys to the end. Those two paths cost very differently and
 *     only the second is the shape the 8.6x was measured against, so both are
 *     reported rather than the flattering one.
 *   - The pointer-capture row compares a Map walk against an array walk. That
 *     is deliberately not a like-for-like shape swap: a Map cannot be indexed,
 *     so removing that per-move iterator *requires* changing the data
 *     structure. The row therefore prices the data-structure change, and its
 *     number is an upper bound on what closing that gap could ever win.
 *   - A global sink keeps each op observable so nothing is dead-code
 *     eliminated. It costs one property load and store per op, identically on
 *     both sides of every pair, so it cancels out of the deltas.
 *
 * Every row is report-only. The meaningful quantity is the ratio between the
 * two arms of a pair, not either absolute — the same reasoning that keeps
 * `write-cost` ungated, and the reason this file needs no `baseline.json`
 * entry and no deliberate `--record`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FirefoxDriver, TestServer, createTestPage } from "../harness/firefox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE = readFileSync(join(HERE, "..", "..", "dist", "playerforge.user.js"), "utf8");

const BATCHES = 7;
const ITERATIONS = 15;

export default async function runJitShapeBench(bundle = DEFAULT_BUNDLE) {
  const server = new TestServer();
  await server.start();
  // The native harness registers the userscript once at startup, so a custom
  // build is chosen at launch rather than injected afterwards.
  const driver = await FirefoxDriver.launch({ bundle });
  const results = [];

  try {
    await driver.navigate(createTestPage(server));
    await driver.injectGMStubs();
    await driver.injectScript();
    await driver.eval(PRIME);

    for (const pair of [
      presetMatchPair("mid-drag, early break", "DRAG"),
      presetMatchPair("preset select, full scan", "EXACT"),
      scrubCurvePair(),
      pinchDistancePair(),
      pointerCapturePair(),
      swipeTransformPair(),
      roundFactorPair(),
      freezePair(),
      withResolversPair(),
      scopeConstructPair(),
      realmCopyPair(),
      mapGetPair(),
      optionalChainPair(),
      addedNodesPair(),
    ]) {
      // Which fixture the arms read is passed as an op argument rather than
      // parked on a global, so neither arm can be perturbed by the other.
      const args = pair.valuesKey ? [pair.valuesKey] : [];
      const firstBatches = [];
      const secondBatches = [];
      for (let b = 0; b < BATCHES; b++) {
        const firstSamples = [];
        const secondSamples = [];
        for (let i = 0; i < ITERATIONS; i++) {
          // Interleaved arm order within the batch, so a machine that warms or
          // cools across the run moves both sides together.
          firstSamples.push((await driver.amplifiedEval(null, pair.firstOp, { args })).perOp);
          secondSamples.push((await driver.amplifiedEval(null, pair.secondOp, { args })).perOp);
        }
        firstBatches.push(median(firstSamples));
        secondBatches.push(median(secondSamples));
      }
      push(results, pair.label + " - " + pair.firstName, firstBatches);
      push(results, pair.label + " - " + pair.secondName, secondBatches);
    }
  } finally {
    await driver.destroy();
    await server.stop();
  }

  return results;
}

const median = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Collapse one arm's per-batch medians into a result row, report-only. */
function push(results, name, batchMedians) {
  const sorted = [...batchMedians].sort((a, b) => a - b);
  results.push({
    name,
    medianMsPerOp: sorted[Math.floor(sorted.length / 2)],
    spread: (sorted[sorted.length - 1] - sorted[0]) / sorted[Math.floor(sorted.length / 2)],
    gateable: false,
  });
}

/* ------------------------------------------------------------------ *
 * Page-side fixture data, installed once.
 *
 * Nine filter keys and seven presets, matching src/shell/filter.js, plus the
 * pointer map and the velocity table the other arms need. Kept out of the ops
 * so no arm pays for building them.
 * ------------------------------------------------------------------ */
const PRIME = `
  const ALL_KEYS = ["brightness","contrast","saturate","hue","grayscale","sepia","invert","temperature","tint"];
  const PRESETS = [
    { brightness: 100, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 0, tint: 0 },
    { brightness: 105, contrast: 115, saturate: 85, hue: 0, grayscale: 0, sepia: 15, invert: 0, temperature: 10, tint: 2 },
    { brightness: 105, contrast: 110, saturate: 140, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 5, tint: 0 },
    { brightness: 100, contrast: 110, saturate: 0, hue: 0, grayscale: 100, sepia: 0, invert: 0, temperature: 0, tint: 0 },
    { brightness: 100, contrast: 100, saturate: 60, hue: 0, grayscale: 0, sepia: 80, invert: 0, temperature: 15, tint: 0 },
    { brightness: 90, contrast: 120, saturate: 90, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: -20, tint: -5 },
    { brightness: 102, contrast: 95, saturate: 80, hue: 0, grayscale: 15, sepia: 25, invert: 0, temperature: 12, tint: 5 }
  ];
  const ENTRIES = Object.entries(PRESETS);

  // Two value shapes.
  //
  // DRAG is mid-gesture on brightness. It matches no preset and, because
  // brightness is ALL_KEYS[0], every preset mismatches at j=0, so the keyed
  // loop takes its earliest exit on the first key every time.
  //
  // EXACT equals PRESETS[5]. Five presets still mismatch at j=0, but that one
  // is compared all nine keys deep before it is accepted — the deepest scan the
  // real function can be driven into.
  const DRAG = { brightness: 101, contrast: 100, saturate: 100, hue: 0, grayscale: 0, sepia: 0, invert: 0, temperature: 0, tint: 0 };
  const EXACT = { ...PRESETS[5] };

  const VELOCITIES = [];
  for (let i = 0; i < 64; i++) VELOCITIES.push(120 + i * 37.5);

  // The pointer map the forge's #pointers holds during a pinch, plus the
  // array-backed list its candidate replacement would hold instead.
  const POINTERS = new Map();
  POINTERS.set(11, { x: 120, y: 300, id: 11 });
  POINTERS.set(12, { x: 480, y: 520, id: 12 });

  window.__pfJit = {
    ALL_KEYS,
    ENTRIES,
    DRAG,
    EXACT,
    VELOCITIES,
    KNEE: 400,
    EXPONENT: 1.5,
    POINTERS,
    POINTER_LIST: [...POINTERS.values()]
  };

  // Fixture shapes for the second wave of pairs below. Each mirrors the
  // production shape it prices rather than an idealized version of it.
  window.__pfShapes = (() => {
    // status-manager.js #queue freezes {seq,kind,name,from,to,cause} per
    // transition; the nested error detail below mirrors the object the
    // realm-crossing dispatch round-trips beside the primitives.
    const NESTED = { code: 4, message: "NotAllowedError" };
    // scheduler.js postTask mints a Scope (controller + disposed flag +
    // null disposers) per scheduled task; the alternative is the bare
    // controller the handle would own directly.
    class ScopeLike {
      #controller = new AbortController();
      #disposers = null;
      #disposed = false;
      dispose() {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#controller.abort();
      }
    }
    // The intent table forge.js consults per keystroke, and the keyed-object
    // form the candidate would replace it with.
    const INTENT = new Map([["play", 1], ["pause", 2], ["seek", 3], ["mute", 4]]);
    const INTENT_OBJ = { play: 1, pause: 2, seek: 3, mute: 4 };
    const INTENT_KEYS = ["play", "pause", "seek", "mute"];
    // scheduler.js's "signal?.aborted" / "signal?.addEventListener" shape:
    // mostly a live signal, sometimes null.
    const WITH_M = { m(x) { return x + 1; } };
    const MAYBES = [WITH_M, null, WITH_M, WITH_M, null, WITH_M];
    // A live NodeList, not an array: forEachVideoInMutations drains
    // mutation.addedNodes, and only a live list carries the iterator cost
    // the pair below prices (a plain array would scalar-replace it away).
    const holder = document.createElement("div");
    holder.innerHTML = "<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>";
    document.body.appendChild(holder);
    const ADDED = holder.childNodes;
    return { NESTED, ScopeLike, INTENT, INTENT_OBJ, INTENT_KEYS, MAYBES, ADDED };
  })();
`;

/**
 * `matchPreset`, priced on both of its real paths.
 *
 * Arm one is the shape in the tree today: a keyed inner loop over ALL_KEYS, so
 * each of the two load sites sees nine different property names. Arm two is the
 * sibling branch's unrolled literal compare.
 */
function presetMatchPair(label, valuesKey) {
  return {
    label: `preset match (${label})`,
    firstName: "keyed inner loop",
    secondName: "unrolled literal compares",
    firstOp: function keyedLoop(valuesKey) {
      const { ALL_KEYS, ENTRIES } = window.__pfJit;
      const values = window.__pfJit[valuesKey];
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (let i = 0; i < ENTRIES.length; i++) {
          const preset = ENTRIES[i][1];
          let hit = true;
          for (let j = 0; j < ALL_KEYS.length; j++) {
            const key = ALL_KEYS[j];
            if (values[key] !== preset[key]) {
              hit = false;
              break;
            }
          }
          if (hit) acc += i;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function unrolled(valuesKey) {
      const { ENTRIES } = window.__pfJit;
      const values = window.__pfJit[valuesKey];
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (let i = 0; i < ENTRIES.length; i++) {
          const preset = ENTRIES[i][1];
          if (
            values.brightness === preset.brightness &&
            values.contrast === preset.contrast &&
            values.saturate === preset.saturate &&
            values.hue === preset.hue &&
            values.grayscale === preset.grayscale &&
            values.sepia === preset.sepia &&
            values.invert === preset.invert &&
            values.temperature === preset.temperature &&
            values.tint === preset.tint
          ) {
            acc += i;
          }
        }
      }
      window.__pfJitSink = acc;
    },
    valuesKey,
  };
}

/**
 * The scrub velocity curve at actions.js:552. `x ** 1.5` with a
 * non-integer exponent is a `Math.pow` call on both engines; the candidate
 * spends a multiply and a sqrt instead. The exponent is the tuning default, so
 * the swap has to stay gated on the exact configured value.
 */
function scrubCurvePair() {
  return {
    label: "scrub velocity curve (x ** 1.5)",
    firstName: "pow via ** operator",
    secondName: "x * sqrt(x)",
    firstOp: function scrubPow() {
      const { VELOCITIES, KNEE, EXPONENT } = window.__pfJit;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (let i = 0; i < VELOCITIES.length; i++) {
          const v = VELOCITIES[i];
          const t = Math.min(1, (v / KNEE) ** EXPONENT);
          acc += t > 0.5 ? 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function scrubSqrt() {
      const { VELOCITIES, KNEE, EXPONENT } = window.__pfJit;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (let i = 0; i < VELOCITIES.length; i++) {
          const v = VELOCITIES[i];
          const x = v / KNEE;
          const t = Math.min(1, EXPONENT === 1.5 ? x * Math.sqrt(x) : x ** EXPONENT);
          acc += t > 0.5 ? 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}

/** `Math.hypot` against the plain sqrt form the same file already uses elsewhere. */
function pinchDistancePair() {
  return {
    label: "pinch distance",
    firstName: "Math.hypot",
    secondName: "sqrt(dx*dx + dy*dy)",
    firstOp: function pinchHypot() {
      const p = window.__pfJit.POINTER_LIST;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const dx = p[1].x - p[0].x;
        const dy = p[1].y - p[0].y;
        acc += Math.hypot(dx, dy) > 300 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function pinchSqrt() {
      const p = window.__pfJit.POINTER_LIST;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const dx = p[1].x - p[0].x;
        const dy = p[1].y - p[0].y;
        acc += Math.sqrt(dx * dx + dy * dy) > 300 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The pinch pair capture. `captureFirstTwo` reads the first two live pointers
 * into pooled scratch, which removed the result allocation, but it still walks
 * the Map with `for (const point of pointers.values())` — one iterator per
 * move. The comment above it claims the loop is allocation-free, so this row
 * asks whether that claim survives measurement, and prices the only change
 * that could close the gap.
 */
function pointerCapturePair() {
  return {
    label: "pinch pointer capture (per move)",
    firstName: "Map.values() iterator walk",
    secondName: "array-backed list (no iterator)",
    firstOp: function captureIterator() {
      const { POINTERS } = window.__pfJit;
      const out = { x0: 0, y0: 0, x1: 0, y1: 0 };
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        let seen = 0;
        for (const point of POINTERS.values()) {
          if (seen === 0) {
            out.x0 = point.x;
            out.y0 = point.y;
          } else {
            out.x1 = point.x;
            out.y1 = point.y;
            acc += out.x1 - out.x0 + out.y1 - out.y0;
            break;
          }
          seen = 1;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function captureIndexed() {
      const list = window.__pfJit.POINTER_LIST;
      const out = { x0: 0, y0: 0, x1: 0, y1: 0 };
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        out.x0 = list[0].x;
        out.y0 = list[0].y;
        out.x1 = list[1].x;
        out.y1 = list[1].y;
        acc += out.x1 - out.x0 + out.y1 - out.y0;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The swipe transform at forge.js:943. The value being concatenated onto is
 * `translateY(<drag>px)`, but the arm being concatenated ONTO - the base
 * transform, latched once when the stroke latches - is re-read and re-joined
 * into a fresh prefix on every single move, behind a ternary, even though it
 * cannot have changed since the latch. The candidate caches the prefix at latch
 * time and leaves one concat per move.
 *
 * Note what this row is NOT: it is not a before/after for guarding on the drag
 * delta. `forge.js:942` already does that, so both arms below carry the guard.
 * The delta measured here is purely the per-move prefix derivation.
 */
function swipeTransformPair() {
  return {
    label: "swipe transform (down-swipe drag, per move)",
    firstName: "re-derived prefix per move",
    secondName: "prefix cached at latch",
    firstOp: function swipeConcatFirst() {
      const base = "translateX(0px)";
      let drag = 0;
      let last = "";
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        // Both arms carry the drag-delta guard that forge.js:942 already has.
        // The drag changes on only some moves, exactly as in a real drag.
        drag = n % 8 === 0 ? (drag + 1) % 40 : drag;
        const t = base ? base + " translateY(" + drag + "px)" : "translateY(" + drag + "px)";
        if (t !== last) {
          last = t;
          acc += t.length;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function swipeGuardFirst() {
      const base = "translateX(0px)";
      const prefix = base ? base + " translateY(" : "translateY(";
      let drag = 0;
      let lastDrag = -1;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        drag = n % 8 === 0 ? (drag + 1) % 40 : drag;
        if (drag !== lastDrag) {
          const t = prefix + drag + "px)";
          lastDrag = drag;
          acc += t.length;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The stepper's rounding factor. `roundTo` recomputes `10 ** decimals` on
 * every call, and it is called per nudge — about 13/s while a chevron is held.
 * The decimals are fixed per widget, so the factor is loop-invariant.
 */
function roundFactorPair() {
  return {
    label: "stepper roundTo (per nudge, ~13/s held)",
    firstName: "10 ** decimals per call",
    secondName: "hoisted factor",
    firstOp: function roundPowEachCall() {
      const decimals = 2;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const value = 100 + (n % 40) * 1.37;
        const factor = 10 ** decimals;
        acc += Math.round(value * factor) / factor;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function roundHoistedFactor() {
      const decimals = 2;
      const factor = 10 ** decimals;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const value = 100 + (n % 40) * 1.37;
        acc += Math.round(value * factor) / factor;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The status transition object. status-manager.js #queue freezes
 * {seq,kind,name,from,to,cause} per transition so a delivered change can
 * never be mutated under a subscriber; the candidate drops the freeze and
 * ships the literal.
 */
function freezePair() {
  return {
    label: "status transition freeze (per transition)",
    firstName: "Object.freeze per object",
    secondName: "plain literal",
    firstOp: function freezeEach() {
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const change = Object.freeze({ seq: n, kind: "scalar", name: "volume", from: 1, to: 0.5, cause: "volumechange" });
        acc += change.to === 0.5 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function plainEach() {
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const change = { seq: n, kind: "scalar", name: "volume", from: 1, to: 0.5, cause: "volumechange" };
        acc += change.to === 0.5 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * Deferred primitives. lifecycle.js and context.js build deferred waits with
 * Promise.withResolvers(); the candidate is the explicit executor form.
 */
function withResolversPair() {
  return {
    label: "deferred primitive (per wait)",
    firstName: "Promise.withResolvers",
    secondName: "new Promise executor",
    firstOp: function withResolvers() {
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        // Only resolve is read; the promise is created either way, which is
        // what is being priced.
        const { resolve } = Promise.withResolvers();
        resolve(n);
        acc += 1;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function executorForm() {
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        let resolve;
        new Promise((res) => {
          resolve = res;
        });
        resolve(n);
        acc += 1;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The per-task teardown owner. scheduler.js postTask mints a Scope
 * (controller + disposed flag + null disposers) per scheduled task so the
 * handle and the owner signal share one vocabulary; the candidate is the
 * bare controller the handle would own directly.
 */
function scopeConstructPair() {
  return {
    label: "teardown owner construction (per scheduled task)",
    firstName: "Scope (controller + flags)",
    secondName: "bare AbortController",
    firstOp: function scopeEach() {
      const { ScopeLike } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const scope = new ScopeLike();
        scope.dispose();
        acc += 1;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function controllerEach() {
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const controller = new AbortController();
        controller.abort();
        acc += 1;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The realm-crossing detail build. status-manager.js #dispatch shallow-copies
 * the change and round-trips nested values through JSON so the page realm
 * receives plain data, never foreign-realm objects; the candidate passes the
 * nested reference straight through (unsafe across realms, priced to show
 * what the safety costs).
 */
function realmCopyPair() {
  return {
    label: "realm detail build (per transition)",
    firstName: "shallow copy + JSON round trip",
    secondName: "reference pass-through",
    firstOp: function jsonCopy() {
      const { NESTED } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const detail = { kind: "scalar", nested: JSON.parse(JSON.stringify(NESTED)) };
        acc += detail.nested.code === 4 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function refPass() {
      const { NESTED } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const detail = { kind: "scalar", nested: NESTED };
        acc += detail.nested.code === 4 ? 1 : 0;
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The intent lookup. forge.js consults a Map per keystroke; the candidate is
 * the keyed-object read on an equivalent fixed-shape table.
 */
function mapGetPair() {
  return {
    label: "intent table lookup (per keystroke)",
    firstName: "Map.get",
    secondName: "keyed object read",
    firstOp: function mapGet() {
      const { INTENT, INTENT_KEYS } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        acc += INTENT.get(INTENT_KEYS[n % INTENT_KEYS.length]);
      }
      window.__pfJitSink = acc;
    },
    secondOp: function objectRead() {
      const { INTENT_OBJ, INTENT_KEYS } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        acc += INTENT_OBJ[INTENT_KEYS[n % INTENT_KEYS.length]];
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The guarded probe. scheduler.js and the gesture key gate read
 * `signal?.aborted` / `el.closest?.()` where the receiver is usually
 * present and sometimes null; the candidate is the explicit null check
 * with a direct call.
 */
function optionalChainPair() {
  return {
    label: "guarded probe (mostly present, sometimes null)",
    firstName: "optional call + nullish",
    secondName: "explicit null check",
    firstOp: function optionalCall() {
      const { MAYBES } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const node = MAYBES[n % MAYBES.length];
        acc += node?.m(1) ?? 0;
      }
      window.__pfJitSink = acc;
    },
    secondOp: function explicitCheck() {
      const { MAYBES } = window.__pfShapes;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        const node = MAYBES[n % MAYBES.length];
        acc += node == null ? 0 : node.m(1);
      }
      window.__pfJitSink = acc;
    },
  };
}

/**
 * The added-node walk. forEachVideoInMutations drains mutation.addedNodes -
 * a live NodeList - with for..of today; the candidate walks it by index, the
 * way the same function already drains querySelectorAll results. A plain
 * array would be the wrong fixture here (its iterator scalar-replaces away),
 * so PRIME parks a live childNodes list for both arms.
 */
function addedNodesPair() {
  return {
    label: "mutation added-node walk (per batch)",
    firstName: "for..of over live NodeList",
    secondName: "indexed walk",
    firstOp: function forOfNodes() {
      const list = window.__pfShapes.ADDED;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (const node of list) {
          acc += node.nodeType === 1 ? 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
    secondOp: function indexedNodes() {
      const list = window.__pfShapes.ADDED;
      let acc = 0;
      for (let n = 0; n < 64; n++) {
        for (let i = 0; i < list.length; i++) {
          acc += list[i].nodeType === 1 ? 1 : 0;
        }
      }
      window.__pfJitSink = acc;
    },
  };
}