import { sleep } from "../../lib/driver.mjs";
/**
 * The storage data plane end to end, on the extension's own surfaces:
 * (a) real playback persists a tracker entry through browser.storage, (b) a
 * reboot restores that position - proven by a REAL navigation replay, not a
 * seed (storage IS the product's persistent plane, so prior state carries
 * exactly like the user's browser state), (c) an explicit boundary
 * ("Start over") persists the reset past the drift-epsilon gate, (d) the
 * DomPool reuse contract at the History cards: a cross-tab structural merge
 * (a REAL second tab's playback adding its entry) re-renders the open list
 * keeping the live card's NODE, and a removal from the other tab's panel
 * (a real foreign write) reconciles back down releasing the excess, and
 * (e) cross-tab delete convergence: a foreign removal of OUR entry is
 * adopted, and this tab's next flush must not resurrect it.
 *
 * Reads ride the debug storageDump sentinel; the case runs on /check with
 * the debug hash. The second tab is a REAL tab (driver new window), whose
 * writes flow back as genuine storage broadcasts.
 */
export async function run({ session, boot, baseUrl }) {
  const rows = [];
  const row = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note, ms: null });

  await boot({ pagePath: "/check#pf-debug" });

  // (a) Real playback above the resume floor leaves a persisted entry: the
  // pause is the flush edge (a save edge any user action produces) - assert
  // the STORE carries it, not video memory.
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.currentTime = 6.2;
    v.play().catch(() => {});
  });
  await sleep(1100);
  await session.eval(function main() {
    document.querySelector("#check-video")?.pause();
  });
  const saved = await session.waitFor(function check() {
    try {
      const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
      const entry = entries.find((e) => e && e.path === "/check");
      return entry && entry.resume >= 5 ? entry : false;
    } catch { return false; }
  }, 5000).then((v) => v, () => null);
  row("real playback persists the tracker entry (pause flush, above the 5s floor)",
    !!saved, saved ? `resume=${saved.resume}` : "entry never reached the store with a restored position");

  // (b) The reboot restore: a real navigation replay replays the stored
  // position after metadata. The debug hash rides along (per-load debug
  // mode, never a storage write) so the case's storage reads - which arm
  // the debug sentinel - work on the replayed document too.
  await session.navigate(`${baseUrl}/check?boot=${Date.now()}#pf-debug`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  const seek = await session.waitFor(function check() {
    const v = document.querySelector("#check-video");
    return v && v.readyState >= 1 && v.currentTime > 4 && v.currentTime < 11 ? v.currentTime : false;
  }, 6000).then((at) => Number(at).toFixed(2), () => null);
  row("resume restores the saved position after a real navigation replay",
    seek !== null, seek === null ? "no restored seek within 6s" : `currentTime=${seek}`);

  // (c) The explicit boundary: the restored boot's action toast carries
  // "Start over". Paused at the saved position, clicking it must write the
  // reset through the store (a plain seek-to-0 would sit inside the save
  // epsilon and be reverted by the next flush).
  await session.eval(function main() {
    document.querySelector("#check-video")?.pause();
  });
  const startOver = await session.evalAsync(function main(done) {
    const probe = () => document.querySelector(".pf-shell")?.shadowRoot?.querySelector(
      'pf-toast .pf-toast-actions button[title="Start over"]');
    let polled = 0;
    const poll = setInterval(() => {
      polled++;
      const button = probe();
      if (button) {
        clearInterval(poll);
        button.click();
        setTimeout(() => {
          try {
            const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
            const entry = entries.find((e) => e && e.path === "/check");
            done({ ok: entry?.resume === 0, why: `resume=${entry?.resume}` });
          } catch (err) {
            done({ ok: false, why: `read failed: ${String(err.message ?? err).slice(0, 80)}` });
          }
        }, 500);
        return;
      }
      if (polled > 24) {
        clearInterval(poll);
        const shadow = document.querySelector(".pf-shell")?.shadowRoot ?? null;
        const toast = shadow?.querySelector("pf-toast") ?? null;
        done({
          ok: false,
          why: `no button; shadow=${shadow ? "yes" : "none"} toast=${toast ? "yes" : "none"} class=${toast?.className}`
            + ` buttons=${(toast?.querySelectorAll(".pf-toast-actions button") ?? []).length}`
            + ` titles=${[...(toast?.querySelectorAll("button") ?? [])].map((b) => b.title).join("|")}`
        });
      }
    }, 60);
  });
  row("Start over writes the reset past the drift-epsilon gate",
    startOver.ok === true, startOver.why ?? null);

  // (d1) The DomPool reuse contract at the History cards: the witness card is
  // the /check entry's card (the card whose node must survive the merge),
  // located by entry id - the render order varies with updatedAt, so the
  // marker rides that entry, not an index.
  const checkId = saved?.id ?? null;
  const marked = await session.evalAsync(function main(entryId, done) {
    const deadline = Date.now() + 6000;
    const step = () => {
      const shadow = document.querySelector(".pf-shell")?.shadowRoot;
      const historyTab = shadow?.querySelector('.pf-panel-tab[data-title="History"]');
      if (!historyTab) {
        // The panel opens on the shared hotkey (the same KeyS route the
        // subtitles case rides); the History section builds lazily at first
        // activation, so the tab click precedes the card wait.
        document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
      } else {
        const list = shadow.querySelector(".pf-history-list");
        const cards = list ? [...list.querySelectorAll(".pf-history-card")] : [];
        const live = cards.find((c) => c.dataset.entryId === entryId) ?? cards[0];
        if (live) {
          live.__pfPoolWitness = true;
          done({ ok: true, at: live.dataset.entryId, cards: cards.length, why: null });
          return;
        }
      }
      if (Date.now() > deadline) {
        done({ ok: false, why: "witness card never rendered (History list empty)" });
        return;
      }
      setTimeout(step, 80);
    };
    setTimeout(step, 120);
  }, checkId);
  row("open History list renders the persisted entry as a card",
    marked.ok === true, marked.why ?? null);

  // (d2) The grow: a REAL second tab plays its own page; its entry write
  // echoes to this hidden tab, the structural merge re-renders the open list
  // by acquisition, and the live card keeps its NODE (a rebuilt tree would
  // lose the __pfPoolWitness stamp).
  const pageHandle = await session.raw.getWindowHandle();
  await session.raw.switchTo().newWindow("tab");
  await sleep(400);
  const tabHandle = await session.raw.getWindowHandle();
  await session.navigate(`${baseUrl}/sdk/plyr?boot=${Date.now()}#pf-debug`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  await session.eval(function main() {
    const v = document.querySelector("video");
    v.currentTime = 6.5;
    v.play().catch(() => {});
  });
  await sleep(1100);
  await session.eval(function main() {
    document.querySelector("video")?.pause();
  });
  const plyrEntry = await session.waitFor(function check() {
    try {
      const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
      return entries.find((e) => e && e.path === "/sdk/plyr") || false;
    } catch { return false; }
  }, 7000).then((v) => v, () => null);
  const plyrId = plyrEntry?.id ?? null;
  // Back to the open panel before the merge read.
  await session.raw.switchTo().window(pageHandle);
  await sleep(300);
  // The merge read as a string body: executeScript serializes source, so a
  // case-side variable must be inlined (a closure over plyrId never rides).
  const grew = await session.waitFor(`
    const cards = [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []];
    const witness = cards.find((c) => c.__pfPoolWitness === true);
    return witness && cards.some((c) => c.dataset.entryId === ${JSON.stringify(plyrId)});
  `, 7000).then(() => true, (err) => String(err.message).slice(0, 60));
  const cardIds = await session.eval(function main() {
    return [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []].map((c) => c.dataset.entryId);
  });
  row("the second tab's real playback merges into the open list keeping the live node",
    grew === true && cardIds.includes(plyrId) && cardIds.length > 1,
    `grew=${JSON.stringify(grew)} cards=${JSON.stringify(cardIds)} plyrId=${plyrId} (base entry id=${checkId})`);

  // (d3) The scroll-snap adoption pin (rides the open panel): the list
  // carries y-proximity snapping and the cards align to their start edge -
  // computed reads, so a dropped or renamed declaration fails the row
  // rather than shipping inert.
  const snap = await session.eval(function main() {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const list = shadow?.querySelector(".pf-history-list");
    const card = shadow?.querySelector(".pf-history-card");
    if (!list || !card) { return { ok: false, why: "history list or card not present" }; }
    const cs = getComputedStyle(list);
    const cardCs = getComputedStyle(card);
    return {
      ok: (cs.scrollSnapType === "y" || cs.scrollSnapType === "y proximity")
        && cardCs.scrollSnapAlign === "start",
      why: null,
      snapType: cs.scrollSnapType, snapAlign: cardCs.scrollSnapAlign
    };
  });
  row("History list carries y-proximity snap, cards align start (computed pin)",
    snap.ok === true, JSON.stringify(snap) + " (Firefox 159 computes `y proximity` as `y` - the default strictness is elided in the computed form, `y mandatory` would show whole)");

  // (d4) The shrink: a REAL removal written by the other tab's panel button
  // (remove /sdk/plyr from history); this tab's open list reconciles down
  // and the witness card rides its same node again.
  const removedInTabB = await removeEntryInTab(tabHandle, plyrId);
  await session.raw.switchTo().window(pageHandle);
  await sleep(300);
  const shrank = await session.waitFor(`
    const cards = [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []];
    const witness = cards.find((c) => c.__pfPoolWitness === true);
    return witness && !cards.some((c) => c.dataset.entryId === ${JSON.stringify(plyrId ?? "")});
  `, 7000).then(() => true, (err) => String(err.message).slice(0, 60));
  row("the foreign removal reconciles the list releasing the excess member (pool release)",
    removedInTabB === true && shrank === true,
    `removedInTabB=${removedInTabB} shrank=${JSON.stringify(shrank)} (witness card=${marked.ok ? "marked" : "unmarked"})`);

  // (e) Cross-tab delete convergence: the other tab's panel removes OUR
  // /check entry too - a deletion made elsewhere must be adopted here (the
  // LWW doc-side guard attests the absence), and this tab's own subsequent
  // flush (a short low play below the resume floor) must not resurrect it.
  const removedCheck = await removeEntryInTab(tabHandle, checkId);
  await session.raw.switchTo().window(pageHandle);
  await sleep(300);
  const converged = await session.waitFor(`
    const cards = [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []];
    return !cards.some((c) => c.dataset.entryId === ${JSON.stringify(checkId ?? "")});
  `, 7000).then(() => true, (err) => String(err.message).slice(0, 60));
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.currentTime = 0.8;
    v.play().catch(() => {});
  });
  await sleep(1500);
  await session.eval(function main() {
    document.querySelector("#check-video")?.pause();
  });
  await sleep(400);
  const resurrected = await session.eval(function main() {
    try {
      const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
      return entries.some((e) => e && e.path === "/check");
    } catch { return true; }
  });
  const checkCardAfter = await session.eval(`
    return [...document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelectorAll(".pf-history-card") ?? []].some((c) => c.dataset.entryId === ${JSON.stringify(checkId ?? "")});
  `);
  row("foreign doc omission adopts the removal (delete convergence, no write-back)",
    removedCheck === true && converged === true && resurrected === false && checkCardAfter === false,
    `removedCheck=${removedCheck} converged=${JSON.stringify(converged)} resurrected=${resurrected} checkCardAfter=${checkCardAfter}`);

  // Close the helper tab: the later cases must see the single-tab session
  // the standalone install produces.
  await session.raw.switchTo().window(tabHandle);
  await sleep(200);
  await session.raw.close().catch(() => {});
  await session.raw.switchTo().window(pageHandle);

  return rows;

  /** Tab helper: open the OTHER tab's panel, find the card with the given
   *  entry id, click its remove button, and poll ITS store until the entry
   *  leaves. Fails loudly (a fail row) when the click never landed. */
  async function removeEntryInTab(handle, entryId) {
    if (entryId == null) {
      row("tab helper remove click", false, "entry id unavailable (an earlier stage never produced it)");
      return false;
    }
    await session.raw.switchTo().window(handle);
    await sleep(300);
    const clicked = await session.evalAsync(function main(id, done) {
      const deadline = Date.now() + 6000;
      const step = () => {
        const shadow = document.querySelector(".pf-shell")?.shadowRoot;
        const historyTab = shadow?.querySelector('.pf-panel-tab[data-title="History"]');
        if (!historyTab) {
          document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
        } else {
          const card = shadow.querySelector(`.pf-history-card[data-entry-id="${id}"]`);
          const btn = card?.querySelector("[data-action=\"remove\"]");
          if (btn) {
            btn.click();
            done({ ok: true, why: null });
            return;
          }
        }
        if (Date.now() > deadline) {
          done({ ok: false, why: "card/button never rendered in the helper tab" });
          return;
        }
        setTimeout(step, 120);
      };
      setTimeout(step, 120);
    }, entryId);
    if (clicked?.ok !== true) {
      row("tab helper remove click", false, clicked?.why ?? "click never landed");
      return false;
    }
    // Poll in the helper tab's own realm: the removal is ITS write, so the
    // entry leaves this tab's store first.
    const gone = await session.evalAsync(function main(id, done) {
      const deadline = Date.now() + 7000;
      const step = () => {
        try {
          const entries = (JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries) ?? [];
          if (!entries.some((e) => e && e.id === id)) {
            done({ ok: true });
            return;
          }
        } catch {}
        if (Date.now() > deadline) {
          done({ ok: false, why: `entry ${id} still in the helper tab's store after 7s` });
          return;
        }
        setTimeout(step, 120);
      };
      setTimeout(step, 120);
    }, entryId);
    if (gone?.ok !== true) {
      row("tab helper removal landed", false, gone?.why ?? "removal never landed");
      return false;
    }
    return true;
  }
}
