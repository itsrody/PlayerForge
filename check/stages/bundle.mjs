/**
 * Gate 4 - the artifact itself.
 *
 * Builds the shipping extension and validates what the browser (and the
 * check's own browser stage) rely on: the manifest parses and carries the
 * frame model's contract (all frames, document_start, the exclusion
 * platform floor, the storage + webRequest(+Blocking, the reforge execute
 * arm) + host permissions),
 * the three script bundles match their kind (the kernel/shell entries are
 * ESM build output with code splitting - the shell lazy-loads through the
 * kernel's dynamic import - and background.js is IIFE build output of
 * src/background), the hand-maintained chrome members ship verbatim from
 * the package tree, and the XPI zip carries exactly the dist tree's
 * members, verifiable against it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./census.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT = join(HERE, "dist", "extension");
const XPI = join(HERE, "dist", "playerforge.xpi");

/**
 * Minimal STORE-mode ZIP reader (the writer's inverse, no compression):
 * the central directory only - name list + a manifest-bytes extraction.
 * The XPI is the signed-binary stand-in the harness installs, so the gate
 * asserts what the install consumes, not zip internals Firefox re-reads
 * itself.
 */
function zipMembers(bytes) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && eocd === -1; i--) {
    if (bytes[i] === sig[0] && bytes[i + 1] === sig[1] && bytes[i + 2] === sig[2] && bytes[i + 3] === sig[3]) eocd = i;
  }
  if (eocd < 0) return null;
  const count = bytes.readUInt16LE(eocd + 10);
  const dirOffset = bytes.readUInt32LE(eocd + 16);
  const names = [];
  const files = new Map();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) return null;
    const compressedSize = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    names.push(name);
    // Extract the member data (STORE: method 0 verified per entry).
    const method = bytes.readUInt16LE(p + 10);
    const localNameLen = bytes.readUInt16LE(localOffset + 26);
    const localExtraLen = bytes.readUInt16LE(localOffset + 28);
    if (method !== 0) return null;
    files.set(name, bytes.subarray(localOffset + 30 + localNameLen + localExtraLen, localOffset + 30 + localNameLen + localExtraLen + compressedSize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { names, files };
}

/**
 * Extract string literals longer than min bytes from a minified JS body,
 * escape-aware (backslash pairs, both quote characters). Used to scope the
 * sheet-fidelity scan to the embedded CSS string - the only giant literal
 * in the content bundle.
 */
function longStringLiterals(source, min) {
  const out = [];
  let i = 0;
  let quote = null;
  let start = -1;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) {
        if (i - start - 1 >= min) out.push(source.slice(start + 1, i));
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      start = i;
    }
    i += 1;
  }
  return out;
}

export async function run() {
  const start = Date.now();
  const rows = [];
  try {
    execFileSync(process.execPath, [join(HERE, "esbuild.config.mjs")], { stdio: "pipe" });
    rows.push({ name: "esbuild.config.mjs", status: "pass", ms: null });
  } catch (err) {
    const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split("\n").filter(Boolean).pop();
    return { rows: [{ name: "esbuild.config.mjs", status: "fail", note: text, ms: null }], ok: false };
  }

  const fails = [];
  const manifestPath = join(EXT, "manifest.json");
  if (!existsSync(manifestPath)) {
    fails.push({ name: "manifest.json", note: "manifest not produced" });
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const pkgVersion = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
    if (manifest.version !== pkgVersion) {
      fails.push({ name: "manifest version", note: `manifest ${manifest.version} != package.json ${pkgVersion}` });
    }
    const cs = manifest.content_scripts?.[0];
    if (!cs || manifest.content_scripts.length !== 1) {
      fails.push({ name: "content script entry", note: "content_scripts missing or not exactly one" });
    } else {
      if (cs.matches?.join() !== "<all_urls>" || cs.all_frames !== true || cs.run_at !== "document_start") {
        fails.push({ name: "frame contract", note: `matches=${cs.matches} all_frames=${cs.all_frames} run_at=${cs.run_at} - every frame, document_start, is the ported frame model` });
      }
      // The exclusion floor: exactly the platform table's worth of strict
      // match-pattern exclusions, the ported @exclude-match surface (the
      // platform count lives in esbuild.config.mjs; the shape contract -
      // every pattern a `*://*.<host>/*` wildcard - is pinned here).
      const excludes = cs.exclude_matches ?? [];
      const malformed = excludes.filter((p) => !/^\*:\/\/\*\.[A-Za-z0-9.-]+\/\*$/.test(p));
      if (excludes.length !== 24 || malformed.length > 0) {
        fails.push({ name: "exclusion floor", note: `exclude_matches=${excludes.length} malformed=${malformed.join(", ") || "none"}` });
      }
      if (cs.include_globs || cs.exclude_globs || cs.css?.length) {
        fails.push({ name: "content script vocabulary", note: "globs/second-css injection present - new manager-lifecycle surfaces joined silently" });
      }
    }
    if (!manifest.permissions?.includes("storage")) {
      fails.push({ name: "storage permission", note: "missing - store.js's whole plane rides browser.storage.local" });
    }
    if (!manifest.permissions?.includes("<all_urls>")) {
      fails.push({ name: "host permission", note: "missing - the background relay's fetch is the one CORS-bypassing egress" });
    }
    if (!manifest.permissions?.includes("webRequest")) {
      fails.push({ name: "webRequest permission", note: "missing - the background ledger's media-hint observation is the only webRequest surface" });
    }
    if (!manifest.permissions?.includes("webRequestBlocking")) {
      fails.push({ name: "webRequestBlocking", note: "missing - the reforge execute arm rides it (batch 3): the roster's claim answers serve text through filterResponseData and redirect to the freshest capture; probe B proved the lever live on the 159 floor" });
    }
    if (cs && cs.js?.join(",") !== "content.js") {
      fails.push({ name: "content script list", note: "must be exactly [content.js] - the classic loader that imports the kernel module" });
    }
    if (manifest.background?.persistent !== true || !manifest.background?.scripts?.includes("background.js")) {
      fails.push({ name: "background page", note: "must be a persistent background.js - the awaited relay fetch never suspends" });
    }
    if (manifest.browser_action?.default_popup !== "popup.html") {
      fails.push({ name: "popup surface", note: "the browserAction popup is the command surface replacing the GM menu" });
    }
    if (manifest.manifest_version !== 2) {
      fails.push({ name: "manifest version", note: `manifest_version=${manifest.manifest_version} - Firefox has no MV2 deprecation on this floor` });
    }
    if (manifest.browser_specific_settings?.gecko?.id) {
      const version = manifest.browser_specific_settings.gecko.strict_min_version;
      if (version !== "159.0") {
        fails.push({ name: "gecko floor", note: `strict_min_version=${version} - the ES target floor is Firefox 159` });
      }
    } else {
      fails.push({ name: "gecko id", note: "browser_specific_settings.gecko.id missing - storage namespace + update identity" });
    }
    rows.push({ name: "manifest shape (frame contract, permissions, background, popup)", status: "pass", ms: null });
  }

  // Membership kinds. The ESM build outputs (kernel, shell, the shared
  // chunks) legitimately carry import/export grammar - splitting is the
  // lazy-shell architecture's shape, the kernel entry dynamic-imports the
  // shell module on first confirmed adoption. The three classic scripts -
  // the hand-written loader, the IIFE background build, the verbatim popup -
  // must stay import-free (the loader's one dynamic import IS the pointer
  // and is asserted verbatim below). GM vocabulary is banned everywhere:
  // no bundle plane may ever re-adopt the manager's names.
  const shouldNotLeak = [
    [/GM_[A-Za-z]+/, "GM_ vocabulary"],
    [/@resource /, "@resource line"],
    [/@grant /, "@grant line"],
    [/\b(stub|GM\.info)\b/, null]
  ];
  const scriptNames = readdirSync(EXT).sort().filter((n) => n.endsWith(".js"));
  const esmNames = scriptNames.filter((n) => /^(kernel|shell|chunk-[0-9A-Za-z]+)\.js$/.test(n));
  const classicNames = scriptNames.filter((n) => ["content.js", "background.js", "popup.js"].includes(n));
  const unclassified = scriptNames.filter((n) => !esmNames.includes(n) && !classicNames.includes(n));
  if (unclassified.length > 0) {
    fails.push({ name: "script membership", note: `unclassified members in dist/extension: ${unclassified.join(", ")}` });
  }
  for (const name of esmNames) {
    const source = readFileSync(join(EXT, name), "utf8");
    const leaked = shouldNotLeak.slice(0, 3).filter(([re]) => re.test(stripComments(source))).map(([, label]) => label);
    if (leaked.length > 0) {
      fails.push({ name, note: `userscript vocabulary leaked: ${leaked.join(", ")}` });
    }
    rows.push({ name: `${name} (esm build, no userscript vocabulary)`, status: "pass", ms: null });
  }
  for (const name of classicNames) {
    const path = join(EXT, name);
    if (!existsSync(path)) {
      fails.push({ name, note: "member not produced/present" });
      continue;
    }
    const source = readFileSync(path, "utf8");
    const stripped = stripComments(source);
    if (name === "content.js") {
      // The loader's whole body is the package pointer: the kernel module,
      // imported by its moz-extension URL. The pointer asserted verbatim,
      // and any further grammar (a second import, an export) is drift.
      if (!/import\s*\(\s*browser\.runtime\.getURL\s*\(\s*["']kernel\.js["']\s*\)\s*\)/.test(stripped)) {
        fails.push({ name, note: "the package pointer (import of browser.runtime.getURL('kernel.js')) missing" });
      }
      if (/\bexport\b/.test(stripped)) {
        fails.push({ name, note: "export grammar in a classic content script" });
      }
    } else if (/\b(import|export)\s*[({"']|import\s+\w+\s+from/.test(stripped)) {
      fails.push({ name, note: "import/export statements in a classic script" });
    }
    const leaked = shouldNotLeak.slice(0, 3).filter(([re]) => re.test(stripped)).map(([, label]) => label);
    if (leaked.length > 0) {
      fails.push({ name, note: `userscript vocabulary leaked: ${leaked.join(", ")}` });
    }
    const kind = name === "content.js" ? "classic loader" : name === "background.js" ? "iife build" : "plain script";
    rows.push({ name: `${name} (${kind}, no userscript vocabulary)`, status: "pass", ms: null });
  }

  // The lazy-shell seam: the kernel entry must keep its dynamic import of
  // the package's shell.js - a bundle change that erased it (a static
  // import, a dropped call) evals the shell in every frame and silently
  // undoes the split's whole point.
  const kernelSource = readFileSync(join(EXT, "kernel.js"), "utf8");
  if (!/import\s*\(\s*browser\.runtime\.getURL\s*\(\s*["']shell\.js["']\s*\)/.test(kernelSource)) {
    fails.push({ name: "lazy shell seam", note: "kernel.js no longer dynamic-imports the package's shell.js - the lazy load (the split's point) would be dead" });
  }

  // Sheet fidelity rides the embedded sheet. The minified sheet lives as
  // one giant string literal inside the script build outputs (the shell
  // module's inject-side sheet import); a document-wide scan cannot run -
  // `)+` is ordinary JS outside a CSS string. Extract the long string
  // literals (escape-aware, quote-pair scan) from every ESM bundle and run
  // the glue regexes over them: the sheet is the only >1KB literal in the
  // bundles, and the glue classes `)and(`/`)[+-]` are exactly what the
  // minifier's two preservation rules exist to prevent.
  const sheetStrings = esmNames
    .map((name) => readFileSync(join(EXT, name), "utf8"))
    .flatMap((source) => longStringLiterals(source, 1000));
  const gluedTokens = [
    ...sheetStrings.flatMap((s) => [...s.match(/\)(and|or|not|only)\(/gi) ?? []]),
    ...sheetStrings.flatMap((s) => [...s.match(/\)[+-]/g) ?? []])
  ];
  if (gluedTokens.length > 0) {
    fails.push({ name: "sheet fidelity (embedded)", note: `glued grammar tokens in the shipped sheet: ${gluedTokens.slice(0, 6).join(", ")}` });
  }

  // HUD class-vocabulary agreement: every pf-* class the source JS spells
  // must have a reader on the HUD's one styling surface (styles.css or the
  // inject-side compact sheet). A JS class no CSS consumes is a dead
  // vocabulary token. Two deliberate scan exclusions: "pf-debug" is the
  // DEBUG_HASH_TAG vocabulary (contract constant, never a class), and a
  // trailing-hyphen token is a template id prefix (pf-panel-tab-${n}).
  let cssCorpus = "";
  try {
    cssCorpus = readFileSync(join(HERE, "src/shell/chrome/styles.css"), "utf8")
      + readFileSync(join(HERE, "src/shell/chrome/inject.js"), "utf8");
  } catch {
    cssCorpus = "";
  }
  // Same directory walk shape as the census stage (statSync directory
  // check); the shared file list feeds one vocabulary scan.
  const srcFiles = [];
  (function walkSrc(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walkSrc(p);
      else if (name.endsWith(".js")) srcFiles.push(p);
    }
  })(join(HERE, "src"));
  const strippedSrc = srcFiles.map((p) => stripComments(readFileSync(p, "utf8"))).join("\n");
  const classTokens = new Set(
    [...strippedSrc.matchAll(/(?<=["'`\s(,=])pf-[a-z][a-z-]+/g)]
      .map((m) => m[0])
      .filter((token) => token !== "pf-debug" && !token.endsWith("-"))
  );
  const dead = [...classTokens].filter((token) => !cssCorpus.includes(token)).sort();
  if (dead.length > 0) {
    fails.push({ name: "HUD class vocabulary", note: `source spells pf-* classes with no CSS reader: ${dead.join(", ")}` });
  }

  // The XPI: the shipping artifact the harness installs - exactly the dist
  // tree's members, manifest at the zip root, each byte-identical to its
  // dist file. The build's own membership audit guarantees no stray file
  // entered the tree; here the zip is what the install reads, so the same
  // set + fidelity is pinned against the actual bytes the browser loads.
  // The five members every shape must carry are named outright (the
  // splitting chunks beyond the entries are the one variable count).
  if (!existsSync(XPI)) {
    fails.push({ name: "playerforge.xpi", note: "xpi not produced" });
  } else {
    const zip = zipMembers(readFileSync(XPI));
    const required = ["manifest.json", "content.js", "kernel.js", "shell.js", "background.js", "popup.html", "popup.js", "icon.svg"];
    if (!zip) {
      fails.push({ name: "playerforge.xpi", note: "central directory unreadable (method/structure)" });
    } else {
      const distMembers = readdirSync(EXT).sort();
      const chromeAndBuild = zip.names.filter((n) => !/^chunk-[0-9A-Za-z]+\.js$/.test(n));
      const unknownZip = zip.names.filter((n) => !distMembers.includes(n));
      const missingRequired = required.filter((n) => !zip.names.includes(n));
      if (!zip.names.some((n) => /^chunk-[0-9A-Za-z]+\.js$/.test(n))) {
        fails.push({ name: "code splitting", note: "no shared chunk member - the kernel/shell split must share the store/runtime planes through one chunk (two store singletons in one realm would fork the storage echo contract)" });
      }
      if (missingRequired.length > 0 || unknownZip.length > 0) {
        fails.push({ name: "playerforge.xpi members", note: `missing=${missingRequired.join(", ") || "none"} unknown=${unknownZip.join(", ") || "none"}` });
      } else if (zip.names.length !== distMembers.length) {
        fails.push({ name: "playerforge.xpi members", note: `zip ${zip.names.length} vs dist ${distMembers.length} members` });
      } else {
        const drift = zip.names.filter((n) => !zip.files.get(n).equals(readFileSync(join(EXT, n))));
        if (drift.length > 0) {
          fails.push({ name: "playerforge.xpi fidelity", note: `zip members differ from dist: ${drift.join(", ")}` });
        }
      }
    }
    const sizeKb = (readFileSync(XPI).length / 1024).toFixed(1);
    rows.push({ name: `playerforge.xpi (${sizeKb} KB, split kernel/shell, zip==dist)`, status: "pass", ms: null });
  }

  if (fails.length > 0) {
    return { rows: [...rows, ...fails.map((f) => ({ name: f.name, status: "fail", note: f.note, ms: null }))], ok: false };
  }
  return { rows, ok: true, bundle: join(EXT, "content.js") };
}
