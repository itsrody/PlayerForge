/**
 * Gate 3 - the executable census.
 *
 * The AGENTS.md census records (ten Fans, twelve Scope roots, the
 * zero-timer pipeline, zero manual teardowns) used to be prose re-derived by
 * hand each review; here they are re-derived by the tool, so a deliberate
 * change that moves a count turns the gate red until the recorded census in
 * AGENTS.md is updated with its why in the same commit. The counts are
 * literal occurrence counts over comment-stripped source - prose that names
 * a pattern (runtime.js mentions `catch {}` in a docstring, kernel.js names
 * `removeEventListener` in a comment) must not count, so a naive grep would
 * misreport the record the moment the prose mentioned it.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(HERE, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}

/**
 * Charset state machine over one file: line/block comments collapse to a
 * space (so a comment fragment can never join its surroundings into a
 * countable pattern), string and template bodies pass through escape-aware.
 * Comment prose mentioning a pattern therefore never inflates a count.
 */
function stripComments(source) {
  let out = "";
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        out += " ";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        out += source.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/* Each row's why-docstring: what the count IS in the product, so a red row
 * is answered by a reasoning commit, never by bumping the number. */
const ROWS = [
  {
    name: "Fan instances",
    pattern: "new Fan(",
    expect: 10,
    why: "the one plain-fan-out owner; ten owners, one per grain - the few-fans review recorded them with their subscriber axes, and direct-callback or grain-tagged-bus reducers are declined verdicts"
  },
  {
    name: "Scope destroy-roots",
    pattern: "new Scope(",
    expect: 12,
    why: "one destroy-root per feature instance; signal-scoped teardown everywhere, zero removal-list pairs (§5.5)"
  },
  {
    name: "setTimeout calls",
    pattern: "setTimeout(",
    expect: 0,
    why: "the zero-timer pipeline: every cadence is a coalescer, deadline-over-witness-absence, or product-defined feature timer, and all ride the shared scheduler (postTask/delay/debounce)"
  },
  {
    name: "setInterval calls",
    pattern: "setInterval(",
    expect: 0,
    why: "the zero-timer pipeline: no poll-style timers; resume checkpoints ride the native timeupdate media clock (~4Hz while advancing)"
  },
  {
    name: "removeEventListener calls",
    pattern: "removeEventListener(",
    expect: 0,
    why: "the manual-removal census: teardown rides native aborts ({ signal } options), an abort-fire tears the whole set down; Fan's own handle dispatches by abort"
  },
  {
    name: "clearTimeout calls",
    pattern: "clearTimeout(",
    expect: 0,
    why: "timer cancellation rides the scheduler's AbortSignal handles (delay/debounce/postTask), never raw clearTimeout pairs"
  },
  {
    name: "AbortController machines",
    pattern: "new AbortController(",
    expect: 16,
    why: "the deliberate release-controller census: each is one machine's internal teardown root (postTask owner bridge, DomSettleWait, DomWatch's subscribe release and defer machine, the pinch wheel, Fan's subscribe handle, the page.js pipe-request settle family, per-pipe entries and the bridge install mount, the panel's per-open dismissal scope, the layout-gate reveal listener, the media-tap scope, the entry hint composite source, per-scope roots) - every hand-rolled release machine rides one of these; the kernel settle-scope retired into the kernel Scope (pagehide disposal already aborted both, one owner per abort story)"
  },
  {
    name: "bare catch blocks",
    pattern: "catch {}",
    expect: 6,
    why: "the verified-empty-catch belt: each one swallows a named-throwaway failure on purpose (entry install probe, forge pointer details, ui icon parse, media position-state races) - a new bare catch needs its own named why in the record"
  },
  {
    name: "Date.now reads",
    pattern: "Date.now(",
    expect: 10,
    why: "the wall-clock reads, page.js and resume.js only: resume entry timestamps and staleness cutoffs, plus page-context nonce/deadline math - the zero-timer pipeline's deadline class reads it at call time; a new consumer must join page/resume or name its own when-why"
  }
];

export async function run() {
  const start = Date.now();
  const files = walk(SRC);
  const countsPerRow = ROWS.map((row) => ({ ...row, total: 0, sites: [] }));
  for (const file of files) {
    const label = file.replace(HERE + "/", "");
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const entry of countsPerRow) {
      let from = 0;
      while (true) {
        const at = stripped.indexOf(entry.pattern, from);
        if (at === -1) break;
        entry.total += 1;
        entry.sites.push(label);
        from = at + entry.pattern.length;
      }
    }
  }
  const rows = countsPerRow.map(({ name, expect, total, why }) => {
    if (total === expect) {
      return { name: `${name} = ${expect}`, status: "pass", note: why, ms: null };
    }
    return {
      name: `${name} = ${total}`,
      status: "fail",
      note: `expected ${expect} - ${why}; a count moved: acknowledge it by updating this gate's expect and the AGENTS.md census with the change's why in the same commit`,
      ms: null
    };
  });
  const ok = rows.every((r) => r.status === "pass");
  return { rows, ok };
}
