import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import process from "node:process";
import { POWER_GROUP, POWER_SCHEMA } from "./src/shared/power-schema.js";

// Minified is the only output. Minification is
// V8/TurboFan-aware by construction: esbuild only does the safe transforms
// (whitespace, local-identifier mangling, syntax compression) that keep
// functions Maglev/TurboFan-compilable - it never introduces eval/with, never
// mangles property names, and its bytecode cost per op is unchanged, so V8's
// hidden-class/IC-driven optimization is untouched. The embedded stylesheet is
// minified separately (esbuild's JS minifier would not shrink a text-loaded
// string); the CSS pass below is deliberately conservative so calc()/content
// and selector whitespace survive intact.

const REPO = "https://github.com/itsrody/PlayerForge";
const RAW = "https://raw.githubusercontent.com/itsrody/PlayerForge/chromium/dist";

/**
 * sha384 of the exact bytes the build writes to dist/playerforge.css, pinned
 * into the @resource line as `#sha384-<hex>`.
 *
 * minifyCss() is pure and both this call and the minifyCssPlugin load below
 * run it over the same source file, so the pinned digest and the published
 * bytes cannot drift. SHA-384 is the hash the W3C SRI guidance recommends and
 * the one ScriptCat documents.
 *
 * This deliberately reverses an earlier decision to leave @resource unpinned
 * so that CSS hot-fixes reached installed scripts without a script update.
 * That convenience is exactly the hole: the URL is a mutable branch, so
 * anything that can write to it could restyle every page PF runs on. The cost
 * of closing it is real but bounded - an installed script whose pinned hash no
 * longer matches the published CSS simply keeps the stylesheet embedded in its
 * own bundle (see shell/chrome/inject.js), which is the correct, working CSS.
 */
const CSS_SOURCE = fileURLToPath(new URL("./src/shell/chrome/styles.css", import.meta.url));
const cssSha384 = createHash("sha384")
  .update(minifyCss(readFileSync(CSS_SOURCE, "utf8")))
  .digest("hex");

/**
 * Render the `==UserConfig==` block from the shared schema so the manager's
 * settings UI and the runtime importer read one definition. Strings are JSON
 * -quoted: YAML plain scalars would break on a ": " or " #" inside a
 * description, and JSON string syntax is valid YAML double-quoted style.
 */
function userConfigYaml() {
  const lines = [`${POWER_GROUP}:`];
  for (const field of POWER_SCHEMA) {
    lines.push(`  ${field.id}:`);
    lines.push(`    title: ${JSON.stringify(field.title)}`);
    lines.push(`    description: ${JSON.stringify(field.description)}`);
    lines.push(`    type: ${field.type}`);
    lines.push(`    default: ${JSON.stringify(field.default)}`);
    if (field.min !== undefined) {
      lines.push(`    min: ${field.min}`);
    }
    if (field.max !== undefined) {
      lines.push(`    max: ${field.max}`);
    }
    if (field.unit) {
      lines.push(`    unit: ${JSON.stringify(field.unit)}`);
    }
  }
  return lines.join("\n");
}

// The banner below is the single version source. Runtime reads the installed
// script's real version through GM_info.script.version, so bumping @version
// here is all a release takes.
// Target: ScriptCat 1.4+ (MV3). ScriptCat's sandbox is always raw, so no
// @sandbox directive is needed. @run-at document-start + @early-start make the
// script evaluate ahead of the page; the DOM-independent kernel never assumes
// the DOM is ready at eval, so it is safe under instant injection. Under
// early-start ScriptCat has not yet installed all granted GM APIs, so
// manager-dependent boot (GM_info, GM_registerMenuCommand) is gated on
// CAT_scriptLoaded() and degrades gracefully instead of assuming availability.
// Storage writes prefer the promise-style GM.setValue (GM.* v4 API) so a
// rejected async write is logged rather than silent; the sync GM_setValue is
// the always-available fallback under early-start and in the test harness.
//
// @inject-into content runs the script in the content-script world rather than
// the page's. Three things fall out of that: the page cannot shadow the globals
// PF reads (scheduler, screen, crypto, ...), the page cannot squat on the PF
// global or make it non-configurable to abort boot, and PF is no longer bound
// by the page's CSP - which is what latches the subtitle parse worker onto its
// in-band fallback on the strict-CSP sites PF exists to enhance. PF touches
// only shared DOM, never the page's `window`, so it loses nothing by it. The
// cost is that a JS-global version surface would be invisible to the page, so
// the version is published as a DOM attribute instead (entry.js).
const banner = `// ==UserScript==
// @name         PlayerForge
// @namespace    https://github.com/PlayerForge
// @version      0.7.2
// @description  Helium Browser (desktop) and Titanium Browser (Android), Chromium 154+ HTML5 video player enhancer for ScriptCat 1.4+ (MV3) with gestures, hotkeys, progress resume, subtitles, and an extensible plugin system
// @author       PlayerForge
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIiB2aWV3Qm94PSIwIDAgNDggNDgiPjxnIGZpbGw9Im5vbmUiPjxwYXRoIGZpbGw9InVybCgjZmx1ZW50Q29sb3JWaWRlbzQ4MCkiIGQ9Im0yMi41IDI0bDE2LjIzMy0xMS4zMjVjMi4yMjEtMS41NSA1LjI2Ny4wNCA1LjI2NyAyLjc0N3YxNy4xNTZjMCAyLjcwOC0zLjA0NiA0LjI5Ny01LjI2NyAyLjc0N3oiLz48cGF0aCBmaWxsPSJ1cmwoI2ZsdWVudENvbG9yVmlkZW80ODIpIiBmaWxsLW9wYWNpdHk9Ii43NSIgZD0ibTIyLjUgMjRsMTYuMjMzLTExLjMyNWMyLjIyMS0xLjU1IDUuMjY3LjA0IDUuMjY3IDIuNzQ3djE3LjE1NmMwIDIuNzA4LTMuMDQ2IDQuMjk3LTUuMjY3IDIuNzQ3eiIvPjxwYXRoIGZpbGw9InVybCgjZmx1ZW50Q29sb3JWaWRlbzQ4MSkiIGQ9Ik00IDE2LjI1QTYuMjUgNi4yNSAwIDAgMSAxMC4yNSAxMGgxNC41QTYuMjUgNi4yNSAwIDAgMSAzMSAxNi4yNXYxNS41QTYuMjUgNi4yNSAwIDAgMSAyNC43NSAzOGgtMTQuNUE2LjI1IDYuMjUgMCAwIDEgNCAzMS43NXoiLz48cGF0aCBmaWxsPSJ1cmwoI2ZsdWVudENvbG9yVmlkZW80ODMpIiBkPSJNOCAzMGE0IDQgMCAwIDEgNC00aDEwYTQgNCAwIDAgMSAwIDhIMTJhNCA0IDAgMCAxLTQtNCIgb3BhY2l0eT0iLjUiLz48cGF0aCBmaWxsPSIjQkFCQUZGIiBkPSJNMTIuMDI2IDI4QzEwLjkwNyAyOCAxMCAyOC45MjIgMTAgMzAuMDU5cy45MDcgMi4wNTkgMi4wMjYgMi4wNTloNC4wNTFjMS4xMTkgMCAyLjAyNi0uOTIyIDIuMDI2LTIuMDZjMC0xLjEzNi0uOTA3LTIuMDU4LTIuMDI2LTIuMDU4em05Ljk0OCA0LjExOGMxLjEyIDAgMi4wMjYtLjkyMiAyLjAyNi0yLjA2QzI0IDI4LjkyMyAyMy4wOTMgMjggMjEuOTc0IDI4cy0yLjAyNS45MjItMi4wMjUgMi4wNTlzLjkwNiAyLjA1OSAyLjAyNSAyLjA1OSIvPjxkZWZzPjxyYWRpYWxHcmFkaWVudCBpZD0iZmx1ZW50Q29sb3JWaWRlbzQ4MCIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFRyYW5zZm9ybT0icm90YXRlKDcxLjg1IDEwLjg3IDI3LjUyMylzY2FsZSgzMy4yNjgzIDY1LjY0MzEpIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agb2Zmc2V0PSIuMDgxIiBzdG9wLWNvbG9yPSIjRjA4QUY0Ii8+PHN0b3Agb2Zmc2V0PSIuMzk0IiBzdG9wLWNvbG9yPSIjOUM2Q0ZFIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNEU0NERCIi8+PC9yYWRpYWxHcmFkaWVudD48cmFkaWFsR3JhZGllbnQgaWQ9ImZsdWVudENvbG9yVmlkZW80ODEiIGN4PSIwIiBjeT0iMCIgcj0iMSIgZ3JhZGllbnRUcmFuc2Zvcm09Im1hdHJpeCgzMS4wNjQ4MSAyOS42MzMzMiAtNjIuMTk2MjMgNjUuMjAwNzMgLS45MDggMTEuMTY3KSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIHN0b3AtY29sb3I9IiNGMDhBRjQiLz48c3RvcCBvZmZzZXQ9Ii4zNDEiIHN0b3AtY29sb3I9IiM5QzZDRkUiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM0RTQ0REIiLz48L3JhZGlhbEdyYWRpZW50PjxsaW5lYXJHcmFkaWVudCBpZD0iZmx1ZW50Q29sb3JWaWRlbzQ4MiIgeDE9IjI3LjUzNCIgeDI9IjQzLjk3OSIgeTE9IjI0IiB5Mj0iMjMuNDE0IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzMxMkE5QSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzMxMkE5QSIgc3RvcC1vcGFjaXR5PSIwIi8+PC9saW5lYXJHcmFkaWVudD48bGluZWFyR3JhZGllbnQgaWQ9ImZsdWVudENvbG9yVmlkZW80ODMiIHgxPSI3LjU5MSIgeDI9IjEwLjMwOCIgeTE9IjI2IiB5Mj0iMzYuNjg4IiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHN0b3Agc3RvcC1jb2xvcj0iIzNCMTQ4QSIvPjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzRCMjBBMCIvPjwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPjwvZz48L3N2Zz4=
// @match        *://*/*
// @exclude      *://*.youtube.com/*
// @exclude      *://youtube.com/*
// @exclude      *://youtu.be/*
// @exclude      *://*.vimeo.com/*
// @exclude      *://vimeo.com/*
// @exclude      *://player.vimeo.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://netflix.com/*
// @exclude      *://*.disneyplus.com/*
// @exclude      *://disneyplus.com/*
// @exclude      *://*.primevideo.com/*
// @exclude      *://primevideo.com/*
// @exclude      *://*.hulu.com/*
// @exclude      *://hulu.com/*
// @exclude      *://*.max.com/*
// @exclude      *://*.hbomax.com/*
// @exclude      *://tv.apple.com/*
// @exclude      *://*.peacocktv.com/*
// @exclude      *://*.paramountplus.com/*
// @exclude      *://*.crunchyroll.com/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://bilibili.com/*
// @exclude      *://*.dailymotion.com/*
// @exclude      *://dailymotion.com/*
// @exclude      *://*.twitch.tv/*
// @exclude      *://twitch.tv/*
// @exclude      *://*.facebook.com/*
// @exclude      *://facebook.com/*
// @exclude      *://fb.watch/*
// @exclude      *://*.x.com/*
// @exclude      *://*.twitter.com/*
// @exclude      *://*.instagram.com/*
// @exclude      *://instagram.com/*
// @exclude      *://*.tiktok.com/*
// @exclude      *://tiktok.com/*
// @exclude      *://*.reddit.com/*
// @exclude      *://reddit.com/*
// @exclude      *://*.tumblr.com/*
// @grant        GM_setValue
// @grant        GM.setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        CAT_scriptLoaded
// @connect      *
// @connect      https://www.subtitlecat.com
// @resource     pfStyle ${RAW}/playerforge.css#sha384-${cssSha384}
// @run-at       document-start
// @early-start
// @inject-into  content
// @updateURL    ${RAW}/playerforge.user.js.meta.js
// @downloadURL  ${RAW}/playerforge.user.js
// @homepage     ${REPO}
// @supportURL   ${REPO}/issues
// @license      MIT
// ==/UserScript==
/* ==UserConfig==
${userConfigYaml()}
==/UserConfig== */
`;

/**
 * Conservative CSS minifier. Safe for this stylesheet's constructs (var(),
 * calc(), min(), content:'', @starting-style): comments are dropped, whitespace
 * runs collapse to one space, and whitespace is stripped only when adjacent to a
 * structural delimiter ({ } ; : , ( )). Whitespace that separates two tokens -
 * notably calc("100% - 24px") arithmetic and descendant selectors - is left
 * alone, so collapsing can never merge tokens into a different rule.
 */
function minifyCss(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const collapsed = noComments.replace(/\s+/g, " ");
  const slim = collapsed
    .replace(/\s*([{};:,(])\s*/g, "$1")
    .replace(/\s*\)\s*/g, ")");
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
      // Report a SHA-256 fingerprint of each shipped stylesheet after the
      // build. This is a release-time paranoia check (an accidental dirty or
      // regenerated stylesheet is caught before it ships). The @resource line
      // carries its own sha384 pin, computed above from the same pure minify
      // pass - this fingerprint exists so a reviewer can see the CSS changed.
      build.onEnd(() => {
        for (const [path, css] of cache) {
          const digest = createHash("sha256").update(css).digest("hex");
          console.log(`[PlayerForge] css fingerprint ${path}: sha256=${digest.slice(0, 16)}…`);
        }
        // Write minified CSS to dist/ so the @resource pfStyle banner URL
        // can point to this file on GitHub's raw content endpoint.
        const dir = new URL("./dist/", import.meta.url);
        mkdirSync(dir, { recursive: true });
        writeFileSync(new URL("./dist/playerforge.css", import.meta.url), cache.values().next().value);
        console.log("[PlayerForge] wrote dist/playerforge.css");
      });
    }
  };
}

// Bundle the subtitle parse worker on its own BEFORE defining the main build:
// its output is embedded into the main bundle via the __VTT_WORKER_SOURCE__
// define, so the single-file userscript can spawn it from a Blob URL. The
// worker input is a real module importing forgevtt.js, which keeps the parse
// engine single-source between main thread and worker. (Watch mode rebuilds
// the main bundle but not this embedded chunk; verify the worker side
// separately with a cold `npm run dev`/`npm run build` after worker edits.)
const workerBuildResult = await build({
  entryPoints: ["src/shell/subtitles/vtt-worker.js"],
  bundle: true,
  format: "iife",
  target: ["chrome154"],
  minify: true,
  charset: "utf8",
  legalComments: "none",
  write: false,
  logLevel: "silent"
});
const vttWorkerSource = workerBuildResult.outputFiles[0].text;

const shared = {
  entryPoints: ["src/entry.js"],
  bundle: true,
  format: "iife",
  target: ["chrome154"],
  outfile: "dist/playerforge.user.js",
  banner: { js: banner },
  loader: { ".css": "text" },
  plugins: [minifyCssPlugin()],
  // The subtitle parse worker is a real entry bundled separately, embedded as
  // a string const so the single-file userscript can spawn it from a Blob URL.
  // forgevtt.js stays a plain, Node-importable module (the test harness reads
  // it straight) because the substitution happens here, not in source.
  define: { __VTT_WORKER_SOURCE__: JSON.stringify(vttWorkerSource) },
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
 * Release-time verification for the minified bundle. Minification is
 * V8/TurboFan-safe by construction (esbuild never emits eval/with, never
 * mangles property names), but a broken minifier would violate exactly
 * those promises - or silently corrupt the metadata block ScriptCat reads
 * to install the script. This gate fails the build rather than ship a bundle
 * that is unsafe to interpret or won't install.
 */
function verifyMinified(text) {
  const body = text.slice(text.indexOf("==/UserScript==") + 16);
  if (!text.startsWith("// ==UserScript==")) {
    throw new Error("min build: metadata banner displaced from file head");
  }
  for (const needle of ["@name         PlayerForge", "@version", "@grant        GM_setValue", "@resource     pfStyle https://raw.githubusercontent.com/itsrody/PlayerForge/chromium/dist/playerforge.css#sha384-", "@inject-into  content", "==UserConfig=="]) {
    if (!text.includes(needle)) {
      throw new Error(`min build: metadata line missing: ${needle.trim().split(/\s+/)[0]}`);
    }
  }
  const forbidden = [
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "new Function"],
    [/\bwith\s*\(/, "with"],
  ];
  for (const [re, label] of forbidden) {
    if (re.test(body)) {
      throw new Error(`min build: forbidden construct '${label}' in body`);
    }
  }
}

if (watch) {
  const ctx = await context({ ...shared, minify: true });
  await ctx.watch();
  console.log("[PlayerForge] watching (minified)...");
} else {
  const minifiedOpts = { ...shared, minify: true };

  // Minified bundle (what ScriptCat installs).
  await build(minifiedOpts);
  console.log("[PlayerForge] built minified bundle");

  // Verify reproducibility + safety.
  const second = await build({ ...minifiedOpts, write: false });
  const onDisk = readFileSync(shared.outfile, "utf8");
  const inMemory = second.outputFiles[0].text;
  if (onDisk !== inMemory) {
    throw new Error("min build: non-deterministic output (disk vs rebuild mismatch)");
  }
  verifyMinified(inMemory);
  console.log("[PlayerForge] min build verified: metadata header intact, no eval/with/new Function, deterministic");
}
