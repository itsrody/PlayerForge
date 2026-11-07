/**
 * Gate 4 - the artifact itself.
 *
 * Builds the shipping extension and validates what the browser (and the
 * check's own browser stage) rely on: the manifest parses and carries the
 * frame model's contract (all frames, document_start, the exclusion
 * platform floor, the storage + host permissions), the content bundle is
 * IIFE build output with no userscript vocabulary while the chrome members
 * ship verbatim from the package tree they hand-maintain, and the XPI zip
 * carries exactly the six members the manifest references, verifyable
 * against the dist tree.
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

  // The `import|export` leak check and the userscript-vocabulary scan run
  // over the content bundle (IIFE build output) and the two verbatim chrome
  // scripts alike - the chrome members must stay plain, import-free
  // scripts, and no plane may spell GM vocabulary by any route.
  const shouldNotLeak = [
    [/GM_[A-Za-z]+/, "GM_ vocabulary"],
    [/@resource /, "@resource line"],
    [/@grant /, "@grant line"],
    [/\b(stub|GM\.info)\b/, null]
  ];
  for (const name of ["content.js", "background.js", "popup.js"]) {
    const path = join(EXT, name);
    if (!existsSync(path)) {
      fails.push({ name, note: "member not produced/present" });
      continue;
    }
    const source = readFileSync(path, "utf8");
    if (/\b(import|export)\s*[({"']/.test(source)) {
      fails.push({ name, note: "import/export statements leaked into the IIFE build" });
    }
    // The vocabulary scan rides the comment-stripped text (the census's own
    // stripper): the chrome members now ship their own docstrings verbatim,
    // so prose about the retired plane must stay out of the counts the
    // content bundle's raw-minified text would have answered for free.
    const stripped = name === "content.js" ? source : stripComments(source);
    const leaked = shouldNotLeak.slice(0, 3).filter(([re]) => re.test(stripped)).map(([, label]) => label);
    if (leaked.length > 0) {
      fails.push({ name, note: `userscript vocabulary leaked: ${leaked.join(", ")}` });
    }
    rows.push({ name: `${name} (plain script, no userscript vocabulary)`, status: "pass", ms: null });
  }

  // Sheet fidelity rides the embedded sheet. The minified sheet lives as
  // one giant string literal in the content bundle; a document-wide scan
  // cannot run - `)+` is ordinary JS outside the CSS string. Extract the
  // long string literals (escape-aware, quote-pair scan) and run the glue
  // regexes over them: the sheet is the only >1KB literal in the bundle,
  // and the glue classes `)and(`/`)[+-]` are exactly what the minifier's
  // two preservation rules exist to prevent.
  const contentSource = readFileSync(join(EXT, "content.js"), "utf8");
  const sheetStrings = longStringLiterals(contentSource, 1000);
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

  // The XPI: the shipping artifact the harness installs - exactly the six
  // members, manifest at the zip root, each byte-identical to its dist file.
  if (!existsSync(XPI)) {
    fails.push({ name: "playerforge.xpi", note: "xpi not produced" });
  } else {
    const zip = zipMembers(readFileSync(XPI));
    const expected = ["manifest.json", "content.js", "background.js", "popup.html", "popup.js", "icon.svg"];
    if (!zip) {
      fails.push({ name: "playerforge.xpi", note: "central directory unreadable (method/structure)" });
    } else {
      const missing = expected.filter((n) => !zip.names.includes(n));
      const extra = zip.names.filter((n) => !expected.includes(n));
      if (missing.length > 0 || extra.length > 0) {
        fails.push({ name: "playerforge.xpi members", note: `missing=${missing.join(", ") || "none"} extra=${extra.join(", ") || "none"}` });
      } else {
        const drift = expected.filter((n) => !zip.files.get(n).equals(readFileSync(join(EXT, n))));
        if (drift.length > 0) {
          fails.push({ name: "playerforge.xpi fidelity", note: `zip members differ from dist: ${drift.join(", ")}` });
        }
      }
    }
    const sizeKb = (readFileSync(XPI).length / 1024).toFixed(1);
    rows.push({ name: `playerforge.xpi (${sizeKb} KB, 6 members, zip==dist)`, status: "pass", ms: null });
  }

  if (fails.length > 0) {
    return { rows: [...rows, ...fails.map((f) => ({ name: f.name, status: "fail", note: f.note, ms: null }))], ok: false };
  }
  return { rows, ok: true, bundle: join(EXT, "content.js") };
}
