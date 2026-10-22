/**
 * Boot behaves like the manager would: on a fixture page with a Plyr-anchored
 * video the kernel discovers the candidate and mounts the shell; on a page
 * with nothing to host it stays off (`window.PlayerForge` never defined) but
 * the GM menu commands still exist - that split is the whole point of the
 * entry's install-time contract.
 */
export async function run({ session, baseUrl, bundle, boot }) {
  const rows = [];
  await boot();
  const shellHost = await session.waitFor(
    `return !!document.querySelector(".pf-shell");`,
    5000
  );
  rows.push({ name: "shell attaches to fixture video", status: shellHost ? "pass" : "fail", ms: null });

  const version = await session.eval(function main() {
    return window.PlayerForge?.version ?? null;
  });
  rows.push({
    name: "PlayerForge.version exposed",
    status: typeof version === "string" && version.length > 0 ? "pass" : "fail",
    note: version === null ? "window.PlayerForge undefined" : null,
    ms: null
  });

  const shadowChildren = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    if (!host) return -1;
    if (!host.shadowRoot) return 0;
    return host.shadowRoot.childElementCount;
  });
  rows.push({
    name: "hud layer mounted in shell shadow root",
    status: shadowChildren > 0 ? "pass" : "fail",
    note: shadowChildren === 0 ? "shadow root empty" : null,
    ms: null
  });

  const menuTitles = await session.eval(function main() {
    return Object.keys(window.__pfMenu ?? {}).filter((k) => k.startsWith("menu:"));
  });
  rows.push({
    name: "GM menu commands installed at top frame",
    status: menuTitles.length >= 1 ? "pass" : "fail",
    note: `${menuTitles.length} commands`,
    ms: null
  });

  await session.navigate(`${baseUrl}/check/blank`);
  await session.injectGMRealm();
  await session.injectBundle(bundle);
  await session.wakeVideos();
  await new Promise((r) => setTimeout(r, 400));
  const unbooted = await session.eval(function main() {
    return window.PlayerForge === undefined;
  });
  rows.push({
    name: "page without a player stays unbooted",
    status: unbooted ? "pass" : "fail",
    ms: null
  });

  return rows;
}
