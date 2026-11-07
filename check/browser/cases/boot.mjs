import { sleep } from "../../lib/driver.mjs";
/**
 * Boot behaves like the extension would: on a fixture page with a
 * Plyr-anchored video the kernel discovers the candidate and mounts the
 * shell; on a page with nothing to host it stays inert (no shell, no HUD -
 * the pfVersion debug rail is what a debug-hash page can witness instead)
 * and the browserAction command receiver still exists from script eval -
 * that split is the whole point of the entry's install-time contract.
 *
 * The version mirror rides dataset.pfVersion (debug mode only): the window
 * sentinel cannot cross the content Xray to the driver realm, and the
 * manifest IS the version source under this architecture.
 */
export async function run({ session, boot, baseUrl }) {
  const rows = [];
  await boot({ pagePath: "/check#pf-debug" });
  const shellHost = await session.waitFor(
    `return !!document.querySelector(".pf-shell");`,
    5000
  );
  rows.push({ name: "shell attaches to fixture video", status: shellHost ? "pass" : "fail", ms: null });

  const bits = await session.eval(function main() {
    return {
      version: document.documentElement.dataset.pfVersion ?? null,
      hud: (() => {
        const host = document.querySelector(".pf-shell");
        return host?.shadowRoot ? host.shadowRoot.childElementCount : -1;
      })()
    };
  });
  rows.push({
    name: "manifest version mirrors to the debug rail",
    status: typeof bits.version === "string" && bits.version.length > 0 ? "pass" : "fail",
    note: bits.version === null ? "dataset.pfVersion missing (debug mode not armed)" : `v${bits.version}`,
    ms: null
  });
  rows.push({
    name: "hud layer mounted in shell shadow root",
    status: bits.hud > 0 ? "pass" : "fail",
    note: bits.hud === 0 ? "shadow root empty" : null,
    ms: null
  });

  // Debug-plane storage read, on the BOOTED page (the handle installs at
  // script eval, kernel-bound arms resolving through the menu reference):
  // the storageDump answer must carry the state plane's configs root.
  const storageOk = await session.eval(function main() {
    const raw = window.PlayerForge?.storageDump?.() ?? null;
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed !== null
      && typeof parsed === "object"
      && parsed.configs !== null
      && typeof parsed.configs === "object";
  });
  rows.push({
    name: "debug storage read answers the state plane",
    status: storageOk === true ? "pass" : "fail",
    note: "window.PlayerForge.storageDump() (debug mode only) - reads pull the store's state plane",
    ms: null
  });

  // Video-less page: no shell and no version rail - the KERNEL boots only on
  // a real candidate (or a network hint); a nothing page never boots. The
  // command door is the eval-scoped surface by design (it must exist BEFORE
  // any video discovery - a video-less embed host top answers the popup):
  // window.PlayerForge installs at script eval, and on this page the
  // kernel-bound dump answers its honest no-kernel record (realm top, shell
  // null, videos 0) - the empty shape IS the diagnosis. The channel census
  // (commands.mjs triggerCommand) proves the same door answers a command
  // end to end.
  await session.navigate(`${baseUrl}/check/blank?boot=${Date.now()}#pf-debug`);
  await session.waitFor("return document.readyState === 'complete';", 5000);
  await sleep(700);
  const unbooted = await session.eval(function main() {
    let diag = null;
    try { diag = JSON.parse(window.PlayerForge?.dumpFrameState?.() ?? "null"); } catch {}
    return {
      shells: document.querySelectorAll(".pf-shell").length,
      version: document.documentElement.dataset.pfVersion ?? null,
      diagRealm: diag?.realm ?? null,
      diagShell: diag?.shell ?? null,
      diagVideos: Array.isArray(diag?.videos) ? diag.videos.length : null
    };
  });
  rows.push({
    name: "page without a player stays unbooted",
    status: unbooted.shells === 0 && unbooted.version === null
      && unbooted.diagRealm === "top" && unbooted.diagShell === null
      && unbooted.diagVideos === 0 ? "pass" : "fail",
    note: JSON.stringify(unbooted)
      + " (no shell, no version stamp - boot is candidate-gated; the eval-scoped command door answers its kernel-less diagnosis)",
    ms: null
  });

  return rows;
}
