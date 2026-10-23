/**
 * Gate 1 - syntax at the platform floor.
 *
 * Every src module is handed to an esbuild transform with `target:
 * firefox158`: a full parse (zero execution, nothing imports anything) that
 * ALSO rejects syntax the target engine cannot run - esbuild's engine table
 * errors on floor-down here, where a bare `node --check` (V8's superset)
 * would happily accept syntax the floor will break on. The browser gate on
 * real Firefox is the runtime half of the same floor.
 * Failures surface as pure transform errors no matter what the file's
 * dependencies would have done; children run 8-wide and keep the file order.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { dirname, join } from "node:path";
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
  const maybeBroken = await inParallel(files, 8, (file) => {
    try {
      transformSync(readFileSync(file, "utf8"), {
        loader: "js",
        format: "esm",
        target: ["firefox158"],
        logLevel: "silent"
      });
      return null;
    } catch (err) {
      return {
        file: file.replace(HERE + "/", ""),
        message: String(err.message ?? err).split("\n").slice(0, 2).join(" | ").slice(0, 160)
      };
    }
  });
  const broken = maybeBroken.filter((b) => b !== null);
  if (broken.length > 0) {
    return { rows: broken.map((b) => ({ name: `parse ${b.file}`, status: "fail", note: b.message, ms: null })), ok: false };
  }
  return { rows: [{ name: `${files.length} source modules parse at the firefox158 floor (esbuild)`, status: "pass", ms: Date.now() - start }], ok: true };
}
