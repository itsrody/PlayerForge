/**
 * The GM surface contract: the API set the granted header shipped, the echo
 * semantics kernel consumers rely on, the cross-tab refreshes that must move
 * the running kernel, real resources, and real network fetches. Realm hooks:
 * window.__pfBacking (live), window.__pfMenu, window.__gmTest (remoteWrite /
 * usage / aliveMenuIds).
 */
export async function run({ session, boot, header, version: bundleVersion }) {
  const rows = [];
  const status = (name, ok, note = null) => rows.push({ name, status: ok ? "pass" : "fail", note: ok ? null : note, ms: null });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));

  await boot();
  await settle(300);

  // 1 - GM_info mirrors the header the bundle shipped, grants included.
  const info = await session.eval(function main(headerName, granted) {
    const gm = window.GM_info ?? { script: {} };
    return {
      name: gm.script.name ?? null,
      ver: gm.script.version ?? null,
      handler: gm.scriptHandler ?? null,
      grants: JSON.stringify((gm.script.grant ?? []).sort()),
      granted: JSON.stringify([...granted].sort())
    };
  }, header.name, header.grants);
  status(
    "GM_info mirrors the shipped header",
    info.name === header.name && info.ver === bundleVersion
      && info.handler === "Tampermonkey" && info.grants === info.granted,
    `name=${info.name} ver=${info.ver} handler=${info.handler}`
  );

  // 2 - own-write echo: exactly one delivery per write, old/new orientation
  // (key, oldValue, newValue) and remote=false - the kernel filters on all of
  // these (store.js watchStorageKey skips args[3] === false).
  await session.eval(function main() {
    window.__echoLog = [];
    window.GM_addValueChangeListener("pf:echo-probe", (_key, oldValue, newValue, remote) => {
      window.__echoLog.push({ old: oldValue === undefined ? null : oldValue, new: newValue, remote });
    });
  });
  for (const value of [42, 43]) {
    await session.eval(function main(v) { window.GM_setValue("pf:echo-probe", v); }, value);
    await settle(220);
  }
  const echo = await session.eval(function main() { return window.__echoLog ?? null; });
  status(
    "own-write echo arrives once with old->new and remote=false",
    echo !== null && echo.length === 2
      && echo[0].old === null && echo[0].new === 42 && echo[0].remote === false
      && echo[1].old === 42 && echo[1].new === 43 && echo[1].remote === false,
    echo === null ? "no echo log" : `deliveries=${JSON.stringify(echo).slice(0, 120)}`
  );

  // 3 - a foreign-tab settings write must move the RUNNING kernel: hotkeys off
  // silences KeyM mid-session, switching back on re-arms it (gateOpen samples
  // getSetting live per keystroke).
  const muteCount = () => session.eval(function main() {
    return { mute: (window.__pfEvents ?? []).filter((e) => e === "mute").length };
  });
  const center = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    if (host === null) return null;
    const r = host.parentElement.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const writeHotkeys = (enabled) => session.eval(function main(on) {
    const doc = JSON.parse(JSON.stringify(window.__pfBacking["pf:configs"] ?? { version: 1 }));
    doc.settings = doc.settings ?? {};
    doc.settings.gestures = { ...(doc.settings.gestures ?? {}), hotkeys: on };
    window.__gmTest.remoteWrite("pf:configs", doc);
  }, enabled);
  const raw = session.raw;
  // Pointer park first - the same precondition the gesture case needs for
  // keystrokes to reach the kernel's document-level listener.
  const keyM = async () => {
    await raw.actions({ async: true }).move({ origin: "viewport", x: center.x, y: center.y }).press().pause(40).release().pause(40).perform();
    await raw.actions({ async: true }).keyDown("m").keyUp("m").pause(120).perform();
  };
  await session.eval(function main() {
    window.__pfEvents = [];
    document.querySelector(".pf-shell")?.addEventListener("pf:gesture-mute", () => window.__pfEvents.push("mute"));
  });
  await keyM();
  const baseline = await muteCount();
  status("KeyM baseline fires while hotkeys are on (foreign-write precondition)", baseline.mute === 1, `mute events=${baseline.mute}`);

  await writeHotkeys(false);
  await settle(300);
  await keyM();
  const off = await muteCount();
  status("remote pf:configs write (hotkeys off) blocks the running kernel's KeyM", off.mute === 1, `mute events after off=${off.mute}`);

  await writeHotkeys(true);
  await settle(300);
  await keyM();
  const back = await muteCount();
  status("remote settings write re-arms hotkeys on the live kernel", back.mute === 2, `mute events after on=${back.mute}`);

  // 4 - cross-tab resume adoption: a foreign pf:resume write merges into the
  // tracker's live state, and the tracker's NEXT save keeps the foreign
  // entry's identity (the createdAt marker) instead of rewiping the store.
  // The tracker only adopts after it has loaded (a save first), and the next
  // save is driven by real playback past RESUME_MIN_POSITION.
  await session.waitFor(
    "return (() => { const v = document.querySelector('#check-video'); return v && v.duration > 3 ? v.duration : false; })()",
    6000
  );
  const kernelEntry = await session.evalAsync(function main(done) {
    const v = document.querySelector("#check-video");
    if (!v) { done(null); return; }
    window.setTimeout(() => {
      v.currentTime = 6;
      v.play().catch(() => {});
    }, 200);
    window.setTimeout(() => { v.pause(); done(true); }, 2400);
  });
  status("tracker loaded before the foreign write (playback drove a save)", kernelEntry === true, "no playback");
  const markerCount = await session.evalAsync(function main(done) {
    const store = window.__pfBacking["pf:resume"] ?? null;
    const own = store && Array.isArray(store.entries)
      ? store.entries.find((e) => e && e.resume > 0 && e.path === "/check")
      : null;
    const marker = 1750000000000 + 424242;
    if (!own) { done({ ok: false, why: "no own entry, store=" + JSON.stringify(store).slice(0, 60) }); return; }
    window.__tls = [];
    const v0 = document.querySelector("#check-video");
    const snap = () => {
      const s = window.__pfBacking["pf:resume"];
      window.__tls.push(`${(s?.entries ?? []).map((e) => `${String(e.id).slice(0, 6)}:${e.resume?.toFixed?.(1) ?? e.resume}`).join("|")}@v${v0.currentTime.toFixed(1)}${v0.paused ? "P" : "R"}`);
    };
    snap();
    // Foreign tab's whole-doc write: their entry, ours dropped (their tab
    // never knew about it).
    window.__gmTest.remoteWrite("pf:resume", {
      version: 1,
      entries: [{
        id: "check-foreign-entry",
        domain: "check.test",
        path: "/check",
        title: "Foreign tab row",
        duration: 12,
        resume: 4.5,
        createdAt: marker,
        updatedAt: Date.now(),
        pending: false
      }]
    });
    snap();
    const v = document.querySelector("#check-video");
    // A seeked event persists immediately (an explicit position choice,
    // resume.js #startProgressWatch) regardless of the 10s checkpoint span -
    // with #lastSavedPosition at 6.0 from the restore, a seek to ~9.2 clears
    // the 3s save epsilon and lands the ADOPTED state on disk.
    window.setTimeout(() => { v.currentTime = 9.2; }, 500);
    window.setTimeout(() => {
      const inFlight = v.currentTime + 0;
      snap();
      const after = window.__pfBacking["pf:resume"] ?? { entries: [] };
      const foreign = (after.entries ?? []).find((e) => e && e.id === "check-foreign-entry");
      done({
        ok: after.entries.length === 2
          && foreign
          && foreign.createdAt === marker
          && foreign.resume > 0,
        why: `count=${(after.entries ?? []).length} v=${Number(inFlight).toFixed(1)} foreign=${JSON.stringify(foreign)}`
      });
    }, 2000);
  });
  status(
    "foreign pf:resume write is adopted and survives the next tracker save",
    markerCount.ok === true,
    markerCount.why ?? null
  );

  // 5 - GM_xmlhttpRequest resolves the full response shape against the
  // session's fixture server.
  const xhr = await session.evalAsync(function main(done) {
    window.GM_xmlhttpRequest({
      url: "/check/xhr-ok",
      timeout: 3000,
      onload: (res) => done({ status: res.status, text: res.responseText, shape: typeof res.response === "string" && res.responseText === res.response, headers: typeof res.responseHeaders === "string", err: null }),
      onerror: () => done({ status: null, text: null, shape: false, headers: false, err: "onerror" }),
      ontimeout: () => done({ err: "ontimeout" })
    });
  });
  status(
    "GM_xmlhttpRequest resolves the response shape",
    xhr.status === 200 && xhr.text === "PONG-OK" && xhr.shape && xhr.headers && !xhr.err,
    `status=${xhr.status} text=${xhr.text} err=${xhr.err}`
  );

  // 6 - timeout: the stalled route hangs past the deadline; ontimeout fires
  // and nothing else (no onload, no onerror, no uncaught timeoutrror).
  const timeout = await session.evalAsync(function main(done) {
    const seen = [];
    window.GM_xmlhttpRequest({
      url: "/check/xhr-slow",
      timeout: 400,
      onload: () => seen.push("load"),
      onerror: () => seen.push("error"),
      ontimeout: () => seen.push("timeout")
    });
    window.setTimeout(() => done(seen), 1600);
  });
  status(
    "GM_xmlhttpRequest timeout fires ontimeout only",
    timeout.length === 1 && timeout[0] === "timeout",
    `callbacks=${JSON.stringify(timeout)}`
  );

  // 7 - @resource pfStyle: the kernel's resource-warm ran at boot because the
  // resource differs from the embedded css; the marker rule must surface via
  // the adopted stylesheet.
  const probe = await session.eval(function main() {
    const host = document.querySelector(".pf-shell");
    return host ? getComputedStyle(host).getPropertyValue("--pf-check-probe").trim() : null;
  });
  status("pfStyle resource reaches the running shell", probe === "ok", `probe=${probe}`);

  // 8 - menu re-registration: one toggle, one unregister, one re-register,
  // the command stays callable and the census adds up.
  const menuCensus = await session.evalAsync(function main(done) {
    const stats0 = window.__gmTest.usage();
    const keys = Object.keys(window.__pfMenu ?? {}).filter((k) => k.startsWith("menu:"));
    const debugKey = keys.find((k) => k.includes("Debug"));
    if (!debugKey) { done({ ok: false, why: "menu keys=" + keys.join("|"), stats0, ids0: window.__gmTest.aliveMenuIds() }); return; }
    const ids0 = window.__gmTest.aliveMenuIds();
    (window.__pfMenu[debugKey])();
    setTimeout(() => {
      const stats1 = window.__gmTest.usage();
      const ids1 = window.__gmTest.aliveMenuIds();
      done({
        ok: (stats1.GM_registerMenuCommand ?? 0) - (stats0.GM_registerMenuCommand ?? 0) === 1
          && (stats1.GM_unregisterMenuCommand ?? 0) - (stats0.GM_unregisterMenuCommand ?? 0) === 1
          // Three live commands: the re-registered debug toggle plus the two
          // one-shot resets (color filter, subtitle sync).
          && ids1.length === 3
          && ids0.length === 3
          && Object.keys(window.__pfMenu).some((k) => k.startsWith("menu:") && k.includes("Debug"))
          && Object.keys(window.__pfMenu).some((k) => k.startsWith("menu:") && k.includes("Color"))
          && Object.keys(window.__pfMenu).some((k) => k.startsWith("menu:") && k.includes("Subtitle")),
        why: `reg=${stats1.GM_registerMenuCommand - stats0.GM_registerMenuCommand} unreg=${stats1.GM_unregisterMenuCommand - stats0.GM_unregisterMenuCommand} ids0=${ids0} ids1=${ids1}`
      });
    }, 500);
  });
  status(
    "menu toggle advances handle census (unregister + re-register)",
    menuCensus.ok === true,
    menuCensus.why ?? null
  );

  // 9 - session harvest seeds the reboot realm: the marker written here is
  // exactly what the NEXT persist-flagged boot replays into GM storage.
  await session.eval(function main() {
    window.GM_setValue("pf:check-harvest", { stamp: "harvest" });
  });
  await settle(150);
  await boot({ persist: true });
  await settle(400);
  const harvested = await session.eval(function main() {
    const v = window.__pfBacking["pf:check-harvest"] ?? null;
    return v && v.stamp === "harvest";
  });
  status("session harvest seeds the next boot realm", harvested === true, "harvest key missing after persist boot");

  return rows;
}
