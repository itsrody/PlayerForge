/**
 * The discovery contract's negative half: a kernel that shells *every* video
 * is worse than one that boots nothing. Probe the boundaries the discovery
 * probe enforces - the Plyr-style wrapper and the 100x60 MIN_VIDEO floor -
 * and require both pages to stay unbooted.
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

export async function run({ session, baseUrl, bundle }) {
  const rows = [];
  session.registerFixture("/check/bare", BARE_PAGE);
  session.registerFixture("/check/small", SMALL_PAGE);

  const bootAttempt = async (path) => {
    await session.navigate(`${baseUrl}${path}?boot=${Date.now()}`);
    await session.injectGMRealm();
    await session.injectBundle(bundle);
    await session.wakeVideos();
    await new Promise((r) => setTimeout(r, 900));
    return session.eval(function main() {
      return { shell: document.querySelector(".pf-shell") !== null, version: typeof window.PlayerForge };
    });
  };

  const bare = await bootAttempt("/check/bare");
  rows.push({
    name: "bare video (no Plyr wrapper) stays unbooted",
    status: !bare.shell ? "pass" : "fail",
    note: bare.shell ? `shell attached on ${baseUrl}/check/bare` : null,
    ms: null
  });

  const small = await bootAttempt("/check/small");
  rows.push({
    name: "sub-MIN_VIDEO video (80x44) stays unbooted",
    status: !small.shell ? "pass" : "fail",
    note: small.shell ? "shell attached despite size floor" : null,
    ms: null
  });

  return rows;
}
