/**
 * Gate 1 - syntax only.
 *
 * Every src module is handed to `node --check`: a full V8 parse with zero
 * execution. Nothing here imports anything, so a broken file surfaces as a
 * pure syntax failure no matter what its dependencies would have done.
 * Children run 8-wide; failures keep the original file order.
 */
import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

export async function run() {
  const start = Date.now();
  const files = walk(SRC);
  const maybeBroken = await inParallel(files, 8, async (file) => {
    try {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, ["--check", file], (err) => (err ? reject(err) : resolve()));
      });
      return null;
    } catch (err) {
      const detail = String(err.stderr ?? "")
        .split("\n")
        .filter((l) => /^(SyntaxError|\^|.*:\d+|SyntaxError:.*)/.test(l.trim()) && !/^\^\s*$/.test(l));
      return {
        file: file.replace(HERE + "/", ""),
        message: detail.slice(-3).join(" | ").slice(0, 160) || err.message
      };
    }
  });
  const broken = maybeBroken.filter((b) => b !== null);
  if (broken.length > 0) {
    return { rows: broken.map((b) => ({ name: `parse ${b.file}`, status: "fail", note: b.message, ms: null })), ok: false };
  }
  return { rows: [{ name: `${files.length} source files parse (node --check)`, status: "pass", ms: Date.now() - start }], ok: true };
}
