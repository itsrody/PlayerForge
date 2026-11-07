import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";

// The manifest's version is interpolated from package.json rather than typed
// here. It was a literal next to a second copy in package.json under a comment
// calling itself "the single version source" - which was not true, and which
// had already drifted once in the harness (a hardcoded '0.7.1-test' beside a
// project on 0.7.2, invisible because the assertions compared against that
// same string). Deriving it here removes the class of bug; the harness keeps
// its own derivation of the same source. Runtime reads the installed
// extension's real version through browser.runtime.getManifest(), so bumping
// package.json is all a release takes. Read as JSON rather than imported so
// the value stays a plain string and the build cannot pull in module caching
// or an accidental code path from it.
const PACKAGE = JSON.parse(readFileSync("./package.json", "utf8"));
const PACKAGE_VERSION = PACKAGE.version;

// Gecko identifier: the permanent per-AMO identity backing the extension's
// storage namespace and update channel. A stable literal, not derived - it
// is the one value in the package that must NEVER change once published
// (deriving it from a name or path would orphan existing installs' storage).
const GECKO_ID = "playerforge@itsrody.dev";

// Semver-ish guard. Firefox orders version numerically to decide whether to
// offer an upgrade, so a malformed value is not cosmetic: it can make a
// release unpublishable, or make an existing install silently un-upgradable.
// Throwing at build time keeps a bad bump from ever reaching dist/.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) {
  throw new Error(
    `package.json version "${PACKAGE_VERSION}" is not MAJOR.MINOR.PATCH; ` +
      `Firefox orders versions numerically to decide upgrades`
  );
}

// Minified is the only output. Minification is SpiderMonkey-safe by
// construction: esbuild only does the safe transforms (whitespace,
// local-identifier mangling, syntax compression) - it never introduces
// eval/with, never mangles property names, so the engine's
// hidden-class/IC-driven optimization is untouched. The embedded stylesheet
// is minified separately (esbuild's JS minifier would not shrink a
// text-loaded string); the CSS pass below is deliberately conservative so
// calc()/content and selector whitespace survive intact.

// Document-start note: content_scripts run_at: "document_start" is the
// manifest-vocabulary equivalent of the userscript header's @run-at - the
// script runs before the document parses, and PF never assumes the DOM is
// ready, so late injects were already safe by design.

/**
 * Platform bans - the ONE source table for the exclusion surface. The
 * userscript header spelled them as @exclude-match lines; the extension
 * spells them as manifest exclude_matches patterns, one per banned
 * platform host. Firefox's match-pattern wildcard `*.<host>/*` covers the
 * apex domain too (the same matcher semantic the userscript header's
 `*.` pairs rode - the released WebExtension matcher covers the empty
 * subdomain alternative), so one line per platform suffices here where the
 * userscript header needed apex-pair lines only because of a glob-vs-
 * match-pattern vocabulary difference, not a matcher difference.
 */
const EXCLUDED_PLATFORMS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "netflix.com",
  "disneyplus.com",
  "primevideo.com",
  "hulu.com",
  "max.com",
  "hbomax.com",
  "tv.apple.com",
  "peacocktv.com",
  "paramountplus.com",
  "crunchyroll.com",
  "bilibili.com",
  "dailymotion.com",
  "twitch.tv",
  "facebook.com",
  "fb.watch",
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
  "tumblr.com"
];

/**
 * The package manifest, built here once per build from the source tables
 * above. MV2: Firefox has no MV2 deprecation plan (Mozilla's 2024-2026
 * policy), blocking host permissions via the background page's fetch are
 * exactly what the subtitle ingest needs, and `persistent: true` keeps the
 * fetch relay's awaited promise alive (an event page could suspend under
 * Firefox's idle rules mid-request; the relay is session-scale and the
 * single-flight shape has no wake logic to write).
 */
function buildManifest() {
  return {
    manifest_version: 2,
    name: "PlayerForge",
    version: PACKAGE_VERSION,
    description: PACKAGE.description,
    author: "PlayerForge",
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "159.0"
      }
    },
    icons: {
      "48": "icon.svg",
      "96": "icon.svg"
    },
    // "storage" backs the store plane; "<all_urls>" is the host permission
    // the background fetch relay rides (the package's one network egress);
    // "webRequest" is the background ledger's OBSERVE-only surface - the
    // media hint never blocks or rewrites a request, so no
    // webRequestBlocking ever joins (a blocking grant would be a redesign
    // decision of its own).
    permissions: ["storage", "webRequest", "<all_urls>"],
    content_scripts: [
      {
        // The frame model's full reach: every frame of every page, top and
        // cross-origin, running document_start. match_origin_as_fallback
        // covers the initiator-scoped vocabulary (about:srcdoc/blob/data
        // descendants) the userscript's match-all header could inject into
        // and a plain pattern cannot name; entry.js's own skip gate keeps
        // the ad/captcha/data frames out at runtime, above this floor, as
        // it always has.
        matches: ["<all_urls>"],
        exclude_matches: EXCLUDED_PLATFORMS.map((host) => `*://*.${host}/*`),
        js: ["content.js"],
        run_at: "document_start",
        all_frames: true,
        match_origin_as_fallback: true
      }
    ],
    background: {
      scripts: ["background.js"],
      persistent: true
    },
    browser_action: {
      default_popup: "popup.html",
      default_title: "PlayerForge",
      default_icon: "icon.svg"
    }
  };
}

/**
 * Release-time verification for the manifest. This block the browser reads
 * to install - a dropped field is a broken package that fails at install
 * time (or worse, silently drops a capability). Fails the build rather
 * than ship an unparsable or capability-losing manifest.
 */
function verifyManifest(manifest) {
  const required = {
    "manifest_version": 2,
    "name": "PlayerForge"
  };
  for (const [name, expect] of Object.entries(required)) {
    if (manifest[name] !== expect) {
      throw new Error(`manifest: ${name} must be ${expect}`);
    }
  }
  if (manifest.version !== PACKAGE_VERSION) {
    throw new Error("manifest: version not derived from package.json");
  }
  const cs = manifest.content_scripts?.[0];
  if (manifest.content_scripts?.length !== 1) {
    throw new Error("manifest: exactly one content_scripts entry");
  }
  if (cs.js.join(",") !== "content.js") {
    throw new Error("manifest: content script list must be exactly [content.js]");
  }
  if (cs.run_at !== "document_start" || cs.all_frames !== true) {
    throw new Error("manifest: content script must run document_start, all_frames");
  }
  if (cs.matches?.join() !== "<all_urls>") {
    throw new Error("manifest: content script must match <all_urls>");
  }
  const exclusions = cs.exclude_matches ?? [];
  if (exclusions.length !== EXCLUDED_PLATFORMS.length) {
    throw new Error(`manifest: exclusion surface drifted: ${exclusions.length} patterns, ${EXCLUDED_PLATFORMS.length} platforms`);
  }
  if (exclusions[0] !== "*://*.youtube.com/*") {
    throw new Error("manifest: exclusion patterns not derived from the platform table");
  }
  if (!manifest.permissions.includes("storage") || !manifest.permissions.includes("<all_urls>")) {
    throw new Error("manifest: storage + <all_urls> host permission missing");
  }
  // Observe-only posture: webRequest listens, nothing blocks. webRequestBlocking
  // in the list would make the match-all content plane's observation grant a
  // blocking power the ledger never uses and the census cannot audit.
  if (!manifest.permissions.includes("webRequest")) {
    throw new Error("manifest: webRequest observation permission missing");
  }
  if (manifest.permissions.includes("webRequestBlocking")) {
    throw new Error("manifest: webRequestBlocking must never ship (observe-only posture)");
  }
  if (!manifest.background?.scripts?.includes("background.js")) {
    throw new Error("manifest: background page missing");
  }
  if (manifest.browser_action?.default_popup !== "popup.html") {
    throw new Error("manifest: browserAction popup missing");
  }
  // The package members the zip reads must exist where the manifest points:
  // the loader (content.js) is hand-maintained chrome shipping verbatim,
  // popup/icon the same, and background.js/kernel.js/shell.js (validated
  // below) are build output the manifest's scripts/background vocabulary
  // reference - checked here for existence so a missing output dies here.
  for (const member of ["background.js", "popup.html", "popup.js", "icon.svg"]) {
    if (!existsSync(new URL(`./dist/extension/${member}`, import.meta.url))) {
      throw new Error(`chrome member missing from dist/extension: ${member}`);
    }
  }
}

/**
 * Conservative CSS minifier. Safe for this stylesheet's constructs (var(),
 * calc(), min(), content:'', @starting-style): comments are dropped, whitespace
 * runs collapse to one space, and whitespace is stripped only when adjacent to
 * a structural delimiter ({ } ; : , ( )) — guarded by two token-merge rules:
 * stripping the run between an identifier-ish character and "(" (or ":")
 * would merge two tokens into one — " and (" into the function token and(...),
 * ":is(" into a compound-pseudo colon+function — and stripping the run between
 * ")" and the calc infix ("+" or "-") cuts the whitespace the calc-sum grammar
 * requires on both sides of the operator. Both classes are probed-on-the-floor
 * facts: Firefox silently rewrites `)and(` to `@media not all` (a media row
 * that never applies), so the run is re-emitted as one space wherever either
 * class exists. Whitespace that merely separates two otherwise-unmergeable
 * tokens — calc("100% - 24px") arithmetic, descendant selectors — is left
 * collapsed to a single space, so collapsing can never merge tokens into a
 * different rule.
 */
function minifyCss(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const collapsed = noComments.replace(/\s+/g, " ");
  // Pass 1: whitespace around {} ; : , ( — the run before a delimiter is
  // preserved (as one space) when dropping it would merge the preceding
  // identifier into a function token (ident+"(") or a compound pseudo
  // (ident+":"); the run after is always strippable, since "("+"ident" and
  // ":"+"ident" stay separate tokens in that direction.
  const delimSlim = collapsed.replace(/\s*([{};:,(])\s*/g, (match, delim, offset, text) => {
    const hadRun = match[0] === " ";
    const before = offset > 0 ? text[offset - 1] : "";
    const runMerges = delim === "(" || delim === ":";
    return runMerges && hadRun && /[A-Za-z0-9_%.@#-]/.test(before) ? " " + delim : delim;
  });
  // Pass 2: whitespace after ")". Preserved for the two grammar classes that
  // require the separator: the media-query keyword ("and", "not" — the MQ
  // prelude silently rewrites a row parsed without this whitespace to
  // `@media not all`), and calc's +/- infix, which must be surrounded by
  // whitespace on BOTH sides even after a closing paren (") + var").
  // A run before ")" is strippable ("%)" tokenizes as number+paren).
  const slim = delimSlim.replace(/\)\s*/g, (match, offset, text) => (
    /[A-Za-z+-]/.test(text[offset + match.length] ?? "") ? ") " : ")"
  ));
  return slim.trim();
}

/** esbuild plugin: serve .css text imports through the minifier above. */
function minifyCssPlugin() {
  const cache = new Map();
  return {
    name: "pf-minify-css",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        let out = cache.get(args.path);
        if (out === undefined) {
          const raw = readFileSync(args.path, "utf8");
          out = minifyCss(raw);
          cache.set(args.path, out);
        }
        return { contents: out, loader: "text" };
      });
      // Fingerprint log after the build (an accidental dirty or regenerated
      // stylesheet is visible before it ships). NOT runtime SRI - the sheet
      // rides the signed package now; pinning a hash would be computed
      // from the same build and pin nothing.
      build.onEnd(() => {
        for (const [path, css] of cache) {
          const digest = createHash("sha256").update(css).digest("hex");
          console.log(`[PlayerForge] css fingerprint ${path}: sha256=${digest.slice(0, 16)}…`);
        }
      });
    }
  };
}

const shared = {
  bundle: true,
  format: "iife",
  target: ["firefox159"],
  loader: { ".css": "text" },
  // Emit real UTF-8 instead of \uXXXX escapes: the three intentional UI
  // glyphs (close X, settings gear, toast separator) stay readable and the
  // bundle stops paying six bytes per code point.
  charset: "utf8",
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
};

const watch = process.argv.includes("--watch");

/**
 * Release-time verification for the minified script bundles. Minification
 * is SpiderMonkey-safe by construction (esbuild never emits eval/with,
 * never mangles property names), but a broken minifier would violate
 * exactly those promises - or silently corrupt other artifacts the
 * extension reads. This gate fails the build rather than ship a bundle
 * that is unsafe to interpret.
 */
function verifyBundle(text, label) {
  const forbidden = [
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "new Function"],
    [/\bwith\s*\(/, "with"],
    // The userscript plane's vocabulary must not survive a platform port:
    // GM_* symbols in a content bundle crash at eval (no manager realm),
    // and a residual @resource/@grant line means the userscript banner leaked in.
    [/GM_\w/, "GM_ vocabulary"],
    [/@resource/, "@resource"],
    [/@grant\b/, "@grant"]
  ];
  for (const [re, label] of forbidden) {
    if (re.test(text)) {
      throw new Error(`${label} build: forbidden construct '${label}' in bundle`);
    }
  }
}

/**
 * Minimal STORE-mode ZIP writer (no compression, zero dependencies). The
 * XPI is a ZIP with manifest.json at its root; the shipped members are
 * already minified text or tiny assets, so STORE costs ~bytes over DEFLATE
 * and keeps the writer auditable in one screen. GECKO-VERIFY note: Firefox
 * accepts stored entries for temporary installs (the harness path); AMO
 * review re-packs, so this writer only ever builds the local/dev XPI.
 */
function zipXpi(files) {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) {
      c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  // Fixed DOS timestamp (1980-01-01 00:00): a build must be reproducible,
  // and per-file mtime would make two builds of one tree differ.
  const modDate = 0x21;
  const modTime = 0;

  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0, 6);          // flags
    local.writeUInt16LE(0, 8);          // method: store
    local.writeUInt16LE(modTime, 10);
    local.writeUInt16LE(modDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);      // compressed
    local.writeUInt32LE(size, 22);      // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra length
    nameBuf.copy(local, 30);
    chunks.push(local, data);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);           // version made by
    dir.writeUInt16LE(20, 6);           // version needed
    dir.writeUInt16LE(0, 8);            // flags
    dir.writeUInt16LE(0, 10);           // method
    dir.writeUInt16LE(modTime, 12);
    dir.writeUInt16LE(modDate, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(size, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);           // extra
    dir.writeUInt16LE(0, 32);           // comment
    dir.writeUInt16LE(0, 34);           // disk start
    dir.writeUInt16LE(0, 36);           // internal attrs
    dir.writeUInt32LE(0, 38);           // external attrs
    dir.writeUInt32LE(offset, 42);      // local header offset
    nameBuf.copy(dir, 46);
    central.push(dir);

    offset += local.length + size;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // disk number
  eocd.writeUInt16LE(0, 6);            // disk where the central directory starts
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);      // central dir offset
  eocd.writeUInt16LE(0, 20);           // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

async function buildPackage() {
  const distDir = new URL("./dist/extension/", import.meta.url);
  mkdirSync(distDir, { recursive: true });

  // The hand-maintained chrome members live here and ship verbatim. The  // three script bundles are build output: content.js is a hand-written
  // classic loader (the manifest's js[] vocabulary is classic scripts), the
  // kernel/shell entries are ESM build output with code splitting, and
  // background.js is build output of src/background (an IIFE - the manifest's
  // background scripts vocabulary is classic too).
  const buildEntries = [
    { in: "src/entry.js", out: "kernel" },
    { in: "src/shell/shell.js", out: "shell" }
  ];
  const esmOpts = {
    ...shared,
    format: "esm",
    splitting: true,
    outdir: "dist/extension",
    entryPoints: buildEntries,
    plugins: [minifyCssPlugin()],
    minify: true
  };
  const backgroundOpts = {
    ...shared,
    entryPoints: ["src/background/index.js"],
    outfile: "dist/extension/background.js",
    minify: true
  };

  if (watch) {
    await (await context(esmOpts)).watch();
    console.log("[PlayerForge] watching (minified); manifest/xpi build once per npm run build");
    return;
  }

  await Promise.all([build(esmOpts), build(backgroundOpts)]);

  const manifest = buildManifest();
  verifyManifest(manifest);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(new URL("./dist/extension/manifest.json", import.meta.url), manifestText);

  // Determinism check: an identical source tree must produce an identical
  // package (the XPI is distributed; a non-deterministic build would make
  // two "same-version" releases differ at the byte level and erase the
  // receipt value of a release's hash). All build outputs - the three
  // script bundles and any shared chunk splitting emitted - compare
  // byte-for-byte against a write:false rebuild.
  const second = await Promise.all([
    build({ ...esmOpts, write: false }),
    build({ ...backgroundOpts, write: false })
  ]);
  for (const outputs of second.map((b) => b.outputFiles)) {
    for (const file of outputs) {
      // readFileSync throws if a second-run output missed the disk, which
      // is its own determinism failure (the build never wrote it).
      if (!readFileSync(file.path).equals(Buffer.from(file.text, "utf8"))) {
        throw new Error(`min build: non-deterministic bundle (disk vs rebuild mismatch: ${file.path})`);
      }
    }
  }
  const kernelText = readFileSync(new URL("kernel.js", distDir), "utf8");
  const shellText = readFileSync(new URL("shell.js", distDir), "utf8");
  const backgroundText = readFileSync(new URL("background.js", distDir), "utf8");
  verifyBundle(kernelText, "kernel");
  verifyBundle(shellText, "shell");
  verifyBundle(backgroundText, "background");

  // The zip ships the dist tree itself: every member read from
  // dist/extension (its only home), byte-identical to what Firefox's
  // unpacked install would load. Membership is audited, not trusted: the
  // chrome members are known, the manifest names content.js/background.js,
  // the two entries are kernel.js/shell.js, and any other member must be a
  // splitting chunk - anything else is a stray in the package tree that
  // would silently ship.
  const memberNames = readdirSync(distDir).sort();
  const known = new Set([
    "manifest.json",
    "content.js",
    "background.js",
    "kernel.js",
    "shell.js",
    "popup.html",
    "popup.js",
    "icon.svg"
  ]);
  for (const name of memberNames) {
    if (!known.has(name) && !/^chunk-[0-9A-Za-z]+\.js$/.test(name)) {
      throw new Error(`unknown member in dist/extension: ${name}`);
    }
  }
  const zip = zipXpi(memberNames.map((name) => ({
    name,
    data: name === "manifest.json"
      ? Buffer.from(manifestText, "utf8")
      : readFileSync(new URL(name, distDir))
  })));
  writeFileSync(new URL("./dist/playerforge.xpi", import.meta.url), zip);
  console.log(`[PlayerForge] built dist/extension + dist/playerforge.xpi (${zip.length} bytes, ${memberNames.length} members, v${PACKAGE_VERSION})`);
}

await buildPackage();
