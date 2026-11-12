/**
 * Gate 3 - the artifact itself.
 *
 * Builds the esb bundle the browser gate will load and validates the parts a
 * userscript environment actually relies on: the ==UserScript== header parses
 * out of the top of the file, and the bundle body is IIFE-wrapped (no import/
 * export survives esbuild's userscript transform).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./census.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(HERE, "dist", "playerforge.user.js");

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
  if (!existsSync(BUNDLE)) {
    fails.push({ name: "dist/playerforge.user.js", note: "bundle not produced" });
  } else {
    const source = readFileSync(BUNDLE, "utf8");
    if (!source.startsWith("// ==UserScript==") || !source.includes("==/UserScript==")) {
      fails.push({ name: "userscript header", note: "==UserScript== header missing from top of bundle" });
    }
    const headerVersion = source.match(/^\/\/ @version\s+(\S+)/m)?.[1] ?? null;
    const pkgVersion = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")).version;
    if (headerVersion !== pkgVersion) {
      fails.push({ name: "header version", note: `bundle @version ${headerVersion ?? "missing"} != package.json ${pkgVersion}` });
    }
    if (/\b(export|import)\b\s*[({"']/.test(source.slice(source.indexOf("==/UserScript==")))) {
      fails.push({ name: "module syntax", note: "import/export statements leaked into the bundle body" });
    }
    // Static drift: every GM_ name the bundle body calls must appear in the
    // @grant list - at runtime an ungranted call is simply undefined (real VM
    // semantics), so only this check makes the omission audible. GM_info is
    // manager-provided, never granted.
    const granted = new Set([...source.matchAll(/^\/\/\s*@grant\s+GM_\w+$/gm)].map((m) => m[0].match(/GM_\w+/)[0]));
    const called = new Set([...source.slice(source.indexOf("==/UserScript==")).matchAll(/\bGM_[A-Za-z]+/g)].map((m) => m[0]));
    const ungranted = [...called].filter((name) => name !== "GM_info" && !granted.has(name));
    if (ungranted.length > 0) {
      fails.push({ name: "grant coverage", note: `body calls ${ungranted.join(", ")} without a matching @grant` });
    }
    // Matching surface: the exclusion list ships on VM's strict surface
    // (@exclude-match, Chrome match-pattern semantics). A loose @exclude glob
    // line returning would silently re-open the any-characters overmatch the
    // migration collapsed away.
    const looseExcludes = [...source.matchAll(/^\/\/\s*@exclude\s+\S/gm)].length;
    const matchExcludes = [...source.matchAll(/^\/\/\s*@exclude-match\s+(\S+)$/gm)].map((m) => m[1]);
    const malformed = matchExcludes.filter((rule) => !/^\*:\/\/[^/]+\/\*$/.test(rule));
    if (looseExcludes > 0 || malformed.length > 0 || matchExcludes.length === 0) {
      fails.push({
        name: "exclude surface",
        note: `@exclude lines=${looseExcludes} @exclude-match=${matchExcludes.length} malformed=${malformed.join(", ") || "none"}`
      });
    }
    // Updater surface: VM's updater compares @version against @downloadURL -
    // a header without it pins auto-update to whatever URL the user installed
    // from (a local install gets none).
    if (!/^\/\/ @downloadURL\s+https:\/\//m.test(source)) {
      fails.push({ name: "updater surface", note: "@downloadURL missing from header" });
    }
    // Connect/resource surface: the census's network block pins the src side
    // (one manager relay, one consumer); this pins the header half those rows
    // voucher. The `*` umbrella is what user-supplied subtitle URLs load
    // under - dropping it kills every URL ingest against CORS with no error
    // a user could act on. The subtitlecat line is documented-inert (it
    // predates the umbrella, has no dedicated caller) and kept as a header
    // surface; the pfStyle resource is the one manager-fetched asset - a
    // second @resource is new manager-lifecycle egress joining silently.
    const connects = [...source.matchAll(/^\/\/\s*@connect\s+(\S+)$/gm)].map((m) => m[1]);
    if (connects.length !== 2 || !connects.includes("*")) {
      fails.push({
        name: "connect surface",
        note: `@connect lines=${connects.length} (${connects.join(", ")}) - expected exactly the * umbrella + the documented-inert subtitlecat entry`
      });
    }
    const resources = [...source.matchAll(/^\/\/\s*@resource\s+(\S+)/gm)].length;
    if (resources !== 1) {
      fails.push({
        name: "resource surface",
        note: `@resource lines=${resources} - pfStyle is the one manager-fetched asset; a second resource is a network decision, not a style tweak`
      });
    }
    const sizeKb = (source.length / 1024).toFixed(1);
    rows.push({ name: `bundle emitted (${sizeKb} KB), header + IIFE shape valid`, status: "pass", ms: null });
  }

  // HUD class-vocabulary agreement: every pf-* class the source JS spells
  // must have a reader on the HUD's one styling surface (styles.css or the
  // mount-side container pocket). A JS class no CSS consumes is a dead
  // vocabulary token, the way an ungranted GM_ call is a silent undefined -
  // the same audit shape as the grant-coverage row above. Two deliberate
  // scan exclusions: "pf-debug" is the DEBUG_HASH_TAG vocabulary (the
  // contract writes that exact literal exactly once; it keys hash
  // detection, never a class), and a trailing-hyphen token is a template
  // prefix (pf-panel-tab-${n} id derivation), not a whole class name.
  let cssCorpus = "";
  try {
    cssCorpus = readFileSync(join(HERE, "src/shell/chrome/styles.css"), "utf8")
      + readFileSync(join(HERE, "src/shell/chrome/mount.js"), "utf8");
  } catch {
    // The styling surfaces always ship; an unreadable corpus fails below
    // with every class unstyled, never silently passes.
    cssCorpus = "";
  }
  const srcWalker = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) srcWalker(path, out);
      else if (name.endsWith(".js")) out.push(path);
    }
    return out;
  };
  const strippedSrc = srcWalker(join(HERE, "src")).map((p) => stripComments(readFileSync(p, "utf8"))).join("\n");
  const classTokens = new Set(
    [...strippedSrc.matchAll(/(?<=["'`\s(,=])pf-[a-z][a-z-]+/g)]
      .map((m) => m[0])
      .filter((token) => token !== "pf-debug" && !token.endsWith("-"))
  );
  const dead = [...classTokens].filter((token) => !cssCorpus.includes(token)).sort();
  if (dead.length > 0) {
    fails.push({ name: "HUD class vocabulary", note: `source spells pf-* classes with no CSS reader: ${dead.join(", ")}` });
  }

  // Sheet fidelity: the minifier's whitespace stripping must never merge two
  // grammar-required tokens. `) and (` in a media prelude glued to `)and(`
  // parses on Firefox into an and() function prelude and the whole row is
  // silently rewritten to `@media not all` — a rule that never applies (the
  // shipped coarse-pointer bottom-sheet rows were inert for releases before
  // the fix). The same glue class in calc — `)+ var(`, `)- var(` — cuts the
  // whitespace the +/- infix requires on both sides of the operator, and the
  // declaration dies at substitution time (probed on the floor: computed
  // bottom falls back to auto). The glue sites the minifier produces are
  // exact: pass 2 strips after ")" (giving `)and(` / `)+ var(`) and pass 1
  // strips before "(" (giving `) and(`); the keyword-in-the-middle shape
  // (`) and(`-led) cannot false-positive on a legitimate `:not(`.
  let sheet = "";
  try {
    sheet = readFileSync(join(HERE, "dist/playerforge.css"), "utf8");
  } catch {
    // The css companion always ships with the bundle (esbuild writes both).
  }
  const gluedTokens = [
    ...(sheet.match(/\)(and|or|not|only)\(/gi) ?? []),
    ...(sheet.match(/\)[+-]/g) ?? [])
  ];
  if (gluedTokens.length > 0) {
    fails.push({
      name: "sheet fidelity",
      note: `glued grammar tokens in shipped sheet: ${gluedTokens.slice(0, 6).join(", ")}`
    });
  }

  if (fails.length > 0) {
    return { rows: [...rows, ...fails.map((f) => ({ name: f.name, status: "fail", note: f.note, ms: null }))], ok: false };
  }
  return { rows, ok: true, bundle: BUNDLE };
}
