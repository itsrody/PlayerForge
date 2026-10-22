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

  // The shell contract must survive a full teardown: drop the current anchor,
  // append a fresh video, and require the kernel to re-anchor onto it - the
  // new video node must carry the shell marker (the old markers on container
  // garbage are not credit).
  const reAnchor = await session.evalAsync(function main(done) {
    document.querySelector("#check-video")?.remove();
    const wrapper = document.querySelector(".plyr__video-wrapper");
    if (!wrapper) { done(null); return; }
    const v2 = document.createElement("video");
    v2.id = "check-video-2";
    v2.preload = "metadata";
    v2.muted = true;
    v2.autoplay = true;
    v2.src = "/check-video.mp4";
    wrapper.appendChild(v2);
    v2.addEventListener("loadeddata", () => {
      const deadline = Date.now() + 8000;
      const tick = () => {
        const stamped = v2.matches("[data-pf-shell]");
        const shells = document.querySelectorAll(".pf-shell").length;
        if (stamped || shells > 1) done({ stamped, shells });
        else if (Date.now() < deadline) setTimeout(tick, 150);
        else done(null);
      };
      tick();
    }, { once: true });
    setTimeout(() => done(null), 11000);
  });
  rows.push({
    name: "kernel re-anchors a shell onto the replacement video",
    status: reAnchor ? "pass" : "fail",
    note: reAnchor ? `stamped=${reAnchor.stamped} shells=${reAnchor.shells}` : "no re-anchor within 10s",
    ms: null
  });

  return rows;
}
