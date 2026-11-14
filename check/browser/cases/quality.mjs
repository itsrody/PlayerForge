/**
 * The qualities-menu adaptor case: the registry's per-record quality
 * vocabularies proven against vendor-shaped stubs through the REAL
 * QualityAdaptor (served from the working tree, the fan/sdk precedent), then
 * the integration surface through a real boot.
 *
 * Unit plane: one fixture page hosts all nine quality-carrying vendor stubs
 * (JW, Plyr, DPlayer, XGPlayer, Shaka, Vidstack, Mux, OvenPlayer, Bitmovin)
 * plus a no-vocabulary Video.js control. Each record's vocabulary is read
 * from the SERVED detection.js - the case proves the shipped vocabularies,
 * never a re-spelled copy. The stubs ride the shapes the records name: open
 * shadow roots (Vidstack, Mux), the label-compare witness (DPlayer's
 * .dplayer-quality-icon), the doubly-lazy open walk (OvenPlayer's
 * panel/animated root + destroyed-on-switch panel stack), the select plane
 * (Bitmovin's selected-IDL witness with its stale [selected] attribute), and
 * an over-cap label for the admission ceiling.
 *
 * Integration plane: a Plyr-shaped page boots the real bundle; the forge
 * bar's quality button seeds visible (the eager construct probe), the panel
 * lands on the Quality section through the bar button's open(prefer), and a
 * row click switches the vendor's own menu AND the media (real second-
 * resolution stream from ensureHdVideoAsset).
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../../lib/driver.mjs";
import { ensureHdVideoAsset } from "../../lib/fixture.mjs";

const UNIT_PAGE = (baseUrl, base) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>quality unit lab</title></head>
<body style="background:#000">
<script>
  window.__w = {};
  window.__opClicks = 0;
  // The verified mux clone chain (media-chrome main): the menu root's value
  // setter finds the matching item, moves the checked state, and dispatches
  // the change event the rendition controller listens to. Defined BEFORE the
  // DOM build so the element upgrades with the accessor live.
  customElements.define("media-rendition-menu", class extends HTMLElement {
    set value(v) {
      const items = this.querySelectorAll("media-chrome-menu-item");
      for (const item of items) {
        item.setAttribute("aria-checked", String(item.getAttribute("value") === String(v)));
      }
      window.__w.mux = String(v);
      this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }
  });
  const el = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  // ---- JW Player: eager, cls witness, label-as-value.
  const jw = el('<div class="jwplayer" id="jw-stub">'
    + '<video id="jw-video"></video>'
    + '<div id="jw-settings-submenu-quality">'
    + '<button class="jw-settings-content-item jw-settings-item-active">Auto</button>'
    + '<button class="jw-settings-content-item">1080p</button>'
    + '<button class="jw-settings-content-item">720p</button>'
    + "</div></div>");
  document.body.append(jw);
  jw.addEventListener("click", (e) => {
    const item = e.target.closest(".jw-settings-content-item");
    if (!item) return;
    for (const b of jw.querySelectorAll(".jw-settings-content-item")) {
      b.classList.toggle("jw-settings-item-active", b === item);
    }
    window.__w.jw = item.textContent.trim();
  });
  // ---- Plyr: eager, aria-checked witness, value attribute.
  const plyr = el('<div class="plyr" id="plyr-stub">'
    + '<video id="plyr-video"></video>'
    + '<div id="plyr-settings-1-quality"><div role="menu">'
    + '<button type="button" role="menuitemradio" aria-checked="true" value="540"><span>540p</span></button>'
    + '<button type="button" role="menuitemradio" aria-checked="false" value="960"><span>960p</span></button>'
    + "</div></div></div>");
  document.body.append(plyr);
  plyr.addEventListener("click", (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (!item) return;
    for (const b of plyr.querySelectorAll('[role="menuitemradio"]')) {
      b.setAttribute("aria-checked", String(b === item));
    }
    window.__w.plyr = item.getAttribute("value");
  });
  // ---- XGPlayer: eager, cls witness, data-index value.
  const xg = el('<div class="xgplayer" id="xg-stub">'
    + '<video id="xg-video"></video>'
    + '<div class="xgplayer-definition">'
    + '<li class="option-item selected" data-index="0">540p</li>'
    + '<li class="option-item" data-index="1">960p</li>'
    + "</div></div>");
  document.body.append(xg);
  xg.addEventListener("click", (e) => {
    const item = e.target.closest("li.option-item");
    if (!item) return;
    for (const li of xg.querySelectorAll("li.option-item")) {
      li.classList.toggle("selected", li === item);
    }
    window.__w.xg = item.getAttribute("data-index");
  });
  // ---- Shaka: eager, aria-checked witness, label-as-value; the fourth
  // entry carries an over-cap label for the admission-ceiling row.
  const shaka = el('<div class="shaka-video-container" id="shaka-stub">'
    + '<video id="shaka-video"></video>'
    + '<div class="shaka-resolutions">'
    + '<button role="menuitemradio" aria-checked="true">Auto</button>'
    + '<button role="menuitemradio" aria-checked="false">1080p</button>'
    + '<button role="menuitemradio" aria-checked="false">720p</button>'
    + "</div></div>");
  const longBtn = document.createElement("button");
  longBtn.setAttribute("role", "menuitemradio");
  longBtn.setAttribute("aria-checked", "false");
  longBtn.textContent = "Long " + "x".repeat(95);
  shaka.querySelector(".shaka-resolutions").append(longBtn);
  document.body.append(shaka);
  shaka.addEventListener("click", (e) => {
    const item = e.target.closest(".shaka-resolutions button");
    if (!item) return;
    for (const b of shaka.querySelectorAll(".shaka-resolutions button")) {
      b.setAttribute("aria-checked", String(b === item));
    }
    window.__w.shaka = item.textContent.trim();
  });
  // ---- Vidstack: items clone-rendered inside an OPEN shadow root; plain
  // document queries must stay blind while the adaptor's deep walk reaches.
  const vsHost = document.createElement("media-player");
  const vsRoot = vsHost.attachShadow({ mode: "open" });
  vsRoot.innerHTML = '<media-quality-radio-group>'
    + '<media-radio value="1080p" aria-checked="true"><span data-part="label">1080p</span></media-radio>'
    + '<media-radio value="720p" aria-checked="false"><span data-part="label">720p</span></media-radio>'
    + "</media-quality-radio-group>";
  // The media lives INSIDE the player element's shadow root (the vendor's
  // own composition); the adaptor's deep walk is what reaches both.
  const vsVideo = document.createElement("video");
  vsRoot.prepend(vsVideo);
  document.body.append(vsHost);
  vsRoot.addEventListener("click", (e) => {
    const item = e.target.closest("media-radio");
    if (!item) return;
    for (const r of vsRoot.querySelectorAll("media-radio")) {
      r.setAttribute("aria-checked", String(r === item));
    }
    window.__w.vs = item.getAttribute("value");
  });
  // ---- Mux: the rendition menu inside the player's open shadow root; the
  // switch verb rides the custom element's value setter above.
  const muxHost = document.createElement("mux-player");
  const muxRoot = muxHost.attachShadow({ mode: "open" });
  muxRoot.innerHTML = "<media-rendition-menu>"
    + '<media-chrome-menu-item value="1080" aria-checked="true">1080p</media-chrome-menu-item>'
    + '<media-chrome-menu-item value="720" aria-checked="false">720p</media-chrome-menu-item>'
    + "</media-rendition-menu>";
  const muxVideo = document.createElement("video");
  muxRoot.prepend(muxVideo);
  document.body.append(muxHost);
  // ---- OvenPlayer: DOUBLY lazy - the settings button toggles the whole
  // panel stack, the main panel root carries the animated class (the record's
  // :not(.animated) menu scope answers sub-panels only), the quality row
  // builds the sub-panel synchronously, and an item click moves the witness
  // AND destroys the panel tree (the vendor's own panelManager.clear()).
  const op = el('<div class="ovenplayer" id="op-stub">'
    + '<video id="op-video"></video>'
    + '<button class="op-setting-button" id="op-btn">settings</button></div>');
  document.body.append(op);
  let opPanel = null;
  let opCurrent = 0;
  const buildOpSub = () => {
    let sub = opPanel.querySelector(".op-setting-panel:not(.animated)");
    if (sub) { sub.remove(); return; }
    sub = document.createElement("div");
    sub.className = "op-setting-panel";
    [0, 1].forEach((i) => {
      const item = document.createElement("div");
      item.className = "op-setting-item";
      item.setAttribute("op-panel-type", "quality");
      item.setAttribute("op-data-value", String(i));
      const check = document.createElement("span");
      check.className = "op-setting-item-checked" + (i === opCurrent ? " op-show" : "");
      const title = document.createElement("span");
      title.className = "op-setting-item-title";
      title.textContent = i === 0 ? "540p" : "960p";
      item.append(check, title);
      item.addEventListener("click", () => {
        opCurrent = i;
        window.__w.op = String(i);
        for (const it of sub.querySelectorAll(".op-setting-item")) {
          it.querySelector(".op-setting-item-checked").classList.toggle("op-show", it === item);
        }
        opPanel.remove();
        opPanel = null;
      });
      sub.append(item);
    });
    opPanel.append(sub);
  };
  document.getElementById("op-btn").addEventListener("click", () => {
    window.__opClicks++;
    if (opPanel) { opPanel.remove(); opPanel = null; return; }
    opPanel = document.createElement("div");
    opPanel.className = "op-setting-panel animated";
    const row = document.createElement("div");
    row.className = "op-setting-item";
    row.setAttribute("op-panel-type", "quality");
    row.setAttribute("op-data-value", "quality");
    const title = document.createElement("span");
    title.className = "op-setting-item-title";
    title.textContent = "Quality";
    row.append(title);
    row.addEventListener("click", buildOpSub);
    opPanel.append(row);
    op.append(opPanel);
  });
  window.__opState = () => ({ panelOpen: opPanel !== null, clicks: window.__opClicks });
  // ---- Bitmovin: the select plane. The [selected] attribute is only the
  // rebuild-time projection; the witness is the option's selected IDL.
  const bit = el('<div class="bmpui-ui-uicontainer" id="bit-stub">'
    + '<video id="bit-video"></video>'
    + '<select class="ui-selectbox ui-videoqualityselectbox" id="bit-select">'
    + '<option value="auto">Auto</option>'
    + '<option value="1080" selected>1080p</option>'
    + '<option value="720">720p</option>'
    + "</select></div>");
  document.body.append(bit);
  document.getElementById("bit-select").addEventListener("change", () => {
    window.__w.bit = document.getElementById("bit-select").value;
  });
  // ---- Video.js: the no-vocabulary control (supported false, read EMPTY).
  document.body.append(el('<div class="video-js" id="vjs-stub"><video id="vjs-video"></video></div>'));
  // ---- DPlayer: the late-menu arm - the vendor's menu is ABSENT at the
  // adaptor's construct probe; the use-time re-query is what catches it.
  setTimeout(() => {
    const icon = el('<button class="dplayer-quality-icon">540p</button>');
    const list = el('<div class="dplayer-quality-list">'
      + '<div class="dplayer-quality-item" data-index="0">540p</div>'
      + '<div class="dplayer-quality-item" data-index="1">960p</div>'
      + "</div>");
    document.getElementById("dplayer-stub").append(icon, list);
    list.addEventListener("click", (e) => {
      const item = e.target.closest(".dplayer-quality-item");
      if (!item) return;
      icon.textContent = item.textContent;
      window.__w.dplayer = item.getAttribute("data-index");
    });
  }, 400);
  document.body.append(el('<div class="dplayer" id="dplayer-stub"><video id="dplayer-video"></video></div>'));
</script>
<script type="module">
  window.__qErr = null;
  try {
    const [det, q] = await Promise.all([
      import("${baseUrl}${base}/kernel/detection.js"),
      import("${baseUrl}${base}/shell/quality.js")
    ]);
    const rec = Object.fromEntries(det.SDK_REGISTRY.map((r) => [r.name, r]));
    const signal = new AbortController().signal;
    // The id-based stubs ride getElementById; the shadow-hosted stubs (Vidstack,
    // Mux) hand the live video/container elements - either shape resolves.
    const mk = (name, video, container) => new q.QualityAdaptor(
      typeof video === "string" ? document.getElementById(video) : video,
      typeof container === "string" ? document.getElementById(container) : container,
      rec[name].quality ?? null,
      signal
    );
    window.__q = {
      ready: true,
      ads: {
        jw: mk("JW Player", "jw-video", "jw-stub"),
        plyr: mk("Plyr", "plyr-video", "plyr-stub"),
        dplayer: mk("DPlayer", "dplayer-video", "dplayer-stub"),
        xg: mk("XGPlayer", "xg-video", "xg-stub"),
        shaka: mk("Shaka Player", "shaka-video", "shaka-stub"),
        vs: mk("Vidstack", vsVideo, vsHost),
        mux: mk("Mux Player", muxVideo, muxHost),
        op: mk("OvenPlayer", "op-video", "op-stub"),
        bit: mk("Bitmovin Player", "bit-video", "bit-stub"),
        vjs: mk("Video.js", "vjs-video", "vjs-stub")
      }
    };
  } catch (err) {
    // The case's fail row reads this - an import-chain or constructor throw
    // must surface its reason, never a bare "missing after 5s".
    window.__qErr = String(err && err.stack ? err.stack.split("\\n").slice(0, 3).join(" | ") : err);
  }
</script>
</body></html>`;

const INTEGRATION_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>plyr quality</title>
<style>
  .plyr { position: relative; width: 960px; height: 540px; }
  video { width: 100%; height: 100%; display: block; }
</style></head>
<body style="background:#000">
<div class="plyr" id="player">
  <video id="check-video" src="/check-video.mp4" preload="metadata" playsinline></video>
  <div id="plyr-settings-77-quality"><div role="menu">
    <button type="button" role="menuitemradio" aria-checked="true" value="540"><span>540p</span></button>
    <button type="button" role="menuitemradio" aria-checked="false" value="960"><span>960p</span></button>
  </div></div>
</div>
<script>
  const V = document.getElementById("check-video");
  const wrap = document.getElementById("plyr-settings-77-quality");
  wrap.addEventListener("click", (e) => {
    const item = e.target.closest('[role="menuitemradio"]');
    if (!item) return;
    // The vendor's own switch: the real second-resolution stream + the
    // menu's exclusive aria-checked witness.
    V.src = item.getAttribute("value") === "960" ? "/check-video-hd.mp4" : "/check-video.mp4";
    for (const b of wrap.querySelectorAll('[role="menuitemradio"]')) {
      b.setAttribute("aria-checked", String(b === item));
    }
  });
</script>
</body></html>`;

const READ_SPECS = [
  { key: "jw", n: 3, labels: ["Auto", "1080p", "720p"], values: ["Auto", "1080p", "720p"], active: 0, name: "JW Player" },
  { key: "plyr", n: 2, labels: ["540p", "960p"], values: ["540", "960"], active: 0, name: "Plyr" },
  { key: "xg", n: 2, labels: ["540p", "960p"], values: ["0", "1"], active: 0, name: "XGPlayer" },
  { key: "shaka", n: 4, labels: ["Auto", "1080p", "720p"], active: 0, name: "Shaka Player" },
  { key: "mux", n: 2, labels: ["1080p", "720p"], values: ["1080", "720"], active: 0, name: "Mux Player" },
  { key: "bit", n: 3, labels: ["Auto", "1080p", "720p"], values: ["auto", "1080", "720"], active: 1, name: "Bitmovin Player" }
];

const SWITCH_SPECS = [
  { key: "jw", idx: 1, active: 1, witness: "jw", wv: "1080p", name: "JW Player" },
  { key: "plyr", idx: 1, active: 1, witness: "plyr", wv: "960", name: "Plyr" },
  { key: "xg", idx: 1, active: 1, witness: "xg", wv: "1", name: "XGPlayer" },
  { key: "shaka", idx: 1, active: 1, witness: "shaka", wv: "1080p", name: "Shaka Player" },
  { key: "vs", idx: 1, active: 1, witness: "vs", wv: "720p", name: "Vidstack" },
  { key: "mux", idx: 1, active: 1, witness: "mux", wv: "720", name: "Mux Player" },
  { key: "dplayer", idx: 1, active: 1, witness: "dplayer", wv: "1", name: "DPlayer" },
  { key: "bit", idx: 2, active: 2, witness: "bit", wv: "720", name: "Bitmovin Player" }
];

const readOf = (session, key) => session.eval(function main(k) {
  const r = window.__q.ads[k].read();
  return {
    n: r.entries.length,
    labels: r.entries.map((e) => e.label),
    values: r.entries.map((e) => e.value),
    active: r.active,
    available: window.__q.ads[k].available
  };
}, key);

export async function run({ session, baseUrl, bundle }) {
  const rows = [];
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SRC = join(HERE, "..", "..", "..", "src");
  const ROOT = join(HERE, "..", "..", "..");
  const base = `/check/quality-${Date.now()}`;
  const serve = async (route, rel) => {
    session.registerAsset(
      `${base}${route}`,
      Buffer.from(await readFile(join(SRC, rel), "utf8")),
      "text/javascript"
    );
  };
  // The mirror-structured registrations (the hotpath/sdk precedent): the
  // served import graph is detection -> contract + ../shared/store (which
  // itself imports runtime), and quality -> ../shared/{core,runtime}.
  await serve("/kernel/detection.js", "kernel/detection.js");
  await serve("/kernel/contract.js", "kernel/contract.js");
  await serve("/shared/core.js", "shared/core.js");
  await serve("/shared/runtime.js", "shared/runtime.js");
  await serve("/shared/store.js", "shared/store.js");
  await serve("/shell/quality.js", "shell/quality.js");

  session.registerFixture("/check/quality-unit", UNIT_PAGE(baseUrl, base));
  session.registerFixture("/check/quality-int", INTEGRATION_PAGE);
  const hdRoute = ensureHdVideoAsset();
  session.registerAsset(hdRoute, await readFile(join(ROOT, "check", ".tmp", "check-video-hd.mp4")), "video/mp4");

  /* ---------------- unit plane: the served adaptor over real vocabularies */

  await session.navigate(`${baseUrl}/check/quality-unit?boot=${Date.now()}`);
  let ready = true;
  try {
    await session.waitFor("return window.__q && window.__q.ready === true ? 'ready' : null", 5000);
  } catch {
    ready = false;
  }
  if (!ready) {
    const qErr = await session.eval(function main() {
      return window.__qErr ?? null;
    }).catch(() => null);
    rows.push({
      name: "quality unit page: the served modules never loaded",
      status: "fail",
      note: "window.__q missing after 5s - import chain or adaptor threw: " + (qErr ?? "no __qErr recorded"),
      ms: null
    });
  } else {
    const supported = await session.eval(function main() {
      const out = {};
      for (const [k, ad] of Object.entries(window.__q.ads)) {
        out[k] = ad.supported;
      }
      return out;
    });
    rows.push({
      name: "the nine vocabulary records support; the no-vocabulary control does not",
      status: supported.jw && supported.plyr && supported.dplayer && supported.xg
        && supported.shaka && supported.vs && supported.mux && supported.op && supported.bit
        && supported.vjs === false ? "pass" : "fail",
      note: JSON.stringify(supported),
      ms: null
    });

    const vjs = await session.eval(function main() {
      const ad = window.__q.ads.vjs;
      const r = ad.read();
      return { n: r.entries.length, active: r.active, available: ad.available };
    });
    rows.push({
      name: "Video.js: no vocabulary reads EMPTY and never flips availability",
      status: vjs.n === 0 && vjs.active === -1 && vjs.available === false ? "pass" : "fail",
      note: JSON.stringify(vjs),
      ms: null
    });

    // The deep-walk premise at the one record that needs it: Vidstack's
    // items live in an open shadow root, so the plain document query is
    // blind while the adaptor's read reaches them.
    const vsProbe = await session.eval(function main() {
      return {
        plain: document.querySelectorAll("media-quality-radio-group media-radio").length,
        read: readOfProxy(window.__q.ads.vs)
      };
      function readOfProxy(ad) {
        const r = ad.read();
        return { n: r.entries.length, labels: r.entries.map((e) => e.label), active: r.active };
      }
    });
    rows.push({
      name: "Vidstack: plain queries are shadow-blind; the adaptor's walk reaches the menu",
      status: vsProbe.plain === 0 && vsProbe.read.n === 2
        && vsProbe.read.labels[0] === "1080p" && vsProbe.read.active === 0 ? "pass" : "fail",
      note: JSON.stringify(vsProbe),
      ms: null
    });

    for (const spec of READ_SPECS) {
      const r = await readOf(session, spec.key);
      let ok = r.n === spec.n && r.active === spec.active;
      if (ok && spec.labels) {
        ok = spec.labels.every((l, i) => r.labels[i] === l);
      }
      if (ok && spec.values) {
        ok = spec.values.every((v, i) => r.values[i] === v);
      }
      if (ok && spec.key === "shaka") {
        // Label-as-value + the admission ceiling: the over-cap row reads
        // capped to 64 chars, its value riding the capped label.
        ok = r.labels[3].length === 64 && r.labels[3].startsWith("Long")
          && r.values[3] === r.labels[3];
      }
      rows.push({
        name: `${spec.name}: read() mirrors the vendor menu (entries/labels/active)`,
        status: ok ? "pass" : "fail",
        note: ok ? null : JSON.stringify(r),
        ms: null
      });
    }

    // The doubly-lazy vendor: unavailable by design until a consumer asks -
    // the construct probe must NOT arm the open walk.
    const opBefore = await session.eval(function main() {
      return window.__q.ads.op.available;
    });
    const opRead = await readOf(session, "op");
    const opAfterRead = await session.eval(function main() {
      return window.__opState();
    });
    rows.push({
      name: "OvenPlayer: doubly-lazy - unavailable until read() arms the open walk",
      status: opBefore === false && opRead.n === 2 && opRead.labels[0] === "540p"
        && opRead.values[0] === "0" && opRead.active === 0 && opRead.available === true
        && opAfterRead.panelOpen === false ? "pass" : "fail",
      note: (opBefore === false ? "" : "available leaked early; ")
        + `read=${JSON.stringify(opRead)} panelState=${JSON.stringify(opAfterRead)}`,
      ms: null
    });

    // The late-menu arm: the DPlayer menu builds 400ms after load - after
    // the construct probe saw nothing. Availability is sticky-off until the
    // use-time re-query. The case itself runs faster than 400ms of evals,
    // so the menu's arrival is awaited before the re-query reads it.
    await session.waitFor(
      "return !!document.querySelector('.dplayer-quality-list') ? 'late-menu' : null;",
      3000
    ).catch(() => null);
    const dpBefore = await session.eval(function main() {
      return window.__q.ads.dplayer.available;
    });
    const dpRead = await readOf(session, "dplayer");
    rows.push({
      name: "DPlayer: the late-populating menu is caught by the use-time re-query",
      status: dpBefore === false && dpRead.n === 2 && dpRead.labels[0] === "540p"
        && dpRead.active === 0 && dpRead.available === true ? "pass" : "fail",
      note: `before=${dpBefore} read=${JSON.stringify(dpRead)}`,
      ms: null
    });

    // Switch rows: the optimistic snapshot, the vendor's own witness, and
    // the converged post-recheck read (250ms > recheckMs 130).
    for (const spec of SWITCH_SPECS) {
      const sw = await session.eval(function main(k, i) {
        const ad = window.__q.ads[k];
        const entry = ad.entries[i];
        if (!entry) {
          return { ok: false, why: "no entry " + i };
        }
        return { ok: ad.switchTo(entry), label: entry.label };
      }, spec.key, spec.idx);
      await sleep(250);
      const after = await readOf(session, spec.key);
      const w = await session.eval(function main() {
        return window.__w;
      });
      let ok = sw.ok === true && after.active === spec.active && w[spec.witness] === spec.wv;
      if (ok && spec.key === "bit") {
        // The select plane's recorded premise: the IDL witness moved while
        // the [selected] attribute stayed on the rebuild-time projection.
        ok = await session.eval(function main() {
          return document.querySelector("#bit-select option[selected]").value;
        }) === "1080";
      }
      rows.push({
        name: `${spec.name}: switchTo rides the vendor's own handler; witness + active move`,
        status: ok ? "pass" : "fail",
        note: ok ? null : JSON.stringify({ sw, after, witness: w[spec.witness] }),
        ms: null
      });
    }

    // The lazy vendor's switch re-arms on demand and hands the panel back
    // WITHOUT the settle click (the vendor destroys its own menu on switch).
    // The click counter pins the exact close contract: the arm's own settings
    // click is the ONE delta (the vendor's panel is already gone), so a
    // settle-after-success would land a SECOND click - delta 2 is the bug.
    const opClicksBefore = await session.eval(function main() {
      return window.__opState();
    });
    const opSwitch = await session.eval(function main() {
      const ad = window.__q.ads.op;
      return { ok: ad.switchTo(ad.entries[1]) };
    });
    await sleep(250);
    const opAfterSwitch = await session.eval(function main() {
      return { state: window.__opState(), w: window.__w.op, read: readProxy(window.__q.ads.op) };
      function readProxy(ad) {
        const r = ad.read();
        return { n: r.entries.length, active: r.active };
      }
    });
    rows.push({
      name: "OvenPlayer: switchTo re-arms (one open click), switches, and never settles after success",
      status: opSwitch.ok === true && opAfterSwitch.w === "1"
        && opAfterSwitch.read.active === 1
        && opAfterSwitch.state.panelOpen === false
        && opAfterSwitch.state.clicks === opClicksBefore.clicks + 1 ? "pass" : "fail",
      note: JSON.stringify({ before: opClicksBefore, sw: opSwitch, after: opAfterSwitch.state, read: opAfterSwitch.read }),
      ms: null
    });
  }

  /* ---------------- integration plane: the real boot surface */

  await session.navigate(`${baseUrl}/check/quality-int?boot=${Date.now()}`);
  await session.injectGMRealm();
  await session.injectBundle(bundle);
  await session.wakeVideos();
  const bootOk = await session.waitFor(function main() {
    return document.querySelector(".pf-shell") !== null ? "booted" : null;
  }, 9000, 120).then(() => true).catch(() => false);
  rows.push({
    name: "Plyr quality page boots the shell",
    status: bootOk ? "pass" : "fail",
    ms: null
  });

  if (bootOk) {
    const i1 = await session.eval(function main() {
      const shadow = document.querySelector(".pf-shell")?.shadowRoot;
      const bar = shadow?.querySelector(".pf-forge-bar");
      const qBtn = bar?.querySelector('[data-action="quality"]');
      const setBtn = bar?.querySelector('[data-action="settings"]');
      return {
        bar: !!bar,
        btn: !!qBtn,
        hidden: qBtn ? qBtn.hidden : null,
        beforeSettings: !!(qBtn && setBtn)
          && (qBtn.compareDocumentPosition(setBtn) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
      };
    });
    rows.push({
      name: "forge bar: the quality button exists, is seeded visible, and sits before settings",
      status: i1.bar && i1.btn && i1.hidden === false && i1.beforeSettings ? "pass" : "fail",
      note: JSON.stringify(i1),
      ms: null
    });

    // The panel lands on the Quality section through the shared hotkey; the
    // lazy section build constructs QualitySection on first open.
    await session.eval(function main() {
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", key: "s", bubbles: true }));
    });
    const opened = await session.waitFor(
      "return !!document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel.pf-open');",
      3000
    ).then(() => true).catch(() => false);
    const i2 = opened
      ? await session.eval(function main() {
          const shadow = document.querySelector(".pf-shell").shadowRoot;
          const tab = shadow.querySelector('.pf-panel-tab[data-title="Quality"]');
          if (!tab) {
            return { tab: false };
          }
          tab.click();
          return { tab: true, id: tab.getAttribute("aria-controls") };
        })
      : { tab: false };
    const i2Rows = i2.tab
      ? await session.eval(function main(id) {
          const shadow = document.querySelector(".pf-shell").shadowRoot;
          const tab = shadow.querySelector('.pf-panel-tab[data-title="Quality"]');
          const section = shadow.getElementById(id);
          const list = section?.querySelector(".pf-quality-list");
          const active = section?.querySelector(".pf-quality-row-active");
          return {
            tabActive: tab.classList.contains("pf-panel-tab-active") && tab.getAttribute("aria-selected") === "true",
            rowCount: list ? list.querySelectorAll(".pf-quality-row").length : 0,
            activeText: active?.textContent ?? null
          };
        }, i2.id)
      : null;
    rows.push({
      name: "panel: the Quality tab activates and mirrors the vendor rows",
      status: opened && i2Rows && i2Rows.tabActive && i2Rows.rowCount === 2
        && i2Rows.activeText === "540p" ? "pass" : "fail",
      note: JSON.stringify({ opened, i2, rows: i2Rows }),
      ms: null
    });

    // A row click switches through the vendor's own handler AND the media -
    // the real second-resolution stream lands (videoWidth 960).
    const i3Clicked = await session.eval(function main() {
      const shadow = document.querySelector(".pf-shell").shadowRoot;
      const tab = shadow.querySelector('.pf-panel-tab[data-title="Quality"]');
      const section = shadow.getElementById(tab.getAttribute("aria-controls"));
      const rows = section.querySelectorAll(".pf-quality-row");
      const target = [...rows].find((r) => !r.classList.contains("pf-quality-row-active"));
      if (!target) {
        return false;
      }
      target.click();
      return true;
    });
    const hd = await session.waitFor(function main() {
      const v = document.querySelector("#check-video");
      return v && v.videoWidth === 960 ? "hd" : null;
    }, 6000, 120).then(() => true).catch(() => false);
    const i3 = await session.eval(function main() {
      const shadow = document.querySelector(".pf-shell").shadowRoot;
      const tab = shadow.querySelector('.pf-panel-tab[data-title="Quality"]');
      const section = shadow.getElementById(tab.getAttribute("aria-controls"));
      const active = section.querySelector(".pf-quality-row-active");
      const vendor = document.querySelector('#plyr-settings-77-quality [value="960"]');
      return {
        activeText: active?.textContent ?? null,
        vendorChecked: vendor?.getAttribute("aria-checked") ?? null
      };
    });
    rows.push({
      name: "row click switches the vendor menu AND the media to the HD stream",
      status: i3Clicked && hd && i3.activeText === "960p" && i3.vendorChecked === "true" ? "pass" : "fail",
      note: JSON.stringify({ i3Clicked, hd, ...i3 }),
      ms: null
    });

    // The bar button's open(prefer): closed panel, then the quality button
    // reopens with the Quality tab already active.
    await session.eval(function main() {
      document.querySelector(".pf-shell").shadowRoot.querySelector(".pf-panel-close").click();
    });
    const closed = await session.waitFor(
      "return !document.querySelector('.pf-shell')?.shadowRoot?.querySelector('.pf-panel.pf-open');",
      3000
    ).then(() => true).catch(() => false);
    await session.eval(function main() {
      document.querySelector(".pf-shell").shadowRoot
        .querySelector('.pf-forge-bar [data-action="quality"]').click();
    });
    const reopened = await session.waitFor(function main() {
      const shadow = document.querySelector(".pf-shell")?.shadowRoot;
      const panel = shadow?.querySelector(".pf-panel.pf-open");
      const tab = shadow?.querySelector('.pf-panel-tab[data-title="Quality"]');
      return panel && tab && tab.classList.contains("pf-panel-tab-active")
        && tab.getAttribute("aria-selected") === "true" ? "quality" : null;
    }, 4000, 100).then(() => true).catch(() => false);
    rows.push({
      name: "forge bar quality button: open(prefer) lands the closed panel on Quality",
      status: closed && reopened ? "pass" : "fail",
      note: `closed=${closed} reopened=${reopened}`,
      ms: null
    });
  }

  return rows;
}
