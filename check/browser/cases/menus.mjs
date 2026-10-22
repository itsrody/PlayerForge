/**
 * The GM menu is the userscript's only always-available surface (it exists
 * even on unbootable pages, which boot.mjs covers). Here the menu commands
 * must drive real page behavior: invoking each registered command has to
 * surface a shell effect - the panel opens, or the kernel persists something,
 * or it re-registers the menu in response.
 */
export async function run({ session, boot }) {
  const rows = [];
  // Brightness 150 seeded before the first boot: the reset command below is
  // proven against a non-default stored state, not a no-op write over
  // defaults.
  await boot({ seed: { "pf:configs": { version: 1, filter: { brightness: 150 } } } });

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

  // The targeted reset: a seeded brightness 150 must come back to the Default
  // value through the menu command alone (no panel, no steppers), and the
  // filter must leave the video's inline style. The generic row above already
  // invoked every command once, so this row re-seeds the leaf (the forensics
  // write path a foreign tab would use) before driving the reset.
  const reset = await session.evalAsync(function main(done) {
    const menu = window.__pfMenu ?? {};
    const colorKey = Object.keys(menu)
      .filter((k) => k.startsWith("menu:"))
      .find((k) => k.includes("Color"));
    if (!colorKey) { done({ ok: false, why: "no Color menu key", keys: Object.keys(menu).join("|") }); return; }
    if (!window.__gmTest) { done({ ok: false, why: "no __gmTest write path" }); return; }
    const doc = window.__pfBacking["pf:configs"] ?? { version: 1 };
    doc.filter = { ...(doc.filter ?? {}), brightness: 150 };
    window.__gmTest.remoteWrite("pf:configs", doc);
    setTimeout(() => {
      const before = window.__pfBacking["pf:configs"]?.filter?.brightness ?? null;
      menu[colorKey]();
      setTimeout(() => {
        const afterLeaf = window.__pfBacking["pf:configs"]?.filter?.brightness ?? null;
        const inline = document.querySelector("video")?.style?.filter ?? "";
        done({
          ok: before === 150 && afterLeaf === 100 && !inline.includes("1.5"),
          why: `brightness ${before}->${afterLeaf}, inline="${inline.slice(0, 60)}"`
        });
      }, 500);
    }, 400);
  });
  rows.push({
    name: "menu reset restores the seeded color filter",
    status: reset.ok === true ? "pass" : "fail",
    note: reset.why ?? null,
    ms: null
  });

  return rows;
}