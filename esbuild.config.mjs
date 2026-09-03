import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";

// Minified is the default (and only shipping) output. The readable variant
// is built alongside for the compare-bundles platform mode. Minification is
// SpiderMonkey/Warp-aware by construction: esbuild only does the safe
// transforms (whitespace, local-identifier mangling, syntax compression) that
// keep functions Warp-compilable - it never introduces eval/with, never
// mangles property names, and its bytecode cost per op is unchanged, so
// SpiderMonkey's IC-driven optimization is untouched. The embedded stylesheet
// is minified separately (esbuild's JS minifier would not shrink a
// text-loaded string); the CSS pass below is deliberately conservative so
// calc()/content and selector whitespace survive intact.

// The banner below is the single version source. Runtime reads the installed
// script's real version through GM_info.script.version, so bumping @version
// here is all a release takes.
// Tampermonkey MV2 note: @run-at document-start only delivers true instant
// injection on Firefox when the manager's Content Script API is set to
// "UserScripts API" / "UserScripts API Dynamic" (the native web-ext
// userScripts_legacy path). Under the default "Content Script" mode, scripts
// arrive via background messaging with no real document-start. PF never
// assumes the DOM is ready at eval either way: the probe defers its static
// <video> scan to DOMContentLoaded while readyState === "loading", the
// mutation dispatcher guards documentElement absence (dom-watch), and shell
// DOM injection happens only after a candidate is found - so it is safe under
// instant injection and degrades gracefully without it.
const banner = `// ==UserScript==
// @name         PlayerForge (Firefox)
// @namespace    https://github.com/PlayerForge
// @version      0.7.1
// @description  Firefox 155+ / Tampermonkey 5.5+ (MV2) exclusive HTML5 video player enhancer with gestures, hotkeys, progress resume, subtitles, and an extensible plugin system
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
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      https://www.subtitlecat.com
// @resource     pfStyle https://raw.githubusercontent.com/itsrody/PlayerForge/firefox/dist/playerforge.css
// @run-at       document-start
// @license      MIT
// ==/UserScript==
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
      // regenerated stylesheet is caught before it ships), NOT runtime SRI -
      // the live @resource stays un-pinned so CSS hot-fixes never invalidate
      // an installed script's hash.
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

const shared = {
  entryPoints: ["src/entry.js"],
  bundle: true,
  format: "iife",
  target: ["firefox155"],
  outfile: "dist/playerforge.user.js",
  banner: { js: banner },
  loader: { ".css": "text" },
  plugins: [minifyCssPlugin()],
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
 * Warp-safe by construction (esbuild never emits eval/with, never mangles
 * property names), but a broken minifier would violate exactly those promises
 * - or silently corrupt the metadata block Tampermonkey reads to install the
 * script. This gate fails the build rather than ship a bundle that is unsafe
 * to interpret or won't install.
 */
function verifyMinified(text) {
  const body = text.slice(text.indexOf("==/UserScript==") + 16);
  if (!text.startsWith("// ==UserScript==")) {
    throw new Error("min build: metadata banner displaced from file head");
  }
  for (const needle of ["@name         PlayerForge", "@version", "@grant        GM_setValue", "@resource     pfStyle https://raw.githubusercontent.com/itsrody/PlayerForge/firefox/dist/playerforge.css"]) {
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
  const readableOpts = { ...shared, minify: false, outfile: "dist/playerforge.readable.js" };

  // Primary: minified bundle (what Tampermonkey installs).
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
  console.log("[PlayerForge] min build verified: TM header intact, no eval/with/new Function, deterministic");

  // Secondary: readable bundle for compare-bundles mode.
  await build(readableOpts);
  console.log("[PlayerForge] wrote dist/playerforge.readable.js");
}
