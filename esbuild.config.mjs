import { build, context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import process from "node:process";

// Minified is the only output. Minification is
// engine-safe by construction: esbuild only does the safe transforms
// (whitespace, local-identifier mangling, syntax compression) - it never
// introduces eval/with, never mangles property names, so the bundle stays a
// straightforward parse for SpiderMonkey's baseline/Ion pipeline with no
// hidden allocation or eval-driven deopt surprises. The embedded stylesheet is
// minified separately (esbuild's JS minifier would not shrink a text-loaded
// string); the CSS pass below is deliberately conservative so calc()/content
// and selector whitespace survive intact.

// The banner below is the single version source. Runtime reads the installed
// script's real version through GM_info.script.version, so bumping @version
// here is all a release takes.
// Instant-injection note: PF never assumes the DOM exists at eval, so it is
// correct under whatever @run-at the manager actually grants - including true
// document-start, where the shared mutation feed subscribes to the Document
// node before documentElement is parsed. Violentmonkey MV2 2.49.0 registers
// injected-web.js as a declarative content script at document_start with
// all_frames, so @run-at document-start is honoured for real here. That is not
// something the script can assert about itself, only the manager's guarantee.
//
// There is deliberately no @sandbox / @inject-into directive. Both are moot for
// PF: SDK detection is purely selector-based against the composed DOM ancestry
// (src/kernel/sdk.js), so PF never reads a page-defined JS global or an expando
// and works identically in the page realm or a content-script realm. Pinning a
// realm would claim a guarantee PF does not need, and on Firefox a page CSP can
// demote a page-realm injection anyway.
//
// @allFrames is set explicitly rather than relied on. Violentmonkey 2.49.0
// has no `allFrames` key at all - the string does not appear anywhere in the
// shipped XPI - and gates sub-frames with `@noframes` instead, injecting into
// every frame unless that key is present. So the line is inert on the shipping
// target and kept only so a Tampermonkey user still gets sub-frame injection:
// its Firefox build defaults Content Script mode (no document_start) unless a
// userscript-API injection mode is chosen, and defaults allFrames true. PF
// self-guards per frame anyway (a shell needs a video to adopt), so an extra
// top-frame boot is a no-op.
//
// A granted script runs in Violentmonkey's CONTENT realm, not the page's. That
// is the default for `@inject-into auto` once any @grant is present, and PF
// does not fight it: verified against a real 2.49.0 build driving the shipped
// bundle, `window.PlayerForge` and the GM_* globals are absent from the page
// world while the kernel boots, finds a Plyr-anchored video and adopts it into
// an open shadow root with an adopted stylesheet. The realm is unobservable to
// PF because it only ever reads the DOM - including a shared, cross-realm
// constructable stylesheet, which is the one thing a realm change could
// plausibly have broken (src/shell/chrome/inject.js). Not inferred.
//
// The GM contract was read from 2.49.0's own injected-web.js rather than its
// docs, and PF uses only the legacy synchronous GM_* surface (never the GM.*
// promise namespace). GM_getValue is synchronous and hands stored values back
// as real objects. GM_addValueChangeListener mints a FRESH ID per call
// (`s || (s = x("VMvc"), n[s] = cb)`) into a per-key table and delivers to every
// registration, so the many-shells-one-key case needs no fan-out of its own -
// every shell's ResumeStore keeps an independent id and its own unsubscribe.
// GM_registerMenuCommand clones its third argument, sets opts.text from the
// caption, keys the entry on `opts.id || caption` and RETURNS that key, so the
// options object is the correct type there and the handle is always usable.
// GM_getResourceText is present. GM_info is defined un-granted.
// GM_xmlhttpRequest is callback-based with a numeric status and responseText.
//
// @connect * is NOT what makes subtitle fetching work, and the previous version
// of this comment claimed it was, by citing api-gm.js - the native harness's GM
// bridge, not the shipping manager. Measured against a real 2.49.0 build:
// Violentmonkey MV2 parses @connect into the script's config and then never
// consults it for GM_xmlhttpRequest. A script declaring `@connect 127.0.0.2` -
// a host nothing is listening on - still fetched 127.0.0.1 and got 200, and a
// dead-port `@connect 127.0.0.1:1` did the same, so it is neither host- nor
// port-matched. The line is kept because a manager that DOES enforce the key
// would need it, not because VM does. Anyone who later "tightens" it and finds
// subtitle hosts breaking has found a different manager's behaviour, not a
// regression here.
const banner = `// ==UserScript==
// @name         PlayerForge
// @namespace    https://github.com/PlayerForge
// @version      0.7.2
// @description  HTML5 video player enhancer, built natively for Firefox 157+ (desktop and Android) running under Violentmonkey MV2 2.49+.
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
// @allFrames    true
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @connect      *
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
  target: ["firefox157"],
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
 * engine-safe by construction (esbuild never emits eval/with, never
 * mangles property names), but a broken minifier would violate exactly
 * those promises - or silently corrupt the metadata block the manager reads
 * to install the script. This gate fails the build rather than ship a bundle
 * that is unsafe to interpret or won't install.
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

  // Minified bundle (what the manager installs).
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
  console.log("[PlayerForge] min build verified: userscript header intact, no eval/with/new Function, deterministic");
}
