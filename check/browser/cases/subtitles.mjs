import { sleep } from "../../lib/driver.mjs";
/**
 * The displayed-picture anchor for cues: the ForgeTrack layers percent cue
 * fields onto the video's PAINTED picture - derived from the one fill-box
 * identity (shell.referenceBox) + the video's own box/intrinsic/object-fit,
 * the audited computeCoverScale relation read from the other side - instead
 * of the cue layer's own box.
 *
 * The stage is deliberately letterboxed: a square 800x800 element box for a
 * 16:9 stream inside a 900x800 stage. object-fit contain centers an
 * 800x450 picture at y=175, so a layer-relative answer (top 85% of 800 =
 * 680, left 50% of 900 = 450) provably differs from the picture answer
 * (top 175 + 85% of 450 = 557.5, left 50% of 800 = 400). The second row
 * widens the VIDEO ELEMENT to 1100 (beside the stage): the picture grows
 * to 1100x618.75 centered at y=90.625, and the box ticks must re-anchor the
 * running slots without any cue change (the video's own box widening -
 * the video-relative arm's signal-scoped RO - and the stage's container
 * RO both join). The third posture scrolls the
 * player into view after the stage was cached below the fold: scroll
 * repositions the rect's viewport origin with no size/fs/orientation
 * signal, so the cache must invalidate on it (a stale stage collapsed the
 * clip and parked cues at the layer origin - the field-reported top-left).
 * The last rows pin the OWN cue scheduler end to end: a second cue at
 * 4.0-4.8s in the dropped SRT, a seek that lands inside it lights the mirror
 * cue (enter boundary), and the window passing drops it (exit boundary) -
 * both edges previously rode the native cuechange. Between them, one row
 * pins the ingest-ownership law on the floor: the track never enters the
 * video's native track list (textTracks.length is 0 while a cue slot is
 * visible), so a hostile host has nothing of ours to list, restyle, or
 * mode-flip - the surface the feature deliberately leaves it. The last two
 * rows machine the surfaces the original case never touched: the panel's
 * V-stepper commit re-anchors the running slot this frame (the no-arg
 * render birth defect never landed a placement override pre-fix), and a
 * track over the retired worker's threshold (512KiB) drains through the
 * cooperative parse - the forgevtt async arm, now THE ingest backend since
 * the dedicated-Worker offloader retired - and lands its overloaded cue
 * through the real panel drop path. The last row machines the hostile
 * column: a genuinely over-ceiling (>16MiB) synthetic "subtitle" through
 * the same real drop path refuses at the admission belt with the fail
 * toast and renders no bomb cue.
 */

export async function run({ session, boot }) {
  const rows = [];
  await boot({ pagePath: "/check/subs" });

  const dropSubs = async () => {
    // The sections build runStepsAsync on the first panel open, so the key
    // first, then the tab wait. A beat after the tab appears is the settle
    // for the drop listener's own binding.
    await session.eval(function main() {
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    });
    const panelReady = await session.waitFor(
      "return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel-tab[data-title=\"Subtitles\"]');",
      6000
    ).then(() => true, () => false);
    if (!panelReady) {
      rows.push({ name: "subtitle panel section reachable", status: "fail", note: "Subtitles tab never appeared", ms: null });
      return false;
    }
    await sleep(600);
    const dropped = await session.eval(function main() {
      const shadow = document.querySelector(".pf-shell")?.shadowRoot;
      const tab = shadow?.querySelector(".pf-panel-tab[data-title=\"Subtitles\"]");
      const section = tab && shadow.getElementById(tab.getAttribute("aria-controls"));
      if (!section) {
        return "no section";
      }
      const dt = new DataTransfer();
      dt.items.add(new File(["1\n00:00:00,300 --> 00:00:40,000\nPF anchor cue\n\n2\n00:00:04,000 --> 00:00:04,800\nPF mirror cue\n"], "subs.srt", { type: "text/plain" }));
      section.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt }));
      section.dispatchEvent(new DragEvent("drop", { dataTransfer: dt }));
      return "dropped";
    });
    if (dropped !== "dropped") {
      rows.push({ name: "subtitle ingest via panel drop", status: "fail", note: String(dropped), ms: null });
      return false;
    }
    return true;
  };

  const dropped = await dropSubs();
  const visible = await session.waitFor(
    "return([...document.querySelector('.pf-shell')?.shadowRoot?.querySelectorAll('.pf-cue') ?? []].some((s) => !s.hidden) || false)",
    6000
  ).then((v) => !!v, () => false);
  rows.push({
    name: "panel drop ingests the track (cue renders)",
    status: dropped && visible ? "pass" : "fail",
    note: dropped && visible ? "slot visible after drop" : `drop=${dropped} visible=${visible}`,
    ms: null
  });

  // The ingest-ownership law, floor-real: with a track loaded and rendering,
  // the video's native track list must still be empty - the captions never
  // enter it, so a hosts's CC menu and `::cue` css have nothing of ours to
  // touch. Read alongside the visible slot so the answer is not vacuous.
  const custody = await session.eval(function main() {
    const video = document.querySelector("#check-video");
    const slot = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])");
    return { textTracks: video?.textTracks?.length ?? "no video", slotVisible: !!slot };
  });
  rows.push({
    name: "the ingested track never enters the video's native track list",
    status: custody && custody.slotVisible && custody.textTracks === 0 ? "pass" : "fail",
    note: JSON.stringify(custody),
    ms: null
  });

  // The motion contract: a visible slot transitions exactly the three
  // properties the hidden flip owns - opacity, translate (the 3px settle),
  // display (allow-discrete). The anchor lane (top/left) must NOT appear:
  // posture corrections land instantly (R9). Pinned as a computed read so a
  // token or property drift off this list fails loudly.
  const readMotion = await session.eval(function main() {
    const slot = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])");
    if (!slot) {
      return null;
    }
    const props = getComputedStyle(slot).transitionProperty.split(",").map((p) => p.trim()).sort();
    return props.join("|");
  });
  const motionProps = (readMotion ?? "").split("|");
  const motionOk = motionProps.includes("opacity") && motionProps.includes("translate") && motionProps.includes("display") && !motionProps.includes("top") && !motionProps.includes("left");
  rows.push({
    name: "cue slot transitions the motion lane only (opacity/translate/display; anchors instant)",
    status: motionOk ? "pass" : "fail",
    note: (readMotion ? readMotion : "no visible slot to read") + (motionOk ? " (opacity+translate+display in, top/left out)" : ""),
    ms: null
  });

  const readSlot = await session.eval(function main() {
    const slot = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])");
    if (!slot) {
      return null;
    }
    const cs = getComputedStyle(slot);
    return { top: cs.top, left: cs.left, maxWidth: cs.maxWidth, textWrap: cs.textWrapStyle };
  });
  rows.push({
    name: "letterboxed stream anchors to the displayed picture",
    status: Math.abs(parseFloat(readSlot?.top ?? "x") - 557.5) < 1.5
      && Math.abs(parseFloat(readSlot?.left ?? "x") - 400) < 1.5
      && Math.abs(parseFloat(readSlot?.maxWidth ?? "x") - 640) < 1.5
      ? "pass" : "fail",
    note: JSON.stringify(readSlot) + " (expected top=557.5px left=400px maxWidth=640px)",
    ms: null
  });
  // The cue balance adoption (computed pin on the same visible slot): the
  // sheet declares text-wrap-style: balance on .pf-cue so the centered
  // multi-line cue rebalances its internal breaks. The row is a vocabulary
  // presence pin, not a geometry one - balance reflows line breaks within
  // the same line count, so the pixel-top row above is the geometry guard.
  rows.push({
    name: "cue text wraps balanced (text-wrap-style pin on the visible slot)",
    status: readSlot?.textWrap === "balance" ? "pass" : "fail",
    note: `${readSlot?.textWrap ?? "no visible slot to read"} (expected balance)`,
    ms: null
  });

  // The re-anchor: the fill box moves (stage resize -> container RO -> the
  // ReferenceBox tick feeds the running renderer), so the running slots move
  // WITHOUT a cue change. The VIDEO ELEMENT itself widens to 1100 (its box
  // is fixed at width:800px in the stage otherwise — a premise the first
  // version of this row got wrong test-first): the video's own RO and the
  // stage's container RO both join, the picture becomes
  // 1100x618.75 centered at y=90.625 -> top 90.625 + 0.85*618.75 = 616.5625,
  // left 0.5*1100 = 550, maxWidth 0.8*1100 = 880.
  await session.eval(function main() {
    document.querySelector(".plyr").style.width = "1100px";
    document.querySelector("#check-video").style.width = "1100px";
  });
  const resized = await session.waitFor(
    "return [...document.querySelector('.pf-shell')?.shadowRoot?.querySelectorAll('.pf-cue:not([hidden])') ?? []].some((s) => Math.abs(parseFloat(getComputedStyle(s).left) - 550) < 1.5)",
    5000
  ).then((v) => !!v, () => false);
  const readResized = await session.eval(function main() {
    const slot = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])");
    if (!slot) {
      return null;
    }
    const cs = getComputedStyle(slot);
    return { top: cs.top, left: cs.left, maxWidth: cs.maxWidth };
  });
  rows.push({
    name: "box ticks re-anchor the running cues on a video+stage widen",
    status: resized
      && Math.abs(parseFloat(readResized?.top ?? "x") - 616.5625) < 1.5
      && Math.abs(parseFloat(readResized?.left ?? "x") - 550) < 1.5
      && Math.abs(parseFloat(readResized?.maxWidth ?? "x") - 880) < 1.5
      ? "pass" : "fail",
    note: JSON.stringify(readResized) + " (expected top=616.5625px left=550px maxWidth=880px)",
    ms: null
  });

  // The scroll posture: the player drops below the fold AFTER the stage
  // rect was cached (real pages boot scrolled to the top, then the user
  // scrolls in). Scroll moves the rect's viewport origin without a size
  // signal, so the stage cache must invalidate on it — a stale stage and
  // the scrolled-in video stop overlapping, the clip collapses, and the
  // prior collapse anchored slots at the layer origin (the field-reported
  // top-left). Video/layer/stage move together, so the layer-space anchor
  // must carry the resize row's exact numbers while scrolled.
  await session.eval(function main() {
    document.body.style.overflow = "scroll";
    document.body.style.height = "2600px";
    document.querySelector(".plyr")
      .insertAdjacentHTML("beforebegin", '<div style="height:1100px"></div>');
  });
  await sleep(400);
  await session.eval(function main() {
    window.scrollTo(0, 1100);
  });
  await sleep(400);
  const rescrolled = await session.waitFor(
    "return [...document.querySelector('.pf-shell')?.shadowRoot?.querySelectorAll('.pf-cue:not([hidden])') ?? []].some((s) => Math.abs(parseFloat(getComputedStyle(s).top) - 616.5625) < 1.5 && Math.abs(parseFloat(getComputedStyle(s).left) - 550) < 1.5)",
    5000
  ).then((v) => !!v, () => false);
  const readScrolled = await session.eval(function main() {
    const slot = document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-cue:not([hidden])");
    if (!slot) {
      return null;
    }
    const cs = getComputedStyle(slot);
    return { top: cs.top, left: cs.left, slotX: slot.getBoundingClientRect().x, videoX: document.querySelector("#check-video").getBoundingClientRect().y };
  });
  rows.push({
    name: "scroll posture keeps the picture anchor (stage invalidates on scroll)",
    status: rescrolled
      && Math.abs((readScrolled?.videoX ?? 999) - 0) < 2
      ? "pass" : "fail",
    note: JSON.stringify(readScrolled) + " (expected top=616.5625px left=550px, video at viewport y=0)",
    ms: null
  });

  // The sampler row: the dropped SRT carries a second cue at 4.0-4.8s, so a
  // seek INTO that window proves the own-sampler scheduler's enter boundary
  // (the second slot lights with the mirror cue), and the 0.8s span end
  // proves the exit boundary - an earlier case relied on the native
  // cuechange for both.
  await session.eval(function main(t) {
    document.querySelector("#check-video").currentTime = t;
  }, 4.2);
  const entered = await session.waitFor(
    'return [...document.querySelector(\'.pf-shell\')?.shadowRoot?.querySelectorAll(\'.pf-cue:not([hidden])\') ?? []].some((s) => s.textContent === "PF mirror cue")',
    6000
  ).then((v) => !!v, () => false);
  rows.push({
    name: "own sampler lights a cue on the enter boundary after a seek",
    status: entered ? "pass" : "fail",
    note: entered ? "mirror cue visible at t=4.2" : "sampler never lit the 4.0-4.8 cue",
    ms: null
  });
  const exited = await session.waitFor(
    'return ![...document.querySelector(\'.pf-shell\')?.shadowRoot?.querySelectorAll(\'.pf-cue:not([hidden])\') ?? []].some((s) => s.textContent === "PF mirror cue")',
    6000
  ).then((v) => !!v, () => false);
  rows.push({
    name: "own sampler drops the cue on the exit boundary",
    status: exited ? "pass" : "fail",
    note: exited ? "mirror cue hidden by 4.8" : "mirror cue outlived its window"
  });

  // The placement override: the panel's V stepper commits a global line
  // override (85 -> 90; step 5), and the running slot must re-anchor THIS
  // FRAME - setPlacement re-renders the last active set instead of waiting
  // for the next cue change. Pre-fix the commit path died inside #render
  // (no-arg call, undefined.length) and the override never landed. The
  // widened+scrolled posture from the earlier rows holds the numbers:
  // picture 1100x618.75 at y=90.625 -> top 90.625 + 0.9*618.75 = 647.5.
  // The stepper's text field (no defer) commits live per input event -
  // typing the value is a real user path and avoids synthesizing pointer
  // capture. Expected top: 647.5px.
  const placement = await session.evalAsync(function main(done) {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const tab = shadow?.querySelector('.pf-panel-tab[data-title="Subtitles"]');
    const section = tab && shadow.getElementById(tab.getAttribute("aria-controls"));
    const cell = section && [...section.querySelectorAll(".pf-panel-cell")]
      .find((c) => c.querySelector(".pf-panel-label")?.textContent === "V");
    const input = cell?.querySelector(".pf-stepper-input");
    if (!input) {
      done({ ok: false, top: null, why: "no V stepper input found" });
      return;
    }
    input.value = "90";
    input.dispatchEvent(new Event("input", { bubbles: false }));
    setTimeout(() => {
      const slot = document.querySelector(".pf-shell")?.shadowRoot
        ?.querySelector(".pf-cue:not([hidden])");
      const top = slot ? parseFloat(getComputedStyle(slot).top) : null;
      done({
        ok: top !== null && Math.abs(top - 647.5) < 1.5,
        top,
        why: top === null ? "no visible slot after override" : `top=${top} (expected 647.5)`
      });
    }, 300);
  });
  rows.push({
    name: "V-stepper commit re-anchors the running slot this frame",
    status: placement.ok === true ? "pass" : "fail",
    note: placement.why ?? null,
    ms: null
  });

  // The scale arm's proof, post-retirement: a track over the threshold the
  // worker once gated (512KiB of text - real .srt/.vtt files are tens of KB)
  // drains through the cooperative parse (forgevtt's 50ms/yield loop, the
  // one remaining backend) and lands its overloaded cue through the REAL
  // panel drop path. The sought cue is 4.5-5.5 inside the second drop's
  // track, whose first member renders slot 0.
  const scaleRide = await session.evalAsync(function main(done) {
    let text = "";
    let i = 1;
    while (text.length < 560000) {
      text += i + "\n00:00:04,500 --> 00:00:05,500\nPF scale cue " + i + "\n\n";
      i++;
    }
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const tab = shadow?.querySelector('.pf-panel-tab[data-title="Subtitles"]');
    const section = tab && shadow.getElementById(tab.getAttribute("aria-controls"));
    if (!section) {
      done({ ok: false, why: "no Subtitles section to drop into" });
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(new File([text], "big.srt", { type: "text/plain" }));
    section.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt }));
    section.dispatchEvent(new DragEvent("drop", { dataTransfer: dt }));
    const deadline = Date.now() + 9000;
    const poll = setInterval(() => {
      const slot = document.querySelector(".pf-shell")?.shadowRoot
        ?.querySelector(".pf-cue:not([hidden])");
      const landed = slot && slot.textContent === "PF scale cue 1";
      if (landed || Date.now() > deadline) {
        clearInterval(poll);
        done({
          ok: landed === true,
          why: landed ? "over-threshold track drained cooperative and landed slot 0"
            : "no scale-cue slot after 9s"
        });
      }
    }, 120);
  });
  rows.push({
    name: "over-threshold ingest drains the cooperative parse and lands its cue",
    status: scaleRide.ok === true ? "pass" : "fail",
    note: scaleRide.why ?? null,
    ms: null
  });

  // The admission ceiling's proof: a >16MiB synthetic "subtitle" through the
  // REAL panel drop path must refuse at #ingest's belt (before normalization
  // or the parser own the string), land the fail toast, and NOT load a track
  // - the previous track's cue stays untouched (the prior track name rides
  // the hint). The File pre-read gate (file.size) dies even before the
  // text() allocation - the row rides the real event path with a genuinely
  // oversized File, so both legs are exercised.
  const sizeRefusal = await session.evalAsync(function main(done) {
    // A genuinely over-ceiling File (~26M bytes of text, ~700k timed cues),
    // built cheap: one repeated line unit keeps the in-page build O(repeat).
    const huge = "1\n00:99:99,000 --> 99:99:99,900\nPF bomb cue\n\n".repeat(700000);
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const tab = shadow?.querySelector('.pf-panel-tab[data-title="Subtitles"]');
    const section = tab && shadow.getElementById(tab.getAttribute("aria-controls"));
    if (!section) {
      done({ ok: false, why: "no Subtitles section to drop into" });
      return;
    }
    const dt = new DataTransfer();
    dt.items.add(new File([huge], "bomb.srt", { type: "text/plain" }));
    section.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt }));
    section.dispatchEvent(new DragEvent("drop", { dataTransfer: dt }));
    const deadline = Date.now() + 4000;
    const poll = setInterval(() => {
      const toast = document.querySelector(".pf-shell")?.shadowRoot?.querySelector("pf-toast.pf-visible");
      const toastText = toast?.textContent ?? "";
      const refusalToast = toastText.includes("Failed to load subtitles");
      // The refusal must not have swapped the live track: no bomb cue slot.
      const slots = document.querySelector(".pf-shell")?.shadowRoot?.querySelectorAll(".pf-cue:not([hidden])") ?? [];
      const bombLoaded = [...slots].some((s) => s.textContent.includes("PF bomb cue"));
      if (refusalToast && !bombLoaded) {
        clearInterval(poll);
        done({ ok: true, why: "fail toast landed, no bomb cue rendered" });
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        done({ ok: false, why: `deadline; bombLoaded=${bombLoaded} toastText='${toastText.slice(0, 60)}'` });
        return;
      }
    }, 120);
  });
  rows.push({
    name: "over-cap ingest refuses at the admission belt (fail toast, no track)",
    status: sizeRefusal.ok === true ? "pass" : "fail",
    note: sizeRefusal.why ?? null,
    ms: null
  });

  // The hostile-style-value column (the law's uBO-grade receipt for the CSS
  // intake): SubtitleStyleState writes stored color/size/shadow/font/stroke
  // STRINGS into custom properties via setProperty — exactly the call this
  // row replicates on the cue layer with hostile token streams. The consume
  // chain must carry NO fetch surface (a hostile value may hold url() tokens,
  // but its consumers — color, font-family, font-size, text-shadow,
  // -webkit-text-stroke — paint only) and degrade IACVT: an invalid value
  // falls back at substitution time instead of resolving to a hostile
  // render. The before/after resource-entries delta carries the no-fetch
  // proof (the fixture's own media must not count), the computed font-size
  // readback the degrade. Inline writes are removed after, so later rows
  // start sheet-clean.
  const cssHostile = await session.evalAsync(function main(done) {
    const shadow = document.querySelector(".pf-shell")?.shadowRoot;
    const layer = shadow?.querySelector(".pf-cue-layer");
    if (!layer) {
      done({ ok: false, why: "no cue layer found" });
      return;
    }
    const before = performance.getEntriesByType("resource").length;
    layer.style.setProperty("--pf-cue-color", 'url("http://127.0.0.1:9/pf-css-leak") ; red');
    layer.style.setProperty("--pf-cue-font-family", 'var(--pf-unknown), url(//127.0.0.1:9/x), "x');
    layer.style.setProperty("--pf-cue-font-size", "1em; background-image: url(//127.0.0.1:9/y)");
    layer.style.setProperty("--pf-cue-text-shadow", "} .pf-shell * { color: green }");
    layer.style.setProperty("--pf-cue-stroke", "99999999999999cm");
    setTimeout(() => {
      const computed = getComputedStyle(layer);
      const out = {
        ok: true,
        delta: performance.getEntriesByType("resource").length - before,
        color: computed.color,
        fontSize: computed.fontSize
      };
      // inline writes off: later rows must see the sheet's own presentation
      for (const p of ["--pf-cue-color", "--pf-cue-font-family", "--pf-cue-font-size", "--pf-cue-text-shadow", "--pf-cue-stroke"]) {
        layer.style.removeProperty(p);
      }
      done(out);
    }, 300);
  });
  rows.push({
    name: "hostile cue-style values carry no fetch surface (CSS intake IACVT)",
    status: cssHostile.ok === true && cssHostile.delta === 0 ? "pass" : "fail",
    note: cssHostile.ok === false
      ? cssHostile.why ?? null
      : cssHostile.delta === 0
        ? `no subresource fetch from hostile cue-style values (computed color '${cssHostile.color}', fontSize '${cssHostile.fontSize}')`
        : `${cssHostile.delta} resource entries after hostile style writes!`,
    ms: null
  });

  return rows;
}
