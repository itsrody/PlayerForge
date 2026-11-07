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
    why: "the verified-empty-catch belt: each one swallows a named-throwaway failure on purpose (the entry ad-host skip probe, the two forge pointer-capture lift races, the ui icon parse belt, the media session release/metadata writes, the shell section-destroy loop, the runtime debug-rail mirror) - a new bare catch needs its own named why in the record"
  },
  {
    name: "Date.now reads",
    pattern: "Date.now(",
    expect: 9,
    why: "the wall-clock reads, page.js and resume.js only: resume entry timestamps and staleness cutoffs, plus page-context nonce/deadline math - the zero-timer pipeline's deadline class reads it at call time; a new consumer must join page/resume or name its own when-why (one resume read left with the never-written 'pending' vocabulary: its load-time sweep was the tenth)"
  },
  // Network egress floor: the product's one network story, pinned. The
  // relay is exactly one background-page fetch (src/background/relay.js,
  // bundled into the generated background.js) - the background's <all_urls>
  // host permission is what cross-origin subtitle ingest is FOR (manifest
  // side pinned in the bundle stage). Every page-context or DOM-shaped
  // channel counts 0: a return of any of these is a redesign decision that
  // must argue its why against the background-relayed single path, never an
  // innocent-looking "second ingest" half-built on XHR or a blob/img/src
  // channel the page's CORS cannot grant.
  {
    name: "fetch calls",
    pattern: "fetch(",
    expect: 1,
    why: "the package's one network egress: the background relay's single fetch (AbortSignal.timeout, body drained inside the handler before the reply) - a content-side fetch would ride the page's CORS and silently die on exactly the user-supplied hosts the ingest serves"
  },
  {
    name: "GM vocabulary (src)",
    pattern: "GM_",
    expect: 0,
    why: "the userscript plane's manager vocabulary left with the GM-realm port; a return is a mixed-plane build, not a port - the two adapter surfaces are store.js (browser.* wrappers) and the extension chrome"
  },
  {
    name: "message receivers",
    pattern: "onMessage.addListener",
    expect: 3,
    why: "the package's three runtime.onMessage receivers: the background relay's one text-relay surface (pf:request-text), kernel.js TabCommands' one command receiver (pf:command, top-frame), and the entry's one hint receiver (pf:net-media, every frame) - a fourth receiver is a new message surface joining without a design conversation"
  },
  {
    name: "message senders",
    pattern: "sendMessage(",
    expect: 5,
    why: "the five runtime/tabs senders: store.js requestText (content -> background relay), popup.js (pages -> the active tab's commander), the ledger's one hint send (background -> the frame that carried media traffic, frame-targeted), the background's command arm (the debug handle's pfCommand relayed over the popup's exact tabs.sendMessage hop - a cross-extension caller structurally cannot make that call, tabs.sendMessage delivers only to the calling extension's own content scripts), and the debug handle's one runtime.sendMessage (content -> background, the same chrome only triggers in debug mode) - every untracked message channel is egress the census cannot see"
  },
  // The background ledger's observe-only webRequest floor: two listeners +
  // one tab-drop hook, the whole uBO-grade substrate the hint plane rides.
  // Blocking (webRequestBlocking) is pinned absent at the manifest.
  {
    name: "webRequest navigation hooks",
    pattern: "onBeforeRequest",
    expect: 1,
    why: "the ledger's one navigation hook: main_frame clears the tab's hinted set, sub_frame clears the frame's entry - hint freshness is event-driven all the way down (the zero-timer pipeline holds in the background plane), no second observer and no clock joins"
  },
  {
    name: "webRequest media observers",
    pattern: "onHeadersReceived",
    expect: 1,
    why: "the ledger's one response observer: media/xhr requests in all frames, answering a video/audio content-type with ONE frame-targeted hint (contract's NET_HINT) - observation only, never blocking, no rewrite, no second sniffing surface"
  },
  {
    name: "tabs.onRemoved hooks",
    pattern: "tabs.onRemoved",
    expect: 1,
    why: "the ledger's tab-drop invalidation: the (tab, frame) hint Map never outlives its tab - a hook per hint-channel is the lease the state is held under"
  },
  {
    name: "storage.local call sites",
    pattern: "browser.storage.local",
    expect: 2,
    why: "the storage data plane's two call sites, both in store.js: the warm wholesale get(null) and setValue's write-behind set - a storage call outside store.js is an escaped cache plane (sync reads serve the map, never IPC)"
  },
  {
    name: "storage echo listeners",
    pattern: "storage.onChanged",
    expect: 1,
    why: "the one onChanged listener (store.js) owns the whole cross-instance echo contract: envelope unwrap, own-write identity dedup, value-map delivery, per-key watcher fan-out - a second listener would fork the delivery contract"
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
    why: "no linked resources: the HUD sheet rides the package's own stylesheet (adoptedStyleSheets from the bundled string) - a link tag is UA-scheduled prefetch the manifest vocabulary cannot audit"
  },
  {
    name: "local file text reads",
    pattern: "await file.text(",
    expect: 1,
    why: "the sibling of the URL path: the panel drop ingest reads the dropped File object directly into #ingest - one site, no network, anchored here so an egress-shaped reader cannot masquerade as it"
  }
];

export async function run() {
  // The corpus is the whole shipped package's hand-maintained JS: the
  // player plane (src/**, the background ledger/relay included) PLUS the
  // hand-written chrome members that live in the dist/extension package
  // tree (the content loader, the popup). background.js is BUILD OUTPUT of
  // src/background now - counting it would double-count the relay - and
  // the kernel/shell/chunk bundles are the same src counted once, so only
  // the hand-maintained members join the walk.
  const files = [
    ...walk(SRC),
    join(HERE, "dist", "extension", "content.js"),
    join(HERE, "dist", "extension", "popup.js")
  ];
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
