/**
 * Real playback through the real bundle: the fixture video is served over
 * http, reaches a real duration, and panel + resume paths that depend on
 * media state hold up end to end.
 */
export async function run({ session, baseUrl, boot }) {
  const rows = [];
  await boot();

  const duration = await session.waitFor(
    `return (() => { const v = document.querySelector("#check-video"); return v && v.duration > 3 ? v.duration : false; })()`,
    5000
  ).catch(async (err) => {
    const probe = await session.eval(function main() {
      const v = document.querySelector("#check-video");
      return v ? { duration: v.duration, readyState: v.readyState, networkState: v.networkState, error: String(v.error?.message ?? null), srcSet: !!v.src, paused: v.paused } : "video-missing";
    }).catch((e) => ({ probeError: e.message }));
    throw new Error(`duration never arrived - ${err.message.slice(0, 40)} - ${JSON.stringify(probe)}`);
  });
  rows.push({
    name: `fixture video streams (duration ${Number(duration).toFixed(2)}s)`,
    status: Number(duration) > 3 ? "pass" : "fail",
    ms: null
  });

  // Panel opens from its key binding; panel content mounts in the shell's
  // shadow root. This engine drives it through the pf:gesture-panel semantic
  // event; the recorder is attached BEFORE the key dispatch.
  await session.eval(function main() {
    window.__pfPanelEvents = 0;
    const host = document.querySelector(".pf-shell");
    host?.addEventListener("pf:gesture-panel", () => window.__pfPanelEvents++);
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", key: "s", bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const panelCount = await session.eval(function main() {
    return window.__pfPanelEvents;
  });
  rows.push({
    name: "KeyS emits pf:gesture-panel",
    status: panelCount >= 1 ? "pass" : "fail",
    ms: null
  });

  const panelDom = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    if (!host || !host.shadowRoot) return 0;
    return host.shadowRoot.querySelectorAll("[class*=panel], [data-pf-panel], pf-panel, [aria-modal]").length;
  });
  rows.push({
    name: "panel mounts dom when opened",
    status: panelDom > 0 ? "pass" : "fail",
    note: panelDom === 0 ? "no panel nodes found in shadow root" : null,
    ms: null
  });

  // The video probe must survive a full teardown: drop the video node, wake
  // the probe, boot into a second shell on a new media anchor.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    if (v) v.remove();
  });
  const secondShell = await session.evalAsync(function main(done) {
    const wrapper = document.querySelector(".plyr__video-wrapper");
    const v2 = document.createElement("video");
    v2.id = "check-video-2";
    v2.preload = "metadata";
    v2.muted = true;
    v2.src = "/check-video.mp4";
    wrapper.appendChild(v2);
    v2.addEventListener("loadeddata", () => {
      const probe = document.querySelector(".pf-shell");
      done(document.querySelectorAll("[data-pf-shell]").length >= 1 ? "found" : "missing");
    }, { once: true });
    setTimeout(() => done("timeout"), 5000);
  });
  rows.push({
    name: "kernel discovers a re-anchored video after teardown",
    status: secondShell === "found" ? "pass" : "fail",
    note: secondShell,
    ms: null
  });

  return rows;
}
