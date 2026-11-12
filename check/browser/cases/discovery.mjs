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
 * downgraded tap re-armed), not strand the video forever. And the bare-player
 * adoption tier: an anchor-less video qualifies only on blob: currentSrc +
 * played.length > 0 with discovery.bareVideos ON (opt-in), adopting through
 * its page container with the video never moved; every leg missing keeps the
 * negative answer, on and off the tier.
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

// The bare-tier page: a video with NO src in markup and NO SDK anchor - the
// MSE shape a page builds programmatically. The eval assigns a blob: URL
// (URL.createObjectURL of the fetched fixture) and plays it; the tier's
// evidence bar (blob: currentSrc + played.length > 0) must see exactly this.
const BLOB_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>bare blob video</title>
<style>
  #player { position: relative; width: 640px; height: 360px; }
  video { width: 100%; height: 100%; display: block; }
</style></head>
<body style="background:#000">
  <div id="player"><video id="check-video" playsinline></video></div>
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
  session.registerFixture("/check/blob", BLOB_PAGE);

  const bootAttempt = async (path, seed = null) => {
    await session.navigate(`${baseUrl}${path}?boot=${Date.now()}`);
    await session.injectGMRealm(seed ? { storage: seed } : undefined);
    await session.injectBundle(bundle);
    await session.wakeVideos();
    await sleep(900);
    return session.eval(function main() {
      return { shell: document.querySelector(".pf-shell") !== null, version: typeof window.PlayerForge };
    });
  };

  // The bare-tier page's feed: blob-URL the fixture and start playback -
  // the evidence bar's two facts land together (src assignment fires the
  // media events the probe re-considers on; play() fills played.length).
  const feedBlob = () => session.evalAsync(function main(done) {
    fetch("/check-video.mp4")
      .then((r) => r.blob())
      .then((b) => {
        const v = document.querySelector("#check-video");
        v.src = URL.createObjectURL(b);
        v.muted = true;
        v.addEventListener("playing", () => done({ ok: true }), { once: true });
        v.play().catch((err) => done({ ok: false, why: `play rejected: ${err}` }));
        setTimeout(() => done({ ok: false, why: "playing never fired" }), 6000);
      })
      .catch((err) => done({ ok: false, why: `fetch failed: ${err}` }));
  });

  const BARE_SEED = { "pf:configs": { discovery: { bareVideos: true } } };

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

  // The bare-player adoption tier (opt-in via discovery.bareVideos). The
  // evidence bar replaces the registry's identity leg for anchor-less
  // videos: blob: currentSrc (the MSE shape) AND played.length > 0 (the
  // junk killer). Presence gates are unchanged - discovery's job.
  const blobTierOn = await (async () => {
    await session.navigate(`${baseUrl}/check/blob?boot=${Date.now()}`);
    await session.injectGMRealm({ storage: BARE_SEED });
    await session.injectBundle(bundle);
    const fed = await feedBlob();
    if (!fed || !fed.ok) {
      return { fed: null, st: null };
    }
    const st = await session.waitFor(function main() {
      return document.querySelector(".pf-shell") !== null ? { ready: true } : null;
    }, 9000, 120).catch(() => null);
    const full = await session.eval(function main() {
      const video = document.querySelector("#check-video");
      const host = document.querySelector(".pf-shell");
      return {
        shell: host !== null,
        version: typeof window.PlayerForge,
        videoParent: video?.parentElement?.id ?? null,
        shellInPlayer: document.querySelector("#player")?.contains(host) ?? false,
        stamped: video?.hasAttribute("data-pf-shell") ?? false
      };
    });
    return { fed, st: { ...full, waited: st !== null } };
  })();
  rows.push({
    name: "bare tier ON: blob+played video adopts through its page container",
    status: blobTierOn.fed?.ok && blobTierOn.st?.shell && blobTierOn.st?.version === "object"
      && blobTierOn.st?.videoParent === "player" && blobTierOn.st?.shellInPlayer
      && blobTierOn.st?.stamped ? "pass" : "fail",
    note: blobTierOn.fed?.ok === false
      ? `feed failed: ${blobTierOn.fed?.why}`
      : `shell=${blobTierOn.st?.shell} pf=${blobTierOn.st?.version} videoParent=${blobTierOn.st?.videoParent} shellInPlayer=${blobTierOn.st?.shellInPlayer} stamped=${blobTierOn.st?.stamped}`,
    ms: null
  });

  // Tier off (default): the same blob+played flow must stay unbooted - the
  // no-generic-fallback law governs every default install, and the tier's
  // OFF posture caches the negative descriptor like it always did.
  const blobTierOff = await (async () => {
    await session.navigate(`${baseUrl}/check/blob?boot=${Date.now()}`);
    await session.injectGMRealm();
    await session.injectBundle(bundle);
    const fed = await feedBlob();
    await sleep(2500);
    const st = await session.eval(function main() {
      return { shell: document.querySelector(".pf-shell") !== null, version: typeof window.PlayerForge };
    });
    return { fed, st };
  })();
  rows.push({
    name: "bare tier OFF (default): blob+played video stays unbooted",
    status: blobTierOff.fed?.ok && !blobTierOff.st?.shell && blobTierOff.st?.version === "undefined" ? "pass" : "fail",
    note: blobTierOff.fed?.ok === false
      ? `feed failed: ${blobTierOff.fed?.why}`
      : `shell=${blobTierOff.st?.shell} pf=${blobTierOff.st?.version}`,
    ms: null
  });

  // Tier ON but the evidence bar's blob leg missing: a PLAIN-src video that
  // actually plays must stay unbooted - played.length alone never adopts.
  const plainTierOn = await (async () => {
    await bootAttempt("/check/bare", BARE_SEED);
    await session.eval(function main() {
      const v = document.querySelector("#check-video");
      v.muted = true;
      v.play();
      return "armed";
    });
    await sleep(2500);
    return session.eval(function main() {
      const v = document.querySelector("#check-video");
      return {
        shell: document.querySelector(".pf-shell") !== null,
        version: typeof window.PlayerForge,
        played: v.played.length > 0
      };
    });
  })();
  rows.push({
    name: "bare tier ON: plain-src playing video stays unbooted (no blob: leg)",
    status: !plainTierOn.shell && plainTierOn.version === "undefined" && plainTierOn.played ? "pass" : "fail",
    note: `shell=${plainTierOn.shell} pf=${plainTierOn.version} played=${plainTierOn.played}`,
    ms: null
  });

  // Tier ON but the evidence bar's played leg missing: a blob-src video
  // nobody ever played must stay unbooted - the decoder-texture/canvas
  // texture class the bar exists to refuse.
  const coldBlobTierOn = await (async () => {
    await session.navigate(`${baseUrl}/check/blob?boot=${Date.now()}`);
    await session.injectGMRealm({ storage: BARE_SEED });
    await session.injectBundle(bundle);
    await session.evalAsync(function main(done) {
      fetch("/check-video.mp4")
        .then((r) => r.blob())
        .then((b) => {
          document.querySelector("#check-video").src = URL.createObjectURL(b);
          done({ ok: true });
        })
        .catch((err) => done({ ok: false, why: `fetch failed: ${err}` }));
    });
    await sleep(2500);
    return session.eval(function main() {
      const v = document.querySelector("#check-video");
      return {
        shell: document.querySelector(".pf-shell") !== null,
        version: typeof window.PlayerForge,
        blob: v.currentSrc.startsWith("blob:"),
        neverPlayed: v.played.length === 0
      };
    });
  })();
  rows.push({
    name: "bare tier ON: blob-src never-played video stays unbooted (no played leg)",
    status: !coldBlobTierOn.shell && coldBlobTierOn.version === "undefined" && coldBlobTierOn.blob && coldBlobTierOn.neverPlayed ? "pass" : "fail",
    note: `shell=${coldBlobTierOn.shell} pf=${coldBlobTierOn.version} blob=${coldBlobTierOn.blob} neverPlayed=${coldBlobTierOn.neverPlayed}`,
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
