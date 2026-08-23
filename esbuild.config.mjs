import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");

const banner = `// ==UserScript==
// @name         PlayerForge
// @namespace    https://github.com/PlayerForge
// @version      0.6.0
// @description  Generic HTML5 video player enhancer with gestures, hotkeys, progress resume, subtitles, and an extensible plugin system
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
// @run-at       document-start
// @license      MIT
// ==/UserScript==

// V8 explicit compile hint (Chrome 136+): eagerly parse+compile on a
// background thread instead of lazily at first call during document_start.
// Must precede the first non-comment token. Ignored by other engines.
//# allFunctionsCalledOnLoad`;

const options = {
  entryPoints: ["src/entry.js"],
  bundle: true,
  format: "iife",
  target: ["es2022"],
  outfile: "dist/playerforge.user.js",
  banner: { js: banner },
  loader: { ".css": "text" },
  legalComments: "none",
  minify: false,
  sourcemap: false,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[PlayerForge] watching for changes...");
} else {
  await build(options);
}
