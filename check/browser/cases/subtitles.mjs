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
 * both edges previously rode the native cuechange.
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
    await new Promise((r) => setTimeout(r, 600));
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
    return { top: cs.top, left: cs.left, maxWidth: cs.maxWidth, text: slot.textContent };
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
  await new Promise((r) => setTimeout(r, 400));
  await session.eval(function main() {
    window.scrollTo(0, 1100);
  });
  await new Promise((r) => setTimeout(r, 400));
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
    note: exited ? "mirror cue hidden by 4.8" : "mirror cue outlived its window",
    ms: null
  });

  return rows;
}
