import { sleep } from "../../lib/driver.mjs";
/**
 * The storage data plane end to end: the kernel must (a) write the configs
 * doc and the resume tracker through the GM backing, (b) a reboot seeded
 * with prior-session storage must surface exactly that state through the
 * store again - the whole reason pf:configs/pf:resume live in manager
 * space, (c) a foreign doc that omits a known entry adopts the removal
 * (cross-tab delete convergence), and (d) an explicit boundary ("Start
 * over") persists regardless of the drift-epsilon gate.
 */
export async function run({ session, boot }) {
  const rows = [];
  await boot();

  const backingKeys = () => session.eval(function main() {
    return Object.keys(window.__pfBacking ?? {});
  });

  // The kernel settles through boot re-anchoring after the shell attaches
  // (the ceremony's late seeks get reset beneath the tracker's init chain),
  // so the position drive starts only after both the duration and the
  // settle window. The sweep starts past RESUME_MIN_POSITION (5s,
  // src/shared/core.js) because restore only applies what survives it.
  await session.waitFor(
    `return (() => { const v = document.querySelector("#check-video"); return v && v.duration > 3 ? v.duration : false; })()`,
    5000
  );
  await sleep(900);
  await session.eval(function main() {
    const v = document.querySelector("#check-video");
    v.currentTime = 6;
    v.play().catch(() => {});
  });
  await sleep(2200);
  const resume = await session.eval(function main() {
    return window.__pfBacking["pf:resume"] ?? null;
  });
  rows.push({
    name: "playback writes resume state (pf:resume)",
    status: resume !== null && typeof resume === "object" ? "pass" : "fail",
    note: resume === null ? "pf:resume absent from GM backing" : `${Object.keys(resume).length} entries`,
    ms: null
  });

  const configs = await session.eval(function main() {
    return window.__pfBacking["pf:configs"] ?? null;
  });
  rows.push({
    name: "configs doc reaches the GM backing (pf:configs)",
    status: configs !== null ? "pass" : "fail",
    note: configs === null ? "pf:configs absent from GM backing" : null,
    ms: null
  });

  // The sync nudge persists into the per-entry grain: one gesture nudge lands
  // in the tracker's entry (subOffset, 0.25s step; persist debounce <= 150ms)
  // instead of only touching the global fallback key - the grain a reboot
  // reloads.
  const nudge = await session.evalAsync(function main(done) {
    const host = document.querySelector(".pf-shell");
    if (!host) { done({ ok: false, why: "no shell to host the gesture" }); return; }
    host.dispatchEvent(new CustomEvent("pf:gesture-sub-sync", {
      detail: { direction: "right", method: "pointer" }
    }));
    setTimeout(() => {
      const entries = window.__pfBacking["pf:resume"]?.entries ?? [];
      const entry = entries.find((e) => typeof e.subOffset === "number" && e.subOffset !== 0);
      done({ ok: !!entry, why: entry ? `${entry.id} subOffset=${entry.subOffset}` : `entries=${entries.length} none carried subOffset` });
    }, 600);
  });
  rows.push({
    name: "subtitle sync nudge lands in the resume entry grain",
    status: nudge.ok === true && nudge.why.endsWith("subOffset=0.25") ? "pass" : "fail",
    note: nudge.why ?? null,
    ms: null
  });

  // Reboot the page seeded with everything session one wrote; the store must
  // hand the same state back out and the resume tracker must apply it.
  const priorState = await session.eval(function main() {
    return { ...window.__pfBacking };
  });
  await boot({ seed: priorState });
  const restoredKeys = await backingKeys();
  const missing = Object.keys(priorState).filter((k) => !restoredKeys.includes(k));
  rows.push({
    name: "storage seeds the reboot realm end to end",
    status: missing.length === 0 ? "pass" : "fail",
    note: missing.length === 0 ? `${restoredKeys.length} keys round-tripped` : `missing: ${missing.join(", ").slice(0, 80)}`,
    ms: null
  });

  const seek = await session
    .waitFor(
      `return (() => { const v = document.querySelector("#check-video"); return v && v.readyState >= 1 && v.currentTime > 0.2 ? v.currentTime : false; })()`,
      6000
    )
    .then((at) => Number(at).toFixed(2), () => null);
  rows.push({
    name: "resume restores the saved position after reboot",
    status: seek !== null ? "pass" : "fail",
    note: seek === null ? "no restored seek within 6s" : `currentTime=${seek}`,
    ms: null
  });

  // The explicit boundary: the restored boot's action toast carries "Start
  // over". Paused at the saved position, clicking it must write the reset
  // through the store - a plain seek-to-0 leaves the entry's last resume
  // intact because the flushed seek lands inside the save epsilon (and the
  // next boot would resume the position the user just discarded).
  const startOver = await session.evalAsync(function main(done) {
    const video = document.querySelector("#check-video");
    video.pause();
    // The HUD (toasts included) lives inside the shell host's open shadow
    // root - the light DOM carries only the host (.pf-shell), so the toast
    // probe must cross the boundary explicitly.
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
          const entries = window.__pfBacking["pf:resume"]?.entries ?? [];
          done({ ok: entries[0]?.resume === 0, why: `resume=${entries[0]?.resume}` });
        }, 400);
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
  rows.push({
    name: "Start over writes the reset past the drift-epsilon gate",
    status: startOver.ok === true ? "pass" : "fail",
    note: startOver.why ?? null,
    ms: null
  });

  // Cross-tab removal convergence: a foreign doc (another tab's whole-store
  // write) that omits one of OUR entries is a deletion made elsewhere - the
  // catalog LWW merge must adopt it, not resurrect the entry on this tab's
  // next checkpoint write. The forged doc stamps a timestamp newer than the
  // entry's last revision, so the doc-side LWW guard attests to the absence.
  const removal = await session.evalAsync(function main(done) {
    const doc = window.__pfBacking["pf:resume"];
    const entry = (doc?.entries ?? [])[0];
    if (!entry) { done({ ok: false, why: "no entry to remove" }); return; }
    window.__gmTest.remoteWrite("pf:resume", {
      version: 1,
      entries: [],
      updatedAt: Math.max(doc.updatedAt || 0, entry.updatedAt || 0) + 5000
    });
    // Provoke this tab's own write path (a pause flush) after the echo: the
    // stale entry must not be rewritten back onto the disk.
    const video = document.querySelector("#check-video");
    video.play().catch(() => {});
    setTimeout(() => {
      video.pause();
      setTimeout(() => {
        const after = window.__pfBacking["pf:resume"];
        const resurrected = (after?.entries ?? []).length > 0;
        done({
          ok: (after?.entries ?? []).length === 0,
          why: resurrected
            ? `resurrected: ${JSON.stringify(after.entries[0]).slice(0, 80)}`
            : "removal adopted, no write-back"
        });
      }, 500);
    }, 250);
  });
  rows.push({
    name: "foreign doc omission adopts the removal (delete convergence)",
    status: removal.ok === true ? "pass" : "fail",
    note: removal.why ?? null,
    ms: null
  });

  return rows;
}
