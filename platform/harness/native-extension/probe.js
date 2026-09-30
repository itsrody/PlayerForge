// Runs in the userScript world as the final entry of the registered script,
// after the bundle body. WebDriver cannot see this realm, so the only way the
// harness learns whether the kernel booted is what is reported here.
(function () {
  function report(payload) {
    try { PF_report(payload); } catch (e) { /* nothing left to tell us */ }
  }

  function snapshot(stage) {
    var pf = globalThis.PlayerForge;
    report({
      ev: "realm",
      regSeq: globalThis.__pfRegSeq ?? null,
      stage: stage,
      hasPlayerForge: typeof pf,
      pfVersion: pf && pf.version ? pf.version : null,
      readyState: document.readyState,
      videos: document.querySelectorAll("video").length,
      shell: !!document.querySelector(".pf-shell"),
      hud: !!document.querySelector(".pf-hud-layer") ||
        !!document.querySelector(".pf-shell")?.shadowRoot?.querySelector(".pf-hud-layer"),
      anyPf: document.querySelectorAll('[class*="pf-"]').length
    });
  }

  snapshot("immediate");

  // The harness waits on this report to confirm the kernel booted and the page
  // scripts have run, so it has to be driven by the document reaching that
  // state. A fixed timer here would put that delay into every measured
  // navigate/inject pair, which is harness cost, not product cost.
  var reported = false;
  function afterLoad() {
    if (reported) return;
    reported = true;
    snapshot("after-load");
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", afterLoad, { once: true });
  } else {
    afterLoad();
  }

  // An error anywhere in the body shows up here rather than only as a
  // permanently absent shell.
  globalThis.addEventListener("error", function (e) {
    report({ ev: "error", msg: String((e.error && e.error.stack) || e.message) });
  });
  globalThis.addEventListener("unhandledrejection", function (e) {
    report({ ev: "rejection", msg: String(e.reason && (e.reason.stack || e.reason)) });
  });
})();
