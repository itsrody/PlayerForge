/**
 * The registry-coverage gate: every SDK record in detection.js is proven
 * against a real anchor-satisfying stub, in the page realm, through the same
 * resolveAdoptionHome the kernel adopts through - not a re-spelled matcher.
 *
 * The records' own claim ("adding an SDK = one record plus one fixture test")
 * was bookkept by hand: only a few records had fixture pages. This case makes
 * it machine-true - a record added without a builder stub below (or with an
 * anchor no builder satisfies) turns its row red. The import rides the served
 * working-tree module (the scheduler/fan precedent), so the shipped registry -
 * not a copy - is what the stubs are proven against.
 *
 * Laravel Video Embed keeps a coverage row and stays under review (its
 * anchors carry Inertia's vocabulary, not the package's own - a verdict the
 * summary records; removing a deliberately-added record needs user direction).
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_REGISTRY } from "../../../src/kernel/detection.js";

export async function run({ session, baseUrl }) {
  const rows = [];
  const KERNEL = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "kernel");
  // The route mirrors the module's real directory (a cache-busting prefix in
  // front of /kernel/), so detection.js's one relative import - the
  // import-clean contract.js sibling - resolves against a served neighbor
  // instead of dead-ending at the route prefix (the first run's abort).
  const base = `/check/sdk-${Date.now()}/kernel`;
  session.registerAsset(`${base}/detection.js`, Buffer.from(await readFile(join(KERNEL, "detection.js"), "utf8")), "text/javascript");
  session.registerAsset(`${base}/contract.js`, Buffer.from(await readFile(join(KERNEL, "contract.js"), "utf8")), "text/javascript");

  const probe = await session.eval(async (url) => {
    const { SDK_REGISTRY, resolveAdoptionHome } = await import(url);
    const results = {};

    // Minimal anchor-satisfying shape per record: the video is a direct child
    // of the element the record's FIRST anchor matches, so the expected
    // resolution is that element at hops 1. `top` is the subtree root to
    // mount - never the matched element itself when its OWN selector depends
    // on its parent (Laravel's `> div:first-child` re-evaluates against the
    // live tree under the mount point), so the builders return the built
    // ancestor chain intact.
    const stub = (attrs, children) => {
      const el = document.createElement("div");
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      const video = document.createElement("video");
      el.append(video, ...(children ?? []));
      return { video, matched: el, top: el };
    };
    const tagStub = (tag) => {
      const el = document.createElement(tag);
      const video = document.createElement("video");
      el.append(video);
      return { video, matched: el, top: el };
    };

    const builders = {
      "JW Player": () => stub({ class: "jwplayer" }),
      "Video.js": () => stub({ "data-vjs-player": "" }),
      Plyr: () => stub({ class: "plyr" }),
      ArtPlayer: () => stub({ class: "art-video-player" }),
      DPlayer: () => stub({ class: "dplayer" }),
      "MediaElement.js": () => stub({ class: "mejs-container" }),
      XGPlayer: () => stub({ class: "xgplayer" }),
      Aliplayer: () => stub({ class: "prism-player" }),
      "Fluid Player": () => stub({ class: "fluid_video_wrapper" }),
      "Flowplayer": () => stub({ class: "fp-player" }),
      Clappr: () => {
        // Container (class container + data-container) wraps the video; the
        // Core element (data-player) wraps the container. The compound anchor
        // is one hop closer, so the container - not the core - must resolve.
        const core = document.createElement("div");
        core.setAttribute("data-player", "");
        const built = stub({ class: "container", "data-container": "" });
        core.append(built.matched);
        return { video: built.video, matched: built.matched, expect: built.matched, top: core };
      },
      Vidstack: () => tagStub("media-player"),
      "Mux Player": () => tagStub("mux-player"),
      // The audit's provenance fix: the stub proves the PRIMARY install
      // route's wrapper (.rmp-container) that the record gained - the WC
      // route's tag stub always matched and never needed a fixture.
      "Radiant Media Player": () => stub({ class: "rmp-container" }),
      "Laravel Video Embed": () => {
        // First anchor shape: the wrapper div that is :first-child of the
        // data-page root holds the video. The data-page root mounts (the
        // wrapper's selector needs ITS parent), the wrapper is the expected
        // container.
        const page = document.createElement("div");
        page.setAttribute("data-page", "");
        const wrapper = document.createElement("div");
        page.append(wrapper);
        const video = document.createElement("video");
        wrapper.append(video);
        return { video, matched: wrapper, expect: wrapper, top: page };
      }
    };

    for (const record of SDK_REGISTRY) {
      const build = builders[record.name];
      if (!build) {
        results[record.name] = { ok: false, why: "no builder stub" };
        continue;
      }
      const { video, matched, expect, top } = build();
      const target = expect ?? matched;
      let home = null;
      let threw = null;
      // Fresh mount per record: the holder is created, attached, resolved
      // against, and detached whole - no prior mount can leave a sibling
      // that shifts a :first-child evaluation.
      const holder = document.createElement("div");
      document.body.append(holder);
      holder.append(top);
      try {
        home = resolveAdoptionHome(video);
      } catch (err) {
        threw = String(err);
      } finally {
        holder.remove();
      }
      if (threw) {
        results[record.name] = { ok: false, why: `threw ${threw}` };
        continue;
      }
      if (!home) {
        results[record.name] = { ok: false, why: "null home" };
        continue;
      }
      const ok = home.sdk.name === record.name
        && home.sdk.container === target
        && home.sdk.hops === 1
        && home.video === video;
      results[record.name] = ok
        ? { ok: true }
        : { ok: false, why: `name=${home.sdk.name} hops=${home.sdk.hops} containerMatch=${home.sdk.container === target} videoMatch=${home.video === video}` };
    }

    // The no-generic-fallback law: a bare video answers null.
    const bare = document.createElement("video");
    let bareAnswer;
    try {
      const answer = resolveAdoptionHome(bare);
      bareAnswer = answer === null ? "null" : `non-null: ${String(answer)}`;
    } catch (err) {
      bareAnswer = `threw: ${String(err)}`;
    }
    results.__bare = { ok: bareAnswer === "null", why: `bare=${bareAnswer}` };

    // The Clappr core arm: a video directly under a bare Core element (no
    // container rebuild between) still identifies, at the core.
    const coreOnly = document.createElement("div");
    coreOnly.setAttribute("data-player", "");
    const coreVideo = document.createElement("video");
    coreOnly.append(coreVideo);
    const coreHolder = document.createElement("div");
    document.body.append(coreHolder);
    coreHolder.append(coreOnly);
    const coreHome = resolveAdoptionHome(coreVideo);
    coreHolder.remove();
    results.__clapprCore = {
      ok: !!coreHome && coreHome.sdk.name === "Clappr" && coreHome.sdk.container === coreOnly,
      why: coreHome ? `${coreHome.sdk.name}@${coreHome.sdk.hops}` : "null"
    };

    // The Laravel second arm: #app[data-page] matches the root itself.
    const app = document.createElement("div");
    app.id = "app";
    app.setAttribute("data-page", "");
    const appVideo = document.createElement("video");
    app.append(appVideo);
    const appHolder = document.createElement("div");
    document.body.append(appHolder);
    appHolder.append(app);
    const appHome = resolveAdoptionHome(appVideo);
    appHolder.remove();
    results.__laravelApp = {
      ok: !!appHome && appHome.sdk.name === "Laravel Video Embed" && appHome.sdk.container === app,
      why: appHome ? `${appHome.sdk.name}@${appHome.sdk.hops}` : "null"
    };
    return results;
  }, `${baseUrl}${base}/detection.js`);

  // Structural registry rows at module scope: schema honesty per record -
  // a record without a name or a non-empty anchor list is dead vocabulary.
  rows.push({
    name: "registry schema: every record carries name + non-empty anchors",
    status: SDK_REGISTRY.every((r) => typeof r.name === "string" && Array.isArray(r.anchors) && r.anchors.length > 0) ? "pass" : "fail",
    ms: null
  });

  for (const record of SDK_REGISTRY) {
    const got = probe[record.name] ?? { ok: false, why: "record not probed" };
    rows.push({
      name: `${record.name}: stub resolves name/container/hops`,
      status: got.ok === true ? "pass" : "fail",
      note: got.ok === true ? null : got.why,
      ms: null
    });
  }

  rows.push({
    name: "the matcher keeps its no-generic-fallback answer",
    status: probe.__bare?.ok === true ? "pass" : "fail",
    note: probe.__bare?.ok === true ? null : probe.__bare?.why,
    ms: null
  });
  rows.push({
    name: "Clappr: the compound container beats the core on fewest hops",
    status: probe.__clapprCore?.ok === true ? "pass" : "fail",
    note: probe.__clapprCore?.ok === true ? null : `core arm: ${probe.__clapprCore?.why}`,
    ms: null
  });
  rows.push({
    name: "Laravel: the #app arm identifies at the root",
    status: probe.__laravelApp?.ok === true ? "pass" : "fail",
    note: probe.__laravelApp?.ok === true ? null : `app arm: ${probe.__laravelApp?.why}`,
    ms: null
  });
  return rows;
}
