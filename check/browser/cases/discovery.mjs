import { sleep } from "../../lib/driver.mjs";
/**
 * The discovery contract's negative half: a kernel that shells *every* video
 * is worse than one that boots nothing. Probe the boundaries the discovery
 * probe enforces - the Plyr-style wrapper and the 100x60 MIN_VIDEO floor -
 * and require both pages to stay unbooted (window.PlayerForge undefined:
 * the probe resolves SDK identity together with presence, so an unanchored
 * or sub-floor candidate never even boots the kernel). Plus the boot-abandon
 * recovery: a settle-window disconnect reconnected inside the removal grace
 * must re-boot (the abandoned boot's seen-pin released through its watch, the
 * downgraded tap re-armed), not strand the video forever.
 */
const BARE_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>bare video</title></head>
<body style="background:#000">
  <video id="check-video" src="/check-video.mp4" preload="metadata" playsinline></video>
</body>
</html>`;

const SMALL_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>video { width: 80px; height: 44px; display: block; }</style>
</head>
<body style="background:#000">
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper">
      <video id="check-video" src="/check-video.mp4" preload="metadata" playsinline></video>
    </div>
  </div>
</body>
</html>`;

// The boot-abandon page: the wrapper starts EMPTY so probe checkStatic (and
// the sleep after bundle injection) sees no candidate, and the eval owns the
// whole adoption timeline from the first dispatched media event.
const VOLATILE_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>flapping player</title>
<style>
  .plyr { position: relative; width: 1280px; height: 720px; }
  .plyr__video-wrapper { position: relative; width: 100%; height: 100%; }
  video { width: 640px; height: 360px; display: block; }
</style></head>
<body style="background:#000">
  <div class="plyr" data-plyr>
    <div class="plyr__video-wrapper"></div>
  </div>
</body>
</html>`;

export async function run({ session, baseUrl, bundle }) {
  const rows = [];
  session.registerFixture("/check/bare", BARE_PAGE);
  session.registerFixture("/check/small", SMALL_PAGE);
  session.registerFixture("/check/volatile", VOLATILE_PAGE);

  const bootAttempt = async (path) => {
    await session.navigate(`${baseUrl}${path}?boot=${Date.now()}`);
    await session.injectGMRealm();
    await session.injectBundle(bundle);
    await session.wakeVideos();
    await sleep(900);
    return session.eval(function main() {
      return { shell: document.querySelector(".pf-shell") !== null, version: typeof window.PlayerForge };
    });
  };

  const bare = await bootAttempt("/check/bare");
  rows.push({
    name: "bare video (no Plyr wrapper) stays unbooted",
    status: !bare.shell && bare.version === "undefined" ? "pass" : "fail",
    note: bare.shell ? `shell attached on ${baseUrl}/check/bare` : null,
    ms: null
  });

  const small = await bootAttempt("/check/small");
  rows.push({
    name: "sub-MIN_VIDEO video (80x44) stays unbooted",
    status: !small.shell && small.version === "undefined" ? "pass" : "fail",
    note: small.shell ? "shell attached despite size floor" : null,
    ms: null
  });

  // Boot-abandon recovery. The eval owns the whole timeline (no wake ceremony:
  // the wrapper starts empty, so checkStatic and the sleep see no candidate):
  // the video surfaces at t0 and adoption begins (the probe resolves identity
  // together with presence and hands the home; kernel adopts prequalified,
  // settle quiet 50/cap 150). The 80ms removal lands inside the settle window,
  // so the boot resolves with the video out of the document - the abandoned
  // path. The 400ms re-add rides within the 500ms removal grace: the stranded
  // shape (pin never released + downgraded tap refusing the video forever)
  // means no shell ever; the released shape re-boots through the re-armed
  // full tap. Permutations where the settle starts late resolve against a
  // connected video and boot ordinarily - the row asserts the recovery
  // outcome, which every permutation reaches with the fix.
  await session.navigate(`${baseUrl}/check/volatile?boot=${Date.now()}`);
  await session.injectGMRealm();
  await session.injectBundle(bundle);
  await sleep(600);
  const flapped = await session.evalAsync(function main(done) {
    const wr = document.querySelector(".plyr__video-wrapper");
    if (!wr) { done(null); return; }
    const v = document.createElement("video");
    v.preload = "none";
    v.muted = true;
    v.src = "/check-video.mp4";
    let fired = false;
    const finish = (record) => {
      if (!fired) {
        fired = true;
        done(record);
      }
    };
    const watch = (from) => {
      const deadline = Date.now() + 9000;
      const tick = () => {
        if (v.matches("[data-pf-shell]")) {
          finish({ ok: true, shells: document.querySelectorAll(".pf-shell").length, t: Date.now() - from });
          return;
        }
        if (Date.now() < deadline) setTimeout(tick, 120);
        else finish({ ok: false, shells: document.querySelectorAll(".pf-shell").length, t: Date.now() - from });
      };
      tick();
    };
    // t0: the video surfaces and adoption begins.
    wr.appendChild(v);
    v.dispatchEvent(new Event("loadeddata"));
    const t0 = Date.now();
    // Inside the settle window: the boot resolves with the video out.
    setTimeout(() => v.remove(), 80);
    // Within the removal grace: only a released pin + re-armed tap re-boots.
    setTimeout(() => {
      wr.appendChild(v);
      v.dispatchEvent(new Event("loadeddata"));
      watch(t0);
    }, 400);
    setTimeout(() => finish({ ok: false, shells: document.querySelectorAll(".pf-shell").length, t: null }), 11000);
  });
  rows.push({
    name: "settle-window disconnect reconnected inside the removal grace re-boots (seen-pin released + tap re-armed)",
    status: flapped && flapped.ok && flapped.shells === 1 ? "pass" : "fail",
    note: flapped
      ? `stamped=${flapped.ok} shells=${flapped.shells}${flapped.t != null ? ` at ${Math.round(flapped.t)}ms` : ""}`
      : "scenario page never settled",
    ms: null
  });

  return rows;
}
