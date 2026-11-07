/*
 * The popup command surface. Pure chrome: it owns no storage reads/writes
 * and dispatches no DOM events - every row is one message to the active
 * tab's top document, where kernel.js TabCommands answers. The reply
 * (debug state, reset handled) replaces the userscript menu's caption
 * rewrite; a missing reply means no reachable PlayerForge top frame, so
 * the hint line says so instead of leaving the row silently dead.
 */
// The command-channel vocabulary mirrors src/kernel/contract.js's
// TAB_COMMAND/COMMANDS one-to-one: a shipped chrome file lives inside the
// package (the XPI carries exactly these six members) and cannot import
// across the tree, the same constraint the harness companion mirrors
// under - the suite rides these same nouns, so contract drift fails
// loudly in both directions instead of silently dead-ending a row.
const TAB_COMMAND = "pf:command";

const COMMANDS = {
  debugQuery: "debug-query",
  debugToggle: "debug-toggle",
  diag: "diag",
  filterReset: "filter-reset",
  syncReset: "sync-reset"
};

const hintEl = document.getElementById("hint");
const debugRow = document.getElementById("debug-toggle");
const rows = {
  [COMMANDS.diag]: document.getElementById("diag"),
  [COMMANDS.filterReset]: document.getElementById("filter-reset"),
  [COMMANDS.syncReset]: document.getElementById("sync-reset")
};

document.getElementById("version").textContent = browser.runtime.getManifest().version;

function say(text) {
  if (!text) {
    hintEl.hidden = true;
    return;
  }
  hintEl.textContent = text;
  hintEl.hidden = false;
}

async function activeTab() {
  // tabs.query needs no permission; tab.url would need it, so reachability
  // is answered by the message itself (an extension page and a page
  // without our content script both reject here).
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id == null ? null : tab;
}

async function send(command) {
  const tab = await activeTab();
  if (!tab) {
    return null;
  }
  try {
    return await browser.tabs.sendMessage(tab.id, { type: TAB_COMMAND, command });
  } catch {
    return null;
  }
}

function labelDebug(enabled) {
  debugRow.textContent = `Debug logs: ${enabled === true ? "On" : "Off"}`;
}

debugRow.addEventListener("click", async () => {
  const enabled = await send(COMMANDS.debugToggle);
  if (enabled == null) {
    say("No active PlayerForge page");
    return;
  }
  labelDebug(enabled);
  say(null);
});


rows[COMMANDS.diag].addEventListener("click", async () => {
  // The diag command itself answers nothing (the dump lands on each
  // realm's console), so reachability is answered by the debug query
  // first - one extra round trip per tap, and the tap is human-rate.
  const reachable = await send(COMMANDS.debugQuery) != null;
  await send(COMMANDS.diag);
  if (reachable) {
    say("State dumped to DevTools console");
  } else {
    say("No active PlayerForge page");
  }
});

rows[COMMANDS.filterReset].addEventListener("click", async () => {
  const handled = await send(COMMANDS.filterReset);
  handled === true
    ? say("Color filter restored")
    : say("No player active on this tab");
});

rows[COMMANDS.syncReset].addEventListener("click", async () => {
  const handled = await send(COMMANDS.syncReset);
  handled === true
    ? say("Subtitle sync restored")
    : say("No player active on this tab");
});

// The debug row's caption answers the current state at popup open - the
// same query the userscript menu item's own caption served.
(async () => {
  const enabled = await send(COMMANDS.debugQuery);
  labelDebug(enabled);
  if (enabled == null) {
    say("No active PlayerForge page");
  }
})();
