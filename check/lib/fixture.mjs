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
