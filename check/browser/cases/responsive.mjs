import { sleep } from "../../lib/driver.mjs";
/**
 * The HUD's responsive posture, pinned at the bands the floor probe measured
 * (check/.tmp/responsive-probe.mjs). The forge bar's fixed chrome (5 x 40px
 * targets + 63px time readout + padding/gaps ~ 305px) overflowed a pill at a
 * ~323px stage and starved the range flex arm below ~400px; the bar carried
 * zero responsive adaptation while the panel carried the whole adaptive
 * system. The adopted ladder (container pockets, mount.js) tightens chrome
 * first (targets untouched), then drops the time readout, then shrinks the
 * targets; a height tier caps the bar's share of a short stage. Rows pin
 * each band's computed values live, the overflow refusal at every stage
 * width of the probe's sweep, the height tier's bar + cue-shift token
 * coherence both directions, and the panel's containment across small
 * embed regions (the base fine-pointer path - the coarse bottom-sheet and
 * landscape blocks are viewport media rows unreachable in this harness).
 *
 * The page is the bare-tier shape (anchor-less video adopted through its
 * page container, tier seeded ON) because the bare shell's bar is the
 * inline control surface - visible while paused (the paused hold), so the
 * geometry rows need no fullscreen stub.
 */
const RESP_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>responsive hud</title>
<style>
  body { margin: 30px; background: #000; }
  #player { position: relative; width: 640px; height: 360px; background: #222; }
  video { width: 100%; height: 100%; display: block; }
</style></head>
<body>
  <div id="player"><video id="check-video" playsinline></video></div>
</body>
</html>`;

const SEED = { "pf:configs": { discovery: { bareVideos: true } } };

export async function run({ session, baseUrl, bundle }) {
  const rows = [];
  session.registerFixture("/check/responsive", RESP_PAGE);

  await session.navigate(`${baseUrl}/check/responsive?boot=${Date.now()}`);
  await session.injectGMRealm({ storage: SEED });
  await session.injectBundle(bundle);

  // Feed the blob evidence bar its two facts (blob: src + played) and wait
  // for the shell the tier adoption builds through the page container.
  const fed = await session.evalAsync(function main(done) {
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
  if (!fed?.ok) {
    rows.push({ name: "responsive: blob feed", status: "fail", note: fed?.why ?? "no feed result", ms: null });
    return rows;
  }
  const shellSeen = await session.waitFor(function main() {
    return document.querySelector(".pf-shell") !== null ? { ready: true } : null;
  }, 9000, 120).catch(() => null);
  if (!shellSeen) {
    rows.push({ name: "responsive: bare shell attached", status: "fail", note: "shell never attached", ms: null });
    return rows;
  }

  // Park playback: the bare bar's paused hold keeps it visible for every
  // geometry row (the idle sweep would hide it mid-row otherwise).
  await session.eval(function main() { document.querySelector("video").pause(); });
  await sleep(400);

  const sizeStage = async (w, h) => {
    await session.eval(function main(v) {
      const p = document.getElementById("player");
      p.style.width = v[0] + "px";
      p.style.height = v[1] + "px";
    }, [w, h]);
    await sleep(160);
  };

  /** Bar geometry + the computed band values at the current stage size. */
  const barState = () => session.eval(function main() {
    const bar = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-forge-bar");
    if (!bar) return { none: true };
    const cs = getComputedStyle(bar);
    const br = bar.getBoundingClientRect();
    // Hidden (display:none) children report a 0,0 rect that would read as a
    // huge left overflow - only visible children are spill candidates.
    const kids = [...bar.children].map((k) => k.getBoundingClientRect())
      .filter((r) => r.width > 0);
    const spill = Math.max(
      Math.max(0, ...kids.map((r) => r.right - br.right)),
      Math.max(0, ...kids.map((r) => br.left - r.left))
    );
    const range = bar.querySelector(".pf-forge-range");
    const time = bar.querySelector(".pf-forge-time");
    const btn = bar.querySelector(".pf-forge-btn");
    const cue = document.querySelector(".pf-shell").shadowRoot.querySelector(".pf-cue-layer");
    return {
      spill: Math.round(spill * 10) / 10,
      sc: bar.scrollWidth > bar.clientWidth,
      hidden: bar.hidden,
      barH: Math.round(br.height),
      rangeW: Math.round(range.getBoundingClientRect().width),
      timeDisplay: getComputedStyle(time).display,
      btnW: getComputedStyle(btn).width,
      gap: cs.gap,
      padL: cs.paddingLeft,
      heightCss: cs.height,
      cueBottom: getComputedStyle(cue).bottom
    };
  });

  const panelState = async () => {
    await session.eval(function main() {
      document.querySelector(".pf-shell")?.shadowRoot
        ?.querySelector('.pf-forge-bar [data-action="settings"]')?.click();
    });
    const opened = await session.waitFor(function main() {
      return document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel.pf-open")
        ? { open: true } : null;
    }, 4000, 100).catch(() => null);
    if (!opened) return { open: false };
    const s = await session.eval(function main() {
      const host = document.querySelector(".pf-shell");
      const panel = host.shadowRoot.querySelector(".pf-panel");
      const pr = panel.getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      return {
        inH: pr.left >= hr.left - 1 && pr.right <= hr.right + 1,
        inV: pr.top >= hr.top - 1 && pr.bottom <= hr.bottom + 1,
        pw: Math.round(pr.width), ph: Math.round(pr.height)
      };
    });
    await session.eval(function main() {
      document.querySelector(".pf-shell")?.shadowRoot
        ?.querySelector(".pf-panel .pf-panel-close")?.click();
    });
    await session.waitFor(function main() {
      return document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-panel.pf-open")
        ? null : { closed: true };
    }, 4000, 100).catch(() => null);
    await sleep(200);
    return { open: true, ...s };
  };

  // Baseline: the resting bar at a roomy stage is byte-unchanged - fit,
  // full chrome, 56px height, cue canvas shifted by 56+8.
  await sizeStage(640, 360);
  const base = await barState();
  rows.push({
    name: "bar baseline at 640px stage: fit, full chrome, 56px strip",
    status: !base.none && !base.hidden && base.spill === 0 && !base.sc
      && base.gap === "4px" && base.padL === "8px" && base.btnW === "40px"
      && base.timeDisplay !== "none" && base.heightCss === "56px"
      && base.cueBottom === "64px" && base.rangeW > 200 ? "pass" : "fail",
    note: JSON.stringify(base),
    ms: null
  });

  // Band 1 (<=400): chrome tightened, targets untouched, still fits.
  await sizeStage(390, 360);
  const b1 = await barState();
  rows.push({
    name: "band 1 at 390px stage: tightened chrome, 40px targets, no overflow",
    status: !b1.none && b1.spill === 0 && !b1.sc && b1.gap === "2px"
      && b1.padL === "6px" && b1.btnW === "40px" && b1.timeDisplay !== "none"
      && b1.rangeW >= 40 && b1.heightCss === "56px" ? "pass" : "fail",
    note: JSON.stringify(b1),
    ms: null
  });

  // Band 2 (<=340): the time readout cedes its 65px to the range arm.
  await sizeStage(320, 360);
  const b2 = await barState();
  rows.push({
    name: "band 2 at 320px stage: time readout hidden, range armed, no overflow",
    status: !b2.none && b2.spill === 0 && !b2.sc && b2.timeDisplay === "none"
      && b2.btnW === "40px" && b2.rangeW >= 40 ? "pass" : "fail",
    note: JSON.stringify(b2),
    ms: null
  });

  // Band 3 (<=260): the targets shrink to the 24px AA floor band - a region
  // this narrow physically cannot carry five 40px targets plus a range.
  await sizeStage(240, 360);
  const b3 = await barState();
  rows.push({
    name: "band 3 at 240px stage: 32px targets, no overflow",
    status: !b3.none && b3.spill === 0 && !b3.sc && b3.btnW === "32px"
      && b3.timeDisplay === "none" && b3.rangeW >= 40 ? "pass" : "fail",
    note: JSON.stringify(b3),
    ms: null
  });

  // Height tier (<=280 tall): the 58px bar is 32% of a 180px picture - the
  // tier drops the strip to 44px + 6px inset, and the cue canvas shift
  // follows through the same tokens set on BOTH consumers (bar height reads
  // them on itself; the sheet's shift rule reads them on the cue layer).
  await sizeStage(640, 220);
  const hb = await barState();
  rows.push({
    name: "height tier at 640x220 stage: 44px strip, cue shift 50px, fit held",
    status: !hb.none && !hb.hidden && hb.spill === 0 && !hb.sc
      && hb.heightCss === "44px" && hb.cueBottom === "50px"
      && hb.btnW === "40px" && hb.gap === "4px" ? "pass" : "fail",
    note: JSON.stringify(hb),
    ms: null
  });
  // And back: the tier must release byte-true (the tokens return to the
  // scope's declared values, the shift returns to 64px).
  await sizeStage(640, 360);
  const back = await barState();
  rows.push({
    name: "height tier releases: 56px strip, cue shift 64px restored",
    status: !back.none && back.heightCss === "56px" && back.cueBottom === "64px"
      ? "pass" : "fail",
    note: JSON.stringify(back),
    ms: null
  });

  // Panel containment at small embed regions (the base fine-pointer path):
  // the panel's own max-height is calc(100% - 24px), so a region shorter
  // than the panel's content must cap it inside the region, never overflow
  // the box the hud is inset:0'd into.
  for (const [w, h] of [[330, 240], [300, 200]]) {
    await sizeStage(w, h);
    await sleep(150);
    const p = await panelState();
    rows.push({
      name: `panel contained in ${w}x${h} embed region`,
      status: p.open && p.inH && p.inV ? "pass" : "fail",
      note: JSON.stringify(p),
      ms: null
    });
  }

  return rows;
}
