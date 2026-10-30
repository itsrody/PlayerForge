/**
 * Fixture page + video asset for the browser gate.
 *
 * The kernel's discovery probe only acknowledges a video that is (a) at least
 * 100x60 and (b) anchored in a Plyr-style wrapper, so the fixture must be a
 * real playback surface: a small h264 webm/mp4 built once with the machine's
 * ffmpeg and served by the session's own http server (same origin, so the
 * boot's ad-host guard keeps the page alive).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const FIXTURE_DIR = join(HERE, "..", ".tmp");

export const FIXTURE_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; width: 1280px; height: 720px; overflow: hidden; }
    .plyr { position: relative; width: 1280px; height: 720px; }
    #check-video { width: 100%; height: 100%; object-fit: contain; display: block; }
  </style>
</head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="check-video" src="/check-video.mp4" preload="metadata" autoplay muted playsinline></video>
    </div>
  </div>
</body>
</html>`;

const VIDEO_ROUTE = "/check-video.mp4";

/** A page the discoverer must not boot: no candidate anywhere. */
export const FALLBACK_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>no player here</title></head>
<body style="background:#000"></body>
</html>`;

/**
 * Frame-lab host: exactly one iframe over the pass-in source (absolute URL),
 * full window, and deliberately NO allowfullscreen/allow="fullscreen" - the
 * kernel's fullscreen provisioner must add that attribute once a shell boots
 * in the embedded page, which is what the nested-frames row asserts.
 */
export function embedHostPage(embedSrc, title = "pf embed host") {  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title>
<style>
  * { margin: 0; padding: 0; }
  body { background: #111; width: 1440px; height: 900px; overflow: hidden; }
  iframe { width: 1280px; height: 720px; border: 0; }
</style>
</head>
<body>
  <iframe id="player-frame" src="${embedSrc}"></iframe>
</body>
</html>`;
}

/** Video.js-shaped stub: the kernel's registry anchors on `[data-vjs-player]`
 *  / `.video-js` classes, so a bare wrapper div with the SDK's names is a
 *  supported player with zero vendor script - same video the other pages run. */
export const VIDEOJS_STUB_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>pf videojs stub</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; width: 1280px; height: 720px; overflow: hidden; }
  .video-js { position: relative; width: 1280px; height: 720px; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
</style>
</head>
<body>
  <div class="video-js" id="stub-player">
    <video src="/check-video.mp4" preload="metadata" autoplay muted playsinline></video>
  </div>
</body>
</html>`;

/** DPlayer-shaped stub - registry anchor `.dplayer`. */
export const DPLAYER_STUB_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>pf dplayer stub</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; width: 1280px; height: 720px; overflow: hidden; }
  .dplayer { position: relative; width: 1280px; height: 720px; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
</style>
</head>
<body>
  <div class="dplayer"><video src="/check-video.mp4" preload="metadata" autoplay muted playsinline></video></div>
</body>
</html>`;

/**
 * The letterbox stage for the subtitle picture-anchor case: the video
 * ELEMENT is square (800x800) inside a 900x800 stage, so object-fit contain
 * puts a 16:9 stream at a KNOWN picture rect (x=0, y=175, w=800, h=450) -
 * images the shell's percent-relative cue anchoring would have missed.
 */
export const SUBS_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; width: 1280px; height: 900px; overflow: hidden; }
    .plyr { position: relative; width: 900px; height: 800px; }
    #check-video { width: 800px; height: 800px; object-fit: contain; display: block; }
  </style>
</head>
<body>
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="check-video" src="/check-video.mp4" preload="metadata" autoplay muted playsinline></video>
    </div>
  </div>
</body>
</html>`;

/**
 * Switchboard host: one placeholder iframe whose document gets swapped
 * between SDK stub pages via `swapBoard()` (driven from the harness). Every
 * variant plays the same fixture video at the same route, so the rows that
 * follow a swap can assert one-shell-at-a-time adoption across SDK records.
 */
export function switchboardPage(firstBoardSrc) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>pf switchboard</title>
<style>
  * { margin: 0; padding: 0; }
  body { background: #111; width: 1440px; height: 900px; overflow: hidden; }
  iframe { width: 1280px; height: 720px; border: 0; }
</style>
</head>
<body>
  <iframe id="board" src="${firstBoardSrc}"></iframe>
  <script>
    window.swapBoard = function (url) {
      document.getElementById("board").src = url;
    };
  </script>
</body>
</html>`;
}

/** Build the fixture video once (idempotent) and return its route path. */
export function ensureVideoAsset() {
  const out = join(FIXTURE_DIR, "check-video.mp4");
  if (existsSync(out)) return VIDEO_ROUTE;
  const ffmpeg = ["ffmpeg", "/opt/homebrew/bin/ffmpeg"]
    .find((bin) => {
      try {
        return execFileSync("sh", ["-c", `command -v ${bin}`]).length > 0;
      } catch { return false; }
    });
  if (ffmpeg === undefined) {
    throw new Error("ffmpeg not found - the browser gate needs a playable video fixture");
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  execFileSync(ffmpeg, [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=320x180:r=25",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    // 12s on purpose: the resume restore contract only applies saved
    // positions above RESUME_MIN_POSITION (5s), so a probe fixture must be
    // able to hold and hand back a position past that floor. faststart puts
    // the moov box first so the range-capable server below can honor seeks
    // from the first byte.
    "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    "-movflags", "+faststart",
    out
  ]);
  return VIDEO_ROUTE;
}
