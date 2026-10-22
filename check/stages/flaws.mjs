/**
 * Gate 2 - execution flaws.
 *
 * Two instruments, deliberately strangers to each other's state:
 *  1. ESLint with the repo's own rules - static analysis for the classes of
 *     flaw a parser cannot see (undefined references, dead stores, shadowing
 *     bugs).
 *  2. Isolated module imports: every src module is imported by its own fresh
 *     node -e child, so an import-time crash (top-level throw, a broken
 *     circular-contract export, a missing name) is attributed to exactly one
 *     file and cannot be masked by another module's boot order.
 *
 * entry.js is consciously outside the smoke set: it boots the page pipeline
 * by design (its import IS a document bootstrap), so its evaluation belongs
 * to the bundle and browser gates, which run it in a real realm.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { inParallel } from "../lib/pool.mjs";

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

function lint() {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [join(HERE, "node_modules", "eslint", "bin", "eslint.js"), SRC],
      { stdio: "pipe", encoding: "utf8" }
    );
    return null;
  } catch (err) {
    return (err.stdout ?? err.stderr ?? err.message).split("\n").filter(Boolean).slice(-20).join("\n");
  }
}

const importSmoke = (files) =>
  inParallel(files, 8, (file) => {
    const url = pathToFileURL(file).href;
    try {
      execFileSync(
        process.execPath,
        [join(HERE, "check", "lib", "node-realm.mjs"), url],
        { stdio: "pipe" }
      );
      return null;
    } catch (err) {
      const text = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
      const line = text.split("\n").find((l) => /^[A-Z]\w*(Error|Exception)/.test(l.trim()) || /Error:/.test(l));
      return {
        file,
        message: (line ?? text.split("\n").filter(Boolean).pop() ?? "unknown").slice(0, 200)
      };
    }
  });

export async function run() {
  const start = Date.now();
  const files = walk(SRC).filter((f) => !f.endsWith(join("src", "entry.js")));
  const failures = [];

  const lintOut = lint();
  if (lintOut) {
    failures.push({ name: "eslint src/", note: lintOut.split("\n")[0].slice(0, 160) });
  }

  for (const b of (await importSmoke(files)).filter((x) => x !== null)) {
    failures.push({ name: `import ${b.file.replace(HERE + "/", "")}`, note: b.message });
  }

  if (failures.length > 0) {
    return {
      rows: failures.map((f) => ({ name: f.name, status: "fail", note: f.note, ms: null })),
      ok: false
    };
  }
  return {
    rows: [
      { name: `eslint src/ (${join("repo rules")})`, status: "pass", ms: null },
      { name: `${files.length + 1} modules import clean (isolated children)`, status: "pass", ms: Date.now() - start }
    ],
    ok: true
  };
}
