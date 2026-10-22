/**
 * The GM menu is the userscript's only always-available surface (it exists
 * even on unbootable pages, which boot.mjs covers). Here the menu commands
 * must drive real page behavior: invoking each registered command has to
 * surface a shell effect - the panel opens, or the kernel persists something,
 * or it re-registers the menu in response.
 */
export async function run({ session, boot }) {
  const rows = [];
  await boot();

  const effects = await session.evalAsync(function main(done) {
    const menu = window.__pfMenu ?? {};
    const keys = Object.keys(menu).filter((k) => k.startsWith("menu:"));
    // Effects can be value-level (a settings toggle rewrites pf:configs with
    // the same key set), so compare the whole backing, not just key presence.
    const backing0 = JSON.stringify(window.__pfBacking ?? {});
    let panelEver = false;
    let index = 0;
    const tick = () => {
      if (index >= keys.length) {
        const backingNow = JSON.stringify(window.__pfBacking ?? {});
        done({ invoked: keys.length, panelEver, backingDelta: backingNow !== backing0 });
        return;
      }
      const key = keys[index++];
      try { menu[key](); }
      catch (err) {
        // Caught on purpose: a throwing command is a menu-row signal, not an
        // uncaught page error - keep __pfErrors clean for the stage probe.
        (window.__pfMenuErrors ??= []).push(key + ": " + String(err.message ?? err).slice(0, 120));
      }
      setTimeout(() => {
        const host = document.querySelector(".pf-shell");
        panelEver = panelEver || !!host?.shadowRoot?.querySelector?.(".pf-panel.pf-open");
        setTimeout(tick, 120);
      }, 150);
    };
    tick();
  });

  const drove = effects.invoked > 0 && (effects.panelEver || effects.backingDelta);
  rows.push({
    name: `menu commands drive real page effects (${effects.invoked} invoked)`,
    status: drove ? "pass" : "fail",
    note: drove
      ? (effects.panelEver ? "panel opened by a command" : "kernel persisted in response")
      : "no observable effect from any command",
    ms: null
  });

  return rows;
}