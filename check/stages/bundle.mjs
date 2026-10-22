/**
 * Gate 3 - the artifact itself.
 *
 * Builds the esb bundle the browser gate will load and validates the parts a
 * userscript environment actually relies on: the ==UserScript== header parses
 * out of the top of the file, and the bundle body is IIFE-wrapped (no import/
 * export survives esbuild's userscript transform).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
    const sizeKb = (source.length / 1024).toFixed(1);
    rows.push({ name: `bundle emitted (${sizeKb} KB), header + IIFE shape valid`, status: "pass", ms: null });
  }

  if (fails.length > 0) {
    return { rows: [...rows, ...fails.map((f) => ({ name: f.name, status: "fail", note: f.note, ms: null }))], ok: false };
  }
  return { rows, ok: true, bundle: BUNDLE };
}
