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
export async function run({ session, baseUrl, boot }) {
  const rows = [];
  await boot("#pf-debug");
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

  // Video-less page: no shell, no version rail (not even in debug mode - the
  // kernel never reaches the stamp), and still no boot error.
  await session.navigate(`${baseUrl}/check/blank?boot=${Date.now()}#pf-debug`);
  await session.waitFor("return document.readyState === 'complete';", 5000);
  await sleep(700);
  const unbooted = await session.eval(function main() {
    return {
      shells: document.querySelectorAll(".pf-shell").length,
      version: document.documentElement.dataset.pfVersion ?? null
    };
  });
  rows.push({
    name: "page without a player stays unbooted",
    status: unbooted.shells === 0 && unbooted.version === undefined ? "pass" : "fail",
    note: JSON.stringify(unbooted),
    ms: null
  });

  return rows;
}
