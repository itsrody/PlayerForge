import { build, context } from "esbuild";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";

// Minified is the default (and only shipping) output. The readable variant
// is built alongside for the compare-bundles platform mode. Minification is
// V8/TurboFan-aware by construction: esbuild only does the safe transforms
// (whitespace, local-identifier mangling, syntax compression) that keep
// functions Maglev/TurboFan-compilable - it never introduces eval/with, never
// mangles property names, and its bytecode cost per op is unchanged, so V8's
// hidden-class/IC-driven optimization is untouched. The embedded stylesheet is
// minified separately (esbuild's JS minifier would not shrink a text-loaded
// string); the CSS pass below is deliberately conservative so calc()/content
// and selector whitespace survive intact.

// The banner below is the single version source. Runtime reads the installed
// script's real version through GM_info.script.version, so bumping @version
// here is all a release takes.
// Instant-injection note: @run-at document-start + @sandbox raw are what make
// real document-start work under Tampermonkey's MV3 userScripts API. PF never
// assumes the DOM is ready at eval, so it is safe under instant injection.
const banner = `// ==UserScript==
// @name         PlayerForge (Chromium)
// @namespace    https://github.com/PlayerForge
// @version      0.7.1
// @description  Chromium 152+ / Tampermonkey 5.5+ (MV3) exclusive HTML5 video player enhancer with gestures, hotkeys, progress resume, subtitles, and an extensible plugin system
// @author       PlayerForge
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
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      https://www.subtitlecat.com
// @resource     pfStyle https://raw.githubusercontent.com/itsrody/PlayerForge/chromium/src/shell/chrome/styles.css
// @sandbox      raw
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
      });
    }
  };
}

const shared = {
  entryPoints: ["src/entry.js"],
  bundle: true,
  format: "iife",
  target: ["chrome152"],
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
 * V8/TurboFan-safe by construction (esbuild never emits eval/with, never
 * mangles property names), but a broken minifier would violate exactly
 * those promises - or silently corrupt the metadata block Tampermonkey reads
 * to install the script. This gate fails the build rather than ship a bundle
 * that is unsafe to interpret or won't install.
 */
function verifyMinified(text) {
  const body = text.slice(text.indexOf("==/UserScript==") + 16);
  if (!text.startsWith("// ==UserScript==")) {
    throw new Error("min build: metadata banner displaced from file head");
  }
  for (const needle of ["@name         PlayerForge", "@version", "@grant        GM_setValue"]) {
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
