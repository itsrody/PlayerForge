import { sleep } from "../../lib/driver.mjs";
/**
 * The command channel + the panel surface: the browserAction popup drives
 * tab-scoped commands (the companion addon replays the popup's exact one-call
 * round trip), the one-shot reset commands dispatch their gesture events on
 * the live shell host, and the panel adoptions (trim, zoom, directional
 * motion) ride the same real panel opens.
 *
 * Storage hygiene: storage persists across a session's cases (one installed
 * extension), so every write this case makes is read back and reverted -
 * the filter-reset row restores the color filter to defaults and the zoom row
 * ends with ui.panelScale back at 1 - leaving the later cases at defaults.
 * The debug SETTING is untouched throughout: the diagnostic rows ride the
 * per-load #pf-debug hash, which never writes storage.
 */
export async function run({ session, boot, baseUrl }) {
  const rows = [];
  const row = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note, ms: null });

  // ---- The channel census: the receiver answers from script eval, before
  // any shell boots, with typed replies (the shape the popup's row relabels
  // ride). debug-query reads storage (false on a stock profile); the one-shot
  // resets answer whether the gesture reached a live shell host.
  const queryOff = await session.triggerCommand("/check", "debug-query");
  row("debug-query answers the stored debug state (false on stock storage)",
    queryOff === false, `reply=${JSON.stringify(queryOff)}`);
  // (live-shell commands: the reset gestures answer "did the gesture reach
  // a live shell host", so the trigger rides the waitShell shape - the
  // popup's own use with the player already live - instead of the
  // fresh-navigation race that answers the stock no-shell false.)
  const filterReply = await session.triggerCommand("/check", "filter-reset", null, { waitShell: true });
  const syncReply = await session.triggerCommand("/check", "sync-reset", null, { waitShell: true });
  row("one-shot resets dispatch through the live shell host (true both)",
    filterReply === true && syncReply === true,
    `filter=${JSON.stringify(filterReply)} sync=${JSON.stringify(syncReply)}`);

  // ---- Color filter reset through a REAL non-default state: the panel's
  // Color tab preset select (Sepia) drives FilterSession directly, the
  // trailing persist lands on the store (poll the storage doc, never assume
  // timing), a fresh page proves the boot re-applies the stored preset, and
  // the filter-reset command alone restores defaults.
  await boot({ pagePath: "/check#pf-debug" });
  await session.eval(function main() {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
  });
  await session.waitFor(
    "return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel-tab[data-title=\"Color\"]');",
    6000
  ).then(() => true, () => false);
  await sleep(600);
  const seeded = await session.evalAsync(function main(done) {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const tab = shadow?.querySelector('.pf-panel-tab[data-title="Color"]');
    const section = tab && shadow.getElementById(tab.getAttribute("aria-controls"));
    const select = section?.querySelector("select");
    if (!select) { done({ ok: false, why: "no preset select in the Color section" }); return; }
    select.value = "Sepia";
    select.dispatchEvent(new Event("change", { bubbles: false }));
    const deadline = Date.now() + 4000;
    const tick = () => {
      const dump = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}");
      const f = dump.configs?.filter;
      if (f && f.sepia === 80) {
        done({
          ok: true,
          inline: document.querySelector("video")?.style.filter ?? "",
          why: null
        });
        return;
      }
      if (Date.now() > deadline) {
        done({ ok: false, why: `filter=${JSON.stringify(f)} inline=${document.querySelector("video")?.style?.filter}` });
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 200);
  });
  row("Color-tab preset drives a real non-default filter and persists it",
    seeded.ok === true && String(seeded.inline).includes("sepia(80%)"),
    seeded.why ?? null);

  // Fresh page: the boot must re-apply the stored preset from the store.
  // The computed form serializes sepia(0.8) on this floor (fixed-percentage
  // serialization), while the seeded row's inline style kept the authored
  // "80%" - both assertions stay in their own serialization space.
  await session.navigate(`${baseUrl}/check?boot=${Date.now()}`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  await sleep(500);
  const applied = await session.eval(function main() {
    return getComputedStyle(document.querySelector("#check-video")).filter;
  });
  row("reboot re-applies the stored preset from storage",
    applied.includes("sepia(0.8)"), `computed filter=${applied}`);

  // The reset rides the live-shell shape too (the fresh-navigation race
  // answers the stock no-shell false before the boot lands a shell); the
  // post-navigation read needs the debug handle, so the hash joins. The
  // reset's trailing persist lands a few hundred ms after the reply (probed:
  // the write is the debounced trailing write, the in-memory reset answers
  // first), so the settle is read off the storage doc here - same poll rule
  // the seeded row rides - before the fresh navigation proves the boot
  // applies the cleared doc. The trigger's own navigation carries the
  // #pf-debug tag (always), so the handle answers on this same page.
  const resetReply = await session.triggerCommand("/check", "filter-reset", null, { waitShell: true });
  try {
    await session.waitFor(function check() {
      const dump = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}");
      return dump.configs?.filter && dump.configs.filter.sepia !== 80 ? true : false;
    }, 6000);
  } catch { /* caught - the row below reads what actually settled */ }
  await session.navigate(`${baseUrl}/check?boot=${Date.now()}#pf-debug`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  await sleep(500);
  const cleared = await session.eval(function main() {
    return {
      computed: getComputedStyle(document.querySelector("#check-video")).filter,
      dump: window.PlayerForge?.storageDump?.() ?? null
    };
  });
  const clearedDoc = cleared.dump ? JSON.parse(cleared.dump) : null;
  row("filter-reset command restores the defaults without the panel",
    resetReply === true
      && !cleared.computed.includes("sepia")
      && clearedDoc?.configs?.filter?.sepia !== 80,
    `reply=${JSON.stringify(resetReply)} computed=${cleared.computed} stored=${JSON.stringify(clearedDoc?.configs?.filter)}`);

  // ---- The panel adoptions (trim + zoom + directional motion). One page
  // carries the whole block: the trim row reads a label under the opened
  // panel, the zoom row drives the REAL settings slider and re-opens the
  // panel (the scale reads per-open - that IS the product's mechanism), and
  // the typed-flip row starts from the closed precondition.
  await boot({ pagePath: "/check#pf-debug" });
  await session.eval(function main() {
    document.querySelector(".pf-shell")?.dispatchEvent(
      new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
  });
  await session.waitFor("return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel.pf-open');", 4000)
    .then(() => true, () => false);
  const trim = await session.eval(function main() {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const panel = shadow?.querySelector(".pf-panel");
    if (!panel?.classList.contains("pf-open")) { return { ok: false, why: "panel not open" }; }
    const label = [...panel.querySelectorAll(".pf-panel-label")][0];
    if (!label) { return { ok: false, why: "no section label rendered" }; }
    const cs = getComputedStyle(label);
    const h = label.getBoundingClientRect().height;
    const fs = parseFloat(cs.fontSize);
    // The trimmed line box hugs the cap/baseline extents: h/fs lands ~0.69
    // authored (0.62..0.90 across the zoom factors), while an untrimmed
    // label reads the 1.4 line-height (1.26..1.82 zoomed) and can never
    // enter the band. The computed serializations pin the declarations.
    return {
      ok: cs.getPropertyValue("text-box-trim") === "trim-both"
        && cs.getPropertyValue("text-box-edge") === "cap alphabetic"
        && h / fs > 0.55 && h / fs < 0.95,
      why: null, trim: cs.getPropertyValue("text-box-trim"),
      edge: cs.getPropertyValue("text-box-edge"), h, fs
    };
  });
  row("section labels carry text-box-trim (computed pin, trimmed height pinned)",
    trim.ok === true, JSON.stringify(trim));

  // The zoom-based panel scale, driven through the REAL settings widget: the
  // schema renders the options row as a range input labeled "Panel Scale"
  // (the label fix THAT row rides), input at index 2 (1.15) writes the
  // setting, and the panel's per-open zoom read makes a close+reopen the
  // honest effect witness. Geometry pin: the seeded box measures 1.15x
  // against zoom 1 with the inline write itself as the switch. Reading rules
  // the probe pinned: computed zoom reads the factor, computed radii/fonts
  // read the unzoomed authored px, and the R9 ink bytes stay unchanged.
  const sliderOut = await session.evalAsync(function main(done) {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const slider = shadow?.querySelector("input.pf-slider[aria-label=\"Panel Scale\"]");
    if (!slider) { done({ ok: false, why: "no Panel Scale slider (the label fix renders it)" }); return; }
    slider.value = "2";
    slider.dispatchEvent(new Event("input", { bubbles: false }));
    const deadline = Date.now() + 4000;
    const tick = () => {
      const dump = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}");
      if (dump.configs?.settings?.ui?.panelScale === 1.15) {
        done({ ok: true, why: null });
        return;
      }
      if (Date.now() > deadline) {
        done({ ok: false, why: `panelScale=${dump.configs?.settings?.ui?.panelScale}` });
        return;
      }
      setTimeout(tick, 100);
    };
    setTimeout(tick, 150);
  });
  // Reopen: the per-open zoom read applies the fresh setting to the root.
  // The close+reopen is SEQUENCED on this floor (probed): two toggles in one
  // task land only the close - the second toggle arrives mid-close-flip and
  // is never processed, so the reopen never runs. Close, observe closed,
  // then open - the per-open zoom write happens on the real reopen either
  // way.
  await session.eval(function main() {
    document.querySelector(".pf-shell")?.dispatchEvent(
      new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
  });
  await session.waitFor("return !document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel.pf-open');", 4000);
  await session.eval(function main() {
    document.querySelector(".pf-shell")?.dispatchEvent(
      new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
  });
  await session.waitFor("return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel.pf-open');", 4000)
    .then(() => true, () => false);
  const zoom = await session.eval(function main() {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const panel = shadow?.querySelector(".pf-panel");
    if (!panel?.classList.contains("pf-open")) { return { ok: false, why: "panel not open on read" }; }
    // The inline write is the product's own mechanism - read it back before
    // any toggle, and capture every computed reading against that live state
    // (getComputedStyle is a live view: after the toggles below it reflects
    // the cleared state).
    const seededInline = panel.style.zoom;
    const cs = getComputedStyle(panel);
    const seededZoom = cs.zoom;
    const csInk = cs.backgroundColor;
    const seededW = panel.getBoundingClientRect().width;
    panel.style.zoom = "1";
    const baseW = panel.getBoundingClientRect().width;
    panel.style.zoom = seededInline;
    const restoredZoom = getComputedStyle(panel).zoom;
    return {
      ok: seededInline === "1.15"
        && seededZoom === "1.15"
        && Math.abs(seededW / baseW - 1.15) <= 0.02
        && restoredZoom === "1.15"
        && csInk === "rgb(14, 14, 16)",
      why: null, seededInline, seededZoom, restoredZoom,
      seededW, baseW, ink: csInk
    };
  });
  row("panel scale rides zoom through the real settings widget (computed pin: factor, 1.15x box ratio, ink unchanged)",
    sliderOut.ok === true && zoom.ok === true,
    sliderOut.why ?? zoom.why ?? null);

  // Restore the closed precondition AND the stored default, in that order
  // (the settings edit rides the open panel; the typed row below opens its own).
  await session.eval(function main() {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const slider = shadow?.querySelector("input.pf-slider[aria-label=\"Panel Scale\"]");
    slider.value = "1";
    slider.dispatchEvent(new Event("input", { bubbles: false }));
    document.querySelector(".pf-shell")?.dispatchEvent(
      new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
  });
  await sleep(300);

  // The directional panel motion: the flips carry their direction as a
  // view-transition type, the HUD sheet's :active-view-transition-type()
  // rules read them, and the R9 ink stays unchanged (motion-lane only).
  // The spy is the debug handle's own arm, not a page-realm patch (probed:
  // a harness-side document.startViewTransition patch is invisible across
  // the Xray - the panel calls the content-script realm's own surface, and
  // the wrapper recording each flip's types must live in that realm, which
  // only the debug handle can marshal). Clear-arm then open+close gives the
  // row exactly its two flips even after the trim/zoom rows rode the same
  // wrapper.
  await session.eval(function main() {
    window.PlayerForge?.vtFlipsDump?.("clear");
  });
  const typed = await session.evalAsync(async function main(done) {
    const host = document.querySelector(".pf-shell");
    const panelEl = () => host?.shadowRoot?.querySelector(".pf-panel");
    const inkOf = () => {
      const p = panelEl();
      if (!p) return null;
      const cs = getComputedStyle(p);
      return `${cs.backgroundColor}|${cs.borderTopColor}`;
    };
    const until = async (cond, budgetMs) => {
      const start = performance.now();
      while (!(await cond()) && performance.now() - start < budgetMs) {
        await new Promise((r) => setTimeout(r, 60));
      }
      return cond();
    };
    const isOpen = () => !!panelEl()?.classList.contains("pf-open");
    host.dispatchEvent(new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
    let opened = await until(isOpen, 2000);
    if (!opened) {
      host.dispatchEvent(new CustomEvent("pf:gesture-panel", { detail: { method: "keyboard" } }));
      opened = await until(isOpen, 2000);
    }
    if (!opened) {
      done({ ok: false, why: "panel never opened via the gesture event", flips: "read vain" });
      return;
    }
    const inkBefore = inkOf();
    const closeBtn = panelEl()?.querySelector(".pf-panel-close");
    if (!closeBtn) { done({ ok: false, why: "no close button", flips: "read vain" }); return; }
    closeBtn.click();
    const closed = await until(() => !panelEl()?.classList.contains("pf-open"), 2000);
    const inkAfter = inkOf();
    const flipsOut = String(window.PlayerForge?.vtFlipsDump?.() ?? "[]");
    const sheetText = [...document.styleSheets, ...document.adoptedStyleSheets ?? []]
      .map((sheet) => { try { return [...sheet.cssRules].map((r) => r.cssText).join("\n"); } catch { return ""; } })
      .join("\n");
    let flips = [];
    try { flips = JSON.parse(flipsOut); } catch {}
    done({
      ok: flips[0] === "pf-panel-open" && flips[1] === "pf-panel-close"
        && sheetText.includes(":active-view-transition-type(pf-panel-open)")
        && sheetText.includes(":active-view-transition-type(pf-panel-close)")
        && opened && closed && inkBefore === inkAfter,
      flips: flipsOut, opened, closed, inkBefore, inkAfter
    });
  });
  row("panel flips carry directional view-transition types and the sheet reads them (ink unchanged)",
    typed.ok === true, typed.ok !== true ? (typed.why ?? JSON.stringify(typed)) : null);

  // ---- Session hygiene: the settings doc must be back at defaults for the
  // cases after this one (storage persists across the session's cases).
  const hygiene = await session.eval(function main() {
    const dump = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}");
    return { scale: dump.configs?.settings?.ui?.panelScale, debug: dump.configs?.debug };
  });
  row("settings left at defaults for the session's later cases",
    hygiene.scale === 1 && hygiene.debug?.logs !== true,
    JSON.stringify(hygiene));

  return rows;
}
