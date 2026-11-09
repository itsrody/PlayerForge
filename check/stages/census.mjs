/**
 * Gate 3 - the executable census.
 *
 * The AGENTS.md census records (ten Fans, eleven Scope roots, the
 * zero-timer pipeline, zero manual teardowns, the network egress floor)
 * used to be prose re-derived by hand each review; here they are re-derived
 * by the tool, so a deliberate
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
/** Exported for the bundle stage's HUD-class agreement scan: one comment
 *  stripper, two consumers. */
export function stripComments(source) {
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
    expect: 11,
    why: "one destroy-root per feature instance carrying real { signal } wiring or defer disposers; the MediaSessionBridge flag-root retired - its listeners rode the claim's caller signal and the scope held no signal consumers and no disposers, a disposal boolean, not an abort story"
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
    expect: 8,
    why: "the verified-empty-catch belt: each one swallows a named-throwaway failure on purpose (the entry ad-host skip probe, the two forge pointer-capture lift races, the ui icon parse belt, the media session release/metadata writes, the shell section-destroy loop, the subtitle percent-decode display-name belt - decodeURIComponent throws URIError on a bare-% served pathname segment, and the raw segment is the fine fallback for a display NAME) - a new bare catch needs its own named why in the record"
  },
  {
    name: "Date.now reads",
    pattern: "Date.now(",
    expect: 9,
    why: "the wall-clock reads, page.js and resume.js only: resume entry timestamps and staleness cutoffs, plus page-context nonce/deadline math - the zero-timer pipeline's deadline class reads it at call time; a new consumer must join page/resume or name its own when-why (one resume read left with the never-written 'pending' vocabulary: its load-time sweep was the tenth)"
  },
  // Network egress floor: the product's one network story, pinned. The relay
  // is exactly one GM_xmlhttpRequest call (store.js gmRequestText), its one
  // consumer is the subtitle loadFromUrl ingest - which is what @connect *
  // is FOR (header side pinned in the bundle stage). Every native or
  // DOM-shaped channel counts 0: a return of any of these is a redesign
  // decision that must argue its why against the manager-relayed single
  // path, never an innocent-looking "second ingest" half-built on XHR or a
  // blob/img/src channel the API cannot grant.
  {
    name: "GM_xmlhttpRequest relay sites",
    pattern: "GM_xmlhttpRequest(",
    expect: 1,
    why: "the one cross-origin relay (store.js gmRequestText): timeout/ontimeout honored, no @connect gate - all egress must stay auditable at one function, the single-flight ingest story rests on it"
  },
  {
    name: "gmRequestText call sites",
    pattern: "gmRequestText(",
    expect: 2,
    why: "the relay definition plus its exactly-one consumer (subtitles.js loadFromUrl) - the voucher for @connect *; a third site is a new egress consumer joining the umbrella without the design conversation"
  },
  {
    name: "fetch calls",
    pattern: "fetch(",
    expect: 0,
    why: "no plain fetch anywhere in src: cross-origin text rides the manager relay (CORS bypass + grant) - a page-context fetch cannot load arbitrary-host subtitle files and silently dies on CORS"
  },
  {
    name: "XMLHttpRequest constructions",
    pattern: "new XMLHttpRequest",
    expect: 0,
    why: "the page-context XHR the manager relay replaces; also the shape the retired subtitlecat-era code would take if it ever came back outside the store"
  },
  {
    name: "WebSocket constructions",
    pattern: "new WebSocket",
    expect: 0,
    why: "no persistent channels: the product's only network session is one user-triggered subtitle GET"
  },
  {
    name: "EventSource constructions",
    pattern: "new EventSource",
    expect: 0,
    why: "no server-stream channels: same single-GET posture as the WebSocket row"
  },
  {
    name: "sendBeacon calls",
    pattern: "sendBeacon",
    expect: 0,
    why: "zero telemetry: the userscript reports nothing anywhere - a beacon-shaped call is a product-drift alarm, not a bug to fix"
  },
  {
    name: "importScripts references",
    pattern: "importScripts",
    expect: 0,
    why: "the dedicated-Worker subtitle offloader retired with its never-firing 512KiB gate; the cooperative scheduler.yield ingest arm is the whole decision space, and importScripts would be its network-eating resurrection"
  },
  {
    name: ".src assignments",
    pattern: ".src =",
    expect: 0,
    why: "the media plane is the single writer of HTMLMediaElement state, and even it never writes src - restoration rides currentTime; any src write is an untracked media load outside the manager's reach"
  },
  {
    name: "srcset attribute surfaces",
    pattern: "srcset",
    expect: 0,
    why: "no responsive-image vocabulary: the poster witness READS the poster attribute, never writes image sources"
  },
  {
    name: "createObjectURL calls",
    pattern: "createObjectURL(",
    expect: 0,
    why: "no blob channels: the drop ingest reads file.text() directly into #ingest, so no object URLs exist to revoke - a blob src would be a fetch-path the census's zero-rows cannot see"
  },
  {
    name: "createElement(\"script\")",
    pattern: "createElement(\"script\")",
    expect: 0,
    why: "no script injection: the only DOM the shell adds is shadow-hosted HUD vocabulary and adopted CSS sheets - a script tag is remote-code execution the grants never hint at"
  },
  {
    name: "createElement(\"iframe\")",
    pattern: "createElement(\"iframe\")",
    expect: 0,
    why: "no frame creation: the frame model already runs the script in every frame the page owns; an injected iframe ships a fetch-tagged document the exclusion vocabulary and the skip gate cannot see"
  },
  {
    name: "createElement(\"img\")",
    pattern: "createElement(\"img\")",
    expect: 0,
    why: "no image loads: MediaSession artwork witnesses the native poster attribute instead (the host page's own fetch does the work) - an img construction would be an untracked request"
  },
  {
    name: "createElement(\"track\")",
    pattern: "createElement(\"track\")",
    expect: 0,
    why: "the <track> parse ledger-rejection executable: a native track's src fetch rides the media element's path, bypassing both CORS and the GM grant, and the boot-restore would strand behind it - cue scheduling is OURS, no native TextTrack anywhere on the path"
  },
  {
    name: "createElement(\"link\")",
    pattern: "createElement(\"link\")",
    expect: 0,
    why: "no linked resources: the HUD sheet rides @resource pfStyle + adoptedStyleSheets - a link tag is UA-scheduled prefetch the header vocabulary cannot audit"
  },
  {
    name: "local file text reads",
    pattern: "await file.text(",
    expect: 1,
    why: "the sibling of the URL path: the panel drop ingest reads the dropped File object directly into #ingest - one site, no network, anchored here so an egress-shaped reader cannot masquerade as it"
  }
];

export async function run() {
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
