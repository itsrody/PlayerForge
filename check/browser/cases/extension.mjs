import { sleep } from "../../lib/driver.mjs";
/**
 * The extension plane's own behaviors - the things that exist because the
 * product ships as an MV2 extension: the browserAction popup channel's
 * round trip (companion addon), the debug state plane persisting back and
 * forth across real navigations, the diagnostics echo delivering the frame
 * state to every realm (top direct, frames through the storage echo), the
 * cross-frame debug-arm flip (a top-frame command toggling a RUNNING embed
 * realm mid-flight - the reach the settings bus rides), and the background
 * text relay ingesting a cross-origin subtitle URL into a running track.
 *
 * Cross-case hygiene: the debug toggle is the one setting this case writes -
 * it is toggled back off before the relay rows, leaving storage clean.
 */
export async function run({ session, boot, baseUrl, crossBaseUrl }) {
  const rows = [];
  const row = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note, ms: null });

  // ---- Debug toggle persistence: the toggle writes the setting and answers
  // its fresh state; a REAL navigation boots a fresh kernel whose init reads
  // the stored value and arms the pfLog mirror with no hash in the URL. The
  // off leg must unlatch the mirror on a stock install (no pfLog at all).
  const t1 = await session.triggerCommand("/check", "debug-toggle");
  row("debug toggle answers its fresh state (on)", t1 === true, `reply=${JSON.stringify(t1)}`);
  await session.navigate(`${baseUrl}/check?boot=${Date.now()}`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  const armed = await session.waitFor(
    "return (document.documentElement.dataset.pfLog ?? '').length > 0;",
    4000
  ).then(() => true, () => false);
  row("persisted debug arms the pfLog mirror on a plain navigation (no hash)",
    armed === true, armed ? "mirror wrote" : "pfLog never appeared within 4s");
  const t2 = await session.triggerCommand("/check", "debug-toggle");
  const q2 = await session.triggerCommand("/check", "debug-query");
  row("the off leg persists too (toggle false, query false)",
    t2 === false && q2 === false, `toggle=${JSON.stringify(t2)} query=${JSON.stringify(q2)}`);
  await session.navigate(`${baseUrl}/check?boot=${Date.now()}`);
  await session.waitFor("return !!document.querySelector('.pf-shell');", 6000);
  await sleep(400);
  const stock = await session.eval(function main() {
    return { log: document.documentElement.dataset.pfLog ?? null, version: document.documentElement.dataset.pfVersion ?? null };
  });
  row("stock install keeps the mirror unlatched (no hash, no pfLog/pfVersion)",
    stock.log === null && stock.version === null, JSON.stringify(stock));

  // ---- The diagnostics dump, read from the pfLog console twin. The popup's
  // diag click writes the pf:diag key and dumps the originating history
  // directly; the answer line is the parsed record. The rerun rides
  // waitShell: the fresh navigation's own lifecycle lines (kernel/shell
  // creation) land before the diag fires, so the one-line mirror still
  // holds the diag record when the row reads it - last-line-only by design.
  await session.triggerCommand("/check#pf-debug", "diag", null, { waitShell: true });
  const diagLine = await session.waitFor(function check() {
    const v = document.documentElement.dataset.pfLog ?? "";
    if (v.startsWith("diag {")) {
      try { return JSON.parse(v.slice(5)); } catch { return false; }
    }
    return false;
  }, 5000).then((v) => v, () => null);
  row("diag dump answers the top realm's parsed frame state",
    !!diagLine
      && diagLine.realm === "top"
      && diagLine.domain === "127-0-0-1"
      && diagLine.debug === true
      && Array.isArray(diagLine.videos) && diagLine.videos.length === 1
      && diagLine.videos[0]?.size === true && diagLine.videos[0]?.screened === true
      && diagLine.shell === "Plyr"
      && diagLine.booting === false,
    diagLine ? JSON.stringify(diagLine) : "diag line never landed in pfLog");

  // ---- Cross-frame reach #1: a top-frame command toggles a RUNNING embed
  // realm mid-flight. The debug flip rides the same storage echo every
  // cross-instance write rides: the frame's #armDebugWatch hears the foreign
  // configs write and flips ITS runtime, logging the mirror line. This is
  // the real foreign-instance delivery the old harness synthesized
  // (`remoteWrite`): the writer here is the command channel on the top doc,
  // the receiver the frame kernel. The trigger rides the waitShell shape
  // (the frame's shell implies the kernel whose debug watch must be armed -
  // the race the row needs settled) and the shell lives in the embed frame,
  // not the top document - the wait-shell gate scans the same-origin embed
  // too. Debug stays ON through the diag row (its echo line only reaches
  // the mirror while the debug runtime is armed; the off leg follows).
  const toggle1 = await session.triggerCommand("/check/frames-so", "debug-toggle", null, { waitShell: true });
  await session.waitForFrame([0], function check() {
    const v = document.documentElement.dataset.pfLog ?? "";
    return v.includes("Debug logs mirrored on from a foreign write");
  }, 5000).then(() => true, () => false);
  const frameArmed = await session.evalInFrame([0], function main() {
    return (document.documentElement.dataset.pfLog ?? "").includes("Debug logs mirrored on from a foreign write");
  });
  // ---- Cross-frame reach #2: the diagnostics echo answers per realm. The
  // debug hash on the trigger navigation arms the top SENTINEL at script
  // eval (entry: the hash arms the mirror without a kernel) - which is what
  // lets the top's Direct dump land in pfLog at all on a video-less embed
  // host. The frame realm armed itself from the toggle above (the toggle
  // stays ON until the off leg below - the frame's echo dump only reaches
  // the debug mirror while the debug runtime is armed). The diag command
  // writes pf:diag from the top - the top dumps directly (its own write,
  // echo-filtered in its own realm) and the frame answers on the storage
  // echo with its own realm's line.
  await session.triggerCommand("/check/frames-so#pf-debug", "diag", null, { waitShell: true });
  const record = await session.waitForFrame([0], function check() {
    const v = document.documentElement.dataset.pfLog ?? "";
    if (!v.startsWith("diag {")) {
      return false;
    }
    try { return JSON.parse(v.slice(5)); } catch { return false; }
  }, 5000).then((v) => v, () => null);
  const topLog = await session.eval(function main() {
    return document.documentElement.dataset.pfLog ?? "";
  });
  let topRec = null;
  try { topRec = JSON.parse(topLog.slice(5)); } catch {}
  const toggleOff = await session.triggerCommand("/check/frames-so#pf-debug", "debug-toggle", null, { waitShell: true });
  row("top-frame debug toggle storage-echoes into the running frame realm",
    toggle1 === true && frameArmed === true && toggleOff === false,
    `toggle=${JSON.stringify(toggle1)} frameMirrored=${frameArmed} offToggle=${JSON.stringify(toggleOff)}`);
  // The honest per-realm split: /check/frames-so's TOP document is the
  // video-less embed HOST - its kernel never boots (discovery boots on
  // video candidates; the host page carries the iframe, not the video), so
  // its diag record legitimately reads shell:null, videos:0 - the empty
  // shape IS the diagnosis ("which document holds the player's state": not
  // this one, the frame). The frame realm answers the live shape: Plyr
  // shell, one media candidate. Asserting a Plyr shell on the top would
  // demand a boot the embed topology never runs.
  row("diag echo answers every realm (top direct, frame through the echo)",
    topRec?.realm === "top" && topRec?.shell === null
      && Array.isArray(topRec?.videos) && topRec.videos.length === 0
      && record?.realm === "frame" && record?.shell === "Plyr"
      && Array.isArray(record?.videos) && record.videos.length === 1,
    `top=${topLog.slice(0, 140)} frame=${JSON.stringify(record).slice(0, 140)}`);

  // Debug hygiene: the toggle-back above left storage off. The next rows
  // ride the per-load hash only. This navigation reuse is also where the
  // relay stage boots from.
  const q3 = await session.triggerCommand("/check", "debug-query");
  row("debug state back at off before the remaining rows",
    q3 === false, `query=${JSON.stringify(q3)}`);


  // ---- The background text relay: the one network egress family. The
  // panel's URL button drives window.prompt; the driver answers the dialog
  // with a CROSS-ORIGIN url (localhost vs 127.0.0.1 - the page's own CORS
  // would refuse it), the request rides the background's <all_urls> host
  // permission, and the parsed track must land a visible cue slot.
  await boot({ pagePath: "/check#pf-debug" });
  await session.eval(function main() {
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
  });
  await session.waitFor(
    "return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel-tab[data-title=\"Subtitles\"]');",
    6000
  ).then(() => true, () => false);
  await sleep(600);
  const url = `${crossBaseUrl}/check/subs-ok.srt`;
  await session.eval(function main() {
    document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelector("button[aria-label=\"Load subtitles from URL\"]")?.click();
  });
  // The prompt dialog is chrome UI: the driver answers it like a user would.
  let dialogAnswered = false;
  for (let i = 0; i < 12 && !dialogAnswered; i++) {
    await sleep(250);
    try {
      const alert = await session.raw.switchTo().alert();
      await alert.sendKeys(url);
      await alert.accept();
      dialogAnswered = true;
    } catch {}
  }
  const relayed = await session.waitFor(
    "return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-cue:not([hidden])');",
    8000
  ).then(() => true, () => false);
  const relayState = await session.eval(function main() {
    return {
      slot: document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])")?.textContent ?? null,
      rail: (document.documentElement.dataset.pfLog ?? "").includes("Relay unavailable")
    };
  });
  row("the background text relay ingests a cross-origin subtitle URL into a running track",
    dialogAnswered === true && relayed === true && relayState.rail === false,
    `dialog=${dialogAnswered} slot=${JSON.stringify(relayState.slot)} relayFallback=${relayState.rail}`);

  // Row hygiene: the ingest wrote the per-viewing subsUrl extra into /check's
  // resume entry (resume.js's restore field), and the persist case - later in
  // the full battery's runner order - restores that same entry: its boot's
  // #tryRestore re-fetches the track and the captions status toast (a
  // no-actions show) lands after the resume toast, clearing the Start-over
  // action buttons that row probes. The panel's Remove subtitles button is
  // the product's own revert verb (session.remove clears the extra); the
  // settle is read off the storage dump with the row's poll rule, not timing.
  await session.eval(function main() {
    document.querySelector(".pf-shell")?.shadowRoot
      ?.querySelector("button[aria-label=\"Remove subtitles\"]")?.click();
  });
  const subsClean = await session.waitFor(function check() {
    try {
      const entries = JSON.parse(window.PlayerForge?.storageDump?.() ?? "{}").resume?.entries ?? [];
      const entry = entries.find((e) => e && e.path === "/check");
      return (entry?.subsUrl ?? "") === "";
    } catch { return false; }
  }, 5000).then(() => true, () => false);
  row("relay row reverts the per-viewing subs extra (no cross-case restore race)",
    subsClean === true, `subsUrlClean=${JSON.stringify(subsClean)}`);

  return rows;
}
